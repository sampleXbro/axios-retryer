import type { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

import type { RequestStore } from './RequestStore';

/**
 *  manual - After each request failure, Axios throws the rejected promise
 *  immediately to allow us to retry failed requests manually using {@link RetryManager.retryFailedRequests}
 *
 *  automatic - Automatic retry according to retry strategy and number of retries.
 *  After retires are completed we can retry the failed requests manually using {@link RetryManager.retryFailedRequests}
 * */
export type RetryMode = 'manual' | 'automatic';

export interface RetryHooks {
  /**
   * Called before every request retry
   * */
  beforeRetry?: (config: AxiosRequestConfig) => void;
  /**
   * Called after every request retry
   * */
  afterRetry?: (config: AxiosRequestConfig, success: boolean) => void;
  /**
   * Called on every failed retry
   * */
  onFailure?: (config: AxiosRequestConfig) => void;
  /**
   * Called on all retries of all requests are completed
   * @arg failedRequests number of failed requests
   * */
  onAllRetriesCompleted?: (failedRequests: number) => void;
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
}

/**
 * By implementing this interface, we can write our own custom retry logic
 * */
export interface RetryStrategy {
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
