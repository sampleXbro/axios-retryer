import type { AxiosError, AxiosInstance, AxiosRequestConfig, Method } from 'axios';

import type { RetryManager } from '../core/RetryManager';

/**
 *  manual - After each request failure, Axios throws the rejected promise
 *  immediately to allow us to retry failed requests manually using {@link RetryManager.retryFailedRequests}
 *
 *  automatic - Automatic retry according to retry strategy and number of retries.
 *  After retires are completed we can retry the failed requests manually using {@link RetryManager.retryFailedRequests}
 * */

export const RETRY_MODES = {
  AUTOMATIC: 'automatic',
  MANUAL: 'manual',
} as const;

export type RetryMode = (typeof RETRY_MODES)[keyof typeof RETRY_MODES];

export const AXIOS_RETRYER_HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  PURGE: 'PURGE',
  LINK: 'LINK',
  UNLINK: 'UNLINK',
} as const;

export type AxiosRetryerHttpMethod = Method;

export const AXIOS_RETRYER_REQUEST_PRIORITIES = {
  CRITICAL: 4,
  HIGHEST: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
} as const;

export type AxiosRetryerRequestPriority =
  (typeof AXIOS_RETRYER_REQUEST_PRIORITIES)[keyof typeof AXIOS_RETRYER_REQUEST_PRIORITIES];

export const AXIOS_RETRYER_BACKOFF_TYPES = {
  STATIC: 0,
  LINEAR: 1,
  EXPONENTIAL: 2,
} as const;

export type AxiosRetryerBackoffType = (typeof AXIOS_RETRYER_BACKOFF_TYPES)[keyof typeof AXIOS_RETRYER_BACKOFF_TYPES];
export type AxiosRetryerStatusRange = readonly [number, number];
export type AxiosRetryerRetryableStatus = number | AxiosRetryerStatusRange;

export interface AxiosRetryerRequestMetadata {
  retryAttempt?: number;
  requestRetries?: number;
  requestMode?: RetryMode;
  requestId?: string;
  isRetrying?: boolean;
  priority?: AxiosRetryerRequestPriority;
  timestamp?: number;
  backoffType?: AxiosRetryerBackoffType;
  retryableStatuses?: readonly AxiosRetryerRetryableStatus[];
  isRetryRefreshRequest?: boolean;
  retryAfterMs?: number;
  cachingOptions?: {
    cache?: boolean;
    ttr?: number;
  };
}

export type RetryEventArgs<TEvents extends object, K extends keyof TEvents> =
  NonNullable<TEvents[K]> extends (...args: infer TArgs) => unknown ? TArgs : never;

export type RetryEventListener<TEvents extends object, K extends keyof TEvents> = (
  ...args: RetryEventArgs<TEvents, K>
) => void;

/**
 * Core events exposed by RetryManager without any plugins attached.
 */
export interface CoreRetryEvents {
  /**
   * Triggered when the retry process begins.
   */
  onRetryProcessStarted?: () => void;
  /**
   * Triggered when manual retry process begins.
   */
  onManualRetryProcessStarted?: () => void;
  /**
   * Triggered before each retry attempt.
   * @param config The Axios request configuration being retried.
   */
  beforeRetry?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered after a retry attempt.
   * @param config The Axios request configuration being retried.
   * @param success Whether the retry was successful.
   */
  afterRetry?: (config: AxiosRequestConfig, success: boolean) => void;

  /**
   * Triggered for each failed retry attempt.
   * @param config The failed Axios request configuration.
   */
  onFailure?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered when all retries are completed.
   * @param metrics Metrics about retry performance.
   */
  onRetryProcessFinished?: (metrics: AxiosRetryerDetailedMetrics) => void;

  /**
   * Triggered when a request is removed from the store due to storage limits.
   * @param request The removed Axios request configuration.
   */
  onRequestRemovedFromStore?: (request: AxiosRequestConfig) => void;

  /**
   * Triggered when a critical request fails.
   * A critical request is defined by {@link RetryManagerOptions.blockingQueueThreshold}.
   */
  onCriticalRequestFailed?: () => void;
  /**
   * Triggered when a request cancelled.
   * @param requestId Id of the cancelled request.
   */
  onRequestCancelled?: (requestId: string) => void;
  /**
   * Triggered when metrics updated.
   * @param metrics Axios Retryer metrics object.
   */
  onMetricsUpdated?: (metrics: AxiosRetryerDetailedMetrics) => void;
  /**
   * Triggered when all critical requests resolved.
   */
  onAllCriticalRequestsResolved?: () => void;
  /**
   * Triggered when internet connection error throw.
   */
  /**
   * Called when a request fails due to network or connection issues, meaning
   * no valid server response was received (e.g., user is offline).
   *
   * @param request - The Axios request config that encountered a connection error.
   */
  onInternetConnectionError?: (request: AxiosRequestConfig) => void;
}

/**
 * Events added by TokenRefreshPlugin.
 */
export interface TokenRefreshPluginEvents {
  /**
   * Called immediately after a new token is successfully obtained from the refresh flow.
   *
   * @param newToken - The newly acquired token string.
   */
  onTokenRefreshed?: (newToken: string) => void;

  /**
   * Called when all token refresh attempts have failed (e.g., server returned errors,
   * timed out, or other terminal conditions).
   */
  onTokenRefreshFailed?: () => void;

  /**
   * Called right before the token refresh process begins, allowing you to perform
   * any necessary logging, UI updates, or other side effects prior to refresh attempts.
   */
  onBeforeTokenRefresh?: () => void;
}

export type RetryManagerEvents<TPluginEvents extends object = {}> = {
  [K in keyof CoreRetryEvents | keyof TPluginEvents]:
    K extends keyof TPluginEvents
      ? K extends keyof CoreRetryEvents
        ? CoreRetryEvents[K] & TPluginEvents[K]
        : TPluginEvents[K]
      : K extends keyof CoreRetryEvents
        ? CoreRetryEvents[K]
        : never;
};

/**
 * Hooks to interact with RetryManager's lifecycle and states.
 */
type RetryLifecycleHooks = {
  /**
   * Called before each stored request is replayed during manual retry.
   * Return the (optionally modified) config to proceed, or `null` to skip this request.
   *
   * @param config - The stored request configuration about to be replayed.
   * @returns The config to use for replay, or `null` to skip.
   */
  beforeManualRetry?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
};

export type RetryHooks<TPluginEvents extends object = {}> = Partial<RetryManagerEvents<TPluginEvents>> & RetryLifecycleHooks;

export interface RetryManagerOptions<TPluginEvents extends object = {}> {
  /**
   * The mode of retrying requests.
   * - 'automatic': Automatically retry requests that meet the retry conditions.
   * - 'manual': No automatic retries; manual retries must be triggered.
   *
   * @default 'automatic'
   *
   * @example
   * mode: RETRY_MODES.AUTOMATIC
   * Requests will retry automatically if conditions are met.
   */
  mode?: RetryMode;

  /**
   * The maximum number of retries for requests in 'automatic' mode.
   *
   * @default 3
   *
   * @example
   * retries: 5
   * Requests will retry up to 5 times if retry conditions are met.
   */
  retries?: number;

  /**
   * Custom retry strategy implementation.
   * Provide your class implementing the `RetryStrategy` interface to define custom retry logic.
   *
   * @example
   * retryStrategy: new CustomRetryStrategy()
   */
  retryStrategy?: RetryStrategy;

  /**
   * Hooks to interact with the internal states of the RetryManager.
   * These hooks can be used to add custom behavior at different stages of the retry process.
   *
   * @example
   * hooks: {
   *   onRetryProcessStarted: () => console.log('Retry process started'),
   *   onFailure: (config) => console.log('Request failed', config),
   * }
   */
  hooks?: RetryHooks<TPluginEvents>;

  /**
   * Custom Axios instance to use for making requests.
   * If not provided, a default Axios instance is created.
   *
   * @example
   * axiosInstance: axios.create({ baseURL: 'https://api.example.com' })
   */
  axiosInstance?: AxiosInstance;

  /**
   * Whether to throw an error if all retry attempts fail.
   * If `true`, an error is thrown after the last retry fails.
   *
   * @default true
   *
   * @example
   * throwErrorOnFailedRetries: false
   * Allows requests to resolve with null instead of throwing an error.
   */
  throwErrorOnFailedRetries?: boolean;

  /**
   * Whether to throw an error if any request is canceled.
   * If `true`, canceled requests will result in an error being thrown.
   *
   * @default true
   *
   * @example
   * throwErrorOnCancelRequest: false
   * Prevents errors when requests are canceled intentionally.
   */
  throwErrorOnCancelRequest?: boolean;

  /**
   * Enable or disable debug mode.
   * If enabled, detailed logs are printed for debugging purposes.
   *
   * @default false
   *
   * @example
   * debug: true
   * Logs detailed retry and request handling information.
   */
  debug?: boolean;
  /**
   * Status codes or ranges of status codes that are considered retryable.
   *
   * @example
   * retryableStatuses: [408, 429, [500, 599] as const]
   * This allows retrying requests with status codes 408, 429, and any status code between 500 and 599 (inclusive).
   */
  retryableStatuses?: readonly AxiosRetryerRetryableStatus[];

  /**
   * HTTP methods that are considered retryable.
   *
   * @example
   * retryableMethods: [AXIOS_RETRYER_HTTP_METHODS.GET, AXIOS_RETRYER_HTTP_METHODS.HEAD]
   * Only requests using these methods will be retried.
   */
  retryableMethods?: readonly AxiosRetryerHttpMethod[];

  /**
   * The backoff strategy used to calculate the delay between retries.
   *
   * @type {AxiosRetryerBackoffType}
   * @default AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL
   *
   * @example
   * backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL
   * Delays double with each retry attempt: 1s, 2s, 4s, etc.
   */
  backoffType?: AxiosRetryerBackoffType;

  /**
   * The maximum number of requests to store in the internal request store.
   * Older requests will be removed when the store reaches its limit.
   *
   * @default 200
   *
   * @example
   * maxRequestsToStore: 300
   * Allows storing up to 300 requests in memory.
   */
  maxRequestsToStore?: number;

  /**
   * Custom request store implementation used for terminal failures that can be replayed manually.
   *
   * @example
   * requestStore: new InMemoryRequestStore(500)
   */
  requestStore?: RequestStore;

  /**
   * The maximum number of requests that can be processed concurrently.
   *
   * @default 5
   *
   * @example
   * maxConcurrentRequests: 10
   * Allows up to 10 requests to be processed simultaneously.
   */
  maxConcurrentRequests?: number;

  /**
   * The delay (in milliseconds) before processing each request in the queue.
   * This delay applies to queued requests.
   *
   * @default 100
   *
   * @example
   * queueDelay: 200
   * Adds a 200ms delay between dequeued requests.
   */
  queueDelay?: number;

  /**
   * The priority level threshold for blocking other requests.
   * Requests with priority greater than or equal to this value will block lower-priority requests
   * until they are resolved or retried to their maximum attempts.
   *
   * @default undefined (No threshold is set by default)
   *
   * @example
   * blockingQueueThreshold: 3
   * Requests with priority >= 3 (critical) block lower-priority requests until resolved.
   */
  blockingQueueThreshold?: AxiosRetryerRequestPriority;

  /**
   * The maximum number of requests that can be queued.
   * When the queue reaches this limit, subsequent requests will be rejected with a QueueFullError.
   *
   * @default undefined (No limit)
   *
   * @example
   * maxQueueSize: 100
   * Limits the request queue to 100 pending requests.
   */
  maxQueueSize?: number;

}

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
 * AxiosRetryer metrics
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
 * By implementing this interface, we can write our own custom retry logic
 * */
export interface RetryStrategy {
  /**
   * Add any logic here to determine that the error is retryable
   * @returns boolean
   * */
  getIsRetryable(error: AxiosError): boolean;
  /**
   * Add any logic here to determine that the request should be retried.
   * @returns boolean
   * */
  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean;
  /**
   * Add any logic here to get the retry delay on each attempt.
   * @returns number
   * */
  getDelay(attempt: number, maxRetries: number, backoffType?: AxiosRetryerBackoffType): number;
}

/**
 * By implementing this interface, we can write our own custom request store
 * */
export interface RequestStore {
  /**
   * Add a request config to the store
   * */
  add(request: AxiosRequestConfig): void;
  /**
   * Remove a request config to the store
   * */
  remove(request: AxiosRequestConfig): void;
  /**
   * Get all request configs from the store
   * */
  getAll(): AxiosRequestConfig[];
  /**
   * Clear request store
   * */
  clear(): void;
}

/**
 * AxiosRetryer plugin interface that can be attached with {@link RetryManager.use} and removed with {@link RetryManager.unuse}
 * */
export interface RetryPlugin<TPluginEvents extends object = {}> {
  /**
   * Plugin name. Should be unique
   * */
  name: string;
  /**
   * Plugin version (e.g. 1.0.0)
   * */
  version: string;
  /**
   * Called when the plugin is attached and initialized
   * @param manager RetryManager instance
   * */
  initialize: (manager: RetryManager<TPluginEvents>) => void;
  /**
   * Called before the plugin is removed
   * @param manager RetryManager instance
   * */
  onBeforeDestroyed?: (manager: RetryManager<TPluginEvents>) => void;
  /**
   * @deprecated Use events instead {@link RetryManager.on} and {@link RetryManager.off}
   * This field is still executed by RetryManager for backward compatibility.
   * */
  hooks?: Partial<RetryManagerEvents<TPluginEvents>>;
}

/**
 * Interface for pluggable metrics recording.
 * The core library ships with no-op metrics by default.
 * Use MetricsPlugin for full metrics collection.
 */
export interface MetricsRecorder {
  recordRequestStart(priority: AxiosRetryerRequestPriority): void;
  recordQueueWait(durationMs: number): void;
  recordRetrySuccess(priority: AxiosRetryerRequestPriority): void;
  recordRetryFailure(priority: AxiosRetryerRequestPriority, error: import('axios').AxiosError): void;
  recordRetryAttempt(attempt: number, priority: AxiosRetryerRequestPriority): void;
  recordRetryDelay(durationMs: number): void;
  recordCancellation(includeErrorType?: boolean): void;
  recordTerminalFailure(isCritical: boolean): void;
  reset(): void;
  buildDetailedMetrics(timerStats: { activeTimers: number; activeRetryTimers: number }): AxiosRetryerDetailedMetrics;
}

/**
 * Provider interface used by CriticalRequestPlugin to integrate critical request
 * tracking with the RetryManager's queue and lifecycle.
 */
export interface CriticalRequestProvider {
  /** Check whether a request qualifies as critical based on its priority. */
  isCriticalRequest(config: AxiosRequestConfig): boolean;
  /** Returns true if any critical requests are currently in-flight. */
  hasActiveCriticalRequests(): boolean;
  /** Called when a new request starts — track it if critical. */
  trackRequestStarted(requestId: string, config: AxiosRequestConfig): void;
  /** Called when a request finishes (success or failure) — untrack it. */
  trackRequestEnded(requestId: string): void;
  /** Clear all tracking state (e.g. when all requests are cancelled). */
  reset(): void;
}
