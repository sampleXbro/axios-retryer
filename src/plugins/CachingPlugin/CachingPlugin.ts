'use strict';

import type { AxiosError, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import type { AxiosRetryerHttpMethod, PluginContext, RetryPlugin } from '../../types';
import { AXIOS_RETRYER_HTTP_METHODS } from '../../types';
import { ensureRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';
import { InvalidCacheKeyError } from './errors';
import { resolveCachingPluginOptions, validateCachingPluginOptions } from './configs';
import {
  requestHasAuthHeaders,
  getErrorMeta,
  isPromiseLike,
  sortCacheEntriesByAccess,
  createInflightCacheEntry,
  type InflightCacheEntry,
  buildCacheKeyContext,
  describeInvalidationMatcher,
  fingerprintValue,
  matchesInvalidationMatcher,
  cloneAxiosResponse,
  createCachedResponseSnapshot,
} from './utils';
import type {
  CacheInvalidationMatcher,
  CacheKeyBuilderContext,
  CacheStorage,
  CacheStorageEntry,
  CachedItem,
  CachingPluginEvents,
  CachingPluginOptions,
  CachingRequestOptions,
} from './types';

export { InMemoryCacheStorage } from './storage';
export type {
  CacheInvalidationMatcher,
  CacheKeyBuilder,
  CacheKeyBuilderContext,
  CacheStorage,
  CacheStorageEntry,
  CachedItem,
  CachingPluginEvents,
  CachingPluginOptions,
  CachingRequestOptions,
} from './types';

export class CachingPlugin implements RetryPlugin<CachingPluginEvents> {
  public name = 'CachingPlugin';
  public version = '1.0.0';
  public readonly _events?: Readonly<CachingPluginEvents>;

  private context!: PluginContext<CachingPluginEvents>;
  private interceptorIdReq: number | null = null;
  private interceptorIdRes: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly cache = new Map<string, CachedItem>();
  private readonly inflightRequests = new Map<string, InflightCacheEntry>();
  // Keyed by a stable tracking ID rather than object identity (survives config object spreads
  // in upstream interceptors). The RetryManager's requestId is used when available; otherwise
  // a fallback ID is generated and stored in a WeakMap local to this plugin instance.
  private readonly inflightLeaders = new Map<string, string>();
  private readonly inflightFollowers = new Map<string, string>();
  private readonly servedFromCache = new Set<string>();
  private readonly trackingIdFallback = new WeakMap<AxiosRequestConfig, string>();
  private readonly options: Required<CachingPluginOptions>;
  private readonly storage: CacheStorage;

  constructor(options?: CachingPluginOptions) {
    this.options = resolveCachingPluginOptions(options);
    this.storage = this.options.storage;

    validateCachingPluginOptions(this.options);
  }

  public initialize(context: PluginContext<CachingPluginEvents>): void {
    this.context = context;
    const axiosInstance = context.axiosInstance;

    this.interceptorIdReq = axiosInstance.interceptors.request.use(
      (config) => this.handleRequest(config) as Promise<InternalAxiosRequestConfig> | InternalAxiosRequestConfig,
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
      this.context.axiosInstance.interceptors.request.eject(this.interceptorIdReq);
    }

    if (this.interceptorIdRes !== null) {
      this.context.axiosInstance.interceptors.response.eject(this.interceptorIdRes);
    }

    this.stopPeriodicCleanup();
    this.inflightLeaders.clear();
    this.inflightFollowers.clear();
    this.servedFromCache.clear();
  }

  private getCacheKeyFingerprint(cacheKey: string): string {
    return fingerprintValue(cacheKey);
  }

  /**
   * Returns a stable tracking ID for this config object.
   * Prefers the RetryManager-assigned requestId (stable across config spreads in upstream
   * interceptors). Falls back to a WeakMap-based local ID for environments where the
   * RetryManager interceptors are not active (e.g. isolated unit tests).
   */
  private getOrAssignTrackingId(config: AxiosRequestConfig): string {
    const requestId = getRequestMetadata(config)?.requestId;

    if (requestId) {
      return requestId;
    }

    let fallbackId = this.trackingIdFallback.get(config);

    if (!fallbackId) {
      fallbackId = `ct_${Math.random().toString(36).slice(2)}`;
      this.trackingIdFallback.set(config, fallbackId);
    }

    return fallbackId;
  }

  /**
   * Checks if there is a fresh cached response and handles the request accordingly.
   */
  private async handleRequest(config: AxiosRequestConfig): Promise<AxiosRequestConfig> {
    const metadata = ensureRequestMetadata(config);
    const cachingOptions = this.getRequestCachingOptions(config);
    const method = (config.method || AXIOS_RETRYER_HTTP_METHODS.GET).toUpperCase() as AxiosRetryerHttpMethod;

    if (cachingOptions) {
      metadata.cachingOptions = cachingOptions;
    }

    if (cachingOptions?.cache === false) {
      this.context.getLogger()?.debug('[CachingPlugin] Skipping cache for request (explicitly disabled)');
      return config;
    }

    if (this.options.skipWhenAuthPresent && requestHasAuthHeaders(config)) {
      this.context.getLogger()?.debug('[CachingPlugin] Skipping cache for authenticated request');
      return config;
    }

    if (cachingOptions?.cache !== true && !this.options.cacheMethods.includes(method)) {
      return config;
    }

    if (this.options.cacheOnlyRetriedRequests && !metadata.isRetrying) {
      return config;
    }

    const cacheKey = this.buildCacheKey(config);
    const cacheKeyFingerprint = this.getCacheKeyFingerprint(cacheKey);
    let cachedItem: CachedItem | undefined = this.cache.get(cacheKey);

    if (!cachedItem) {
      try {
        cachedItem = await this.storage.get(cacheKey);
      } catch (error) {
        this.context.getLogger()?.warn('[CachingPlugin] Failed to read cache entry', {
          cacheKeyFingerprint,
          ...getErrorMeta(error),
        });
        return config;
      }
    }

    if (cachedItem) {
      const now = Date.now();
      const ageMs = now - cachedItem.timestamp;
      const ttr = cachedItem.ttr ?? this.options.timeToRevalidate;

      if (ttr === 0 || ageMs < ttr) {
        const touchedItem = this.touchCacheEntry(cacheKey, cachedItem, now);
        await this.persistCacheTouchIfNeeded(cacheKey, touchedItem, cacheKeyFingerprint);
        this.context.getLogger()?.debug('[CachingPlugin] Cache hit', {
          cacheKeyFingerprint,
          ageMs,
        });
        this.context.triggerAndEmit('onCacheHit', {
          keyFingerprint: cacheKeyFingerprint,
          config,
          ageMs,
        });
        this.servedFromCache.add(this.getOrAssignTrackingId(config));
        return {
          ...config,
          adapter: () => Promise.resolve(cloneAxiosResponse(touchedItem.response, config)) as never,
        };
      }

      this.context.getLogger()?.debug('[CachingPlugin] Cache stale', {
        cacheKeyFingerprint,
        ageMs,
      });
      this.context.triggerAndEmit('onCacheMiss', {
        keyFingerprint: cacheKeyFingerprint,
        config,
        reason: 'stale',
      });
      await this.deleteCacheEntry(cacheKey);
    } else {
      this.context.triggerAndEmit('onCacheMiss', {
        keyFingerprint: cacheKeyFingerprint,
        config,
        reason: 'empty',
      });
    }

    if (!this.options.dedupeConcurrentRequests) {
      return config;
    }

    const inflightEntry = this.inflightRequests.get(cacheKey);

    if (inflightEntry) {
      this.inflightFollowers.set(this.getOrAssignTrackingId(config), cacheKey);
      this.context.getLogger()?.debug('[CachingPlugin] Piggybacking on in-flight request', {
        cacheKeyFingerprint,
      });
      return {
        ...config,
        adapter: async () => cloneAxiosResponse(await inflightEntry.promise, config) as never,
      };
    }

    this.inflightRequests.set(cacheKey, createInflightCacheEntry());
    this.inflightLeaders.set(this.getOrAssignTrackingId(config), cacheKey);
    return config;
  }

  /**
   * Handles successful responses by caching them when appropriate.
   */
  private async handleResponseSuccess(response: AxiosResponse): Promise<AxiosResponse> {
    const metadata = response.config ? getRequestMetadata(response.config) : undefined;
    const responseId = response.config ? this.getOrAssignTrackingId(response.config) : undefined;
    const followerKey = responseId ? this.inflightFollowers.get(responseId) : undefined;

    if (followerKey) {
      if (responseId) {
        this.inflightFollowers.delete(responseId);
      }

      return response;
    }

    if (responseId && this.servedFromCache.has(responseId)) {
      this.servedFromCache.delete(responseId);
      return response;
    }

    const cachingOptions = this.getRequestCachingOptions(response.config);

    if (cachingOptions?.cache === false) {
      this.resolveInflightRequest(response.config, response);
      return response;
    }

    if (this.options.skipWhenAuthPresent && requestHasAuthHeaders(response.config)) {
      this.resolveInflightRequest(response.config, response);
      return response;
    }

    if (cachingOptions?.cache !== true) {
      const method = (
        response.config?.method || AXIOS_RETRYER_HTTP_METHODS.GET
      ).toUpperCase() as AxiosRetryerHttpMethod;

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
      const cacheKey = this.buildCacheKey(response.config);
      const cacheKeyFingerprint = this.getCacheKeyFingerprint(cacheKey);
      const ttr = cachingOptions?.ttr;

      if (this.options.maxEntrySize > 0) {
        try {
          const estimatedSize = JSON.stringify(response.data)?.length ?? 0;

          if (estimatedSize > this.options.maxEntrySize) {
            this.context.getLogger()?.debug('[CachingPlugin] Skipping oversized response', {
              cacheKeyFingerprint,
              estimatedSize,
              maxEntrySize: this.options.maxEntrySize,
            });
            this.resolveInflightRequest(response.config, response);
            return response;
          }
        } catch {
          // JSON.stringify may throw for circular structures; skip caching defensively.
          this.resolveInflightRequest(response.config, response);
          return response;
        }
      }

      try {
        this.context.getLogger()?.debug('[CachingPlugin] Caching response', {
          cacheKeyFingerprint,
          ...(ttr ? { ttrMs: ttr } : {}),
        });

        await this.upsertCacheEntry(cacheKey, {
          response: createCachedResponseSnapshot(response, this.options.sensitiveResponseHeaders),
          timestamp: Date.now(),
          ttr,
          lastAccessedAt: Date.now(),
        });
      } catch (error) {
        this.context.getLogger()?.warn('[CachingPlugin] Failed to cache response', {
          cacheKeyFingerprint,
          ...getErrorMeta(error),
        });
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
      this.inflightFollowers.delete(this.getOrAssignTrackingId(error.config));
    }

    return Promise.reject(error);
  }

  /**
   * Generates a unique cache key based on the request configuration.
   */
  public buildCacheKey(config: AxiosRequestConfig): string {
    if (!config.url) {
      throw new InvalidCacheKeyError();
    }

    return this.options.cacheKeyBuilder(this.buildCacheKeyContext(config));
  }

  private startPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.runCacheCleanup().catch((error: unknown) => {
        this.context.getLogger()?.warn('[CachingPlugin] Failed to run cache cleanup', getErrorMeta(error));
      });
    }, this.options.cleanupInterval);
  }

  private stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async runCacheCleanup(): Promise<void> {
    const indexedEntries = await this.readCacheEntriesForScan();
    this.syncLocalCache(indexedEntries);

    const now = Date.now();
    const itemsToRemove = new Set<string>();

    if (this.options.maxAge > 0) {
      indexedEntries.forEach(({ key, value }) => {
        if (now - value.timestamp > this.options.maxAge) {
          itemsToRemove.add(key);
        }
      });
    }

    if (this.options.maxItems > 0 && indexedEntries.length > this.options.maxItems) {
      const excess = indexedEntries.length - this.options.maxItems;
      const evictionCandidates = sortCacheEntriesByAccess(indexedEntries);

      for (let i = 0; i < evictionCandidates.length && itemsToRemove.size < excess; i++) {
        itemsToRemove.add(evictionCandidates[i].key);
      }
    }

    if (itemsToRemove.size > 0) {
      await Promise.all(Array.from(itemsToRemove, (key) => this.deleteCacheEntry(key)));
      this.context.getLogger()?.debug(`[CachingPlugin] Cleaned up ${itemsToRemove.size} cached items`);
    }
  }

  /**
   * Manually clears all cache entries.
   */
  public clearCache(): void | Promise<void> {
    const count = this.cache.size;
    this.cache.clear();
    this.inflightRequests.clear();
    this.context.getLogger()?.debug('[CachingPlugin] Cache cleared.');
    this.context.triggerAndEmit('onCacheInvalidated', { count, matcher: 'all' });

    const clearResult = this.storage.clear();

    if (isPromiseLike(clearResult)) {
      return clearResult.then(() => undefined);
    }
  }

  /**
   * Invalidates cache entries using explicit exact-key, prefix, or RegExp matching.
   *
   * Plain string input is treated as an exact-key match.
   *
   * @param matcher The exact key, prefix matcher, or RegExp to match for invalidation
   * @returns The number of invalidated cache entries
   */
  public invalidateCache(matcher: CacheInvalidationMatcher): number | Promise<number> {
    const indexedEntries = this.storage.entries();

    if (isPromiseLike(indexedEntries)) {
      return Promise.resolve(indexedEntries).then((entries) => this.invalidateCacheEntries(matcher, entries));
    }

    return this.invalidateCacheEntries(matcher, indexedEntries);
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
    await this.enforceMaxItemsBeforeUpsert(cacheKey);

    const touchedItem = this.touchCacheEntry(cacheKey, cachedItem, cachedItem.lastAccessedAt ?? cachedItem.timestamp);
    await this.storage.set(cacheKey, touchedItem);
  }

  private touchCacheEntry(cacheKey: string, cachedItem: CachedItem, touchedAt = Date.now()): CachedItem {
    const touchedItem =
      cachedItem.lastAccessedAt === touchedAt ? cachedItem : { ...cachedItem, lastAccessedAt: touchedAt };

    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, touchedItem);

    return touchedItem;
  }

  private deleteCacheEntry(cacheKey: string): void | Promise<void> {
    this.cache.delete(cacheKey);

    const deleteResult = this.storage.delete(cacheKey);

    if (isPromiseLike(deleteResult)) {
      return deleteResult.then(() => undefined);
    }
  }

  private getRequestCachingOptions(config: AxiosRequestConfig): CachingRequestOptions | undefined {
    return config.__cachingOptions ?? getRequestMetadata(config)?.cachingOptions;
  }

  private async readCacheEntriesForScan(): Promise<CacheStorageEntry[]> {
    return Array.from(await this.storage.entries());
  }

  private syncLocalCache(entries: readonly CacheStorageEntry[]): void {
    this.cache.clear();

    sortCacheEntriesByAccess(entries).forEach(({ key, value }) => {
      this.cache.set(key, value);
    });
  }

  private async enforceMaxItemsBeforeUpsert(cacheKey: string): Promise<void> {
    if (this.options.maxItems === 0) {
      return;
    }

    // Fast path: use the in-memory mirror when it is populated.
    // The local Map is kept in insertion/access order and is authoritative
    // for the in-memory storage adapter. For custom persistent adapters it
    // may lag after restart, but syncLocalCache during periodic cleanup
    // re-aligns it. Falling back to storage on a cold cache is still correct.
    if (this.cache.size > 0) {
      if (this.cache.has(cacheKey)) {
        return;
      }

      if (this.cache.size < this.options.maxItems) {
        return;
      }

      const excess = this.cache.size - this.options.maxItems + 1;
      const evictionCandidates = sortCacheEntriesByAccess(Array.from(this.cache, ([key, value]) => ({ key, value })));
      await Promise.all(evictionCandidates.slice(0, excess).map(({ key }) => this.deleteCacheEntry(key)));
      return;
    }

    // Cold-start path: local cache is empty — read from storage once to
    // initialise the mirror, then apply the same eviction logic.
    const indexedEntries = await this.readCacheEntriesForScan();
    this.syncLocalCache(indexedEntries);

    if (indexedEntries.some((entry) => entry.key === cacheKey)) {
      return;
    }

    const excess = indexedEntries.length - this.options.maxItems + 1;

    if (excess <= 0) {
      return;
    }

    const keysToRemove = sortCacheEntriesByAccess(indexedEntries)
      .slice(0, excess)
      .map((entry) => entry.key);

    await Promise.all(keysToRemove.map((key) => this.deleteCacheEntry(key)));
  }

  private async persistCacheTouchIfNeeded(
    cacheKey: string,
    cachedItem: CachedItem,
    cacheKeyFingerprint: string,
  ): Promise<void> {
    if (this.options.maxItems === 0) {
      return;
    }

    try {
      await this.storage.set(cacheKey, cachedItem);
    } catch (error) {
      this.context.getLogger()?.warn('[CachingPlugin] Failed to persist cache access metadata', {
        cacheKeyFingerprint,
        ...getErrorMeta(error),
      });
    }
  }

  private invalidateCacheEntries(
    matcher: CacheInvalidationMatcher,
    indexedEntries: readonly CacheStorageEntry[],
  ): number | Promise<number> {
    this.syncLocalCache(indexedEntries);

    const keysToRemove = indexedEntries
      .filter(({ key }) => matchesInvalidationMatcher(key, matcher))
      .map(({ key }) => key);

    if (keysToRemove.length === 0) {
      return 0;
    }

    const deleteOperations = keysToRemove.map((key) => this.deleteCacheEntry(key));
    const finalize = (): number => {
      this.context.getLogger()?.debug('[CachingPlugin] Invalidated cache entries', {
        count: keysToRemove.length,
        matcher: describeInvalidationMatcher(matcher),
      });
      this.context.triggerAndEmit('onCacheInvalidated', {
        count: keysToRemove.length,
        matcher: 'custom',
      });

      return keysToRemove.length;
    };

    if (deleteOperations.some((operation) => isPromiseLike(operation))) {
      return Promise.all(deleteOperations.map((operation) => Promise.resolve(operation))).then(() => finalize());
    }

    return finalize();
  }

  private buildCacheKeyContext(config: AxiosRequestConfig): CacheKeyBuilderContext {
    return buildCacheKeyContext(config, this.options);
  }

  private resolveInflightRequest(config: AxiosRequestConfig | undefined, response: AxiosResponse): void {
    if (!config) {
      return;
    }

    const trackingId = this.getOrAssignTrackingId(config);
    const leaderKey = this.inflightLeaders.get(trackingId);

    if (!leaderKey) {
      return;
    }

    const inflightEntry = this.inflightRequests.get(leaderKey);

    if (inflightEntry) {
      inflightEntry.resolve(response);
      this.inflightRequests.delete(leaderKey);
    }

    this.inflightLeaders.delete(trackingId);
  }

  private rejectInflightRequest(config: AxiosRequestConfig, error: unknown): void {
    const trackingId = this.getOrAssignTrackingId(config);
    const leaderKey = this.inflightLeaders.get(trackingId);

    if (!leaderKey) {
      return;
    }

    const inflightEntry = this.inflightRequests.get(leaderKey);

    if (inflightEntry) {
      inflightEntry.reject(error);
      this.inflightRequests.delete(leaderKey);
    }

    this.inflightLeaders.delete(trackingId);
  }
}
