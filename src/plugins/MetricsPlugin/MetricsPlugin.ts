'use strict';

import type {
  AxiosRetryerDetailedMetrics,
  AxiosRetryerMetrics,
  MetricsRecorder,
  PluginContext,
  RetryPlugin,
} from '../../types';
import { createInitialMetrics, EMPTY_TIMER_STATS } from './configs';
import { MetricsCollector } from './managers';
import type { MetricsPluginEvents } from './types';

export type { MetricsPluginEvents } from './types';

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
  public readonly _events?: Readonly<MetricsPluginEvents>;

  private context: PluginContext<MetricsPluginEvents> | null = null;
  private metrics: AxiosRetryerMetrics = createInitialMetrics();
  private collector: MetricsCollector = new MetricsCollector(() => this.metrics);
  private readonly recorder: MetricsRecorder = {
    reset: () => this.collector.reset(),
    buildDetailedMetrics: (timerStats) => this.collector.buildDetailedMetrics(timerStats),
    emitMetricsUpdated: () => this.emitMetricsUpdated(),
  };

  public initialize(context: PluginContext<MetricsPluginEvents>): void {
    this.context = context;
    context.registerMetricsRecorder(this.recorder);

    context.on('onRequestQueued', (payload) => {
      this.collector.recordRequestStart(payload.priority);
      this.emitMetricsUpdated();
    });

    context.on('onRequestDispatched', (payload) => {
      this.collector.recordQueueWait(payload.queuedForMs);
      this.emitMetricsUpdated();
    });

    context.on('onRequestCancelled', (_requestId) => {
      this.collector.recordCancellation(true);
      this.emitMetricsUpdated();
    });

    context.on('beforeRetry', (config) => {
      const priority = config.__axiosRetryer?.priority ?? 1; // MEDIUM priority as default
      const attempt = config.__axiosRetryer?.retryAttempt ?? 1;
      this.collector.recordRetryAttempt(attempt, priority);
      this.emitMetricsUpdated();
    });

    context.on('afterRetry', (config, success, error) => {
      const priority = config.__axiosRetryer?.priority ?? 1;
      if (success) {
        this.collector.recordRetrySuccess(priority);
      } else if (error) {
        this.collector.recordRetryFailure(priority, error);
      }
      this.emitMetricsUpdated();
    });

    context.on('onRetryScheduled', (delayMs) => {
      this.collector.recordRetryDelay(delayMs);
      this.emitMetricsUpdated();
    });

    context.on('onFailure', (_config) => {
      this.collector.recordTerminalFailure(false);
      this.emitMetricsUpdated();
    });

    context.on('onBlockingRequestFailed', (_config) => {
      this.collector.recordTerminalFailure(true);
      this.emitMetricsUpdated();
    });

    context.on('onRequestSucceeded', () => {
      this.emitMetricsUpdated();
    });
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
