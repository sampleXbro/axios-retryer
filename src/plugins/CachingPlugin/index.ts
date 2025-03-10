export { CachingPlugin } from './CachingPlugin';
export { type CachingPluginOptions } from './CachingPlugin';

import { CachingPlugin, type CachingPluginOptions } from './CachingPlugin';

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
 * const cachePlugin = createCachePlugin({
 *   timeToRevalidate: 60000,  // Cache responses for 60 seconds
 *   cacheMethods: ['GET'],    // Only cache GET requests
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