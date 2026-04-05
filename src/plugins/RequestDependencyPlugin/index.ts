export {
  RequestDependencyPlugin,
  type RequestDependencyPluginEvents,
  type RequestDependencyPluginOptions,
} from './RequestDependencyPlugin';

import { RequestDependencyPlugin, type RequestDependencyPluginOptions } from './RequestDependencyPlugin';

/**
 * Creates a RequestDependencyPlugin instance.
 * Functional alternative to using the `new RequestDependencyPlugin()` constructor.
 *
 * The request dependency plugin enables queue blocking based on request priority.
 * Requests at or above the threshold block lower-priority requests until resolved.
 *
 * @param options Configuration options for the RequestDependencyPlugin
 * @returns A configured RequestDependencyPlugin instance
 *
 * @example
 * ```typescript
 * import { AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';
 *
 * const dependencyPlugin = createRequestDependencyPlugin({
 *   blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
 *   cancelPendingOnDependencyFailure: true,
 * });
 *
 * manager.use(dependencyPlugin);
 * ```
 */
export function createRequestDependencyPlugin(options: RequestDependencyPluginOptions): RequestDependencyPlugin {
  return new RequestDependencyPlugin(options);
}
