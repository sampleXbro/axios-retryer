import type { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

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

/**
 * Hooks to interact with RetryManager's lifecycle and states.
 */
export interface RetryHooks {
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
  onRetryProcessFinished?: (metrics: AxiosRetryerMetrics) => void;

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
  onMetricsUpdated?: (metrics: AxiosRetryerMetrics) => void;
  /**
   * Triggered when all critical requests resolved.
   */
  onAllCriticalRequestsResolved?: () => void;
}

export interface RetryManagerOptions {
  /**
   * The mode of retrying requests.
   * - 'automatic': Automatically retry requests that meet the retry conditions.
   * - 'manual': No automatic retries; manual retries must be triggered.
   *
   * @default 'automatic'
   *
   * @example
   * mode: 'automatic'
   * Requests will retry automatically if conditions are met.
   */
  mode: RetryMode;

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
  hooks?: RetryHooks;

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
   * retryableStatuses: [408, 429, [500, 599]]
   * This allows retrying requests with status codes 408, 429, and any status code between 500 and 599 (inclusive).
   */
  retryableStatuses?: (number | [number, number])[];

  /**
   * HTTP methods that are considered retryable.
   *
   * @example
   * retryableMethods: ['get', 'head', 'options']
   * Only requests using these methods will be retried.
   */
  retryableMethods?: string[];

  /**
   * The backoff strategy used to calculate the delay between retries.
   *
   * @type {'static' | 'linear' | 'exponential'}
   * @default 'exponential'
   *
   * @example
   * backoffType: 'exponential'
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
   * This delay applies to all enqueued requests.
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
  getDelay(attempt: number, maxRetries: number): number;
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
 * AxiosRetryer plugin interface that can be attached with {@link RetryManager.use}
 * */
export interface RetryPlugin {
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
  initialize: (manager: RetryManager) => void;
  /**
   * RetryManager lifecycle hooks {@link RetryHooks}
   * */
  hooks?: RetryHooks;
}
