export { ManualRetryPlugin, type ManualRetryPluginEvents, type ManualRetryPluginOptions } from './ManualRetryPlugin';
export type { RequestStore } from '../../types';

import { ManualRetryPlugin, type ManualRetryPluginOptions } from './ManualRetryPlugin';

/**
 * Creates a ManualRetryPlugin instance.
 * Functional alternative to using the `new ManualRetryPlugin()` constructor.
 *
 * The manual retry plugin stores failed requests and allows replaying them
 * later via `retryFailedRequests()`.
 *
 * @param options Configuration options for the ManualRetryPlugin
 * @returns A configured ManualRetryPlugin instance
 *
 * @example
 * ```typescript
 * const manualRetry = createManualRetryPlugin({
 *   manualRetryMaxAge: 60000,    // Discard requests older than 1 minute
 *   maxRequestsToStore: 100,     // Store at most 100 failed requests
 *   storeNonIdempotent: false,   // Only store idempotent requests
 * });
 *
 * manager.use(manualRetry);
 *
 * // Later:
 * const results = await manualRetry.retryFailedRequests();
 * ```
 */
export function createManualRetryPlugin(options?: ManualRetryPluginOptions): ManualRetryPlugin {
  return new ManualRetryPlugin(options);
}
