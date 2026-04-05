export { MetricsPlugin } from './MetricsPlugin';
export { MetricsCollector } from './MetricsCollector';
export type { MetricsPluginEvents } from './MetricsPlugin';
export type { MetricsRecorder } from '../../types';

import { MetricsPlugin } from './MetricsPlugin';

/**
 * Creates a MetricsPlugin instance.
 * Functional alternative to using the `new MetricsPlugin()` constructor.
 *
 * @returns A configured MetricsPlugin instance
 *
 * @example
 * ```typescript
 * import { createMetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';
 *
 * const metricsPlugin = createMetricsPlugin();
 * manager.use(metricsPlugin);
 * ```
 */
export function createMetricsPlugin(): MetricsPlugin {
  return new MetricsPlugin();
}
