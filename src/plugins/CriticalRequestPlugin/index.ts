export { CriticalRequestPlugin, type CriticalRequestPluginOptions } from './CriticalRequestPlugin';

import { CriticalRequestPlugin, type CriticalRequestPluginOptions } from './CriticalRequestPlugin';

/**
 * Creates a CriticalRequestPlugin instance.
 * Functional alternative to using the `new CriticalRequestPlugin()` constructor.
 *
 * The critical request plugin enables queue blocking based on request priority.
 * Requests at or above the threshold block lower-priority requests until resolved.
 *
 * @param options Configuration options for the CriticalRequestPlugin
 * @returns A configured CriticalRequestPlugin instance
 *
 * @example
 * ```typescript
 * import { AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';
 *
 * const criticalPlugin = createCriticalRequestPlugin({
 *   blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
 *   cancelQueuedOnCriticalFailure: true,
 * });
 *
 * manager.use(criticalPlugin);
 * ```
 */
export function createCriticalRequestPlugin(options: CriticalRequestPluginOptions): CriticalRequestPlugin {
  return new CriticalRequestPlugin(options);
}
