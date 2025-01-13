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
  CRITICAL: 3,
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
 * RetryManager lifecycle hooks
 * */
export interface RetryHooks {
  /**
   * Called on every retry process start
   * */
  onRetryProcessStarted?: () => void;
  /**
   * Called before every request retry
   * */
  beforeRetry?: (config: AxiosRetryerRequestConfig) => void;
  /**
   * Called after every request retry
   * */
  afterRetry?: (config: AxiosRetryerRequestConfig, success: boolean) => void;
  /**
   * Called on every failed retry
   * */
  onFailure?: (config: AxiosRetryerRequestConfig) => void;
  /**
   * Called on all retries of all requests are completed
   * @arg failedRequests number of failed requests
   * */
  onRetryProcessFinished?: (metrics: AxiosRetryerMetrics) => void;
}

export interface RetryManagerOptions {
  mode: RetryMode;
  /**
   * Number of retries for 'automatic' and 'both' modes
   * */
  retries?: number;
  /**
   * Pass your custom retry strategy class here by implementing the RetryStrategy interface.
   * */
  retryStrategy?: RetryStrategy;
  /**
   * Pass your custom request store class here by implementing the RequestStore interface.
   * */
  requestStore?: RequestStore;
  /**
   * Hooks that allow to use internal RequestManager states
   * */
  hooks?: RetryHooks;
  /**
   * Custom Axios instance
   * */
  axiosInstance?: AxiosInstance;
  /**
   * Should Axios throw an error if all retries are failed
   * */
  throwErrorOnFailedRetries?: boolean;
  /**
   * Should Axios throw an error if any request is cancelled
   * */
  throwErrorOnCancelRequest?: boolean;
  /**
   * Enable/disable debug mode
   * */
  debug?: boolean;
  /**
   * Optional array defining HTTP status codes or ranges that should be considered retryable.
   * Each element can be either:
   * - A single numeric status code (e.g., `429`), or
   * - A tuple representing an inclusive range ([start, end], e.g., `[500, 504]`).
   *
   * @example
   * // This means status codes 400–428, 429, and 500–504 are retryable:
   * retryableStatuses: [[400, 428], 429, [500, 504]]
   */
  retryableStatuses?: (number | [number, number])[];

  /**
   * Optional array specifying HTTP methods that are eligible for retry.
   * If omitted, a default set will be used.
   *
   * @example
   * retryableMethods: ['GET', 'POST']
   */
  retryableMethods?: string[];

  /**
   * Defines how backoff delays are computed between retries. Possible values:
   * - `'static'` (constant delay),
   * - `'linear'` (delay grows linearly with each attempt),
   * - `'exponential'` (delay doubles each time).
   *
   * @example
   * backoffType: 'exponential' // 1s, 2s, 4s, 8s, ...
   */
  backoffType?: AxiosRetryerBackoffType;
}

/**
 * Extended AxiosRequestConfig with Retryer params
 * */
export interface AxiosRetryerRequestConfig extends AxiosRequestConfig {
  __retryAttempt?: number;
  __requestRetries?: number;
  __requestMode?: RetryMode;
  __requestId?: string;
  __abortController?: AbortController;
  __isRetrying?: boolean;
  __priority?: AxiosRetryerRequestPriority;
  __timestamp?: number;
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
  add(request: AxiosRetryerRequestConfig): void;
  /**
   * Remove a request config to the store
   * */
  remove(request: AxiosRetryerRequestConfig): void;
  /**
   * Get all request configs from the store
   * */
  getAll(): AxiosRetryerRequestConfig[];
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
