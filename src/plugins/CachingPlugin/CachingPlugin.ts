'use strict';

import type { AxiosError, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import type { AxiosRetryerHttpMethod, RetryPlugin } from '../../types';
import { AXIOS_RETRYER_HTTP_METHODS } from '../../types';
import { RetryManager } from '../../core/RetryManager';
import { ensureRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';

type MaybePromise<T> = T | Promise<T>;

/**
 * Represents a cached item containing the AxiosResponse and the timestamp it was cached.
 */
export interface CachedItem {
  response: AxiosResponse<unknown>;
  timestamp: number;
  ttr?: number; // Custom TTR for this cache entry
}

export interface CacheStorage {
  get(key: string): MaybePromise<CachedItem | undefined>;
  set(key: string, value: CachedItem): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  clear(): MaybePromise<void>;
}

export class InMemoryCacheStorage implements CacheStorage {
  private readonly storage = new Map<string, CachedItem>();

  public get(key: string): CachedItem | undefined {
    return this.storage.get(key);
  }

  public set(key: string, value: CachedItem): void {
    this.storage.set(key, value);
  }

  public delete(key: string): void {
    this.storage.delete(key);
  }

  public clear(): void {
    this.storage.clear();
  }
}

interface InflightCacheEntry {
  promise: Promise<AxiosResponse<unknown>>;
  resolve: (response: AxiosResponse<unknown>) => void;
  reject: (error: unknown) => void;
}

function createInflightCacheEntry(): InflightCacheEntry {
  let resolve!: (response: AxiosResponse<unknown>) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<AxiosResponse<unknown>>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Leaders may never await this promise directly. Attach a noop rejection handler
  // so leader-only failures do not surface as unhandled rejections.
  promise.catch(() => {});

  return { promise, resolve, reject };
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function';
}

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
   * @default [AXIOS_RETRYER_HTTP_METHODS.GET]
   */
  cacheMethods?: readonly AxiosRetryerHttpMethod[];

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

  /**
   * Storage backend used for cache entries.
   * Defaults to the built-in in-memory storage.
   */
  storage?: CacheStorage;

  /**
   * If true, concurrent identical cacheable requests share the same in-flight response.
   * @default true
   */
  dedupeConcurrentRequests?: boolean;
}

export class CachingPlugin implements RetryPlugin {
  public name = 'CachingPlugin';
  public version = '1.0.0';

  private manager!: RetryManager;
  private interceptorIdReq: number | null = null;
  private interceptorIdRes: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly cache = new Map<string, CachedItem>();
  private readonly inflightRequests = new Map<string, InflightCacheEntry>();
  private readonly inflightLeaders = new WeakMap<AxiosRequestConfig, string>();
  private readonly inflightFollowers = new WeakMap<AxiosRequestConfig, string>();
  private readonly servedFromCache = new WeakSet<AxiosRequestConfig>();
  private readonly options: Required<CachingPluginOptions>;
  private readonly storage: CacheStorage;

  constructor(options?: CachingPluginOptions) {
    this.options = {
      compareHeaders: false,
      timeToRevalidate: 0,
      cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET],
      cleanupInterval: 0,
      maxAge: 0,
      maxItems: 1000,
      cacheOnlyRetriedRequests: false,
      storage: options?.storage ?? new InMemoryCacheStorage(),
      dedupeConcurrentRequests: true,
      ...options,
    };
    this.storage = this.options.storage;

    if (!Number.isInteger(this.options.cleanupInterval) || this.options.cleanupInterval < 0) {
      throw new Error('cleanupInterval must be a non-negative integer');
    }
    if (!Number.isInteger(this.options.maxAge) || this.options.maxAge < 0) {
      throw new Error('maxAge must be a non-negative integer');
    }
    if (!Number.isInteger(this.options.maxItems) || this.options.maxItems < 0) {
      throw new Error('maxItems must be a non-negative integer');
    }
    if (!Number.isInteger(this.options.timeToRevalidate) || this.options.timeToRevalidate < 0) {
      throw new Error('timeToRevalidate must be a non-negative integer');
    }
  }

  public initialize(manager: RetryManager): void {
    this.manager = manager;
    const axiosInstance = manager.axiosInstance;

    this.interceptorIdReq = axiosInstance.interceptors.request.use(
      (config) =>
        this.handleRequest(config) as Promise<InternalAxiosRequestConfig> | InternalAxiosRequestConfig,
      (error) => Promise.reject(error),
    );

    this.interceptorIdRes = axiosInstance.interceptors.response.use(
      (response) => this.handleResponseSuccess(response),
      (error) => this.handleResponseError(error),
    );

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
  private async handleRequest(config: AxiosRequestConfig): Promise<AxiosRequestConfig> {
    const metadata = ensureRequestMetadata(config);
    const method = (config.method || AXIOS_RETRYER_HTTP_METHODS.GET).toUpperCase() as AxiosRetryerHttpMethod;

    if (metadata.cachingOptions?.cache === false) {
      this.manager.getLogger()?.debug('[CachingPlugin] Skipping cache for request (explicitly disabled)');
      return config;
    }

    if (metadata.cachingOptions?.cache !== true && !this.options.cacheMethods.includes(method)) {
      return config;
    }

    if (this.options.cacheOnlyRetriedRequests && !metadata.isRetrying) {
      return config;
    }

    const cacheKey = this.generateCacheKey(config);
    let cachedItem: CachedItem | undefined = this.cache.get(cacheKey);

    if (!cachedItem) {
      try {
        cachedItem = await this.storage.get(cacheKey);
      } catch (error) {
        this.manager.getLogger()?.warn(`[CachingPlugin] Failed to read cache entry for ${cacheKey}`, error);
        return config;
      }
    }

    if (cachedItem) {
      this.touchCacheEntry(cacheKey, cachedItem);
      const ageMs = Date.now() - cachedItem.timestamp;
      const ttr = cachedItem.ttr ?? this.options.timeToRevalidate;

      if (ttr === 0 || ageMs < ttr) {
        this.manager.getLogger()?.debug(`[CachingPlugin] Cache hit for ${cacheKey} (age: ${ageMs}ms)`);
        this.servedFromCache.add(config);
        return {
          ...config,
          adapter: () =>
            Promise.resolve({
              ...cachedItem.response,
              config,
            }) as never,
        };
      }

      this.manager.getLogger()?.debug(`[CachingPlugin] Cache stale for ${cacheKey} (age: ${ageMs}ms); removing entry.`);
      await this.deleteCacheEntry(cacheKey);
    }

    if (!this.options.dedupeConcurrentRequests) {
      return config;
    }

    const inflightEntry = this.inflightRequests.get(cacheKey);
    if (inflightEntry) {
      this.inflightFollowers.set(config, cacheKey);
      this.manager.getLogger()?.debug(`[CachingPlugin] Piggybacking on in-flight request for ${cacheKey}`);
      return {
        ...config,
        adapter: async () => ({
          ...(await inflightEntry.promise),
          config,
        }) as never,
      };
    }

    this.inflightRequests.set(cacheKey, createInflightCacheEntry());
    this.inflightLeaders.set(config, cacheKey);
    return config;
  }

  /**
   * Handles successful responses by caching them when appropriate.
   */
  private async handleResponseSuccess(response: AxiosResponse): Promise<AxiosResponse> {
    const metadata = response.config ? getRequestMetadata(response.config) : undefined;
    const followerKey = response.config ? this.inflightFollowers.get(response.config) : undefined;

    if (followerKey) {
      this.inflightFollowers.delete(response.config);
      return response;
    }

    if (response.config && this.servedFromCache.has(response.config)) {
      this.servedFromCache.delete(response.config);
      return response;
    }

    if (metadata?.cachingOptions?.cache === false) {
      this.resolveInflightRequest(response.config, response);
      return response;
    }

    if (metadata?.cachingOptions?.cache !== true) {
      const method = (response.config?.method || AXIOS_RETRYER_HTTP_METHODS.GET).toUpperCase() as AxiosRetryerHttpMethod;
      if (!this.options.cacheMethods.includes(method)) {
        this.resolveInflightRequest(response.config, response);
        return response;
      }

      if (this.options.cacheOnlyRetriedRequests && response.config && !metadata?.isRetrying) {
        this.resolveInflightRequest(response.config, response);
        return response;
      }
    }

    if (response.status >= 200 && response.status < 300) {
      const cacheKey = this.generateCacheKey(response.config);
      const ttr = metadata?.cachingOptions?.ttr;

      try {
        this.manager.getLogger()?.debug(
          `[CachingPlugin] Caching response for ${cacheKey}${ttr ? ` with custom TTR: ${ttr}ms` : ''}`
        );

        await this.upsertCacheEntry(cacheKey, {
          response,
          timestamp: Date.now(),
          ttr,
        });
      } catch (error) {
        this.manager.getLogger()?.warn(`[CachingPlugin] Failed to cache response for ${cacheKey}`, error);
      } finally {
        this.resolveInflightRequest(response.config, response);
      }
    } else {
      this.resolveInflightRequest(response.config, response);
    }

    return response;
  }

  private handleResponseError(error: AxiosError): Promise<never> {
    if (error.config) {
      this.rejectInflightRequest(error.config, error);
      this.inflightFollowers.delete(error.config);
    }

    return Promise.reject(error);
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
      void this.runCacheCleanup();
    }, this.options.cleanupInterval);
  }

  private stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async runCacheCleanup(): Promise<void> {
    const now = Date.now();
    const itemsToRemove = new Set<string>();

    if (this.options.maxAge > 0) {
      this.cache.forEach((item, key) => {
        if (now - item.timestamp > this.options.maxAge) {
          itemsToRemove.add(key);
        }
      });
    }

    if (this.options.maxItems > 0 && this.cache.size > this.options.maxItems) {
      const excess = this.cache.size - this.options.maxItems;
      let removed = 0;
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < keys.length && removed < excess; i++) {
        itemsToRemove.add(keys[i]);
        removed++;
      }
    }

    if (itemsToRemove.size > 0) {
      await Promise.all(Array.from(itemsToRemove, (key) => this.deleteCacheEntry(key)));
      this.manager.getLogger()?.debug(`[CachingPlugin] Cleaned up ${itemsToRemove.size} cached items`);
    }
  }

  /**
   * Manually clears all cache entries.
   */
  public clearCache(): void | Promise<void> {
    this.cache.clear();
    this.inflightRequests.clear();
    this.manager.getLogger()?.debug('[CachingPlugin] Cache cleared.');

    const clearResult = this.storage.clear();
    if (isPromiseLike(clearResult)) {
      return clearResult.then(() => undefined);
    }
  }

  /**
   * Invalidates a specific cache entry by key pattern.
   * If the key is a string, it will invalidate exact matches.
   * If the key is a RegExp, it will invalidate all matching keys.
   *
   * @param keyPattern The key or pattern to match for invalidation
   * @returns The number of invalidated cache entries
   */
  public invalidateCache(keyPattern: string | RegExp): number | Promise<number> {
    let count = 0;
    const keys = Array.from(this.cache.keys());
    const deleteOperations: Array<void | Promise<void>> = [];

    if (keyPattern instanceof RegExp) {
      keys.forEach((key) => {
        if (keyPattern.test(key)) {
          this.cache.delete(key);
          deleteOperations.push(this.storage.delete(key));
          count++;
        }
      });
    } else {
      keys.forEach((key) => {
        if (key === keyPattern || key.includes(keyPattern)) {
          this.cache.delete(key);
          deleteOperations.push(this.storage.delete(key));
          count++;
        }
      });
    }

    if (count > 0) {
      this.manager.getLogger()?.debug(`[CachingPlugin] Invalidated ${count} cache entries matching pattern: ${keyPattern}`);
    }

    if (deleteOperations.some((operation) => isPromiseLike(operation))) {
      return Promise.all(deleteOperations.map((operation) => Promise.resolve(operation))).then(() => count);
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

  private async upsertCacheEntry(cacheKey: string, cachedItem: CachedItem): Promise<void> {
    if (this.options.maxItems > 0 && !this.cache.has(cacheKey) && this.cache.size >= this.options.maxItems) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        await this.deleteCacheEntry(oldestKey);
      }
    }

    this.touchCacheEntry(cacheKey, cachedItem);
    await this.storage.set(cacheKey, cachedItem);
  }

  private touchCacheEntry(cacheKey: string, cachedItem: CachedItem): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, cachedItem);
  }

  private async deleteCacheEntry(cacheKey: string): Promise<void> {
    this.cache.delete(cacheKey);
    await this.storage.delete(cacheKey);
  }

  private resolveInflightRequest(config: AxiosRequestConfig | undefined, response: AxiosResponse): void {
    if (!config) {
      return;
    }

    const leaderKey = this.inflightLeaders.get(config);
    if (!leaderKey) {
      return;
    }

    const inflightEntry = this.inflightRequests.get(leaderKey);
    if (inflightEntry) {
      inflightEntry.resolve(response);
      this.inflightRequests.delete(leaderKey);
    }

    this.inflightLeaders.delete(config);
  }

  private rejectInflightRequest(config: AxiosRequestConfig, error: unknown): void {
    const leaderKey = this.inflightLeaders.get(config);
    if (!leaderKey) {
      return;
    }

    const inflightEntry = this.inflightRequests.get(leaderKey);
    if (inflightEntry) {
      inflightEntry.reject(error);
      this.inflightRequests.delete(leaderKey);
    }

    this.inflightLeaders.delete(config);
  }
}
