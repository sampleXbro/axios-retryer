'use strict';

import type {
  AxiosRetryerDetailedMetrics,
  AxiosRetryerMetrics,
  MetricsRecorder,
  PluginContext,
  RetryPlugin,
} from '../../types';
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

const EMPTY_TIMER_STATS = {
  activeTimers: 0,
  activeRetryTimers: 0,
};

export interface MetricsPluginEvents {
  onMetricsUpdated?: (metrics: AxiosRetryerDetailedMetrics) => void;
}

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
export class MetricsPlugin implements RetryPlugin<MetricsPluginEvents> {
  public name = 'MetricsPlugin';
  public version = '1.0.0';

  private context: PluginContext<MetricsPluginEvents> | null = null;
  private metrics: AxiosRetryerMetrics = createInitialMetrics();
  private collector: MetricsCollector = new MetricsCollector(() => this.metrics);
  private readonly recorder: MetricsRecorder = {
    recordRequestStart: (priority) => this.collector.recordRequestStart(priority),
    recordQueueWait: (durationMs) => this.collector.recordQueueWait(durationMs),
    recordRetrySuccess: (priority) => this.collector.recordRetrySuccess(priority),
    recordRetryFailure: (priority, error) => this.collector.recordRetryFailure(priority, error),
    recordRetryAttempt: (attempt, priority) => this.collector.recordRetryAttempt(attempt, priority),
    recordRetryDelay: (durationMs) => this.collector.recordRetryDelay(durationMs),
    recordCancellation: (includeErrorType) => this.collector.recordCancellation(includeErrorType),
    recordTerminalFailure: (isCritical) => this.collector.recordTerminalFailure(isCritical),
    reset: () => this.collector.reset(),
    buildDetailedMetrics: (timerStats) => this.collector.buildDetailedMetrics(timerStats),
    emitMetricsUpdated: () => this.emitMetricsUpdated(),
  };

  public initialize(context: PluginContext<MetricsPluginEvents>): void {
    this.context = context;
    context.registerMetricsRecorder(this.recorder);
  }

  public onBeforeDestroyed(context: PluginContext<MetricsPluginEvents>): void {
    context.registerMetricsRecorder(null);
    this.context = null;
  }

  public getMetrics(): AxiosRetryerDetailedMetrics {
    return this.collector.buildDetailedMetrics(this.context?.getTimerStats() ?? EMPTY_TIMER_STATS);
  }

  public resetMetrics(): void {
    this.collector.reset();
    this.emitMetricsUpdated();
  }

  private emitMetricsUpdated(): void {
    if (!this.context) {
      return;
    }

    this.context.triggerAndEmit('onMetricsUpdated', this.getMetrics());
  }
}
