'use strict';

import type { AxiosRetryerMetrics, RetryPlugin } from '../../types';
import type { RetryManager } from '../../core/RetryManager';
import { MetricsCollector } from './MetricsCollector';

const createInitialMetrics = (): AxiosRetryerMetrics => ({
  totalRequests: 0,
  successfulRetries: 0,
  failedRetries: 0,
  completelyFailedRequests: 0,
  canceledRequests: 0,
  completelyFailedCriticalRequests: 0,
  errorTypes: {
    network: 0,
    server5xx: 0,
    client4xx: 0,
    cancelled: 0,
  },
  retryAttemptsDistribution: {},
  retryPrioritiesDistribution: {},
  requestCountsByPriority: {},
  queueWaitDuration: 0,
  retryDelayDuration: 0,
});

/**
 * Plugin that enables detailed metrics collection for the RetryManager.
 *
 * Without this plugin, `getMetrics()` returns empty/zero metrics.
 * Install this plugin to track request counts, retry distributions,
 * error types, queue wait times, and priority breakdowns.
 *
 * @example
 * ```typescript
 * import { MetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';
 *
 * const metricsPlugin = new MetricsPlugin();
 * manager.use(metricsPlugin);
 *
 * // Later: read collected metrics
 * const metrics = manager.getMetrics();
 * ```
 */
export class MetricsPlugin implements RetryPlugin {
  public name = 'MetricsPlugin';
  public version = '1.0.0';

  private metrics: AxiosRetryerMetrics = createInitialMetrics();
  private collector: MetricsCollector = new MetricsCollector(() => this.metrics);

  public initialize(manager: RetryManager): void {
    manager.registerMetricsRecorder(this.collector);
  }

  public onBeforeDestroyed(manager: RetryManager): void {
    manager.registerMetricsRecorder(null);
  }
}
