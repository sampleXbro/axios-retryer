import type { AxiosInstance } from 'axios';

import type {
  AxiosRetryerBackoffType,
  AxiosRetryerHttpMethod,
  AxiosRetryerRequestPriority,
  AxiosRetryerRetryableStatus,
  RetryMode,
} from './common';
import type { Logger, RetryStrategy } from './plugins';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface RetryManagerOptions<TPluginEvents extends object = Record<string, never>> {
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

  /**
   * When `true`, calling `manager.on()` after the per-event listener limit is
   * reached throws an `Error` instead of logging a warning and dropping the
   * registration silently. Useful in development to catch listener leaks early.
   *
   * @default false
   */
  strictListenerLimit?: boolean;
}
