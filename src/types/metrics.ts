/**
 * AxiosRetryer metrics
 * */
export interface AxiosRetryerMetrics {
  totalRequests: number;
  successfulRetries: number;
  failedRetries: number;
  completelyFailedRequests: number;
  canceledRequests: number;
  completelyFailedCriticalRequests: number;
  errorTypes: {
    network: number;
    server5xx: number;
    client4xx: number;
    cancelled: number;
  };
  retryAttemptsDistribution: Record<string, number>;
  requestCountsByPriority: Record<string, number>;
  retryPrioritiesDistribution: Record<string, { total: number; successes: number; failures: number }>;
  queueWaitDuration: number;
  retryDelayDuration: number;
}

/**
 * Represents the distribution of different error types encountered
 */
interface ErrorTypesDistribution {
  /** Number of network-related errors (e.g., connection failures) */
  network: number;
  /** Number of 5xx server errors */
  server5xx: number;
  /** Number of 4xx client errors */
  client4xx: number;
  /** Number of canceled requests */
  cancelled: number;
}

/**
 * Represents metrics for a specific request priority level
 */
interface PriorityMetrics {
  /** The priority level (higher numbers indicate higher priority) */
  priority: number;
  /** Total number of retry attempts for this priority */
  total: number;
  /** Number of successful retries for this priority */
  successes: number;
  /** Number of failed retries for this priority */
  failures: number;
  /** Success rate percentage for this priority (0-100) */
  successRate: number;
  /** Failure rate percentage for this priority (0-100) */
  failureRate: number;
}

/**
 * AxiosRetryer detailed metrics
 * */
export interface AxiosRetryerDetailedMetrics {
  /** Total number of requests made through the retryer */
  totalRequests: number;
  /** Number of successfully completed retries */
  successfulRetries: number;
  /** Number of failed retry attempts */
  failedRetries: number;
  /** Requests that failed all retry attempts */
  completelyFailedRequests: number;
  /** Requests canceled before completion */
  canceledRequests: number;
  /** Critical priority requests that failed all retries */
  completelyFailedCriticalRequests: number;
  /** Distribution of error types encountered */
  errorTypesDistribution: ErrorTypesDistribution;
  /** Distribution of retry attempts across all requests */
  retryAttemptsDistribution: Record<number, number>;
  /** Count of requests by priority level */
  requestCountsByPriority: Record<number, number>;
  /** Average time spent in queue (seconds) */
  avgQueueWait: number;
  /** Average delay between retry attempts (seconds) */
  avgRetryDelay: number;
  /** Detailed metrics grouped by request priority */
  priorityMetrics: PriorityMetrics[];
  /** Timer health and accumulation metrics */
  timerHealth: {
    /** Number of active internal timers */
    activeTimers: number;
    /** Number of active retry timers */
    activeRetryTimers: number;
    /** Health score (0 = excellent, 100+ = potential issues) */
    healthScore: number;
  };
}

/**
 * Interface for pluggable metrics recording.
 * The core library ships with no-op metrics by default.
 * Use MetricsPlugin for full metrics collection.
 */
export interface MetricsRecorder {
  reset(): void;
  buildDetailedMetrics(timerStats: { activeTimers: number; activeRetryTimers: number }): AxiosRetryerDetailedMetrics;
  emitMetricsUpdated?(): void;
}
