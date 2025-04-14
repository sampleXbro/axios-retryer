'use strict';

import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import type { RetryPlugin } from '../../types';
import { RetryManager } from '../../core/RetryManager';

/**
 * Options for the CachingPlugin.
 */
export interface CachingPluginOptions {
  /**
   * If true, include the entire headers object in the cache key.
   * @default false
   */
  compareHeaders?: boolean;

  /**
   * Duration (in milliseconds) a cached entry is considered fresh.
   * If 0, the cache never expires.
   * @default 0
   */
  timeToRevalidate?: number;

  /**
   * HTTP methods to cache. By default, only GET requests are cached.
   * @default ['GET']
   */
  cacheMethods?: string[];

  /**
   * Interval in milliseconds to run cache cleanup.
   * If 0, periodic cleanup is disabled.
   * @default 0
   */
  cleanupInterval?: number;

  /**
   * Maximum age in milliseconds for cached items.
   * Items older than this will be removed during cleanup.
   * If 0, items don't expire based on age.
   * @default 0
   */
  maxAge?: number;

  /**
   * Maximum number of items to keep in cache.
   * If exceeded, oldest items will be removed first.
   * If 0, no limit is applied.
   * @default 1000
   */
  maxItems?: number;

  /**
   * If true, only requests that are retried will be cached.
   * Requests that are not retried will not be cached even if they are cacheable.
   * @default false
   */
  cacheOnlyRetriedRequests?: boolean;
}

/**
 * Represents a cached item containing the AxiosResponse and the timestamp it was cached.
 */
interface CachedItem {
  response: AxiosResponse;
  timestamp: number;
  ttr?: number; // Custom TTR for this cache entry
}

export class CachingPlugin implements RetryPlugin {
  public name = 'CachingPlugin';
  public version = '1.0.0';

  private manager!: RetryManager;
  private interceptorIdReq: number | null = null;
  private interceptorIdRes: number | null = null;
  private cache = new Map<string, CachedItem>();
  private cacheLock = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly options: Required<CachingPluginOptions>;

  constructor(options?: CachingPluginOptions) {
    this.options = {
      compareHeaders: false,
      timeToRevalidate: 0,
      cacheMethods: ['GET'],
      cleanupInterval: 0,
      maxAge: 0,
      maxItems: 1000,
      cacheOnlyRetriedRequests: false,
      ...options,
    };
  }

  public initialize(manager: RetryManager): void {
    this.manager = manager;
    const axiosInstance = manager.axiosInstance;

    // Attach request interceptor
    this.interceptorIdReq = axiosInstance.interceptors.request.use(
      (config) => this.handleRequest(config) as InternalAxiosRequestConfig,
      (error) => Promise.reject(error),
    );

    // Attach response interceptor
    this.interceptorIdRes = axiosInstance.interceptors.response.use(
      (response) => this.handleResponseSuccess(response),
      (error) => Promise.reject(error),
    );

    // Start periodic cleanup if enabled
    if (this.options.cleanupInterval > 0) {
      this.startPeriodicCleanup();
    }
  }

  public onBeforeDestroyed(): void {
    if (this.interceptorIdReq !== null) {
      this.manager.axiosInstance.interceptors.request.eject(this.interceptorIdReq);
    }
    if (this.interceptorIdRes !== null) {
      this.manager.axiosInstance.interceptors.response.eject(this.interceptorIdRes);
    }
    this.stopPeriodicCleanup();
  }

  /**
   * Checks if there is a fresh cached response and handles the request accordingly.
   */
  private handleRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    const method = (config.method || 'GET').toUpperCase();
    
    // Check per-request cache settings first
    if (config.__cachingOptions?.cache === false) {
      this.manager.getLogger()?.debug(`[CachingPlugin] Skipping cache for request (explicitly disabled)`);
      return config;
    }
    
    // If not explicitly enabled, check global method settings
    if (config.__cachingOptions?.cache !== true && !this.options.cacheMethods.includes(method)) {
      return config;
    }

    if (this.options.cacheOnlyRetriedRequests && !config.__isRetrying) {
      return config;
    }

    const cacheKey = this.generateCacheKey(config);
    const cachedItem = this.cache.get(cacheKey);

    if (cachedItem) {
      const ageMs = Date.now() - cachedItem.timestamp;
      
      // Use per-request TTR if available, otherwise use global setting
      const ttr = cachedItem.ttr ?? this.options.timeToRevalidate;
      
      if (ttr === 0 || ageMs < ttr) {
        this.manager.getLogger()?.debug(`[CachingPlugin] Cache hit for ${cacheKey} (age: ${ageMs}ms)`);

        // Return modified config with cached response
        return {
          ...config,
          adapter: () =>
            Promise.resolve({
              ...cachedItem.response,
              config,
            }) as never,
        };
      } else {
        this.manager
          .getLogger()
          ?.debug(`[CachingPlugin] Cache stale for ${cacheKey} (age: ${ageMs}ms); removing entry.`);
        this.cache.delete(cacheKey);
      }
    }
    return config;
  }

  /**
   * Handles successful responses by caching them when appropriate.
   */
  private async handleResponseSuccess(response: AxiosResponse): Promise<AxiosResponse> {
    // Check per-request cache setting first
    if (response.config?.__cachingOptions?.cache === false) {
      return response;
    }
    
    // If not explicitly enabled via per-request setting, check global settings
    if (response.config?.__cachingOptions?.cache !== true) {
      const method = (response.config?.method || 'GET').toUpperCase();
      if (!this.options.cacheMethods.includes(method)) {
        return response;
      }
      
      if (this.options.cacheOnlyRetriedRequests && response.config && !response.config.__isRetrying) {
        return response;
      }
    }

    if (response.status >= 200 && response.status < 300) {
      const cacheKey = this.generateCacheKey(response.config);

      // Create or reuse existing lock
      let lock = this.cacheLock.get(cacheKey);
      if (!lock) {
        lock = Promise.resolve();
        this.cacheLock.set(cacheKey, lock);
      }

      try {
        // Wait for lock before updating cache
        await lock;

        // Check cache size before adding new item
        if (this.options.maxItems > 0 && this.cache.size >= this.options.maxItems) {
          const oldestKey = Array.from(this.cache.entries()).sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][0];
          this.cache.delete(oldestKey);
        }

        // Get per-request TTR if available
        const ttr = response.config?.__cachingOptions?.ttr;
        
        this.manager.getLogger()?.debug(
          `[CachingPlugin] Caching response for ${cacheKey}${ttr ? ` with custom TTR: ${ttr}ms` : ''}`
        );
        
        this.cache.set(cacheKey, {
          response,
          timestamp: Date.now(),
          ttr, // Store custom TTR if provided
        });
      } finally {
        this.cacheLock.delete(cacheKey);
      }
    }
    return response;
  }

  /**
   * Generates a unique cache key based on the request configuration.
   */
  private generateCacheKey(config: AxiosRequestConfig): string {
    if (!config.url) {
      throw new Error('URL is required for cache key generation');
    }

    const method = (config.method || 'GET').toUpperCase();
    const params = config.params
      ? typeof config.params === 'object'
        ? JSON.stringify(config.params)
        : String(config.params)
      : '';
    const data = config.data
      ? typeof config.data === 'object'
        ? JSON.stringify(config.data)
        : String(config.data)
      : '';

    let headersPart = '';
    if (this.options.compareHeaders && config.headers) {
      headersPart = typeof config.headers === 'object' ? JSON.stringify(config.headers) : String(config.headers);
    }

    return [method, config.url, params, data, headersPart].join('|');
  }

  private startPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.runCacheCleanup();
    }, this.options.cleanupInterval);
  }

  private stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private runCacheCleanup(): void {
    const now = Date.now();
    let itemsToRemove: string[] = [];

    // Check for expired items
    if (this.options.maxAge > 0) {
      // Find all expired items
      Array.from(this.cache.entries()).forEach(([key, item]) => {
        if (now - item.timestamp > this.options.maxAge) {
          itemsToRemove.push(key);
        }
      });
    }

    // Check for cache size limits
    if (this.options.maxItems > 0 && this.cache.size > this.options.maxItems) {
      const sortedItems = Array.from(this.cache.entries()).sort(([, a], [, b]) => a.timestamp - b.timestamp);
      
      // Calculate how many items we need to remove to get down to maxItems
      const excess = this.cache.size - this.options.maxItems;
      
      // Get the keys of the oldest items that need to be removed
      const extraItems = sortedItems.slice(0, excess).map(([key]) => key);
      
      // Add these keys to our removal list without using Set
      extraItems.forEach(key => {
        if (!itemsToRemove.includes(key)) {
          itemsToRemove.push(key);
        }
      });
    }

    // Remove items and log
    if (itemsToRemove.length > 0) {
      itemsToRemove.forEach((key) => this.cache.delete(key));
      this.manager.getLogger()?.debug(`[CachingPlugin] Cleaned up ${itemsToRemove.length} cached items`);
    }
  }

  /**
   * Manually clears all cache entries.
   */
  public clearCache(): void {
    this.cache.clear();
    this.manager.getLogger()?.debug('[CachingPlugin] Cache cleared.');
  }

  /**
   * Invalidates a specific cache entry by key pattern.
   * If the key is a string, it will invalidate exact matches.
   * If the key is a RegExp, it will invalidate all matching keys.
   * 
   * @param keyPattern The key or pattern to match for invalidation
   * @returns The number of invalidated cache entries
   */
  public invalidateCache(keyPattern: string | RegExp): number {
    let count = 0;
    const keys = Array.from(this.cache.keys());
    
    if (keyPattern instanceof RegExp) {
      // If pattern is a RegExp, test each key
      keys.forEach(key => {
        if (keyPattern.test(key)) {
          this.cache.delete(key);
          count++;
        }
      });
    } else {
      // Otherwise, look for exact matches or keys containing the pattern
      keys.forEach(key => {
        if (key === keyPattern || key.includes(keyPattern)) {
          this.cache.delete(key);
          count++;
        }
      });
    }
    
    if (count > 0) {
      this.manager.getLogger()?.debug(`[CachingPlugin] Invalidated ${count} cache entries matching pattern: ${keyPattern}`);
    }
    
    return count;
  }

  /**
   * Returns current cache statistics.
   */
  public getCacheStats(): {
    size: number;
    oldestItemAge: number;
    newestItemAge: number;
    averageAge: number;
  } {
    const now = Date.now();
    const items = Array.from(this.cache.values());

    if (items.length === 0) {
      return {
        size: 0,
        oldestItemAge: 0,
        newestItemAge: 0,
        averageAge: 0,
      };
    }

    const ages = items.map((item) => now - item.timestamp);

    return {
      size: this.cache.size,
      oldestItemAge: Math.max(...ages),
      newestItemAge: Math.min(...ages),
      averageAge: ages.reduce((sum, age) => sum + age, 0) / ages.length,
    };
  }
}
