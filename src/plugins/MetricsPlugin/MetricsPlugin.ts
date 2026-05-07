'use strict';

import type { AxiosError, AxiosRequestConfig } from 'axios';

import type {
  AxiosRetryerDetailedMetrics,
  AxiosRetryerMetrics,
  AxiosRetryerRequestDispatchedEvent,
  AxiosRetryerRequestQueuedEvent,
  MetricsRecorder,
  PluginContext,
  RetryPlugin,
} from '../../types';
import { getRequestMetadata } from '../../utils/requestMetadata';
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

  // Stored listener references so onBeforeDestroyed can unregister them.
  private readonly onRequestQueuedListener: (payload: AxiosRetryerRequestQueuedEvent) => void;
  private readonly onRequestDispatchedListener: (payload: AxiosRetryerRequestDispatchedEvent) => void;
  private readonly onRequestCancelledListener: (requestId: string) => void;
  private readonly beforeRetryListener: (config: AxiosRequestConfig) => void;
  private readonly afterRetryListener: (config: AxiosRequestConfig, success: boolean, error?: AxiosError) => void;
  private readonly onRetryScheduledListener: (delayMs: number, config: AxiosRequestConfig) => void;
  private readonly onFailureListener: (config: AxiosRequestConfig) => void;
  private readonly onBlockingRequestFailedListener: (config: AxiosRequestConfig) => void;
  private readonly onRequestSucceededListener: () => void;

  constructor() {
    this.onRequestQueuedListener = (payload) => {
      this.collector.recordRequestStart(payload.priority);
      this.emitMetricsUpdated();
    };

    this.onRequestDispatchedListener = (payload) => {
      this.collector.recordQueueWait(payload.queuedForMs);
      this.emitMetricsUpdated();
    };

    this.onRequestCancelledListener = (_requestId) => {
      this.collector.recordCancellation(true);
      this.emitMetricsUpdated();
    };

    this.beforeRetryListener = (config) => {
      const meta = getRequestMetadata(config);
      const priority = meta?.priority ?? 1;
      const attempt = meta?.retryAttempt ?? 1;
      this.collector.recordRetryAttempt(attempt, priority);
      this.emitMetricsUpdated();
    };

    this.afterRetryListener = (config, success, error) => {
      const priority = getRequestMetadata(config)?.priority ?? 1;
      if (success) {
        this.collector.recordRetrySuccess(priority);
      } else if (error) {
        this.collector.recordRetryFailure(priority, error);
      }
      this.emitMetricsUpdated();
    };

    this.onRetryScheduledListener = (delayMs) => {
      this.collector.recordRetryDelay(delayMs);
      this.emitMetricsUpdated();
    };

    this.onFailureListener = (_config) => {
      this.collector.recordTerminalFailure(false);
      this.emitMetricsUpdated();
    };

    this.onBlockingRequestFailedListener = (_config) => {
      this.collector.recordTerminalFailure(true);
      this.emitMetricsUpdated();
    };

    this.onRequestSucceededListener = () => {
      this.emitMetricsUpdated();
    };
  }

  public initialize(context: PluginContext<MetricsPluginEvents>): void {
    this.context = context;
    context.registerMetricsRecorder(this.recorder);

    context.on('onRequestQueued', this.onRequestQueuedListener);
    context.on('onRequestDispatched', this.onRequestDispatchedListener);
    context.on('onRequestCancelled', this.onRequestCancelledListener);
    context.on('beforeRetry', this.beforeRetryListener);
    context.on('afterRetry', this.afterRetryListener);
    context.on('onRetryScheduled', this.onRetryScheduledListener);
    context.on('onFailure', this.onFailureListener);
    context.on('onBlockingRequestFailed', this.onBlockingRequestFailedListener);
    context.on('onRequestSucceeded', this.onRequestSucceededListener);
  }

  public onBeforeDestroyed(context: PluginContext<MetricsPluginEvents>): void {
    context.off('onRequestQueued', this.onRequestQueuedListener);
    context.off('onRequestDispatched', this.onRequestDispatchedListener);
    context.off('onRequestCancelled', this.onRequestCancelledListener);
    context.off('beforeRetry', this.beforeRetryListener);
    context.off('afterRetry', this.afterRetryListener);
    context.off('onRetryScheduled', this.onRetryScheduledListener);
    context.off('onFailure', this.onFailureListener);
    context.off('onBlockingRequestFailed', this.onBlockingRequestFailedListener);
    context.off('onRequestSucceeded', this.onRequestSucceededListener);
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
