'use strict';

import type { AxiosError, AxiosRequestConfig } from 'axios';

import type { RetryLogger } from '../../services/logger';
import type { AxiosRetryerBackoffType, RetryStrategy } from '../../types';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../../types';
import { getBackoffDelay } from '../../utils';

const DEFAULT_RETRYABLE_STATUSES: (number | [number, number])[] = [408, 429, 500, 502, 503, 504, [520, 527]];
const DEFAULT_RETRYABLE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export class DefaultRetryStrategy implements RetryStrategy {
  private retryableMethodsLower: string[];
  private defaultStatusSet: Set<number>;
  private defaultRanges: [number, number][];

  /**
   * @param retryableStatuses - List of statuses or ranges that are considered retryable.
   * @param retryableMethods - List of HTTP methods that are allowed to be retried.
   * @param backoffType - The backoff type used to compute delay times.
   * @param idempotencyHeaders - Headers that indicate a request is idempotent.
   * @param logger - Optional logger for debug information.
   */
  constructor(
    private readonly retryableStatuses: (number | [number, number])[] = DEFAULT_RETRYABLE_STATUSES,
    private readonly retryableMethods: string[] = DEFAULT_RETRYABLE_METHODS,
    private readonly backoffType: AxiosRetryerBackoffType = AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
    private readonly idempotencyHeaders: string[] = ['Idempotency-Key'],
    private readonly logger?: RetryLogger,
  ) {
    // Precompute lower-case methods once
    this.retryableMethodsLower = this.retryableMethods.map((m) => m.toLowerCase());

    // Precompute default statuses as a Set and an array of ranges.
    this.defaultStatusSet = new Set<number>();
    this.defaultRanges = [];
    for (const s of retryableStatuses) {
      if (typeof s === 'number') {
        this.defaultStatusSet.add(s);
      } else if (Array.isArray(s)) {
        this.defaultRanges.push(s);
      }
    }
  }

  /**
   * Checks if a given status is retryable based on provided statuses.
   *
   * @param status - The HTTP status code.
   * @param statuses - The statuses (or ranges) to test against.
   * @returns true if the status is considered retryable.
   */
  private isRetryableStatus(status: number, statuses: (number | [number, number])[]): boolean {
    // If statuses is exactly the default, use precomputed values.
    if (statuses === this.retryableStatuses) {
      return (
        this.defaultStatusSet.has(status) || this.defaultRanges.some(([start, end]) => status >= start && status <= end)
      );
    } else {
      // Otherwise, recalc.
      const statusMap = new Set<number>();
      const ranges: [number, number][] = [];
      statuses.forEach((s) => {
        if (typeof s === 'number') statusMap.add(s);
        else if (Array.isArray(s)) ranges.push(s);
      });
      return statusMap.has(status) || ranges.some(([start, end]) => status >= start && status <= end);
    }
  }

  /**
   * Returns true if the error is retryable.
   *
   * @param error - The Axios error.
   * @returns true if the error should be retried.
   */
  public getIsRetryable = (error: AxiosError): boolean => {
    if (!error.response) {
      this.logger?.debug('Retrying due to network error');
      return true;
    }

    const config = error.config as AxiosRequestConfig;
    const method = config?.method?.toLowerCase();
    const status = error.response.status;
    const statuses = config?.__retryableStatuses ?? this.retryableStatuses;

    if (method && this.retryableMethodsLower.includes(method)) {
      if (this.isRetryableStatus(status, statuses)) {
        this.logger?.debug(`Retrying request with status ${status} and method ${method}`);
        return true;
      }
    }

    // If POST/PUT/PATCH and contains an idempotency header, treat as retryable.
    if (
      (method === 'post' || method === 'put' || method === 'patch') &&
      this.idempotencyHeaders.some((header) => !!config.headers?.[header])
    ) {
      this.logger?.debug(`Retrying idempotent request with method ${method}`);
      return true;
    }

    this.logger?.debug(`Not retrying request with method ${method} and status ${status}`);
    return false;
  };

  /**
   * Determines whether the request should be retried based on the error and attempt count.
   *
   * @param error - The Axios error.
   * @param attempt - The current retry attempt.
   * @param maxRetries - The maximum allowed retries.
   * @returns true if the request should be retried.
   */
  public shouldRetry = (error: AxiosError, attempt: number, maxRetries: number): boolean => {
    return this.getIsRetryable(error) && attempt <= maxRetries;
  };

  /**
   * Computes the delay for the next retry attempt.
   *
   * @param attempt - The current attempt number.
   * @param maxRetries - The maximum retries allowed.
   * @param backoffType - Optional backoff type override.
   * @returns The delay in milliseconds.
   */
  public getDelay = (attempt: number, maxRetries: number, backoffType?: AxiosRetryerBackoffType): number => {
    const delay = getBackoffDelay(attempt, backoffType || this.backoffType);
    this.logger?.debug(`Retry delay for attempt ${attempt}: ${delay}ms; MaxRetries: ${maxRetries}`);
    return delay;
  };
}
