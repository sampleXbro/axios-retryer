import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import type { AxiosRetryerHttpMethod } from '../../../types';

export type MaybePromise<T> = T | Promise<T>;

/**
 * Represents a cached item containing the AxiosResponse and the timestamp it was cached.
 */
export interface CachedItem {
  response: AxiosResponse<unknown>;
  timestamp: number;
  ttr?: number;
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

/**
 * Options for the CachingPlugin.
 */
export interface CachingPluginOptions {
  /**
   * Response header names that are stripped before a response is written to the cache.
   * This prevents sensitive per-user or session-establishing headers (e.g. `Set-Cookie`)
   * from being replayed to different callers who receive a cached response.
   *
   * Matching is case-insensitive.
   *
   * @default ['set-cookie']
   */
  sensitiveResponseHeaders?: readonly string[];

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

  /**
   * Maximum byte size of a response body (measured via `JSON.stringify` length) that
   * will be written to the cache. Responses whose serialized body exceeds this limit
   * are served normally but not stored.
   *
   * Use this to prevent a single large response from consuming excessive memory.
   * Set to `0` to disable the check (no limit).
   *
   * @default 0
   */
  maxEntrySize?: number;
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
