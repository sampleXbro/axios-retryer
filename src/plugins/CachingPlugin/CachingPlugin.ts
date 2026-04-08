'use strict';

import type { AxiosError, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import type { AxiosRetryerHttpMethod, RetryPlugin } from '../../types';
import { AXIOS_RETRYER_HTTP_METHODS } from '../../types';
import { RetryerConfigError } from '../../core/errors/RetryerConfigError';
import type { PluginContext } from '../../types';
import { cloneValue } from '../../utils/clone';
import { ensureRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';
import { InvalidCacheKeyError } from './InvalidCacheKeyError';

type MaybePromise<T> = T | Promise<T>;

/**
 * Represents a cached item containing the AxiosResponse and the timestamp it was cached.
 */
export interface CachedItem {
  response: AxiosResponse<unknown>;
  timestamp: number;
  ttr?: number; // Custom TTR for this cache entry
  lastAccessedAt?: number;
}

export interface CacheStorageEntry {
  readonly key: string;
  readonly value: CachedItem;
}

export interface CacheStorage {
  get(key: string): MaybePromise<CachedItem | undefined>;
  set(key: string, value: CachedItem): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  clear(): MaybePromise<void>;
  /**
   * Returns the adapter's full cache index.
   * Cleanup and non-exact invalidation operate on this index.
   */
  entries(): MaybePromise<readonly CacheStorageEntry[]>;
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

  public entries(): readonly CacheStorageEntry[] {
    return Array.from(this.storage, ([key, value]) => ({ key, value }));
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

function fingerprintValue(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `fp_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function compareStringTuples(
  [leftKey, leftValue]: readonly [string, string],
  [rightKey, rightValue]: readonly [string, string],
): number {
  return leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue);
}

function normalizeUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');

  if (queryIndex === -1) {
    return withoutHash;
  }

  const pathname = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);
  if (!query) {
    return pathname;
  }

  const entries = Array.from(new URLSearchParams(query).entries()).sort(compareStringTuples);
  if (entries.length === 0) {
    return pathname;
  }

  const normalizedQuery = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `${pathname}?${normalizedQuery}`;
}

function normalizeValue(value: unknown, lowercaseKeys = false): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return Array.from(value.entries()).sort(compareStringTuples);
  }

  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([key, entryValue]) => [String(key), normalizeValue(entryValue, lowercaseKeys)] as const)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  }

  if (value instanceof Set) {
    return Array.from(value.values()).map((entryValue) => normalizeValue(entryValue, lowercaseKeys));
  }

  if (Array.isArray(value)) {
    return value.map((entryValue) => normalizeValue(entryValue, lowercaseKeys));
  }

  if (typeof value === 'object') {
    const objectValue =
      typeof (value as { toJSON?: () => unknown }).toJSON === 'function'
        ? (value as { toJSON: () => unknown }).toJSON()
        : value;

    if (objectValue !== value) {
      return normalizeValue(objectValue, lowercaseKeys);
    }

    const normalizedObject: Record<string, unknown> = {};
    Object.entries(objectValue as Record<string, unknown>)
      .map(
        ([key, entryValue]) =>
          [lowercaseKeys ? key.toLowerCase() : key, normalizeValue(entryValue, lowercaseKeys)] as const,
      )
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .forEach(([key, entryValue]) => {
        normalizedObject[key] = entryValue;
      });

    return normalizedObject;
  }

  return String(value);
}

function stableStringify(value: unknown, lowercaseKeys = false): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(normalizeValue(JSON.parse(trimmed), lowercaseKeys));
      } catch (_error) {
        // Fall through and treat invalid JSON-like strings as plain strings.
      }
    }

    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(normalizeValue(value, lowercaseKeys));
}

/**
 * Options for the CachingPlugin.
 */
/**
 * Header names that indicate authenticated or personalized traffic.
 * Requests carrying any of these headers are excluded from caching by default
 * to prevent cross-principal cache collisions.
 */
const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-auth-token', 'x-api-key']);

function requestHasAuthHeaders(config: AxiosRequestConfig): boolean {
  if (!config.headers) {
    return false;
  }

  for (const key of Object.keys(config.headers)) {
    if (AUTH_HEADERS.has(key.toLowerCase())) {
      return true;
    }
  }

  return false;
}

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
   * Indexed storage backend used for cache entries.
   * Custom adapters must implement `entries()` so cleanup and invalidation can
   * operate on the adapter's source of truth after restart or across processes.
   * Defaults to the built-in in-memory storage.
   */
  storage?: CacheStorage;

  /**
   * If true, concurrent identical cacheable requests share the same in-flight response.
   * @default true
   */
  dedupeConcurrentRequests?: boolean;

  /**
   * Allows custom cache key composition from canonical request parts.
   * The default builder uses normalized method, URL, params, body, and optional headers.
   */
  cacheKeyBuilder?: CacheKeyBuilder;

  /**
   * When true, requests carrying authentication headers (Authorization, Cookie,
   * Proxy-Authorization, X-Auth-Token, X-API-Key) are excluded from caching.
   * This prevents cross-principal cache collisions on shared retryer instances.
   *
   * Set to `false` only for legitimate shared-cache use cases where all
   * principals should receive the same cached response.
   *
   * @default true
   */
  skipWhenAuthPresent?: boolean;

  /**
   * Header names whose values are folded into the cache key, binding each
   * cache entry to the identity or context carried by those headers.
   *
   * Use this instead of (or together with) `skipWhenAuthPresent: false`
   * when you need per-principal caching rather than skipping the cache entirely.
   *
   * Header name matching is case-insensitive.
   *
   * @default []
   *
   * @example
   * ```ts
   * // Cache responses per-user based on their Authorization header:
   * new CachingPlugin({ skipWhenAuthPresent: false, varyHeaders: ['Authorization'] });
   * ```
   */
  varyHeaders?: readonly string[];
}

export interface CachingRequestOptions {
  cache?: boolean;
  ttr?: number;
}

export interface CacheKeyBuilderContext {
  readonly config: AxiosRequestConfig;
  readonly method: string;
  readonly normalizedUrl: string;
  readonly normalizedParams: string;
  readonly normalizedData: string;
  readonly normalizedHeaders: string;
}

export type CacheKeyBuilder = (context: CacheKeyBuilderContext) => string;

export interface CachingPluginEvents {
  onCacheHit?: (payload: { keyFingerprint: string; config: AxiosRequestConfig; ageMs: number }) => void;
  onCacheMiss?: (payload: { keyFingerprint: string; config: AxiosRequestConfig; reason: 'empty' | 'stale' }) => void;
  onCacheInvalidated?: (payload: { count: number; matcher: 'all' | 'custom' }) => void;
}

export type CacheInvalidationMatcher =
  | string
  | RegExp
  | {
      exact: string;
    }
  | {
      prefix: string;
    };

function buildDefaultCacheKey(context: CacheKeyBuilderContext): string {
  return [
    context.method,
    context.normalizedUrl,
    context.normalizedParams,
    context.normalizedData,
    context.normalizedHeaders,
  ].join('|');
}

function getCacheEntryAccessTimestamp(cachedItem: CachedItem): number {
  return cachedItem.lastAccessedAt ?? cachedItem.timestamp;
}

function sortCacheEntriesByAccess(entries: readonly CacheStorageEntry[]): CacheStorageEntry[] {
  return [...entries].sort(
    (left, right) =>
      getCacheEntryAccessTimestamp(left.value) - getCacheEntryAccessTimestamp(right.value) ||
      left.key.localeCompare(right.key),
  );
}

function createCachedResponseSnapshot(response: AxiosResponse<unknown>): AxiosResponse<unknown> {
  return {
    config: {} as AxiosRequestConfig,
    data: cloneValue(response.data),
    headers: cloneValue(response.headers),
    status: response.status,
    statusText: response.statusText,
  } as AxiosResponse<unknown>;
}

function cloneAxiosResponse(
  response: Pick<AxiosResponse<unknown>, 'data' | 'headers' | 'status' | 'statusText'>,
  config: AxiosRequestConfig,
): AxiosResponse<unknown> {
  return {
    config: config as AxiosRequestConfig,
    data: cloneValue(response.data),
    headers: cloneValue(response.headers),
    status: response.status,
    statusText: response.statusText,
  } as AxiosResponse<unknown>;
}

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
      cacheKeyBuilder: options?.cacheKeyBuilder ?? buildDefaultCacheKey,
      skipWhenAuthPresent: true,
      varyHeaders: [],
      ...options,
    };
    this.storage = this.options.storage;

    if (!Number.isInteger(this.options.cleanupInterval) || this.options.cleanupInterval < 0) {
      throw new RetryerConfigError(
        'cleanupInterval must be a non-negative integer',
        'cleanupInterval',
        this.options.cleanupInterval,
      );
    }
    if (!Number.isInteger(this.options.maxAge) || this.options.maxAge < 0) {
      throw new RetryerConfigError('maxAge must be a non-negative integer', 'maxAge', this.options.maxAge);
    }
    if (!Number.isInteger(this.options.maxItems) || this.options.maxItems < 0) {
      throw new RetryerConfigError('maxItems must be a non-negative integer', 'maxItems', this.options.maxItems);
    }
    if (!Number.isInteger(this.options.timeToRevalidate) || this.options.timeToRevalidate < 0) {
      throw new RetryerConfigError(
        'timeToRevalidate must be a non-negative integer',
        'timeToRevalidate',
        this.options.timeToRevalidate,
      );
    }
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
  }

  private getCacheKeyFingerprint(cacheKey: string): string {
    return fingerprintValue(cacheKey);
  }

  private describeInvalidationMatcher(matcher: CacheInvalidationMatcher): {
    type: 'exact' | 'prefix' | 'regexp';
    fingerprint: string;
  } {
    if (matcher instanceof RegExp) {
      return {
        type: 'regexp',
        fingerprint: fingerprintValue(String(matcher)),
      };
    }

    if (typeof matcher === 'string') {
      return {
        type: 'exact',
        fingerprint: fingerprintValue(matcher),
      };
    }

    return {
      type: 'exact' in matcher ? 'exact' : 'prefix',
      fingerprint: fingerprintValue('exact' in matcher ? matcher.exact : matcher.prefix),
    };
  }

  private getErrorMeta(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return { errorName: error.name };
    }

    return {};
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
          ...this.getErrorMeta(error),
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
        this.servedFromCache.add(config);
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
      this.inflightFollowers.set(config, cacheKey);
      this.context.getLogger()?.debug('[CachingPlugin] Piggybacking on in-flight request', {
        cacheKeyFingerprint,
      });
      return {
        ...config,
        adapter: async () => cloneAxiosResponse(await inflightEntry.promise, config) as never,
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

      try {
        this.context.getLogger()?.debug('[CachingPlugin] Caching response', {
          cacheKeyFingerprint,
          ...(ttr ? { ttrMs: ttr } : {}),
        });

        await this.upsertCacheEntry(cacheKey, {
          response: createCachedResponseSnapshot(response),
          timestamp: Date.now(),
          ttr,
          lastAccessedAt: Date.now(),
        });
      } catch (error) {
        this.context.getLogger()?.warn('[CachingPlugin] Failed to cache response', {
          cacheKeyFingerprint,
          ...this.getErrorMeta(error),
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
      this.inflightFollowers.delete(error.config);
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
        this.context.getLogger()?.warn('[CachingPlugin] Failed to run cache cleanup', this.getErrorMeta(error));
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
        return; // Updating an existing entry — no capacity change.
      }
      if (this.cache.size < this.options.maxItems) {
        return; // Capacity available — no eviction needed.
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
        ...this.getErrorMeta(error),
      });
    }
  }

  private invalidateCacheEntries(
    matcher: CacheInvalidationMatcher,
    indexedEntries: readonly CacheStorageEntry[],
  ): number | Promise<number> {
    this.syncLocalCache(indexedEntries);

    const keysToRemove = indexedEntries
      .filter(({ key }) => this.matchesInvalidationMatcher(key, matcher))
      .map(({ key }) => key);

    if (keysToRemove.length === 0) {
      return 0;
    }

    const deleteOperations = keysToRemove.map((key) => this.deleteCacheEntry(key));
    const finalize = (): number => {
      this.context.getLogger()?.debug('[CachingPlugin] Invalidated cache entries', {
        count: keysToRemove.length,
        matcher: this.describeInvalidationMatcher(matcher),
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
    let normalizedHeaders: string;

    if (this.options.compareHeaders && config.headers) {
      normalizedHeaders = stableStringify(config.headers, true);
    } else if (this.options.varyHeaders.length > 0 && config.headers) {
      const varySet = new Set(this.options.varyHeaders.map((h) => h.toLowerCase()));
      const varyEntries: [string, string][] = [];

      for (const key of Object.keys(config.headers)) {
        if (varySet.has(key.toLowerCase())) {
          varyEntries.push([key.toLowerCase(), String(config.headers[key])]);
        }
      }

      varyEntries.sort(compareStringTuples);
      normalizedHeaders = varyEntries.length > 0 ? JSON.stringify(varyEntries) : '';
    } else {
      normalizedHeaders = '';
    }

    return {
      config,
      method: (config.method || AXIOS_RETRYER_HTTP_METHODS.GET).toUpperCase(),
      normalizedUrl: normalizeUrl(config.url ?? ''),
      normalizedParams: stableStringify(config.params),
      normalizedData: stableStringify(config.data),
      normalizedHeaders,
    };
  }

  private matchesInvalidationMatcher(key: string, matcher: CacheInvalidationMatcher): boolean {
    if (matcher instanceof RegExp) {
      return matcher.test(key);
    }

    if (typeof matcher === 'string') {
      return key === matcher;
    }

    if ('exact' in matcher) {
      return key === matcher.exact;
    }

    return key.startsWith(matcher.prefix);
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
