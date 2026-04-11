import { RetryerConfigError } from '../../../core/errors/RetryerConfigError';
import { AXIOS_RETRYER_HTTP_METHODS } from '../../../types';
import { InMemoryCacheStorage } from '../storage';
import type { CachingPluginOptions } from '../types';
import { buildDefaultCacheKey } from '../utils/key';

export function resolveCachingPluginOptions(options?: CachingPluginOptions): Required<CachingPluginOptions> {
  return {
    sensitiveResponseHeaders: ['set-cookie'],
    compareHeaders: false,
    timeToRevalidate: 0,
    cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET],
    cleanupInterval: 0,
    maxAge: 0,
    maxItems: 1000,
    maxEntrySize: 0,
    cacheOnlyRetriedRequests: false,
    storage: options?.storage ?? new InMemoryCacheStorage(),
    dedupeConcurrentRequests: true,
    cacheKeyBuilder: options?.cacheKeyBuilder ?? buildDefaultCacheKey,
    skipWhenAuthPresent: true,
    varyHeaders: [],
    ...options,
  };
}

export function validateCachingPluginOptions(options: Required<CachingPluginOptions>): void {
  if (!Number.isInteger(options.cleanupInterval) || options.cleanupInterval < 0) {
    throw new RetryerConfigError(
      'cleanupInterval must be a non-negative integer',
      'cleanupInterval',
      options.cleanupInterval,
    );
  }

  if (!Number.isInteger(options.maxAge) || options.maxAge < 0) {
    throw new RetryerConfigError('maxAge must be a non-negative integer', 'maxAge', options.maxAge);
  }

  if (!Number.isInteger(options.maxItems) || options.maxItems < 0) {
    throw new RetryerConfigError('maxItems must be a non-negative integer', 'maxItems', options.maxItems);
  }

  if (!Number.isInteger(options.maxEntrySize) || options.maxEntrySize < 0) {
    throw new RetryerConfigError('maxEntrySize must be a non-negative integer', 'maxEntrySize', options.maxEntrySize);
  }

  if (!Number.isInteger(options.timeToRevalidate) || options.timeToRevalidate < 0) {
    throw new RetryerConfigError(
      'timeToRevalidate must be a non-negative integer',
      'timeToRevalidate',
      options.timeToRevalidate,
    );
  }
}
