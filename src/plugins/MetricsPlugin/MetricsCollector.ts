import type { AxiosError } from 'axios';

import type { AxiosRetryerDetailedMetrics, AxiosRetryerMetrics, AxiosRetryerRequestPriority, MetricsRecorder } from '../../types';

const initialPriorityMetrics = {
  total: 0,
  successes: 0,
  failures: 0,
};

const METRIC_WINDOW_MS = 5 * 60 * 1000;

type DurationSample = {
  timestamp: number;
  durationMs: number;
};

export class MetricsCollector implements MetricsRecorder {
  private queueWaitHistory: DurationSample[] = [];
  private retryDelayHistory: DurationSample[] = [];

  constructor(private readonly getMetricsState: () => AxiosRetryerMetrics) {}

  public recordRequestStart(priority: AxiosRetryerRequestPriority): void {
    const metrics = this.getMetricsState();
    metrics.totalRequests++;
    metrics.requestCountsByPriority[priority] = (metrics.requestCountsByPriority[priority] ?? 0) + 1;
  }

  public recordQueueWait(durationMs: number): void {
    this.getMetricsState().queueWaitDuration += durationMs;
    this.recordDuration(this.queueWaitHistory, durationMs);
  }

  public recordRetrySuccess(priority: AxiosRetryerRequestPriority): void {
    const metrics = this.getMetricsState();
    metrics.successfulRetries++;
    this.getPriorityMetrics(priority).successes++;
  }

  public recordRetryFailure(priority: AxiosRetryerRequestPriority, error: AxiosError): void {
    const metrics = this.getMetricsState();
    metrics.failedRetries++;

    if (!error.response) {
      metrics.errorTypes.network++;
    } else if (error.response.status >= 500) {
      metrics.errorTypes.server5xx++;
    } else if (error.response.status >= 400) {
      metrics.errorTypes.client4xx++;
    }

    this.getPriorityMetrics(priority).failures++;
  }

  public recordRetryAttempt(attempt: number, priority: AxiosRetryerRequestPriority): void {
    const metrics = this.getMetricsState();
    metrics.retryAttemptsDistribution[attempt] = (metrics.retryAttemptsDistribution[attempt] ?? 0) + 1;
    this.getPriorityMetrics(priority).total++;
  }

  public recordRetryDelay(durationMs: number): void {
    this.getMetricsState().retryDelayDuration += durationMs;
    this.recordDuration(this.retryDelayHistory, durationMs);
  }

  public reset(): void {
    const metrics = this.getMetricsState();
    metrics.totalRequests = 0;
    metrics.successfulRetries = 0;
    metrics.failedRetries = 0;
    metrics.completelyFailedRequests = 0;
    metrics.canceledRequests = 0;
    metrics.completelyFailedCriticalRequests = 0;
    metrics.errorTypes = {
      network: 0,
      server5xx: 0,
      client4xx: 0,
      cancelled: 0,
    };
    metrics.retryAttemptsDistribution = {};
    metrics.requestCountsByPriority = {};
    metrics.retryPrioritiesDistribution = {};
    metrics.queueWaitDuration = 0;
    metrics.retryDelayDuration = 0;

    this.queueWaitHistory = [];
    this.retryDelayHistory = [];
  }

  public recordCancellation(includeErrorType = false): void {
    const metrics = this.getMetricsState();
    metrics.canceledRequests++;

    if (includeErrorType) {
      metrics.errorTypes.cancelled++;
    }
  }

  public recordTerminalFailure(isCritical: boolean): void {
    const metrics = this.getMetricsState();
    metrics.completelyFailedRequests++;

    if (isCritical) {
      metrics.completelyFailedCriticalRequests++;
    }
  }

  public buildDetailedMetrics(timerStats: { activeTimers: number; activeRetryTimers: number }): AxiosRetryerDetailedMetrics {
    const metrics = this.getMetricsState();
    const totalRetries = metrics.failedRetries + metrics.successfulRetries;
    this.pruneDurationHistory(this.queueWaitHistory);
    this.pruneDurationHistory(this.retryDelayHistory);

    return {
      totalRequests: metrics.totalRequests,
      successfulRetries: metrics.successfulRetries,
      failedRetries: metrics.failedRetries,
      completelyFailedRequests: metrics.completelyFailedRequests,
      canceledRequests: metrics.canceledRequests,
      completelyFailedCriticalRequests: metrics.completelyFailedCriticalRequests,
      errorTypesDistribution: metrics.errorTypes,
      retryAttemptsDistribution: metrics.retryAttemptsDistribution as Record<number, number>,
      requestCountsByPriority: metrics.requestCountsByPriority as Record<number, number>,
      avgQueueWait: this.getWindowAverage(this.queueWaitHistory),
      avgRetryDelay: totalRetries > 0 ? this.getWindowAverage(this.retryDelayHistory) : 0,
      priorityMetrics: Object.entries(metrics.retryPrioritiesDistribution).map(([priority, data]) => ({
        priority: Number(priority),
        ...data,
        successRate: data.total > 0 ? (data.successes / data.total) * 100 : 0,
        failureRate: data.total > 0 ? (data.failures / data.total) * 100 : 0,
      })),
      timerHealth: {
        activeTimers: timerStats.activeTimers,
        activeRetryTimers: timerStats.activeRetryTimers,
        healthScore: timerStats.activeTimers + (timerStats.activeRetryTimers * 2),
      },
    };
  }

  private getPriorityMetrics(priority: AxiosRetryerRequestPriority): { total: number; successes: number; failures: number } {
    const metrics = this.getMetricsState();

    if (!metrics.retryPrioritiesDistribution[priority]) {
      metrics.retryPrioritiesDistribution[priority] = { ...initialPriorityMetrics };
    }

    return metrics.retryPrioritiesDistribution[priority];
  }

  private recordDuration(history: DurationSample[], durationMs: number): void {
    history.push({
      timestamp: Date.now(),
      durationMs,
    });
    this.pruneDurationHistory(history);
  }

  private pruneDurationHistory(history: DurationSample[]): void {
    const cutoff = Date.now() - METRIC_WINDOW_MS;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
  }

  private getWindowAverage(history: DurationSample[]): number {
    if (history.length === 0) {
      return 0;
    }

    const totalDuration = history.reduce((sum, sample) => sum + sample.durationMs, 0);
    return (totalDuration / history.length) * 0.001;
  }
}
