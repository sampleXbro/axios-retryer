import 'axios';

export { CachingPlugin } from './CachingPlugin';
export { InvalidCacheKeyError } from './InvalidCacheKeyError';
export {
  InMemoryCacheStorage,
  type CacheInvalidationMatcher,
  type CacheKeyBuilder,
  type CacheKeyBuilderContext,
  type CacheStorageEntry,
  type CacheStorage,
  type CachedItem,
  type CachingPluginOptions,
  type CachingPluginEvents,
  type CachingRequestOptions,
} from './CachingPlugin';

import { CachingPlugin, type CachingPluginOptions, type CachingRequestOptions } from './CachingPlugin';

declare module 'axios' {
  interface AxiosRequestConfig {
    __cachingOptions?: CachingRequestOptions;
  }
}

/**
 * Creates a CachingPlugin instance.
 * Functional alternative to using the `new CachingPlugin()` constructor.
 *
 * The caching plugin stores responses from successful requests and returns them
 * for identical requests, reducing network traffic and improving performance.
 *
 * @param options Configuration options for the CachingPlugin
 * @returns A configured CachingPlugin instance
 * 
 * @example
 * ```typescript
 * import { AXIOS_RETRYER_HTTP_METHODS } from 'axios-retryer';
 *
 * const cachePlugin = createCachePlugin({
 *   timeToRevalidate: 60000,  // Cache responses for 60 seconds
 *   cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET], // Only cache GET requests
 *   cleanupInterval: 300000,  // Run cleanup every 5 minutes
 *   maxItems: 100,            // Store at most 100 responses
 *   compareHeaders: false     // Don't include headers in cache key
 * });
 * 
 * manager.use(cachePlugin);
 * ```
 */
export function createCachePlugin(options?: CachingPluginOptions): CachingPlugin {
  return new CachingPlugin(options);
}
