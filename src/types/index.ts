import type { AxiosError, AxiosInstance, AxiosRequestConfig, Method } from 'axios';

/**
 *  manual - Requests fail immediately after the first attempt.
 *  Optional replay can be layered in with ManualRetryPlugin.
 *
 *  automatic - Requests retry automatically according to the configured
 *  retry strategy and retry count.
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
  /** Current retry attempt count. Managed by the library; read-only for consumers. */
  readonly retryAttempt?: number;
  /** Override the max retry count for this specific request. */
  requestRetries?: number;
  /** Override the retry mode (automatic / manual) for this specific request. */
  requestMode?: RetryMode;
  /** Custom request identifier for cancellation targeting. */
  requestId?: string;
  /** Whether the request is currently in a retry cycle. Managed by the library. */
  readonly isRetrying?: boolean;
  /** Override request priority for queue ordering. */
  priority?: AxiosRetryerRequestPriority;
  /** Request creation timestamp (ms). Managed by the library. */
  readonly timestamp?: number;
  /** Override the backoff strategy for this specific request. */
  backoffType?: AxiosRetryerBackoffType;
  /** Override the retryable status codes for this specific request. */
  retryableStatuses?: readonly AxiosRetryerRetryableStatus[];
  /** Extra metadata for this request. */
  extra?: unknown;
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
   * Triggered before each retry attempt.
   * @param config The Axios request configuration being retried.
   */
  beforeRetry?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered after a retry attempt.
   * @param config The Axios request configuration being retried.
   * @param success Whether the retry was successful.
   * @param error If the retry failed, the error that caused the failure.
   */
  afterRetry?: (config: AxiosRequestConfig, success: boolean, error?: AxiosError) => void;

  /**
   * Triggered when a retry is scheduled and waiting for the specified delay.
   * @param delayMs The delay in milliseconds.
   * @param config The Axios request configuration.
   */
  onRetryScheduled?: (delayMs: number, config: AxiosRequestConfig) => void;

  /**
   * Triggered for each failed retry attempt.
   * @param config The failed Axios request configuration.
   */
  onFailure?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered when a request enters the queue.
   *
   * @param payload Queue entry metadata for this request.
   */
  onRequestQueued?: (payload: AxiosRetryerRequestQueuedEvent) => void;

  /**
   * Triggered when a queued request is dispatched from the queue to the network layer.
   *
   * @param payload Dispatch metadata including queue wait duration.
   */
  onRequestDispatched?: (payload: AxiosRetryerRequestDispatchedEvent) => void;

  /**
   * Triggered when a request succeeds (initial attempt or after retries).
   *
   * @param payload Success metadata for this request.
   */
  onRequestSucceeded?: (payload: AxiosRetryerRequestSucceededEvent) => void;

  /**
   * Triggered once when a request fails terminally (all retries exhausted or no-retry terminal path).
   * Unlike `onFailure`, this event is emitted only for the final failure.
   *
   * @param payload Terminal error context for application-level handling.
   */
  onRequestError?: (payload: AxiosRetryerRequestErrorEvent) => void;

  /**
   * Triggered when all retries are completed.
   */
  onRetryProcessFinished?: () => void;

  /**
   * Triggered when a request cancelled.
   * @param requestId Id of the cancelled request.
   */
  onRequestCancelled?: (requestId: string) => void;

  /**
   * Called when a request fails due to network or connection issues, meaning
   * no valid server response was received (e.g., user is offline).
   *
   * @param request - The Axios request config that encountered a connection error.
   */
  onInternetConnectionError?: (request: AxiosRequestConfig) => void;

  /**
   * Triggered when a blocking request (at or above `blockingPriorityThreshold`) fails terminally.
   * Only fires when `blockingPriorityThreshold` is configured.
   *
   * @param config The Axios request config of the failed blocking request.
   */
  onBlockingRequestFailed?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered when every in-flight blocking request (at or above `blockingPriorityThreshold`)
   * has **succeeded** (terminal success) and none remain in the internal blocker set.
   * Not emitted when a blocker fails (`onBlockingRequestFailed`) or is cancelled.
   * Only fires when `blockingPriorityThreshold` is configured.
   */
  onAllBlockingRequestsResolved?: () => void;
}

/**
 * Terminal request error payload emitted by `onRequestError`.
 */
export interface AxiosRetryerRequestErrorEvent {
  /** Final Axios error object that caused request failure. */
  error: AxiosError;
  /** Final Axios request config that failed. */
  config: AxiosRequestConfig;
  /** HTTP status if available, otherwise `null` for network-level failures. */
  status: number | null;
  /** Request identifier if available. */
  requestId?: string;
  /** Total attempts performed including the initial attempt. */
  attempts: number;
  /** Whether the final error shape is considered retryable by the active strategy. */
  retryable: boolean;
}

/**
 * Queue-entry payload emitted by `onRequestQueued`.
 */
export interface AxiosRetryerRequestQueuedEvent {
  /** Request identifier generated or assigned by RetryManager. */
  requestId: string;
  /** Request config entering the queue. */
  config: AxiosRequestConfig;
  /** Resolved priority used for queue ordering. */
  priority: AxiosRetryerRequestPriority;
  /** Queue size immediately after this request was enqueued. */
  queueSize: number;
}

/**
 * Queue-dispatch payload emitted by `onRequestDispatched`.
 */
export interface AxiosRetryerRequestDispatchedEvent {
  /** Request identifier generated or assigned by RetryManager. */
  requestId: string;
  /** Request config dispatched from the queue. */
  config: AxiosRequestConfig;
  /** Resolved priority used for queue ordering. */
  priority: AxiosRetryerRequestPriority;
  /** Time spent waiting in the queue before dispatch (milliseconds). */
  queuedForMs: number;
}

/**
 * Success payload emitted by `onRequestSucceeded`.
 */
export interface AxiosRetryerRequestSucceededEvent {
  /** Request identifier generated or assigned by RetryManager. */
  requestId?: string;
  /** Final request config that succeeded. */
  config: AxiosRequestConfig;
  /** Final HTTP status code. */
  status: number;
  /** Total attempts performed including the initial attempt. */
  attempts: number;
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

  /**
   * Custom logger implementation.
   * When provided, all log output is routed through this logger instead of
   * the built-in console-based logger.
   *
   * @default undefined (uses built-in console logger)
   *
   * @example
   * logger: {
   *   log: (msg, data) => myLogger.info(msg, data),
   *   error: (msg, err) => myLogger.error(msg, err),
   *   warn: (msg, data) => myLogger.warn(msg, data),
   *   debug: (msg, meta) => myLogger.debug(msg, meta),
   * }
   */
  logger?: Logger;

  /**
   * When set, requests with priority at or above this threshold are treated as
   * "blocking". While any blocking request is in flight, lower-priority requests
   * wait in the queue until all blockers complete.
   *
   * Fires `onBlockingRequestFailed` when a blocking request fails terminally, and
   * `onAllBlockingRequestsResolved` when all in-flight blocking requests have **succeeded**.
   *
   * @example
   * blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL
   * // CRITICAL requests will block all lower-priority requests in the queue
   */
  blockingPriorityThreshold?: AxiosRetryerRequestPriority;

  /**
   * When `true` and a blocking request fails terminally, all queued non-blocking
   * requests are cancelled. Has no effect if `blockingPriorityThreshold` is not set.
   *
   * @default true
   */
  cancelPendingOnDependencyFailure?: boolean;
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
 * Context object passed to plugins during initialization and teardown.
 * Provides the plugin-facing view of RetryManager capabilities including
 * plugin-only wiring hooks that are not part of the public manager API.
 */
export interface PluginContext<TPluginEvents extends object = {}> {
  /** The Axios instance managed by RetryManager. */
  readonly axiosInstance: AxiosInstance;
  /** Returns the configured logger. */
  getLogger(): Logger;
  /** Subscribe to a manager or plugin event. */
  on<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): void;
  /** Unsubscribe from a manager or plugin event. */
  off<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): boolean;
  /** Emit an event (fires listeners only, does not call hooks). */
  emit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void;
  /** Call hooks and emit an event. */
  triggerAndEmit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void;
  /** Cancel a specific in-flight or queued request by its ID. */
  cancelRequest(requestId: string): void;
  /** Cancel all active and queued requests. */
  cancelAllRequests(): void;
  /** Cancel only requests currently waiting in the queue. */
  cancelQueuedRequests(): void;
  /**
   * Register a queue gate that must approve each request before it is dispatched.
   * Used by plugins that need to block request processing under certain conditions.
   */
  registerQueueGate(name: string, canProcess: (request: AxiosRequestConfig) => boolean): void;
  /** Remove a previously registered queue gate. */
  unregisterQueueGate(name: string): boolean;
  /** Trigger a queue drain pass. Useful after a gate condition changes. */
  refreshQueue(): void;
  /**
   * Register or unregister a metrics recorder.
   * Pass `null` to detach. Used by MetricsPlugin to expose metric data to the RetryManager's getMetrics() method.
   */
  registerMetricsRecorder(recorder: MetricsRecorder | null): void;
  /**
   * Return active timer counts.
   * Used by MetricsPlugin to populate the timerHealth section of detailed metrics.
   */
  getTimerStats(): { activeTimers: number; activeRetryTimers: number };
  /**
   * Release lifecycle tracking for a request config and mark its queue slot complete.
   * Used by TokenRefreshPlugin when a tracked request is intercepted for token refresh.
   */
  releaseRequestTracking(config: AxiosRequestConfig): void;
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
   * Phantom covariant marker for TypeScript to infer `TPluginEvents` at call sites
   * such as `manager.use(plugin)`. Never set this at runtime; implementations may
   * simply omit it (it is always `undefined`).
   * */
  readonly _events?: Readonly<TPluginEvents>;
  /**
   * Called when the plugin is attached and initialized.
   * @param context Plugin context providing manager capabilities and plugin-only wiring hooks.
   * */
  initialize: (context: PluginContext<TPluginEvents>) => void;
  /**
   * Called before the plugin is removed.
   * @param context Plugin context providing manager capabilities and plugin-only wiring hooks.
   * */
  onBeforeDestroyed?: (context: PluginContext<TPluginEvents>) => void;
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

/**
 * Logger interface used by RetryManager and its collaborators.
 * Supply a custom implementation via {@link RetryManagerOptions.logger}
 * to redirect or suppress log output.
 */
export interface Logger {
  log(message: string, data?: unknown): void;
  error(message: string, error?: unknown): void;
  warn(message: string, data?: unknown): void;
  debug(message: string, meta?: unknown): void;
}
