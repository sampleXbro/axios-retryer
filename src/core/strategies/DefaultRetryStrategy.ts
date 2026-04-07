'use strict';

import type { AxiosError, AxiosRequestConfig } from 'axios';

import type { AxiosRetryerBackoffType, AxiosRetryerHttpMethod, AxiosRetryerRetryableStatus, Logger, RetryStrategy } from '../../types';
import { AXIOS_RETRYER_BACKOFF_TYPES, AXIOS_RETRYER_HTTP_METHODS } from '../../types';
import { getBackoffDelay } from '../../utils';
import { getRequestMetadata } from '../../utils/requestMetadata';

const DEFAULT_RETRYABLE_STATUSES: readonly AxiosRetryerRetryableStatus[] = [408, 429, 500, 502, 503, 504, [520, 527]];
const DEFAULT_RETRYABLE_METHODS: readonly AxiosRetryerHttpMethod[] = [
  AXIOS_RETRYER_HTTP_METHODS.GET,
  AXIOS_RETRYER_HTTP_METHODS.HEAD,
  AXIOS_RETRYER_HTTP_METHODS.OPTIONS,
];

export class DefaultRetryStrategy implements RetryStrategy {
  private retryableMethodsLower: Set<string>;
  private defaultStatusSet: Set<number>;
  private defaultRanges: [number, number][];
  // Cache parsed Set/Array per unique per-request retryableStatuses array reference.
  private readonly overrideCache = new WeakMap<
    readonly AxiosRetryerRetryableStatus[],
    { set: Set<number>; ranges: [number, number][] }
  >();

  /**
   * @param retryableStatuses - List of statuses or ranges that are considered retryable.
   * @param retryableMethods - List of HTTP methods that are allowed to be retried.
   * @param backoffType - The backoff type used to compute delay times.
   * @param idempotencyHeaders - Headers that indicate a request is idempotent.
   * @param logger - Optional logger for debug information.
   */
  constructor(
    private readonly retryableStatuses: readonly AxiosRetryerRetryableStatus[] = DEFAULT_RETRYABLE_STATUSES,
    private readonly retryableMethods: readonly AxiosRetryerHttpMethod[] = DEFAULT_RETRYABLE_METHODS,
    private readonly backoffType: AxiosRetryerBackoffType = AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
    private readonly idempotencyHeaders: readonly string[] = ['Idempotency-Key'],
    private readonly logger?: Logger,
  ) {
    // Precompute lower-case methods once as a Set for O(1) lookup
    this.retryableMethodsLower = new Set(this.retryableMethods.map((m) => m.toLowerCase()));

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
  private isRetryableStatus(status: number, statuses: readonly AxiosRetryerRetryableStatus[]): boolean {
    // If statuses is exactly the default, use precomputed values.
    if (statuses === this.retryableStatuses) {
      return (
        this.defaultStatusSet.has(status) || this.defaultRanges.some(([start, end]) => status >= start && status <= end)
      );
    }

    let cached = this.overrideCache.get(statuses);
    if (!cached) {
      const set = new Set<number>();
      const ranges: [number, number][] = [];
      for (const s of statuses) {
        if (typeof s === 'number') set.add(s);
        else if (Array.isArray(s)) ranges.push(s);
      }
      cached = { set, ranges };
      this.overrideCache.set(statuses, cached);
    }
    return cached.set.has(status) || cached.ranges.some(([start, end]) => status >= start && status <= end);
  }

  /**
   * Returns true if the error is retryable.
   *
   * @param error - The Axios error.
   * @returns true if the error should be retried.
   */
  public getIsRetryable = (error: AxiosError): boolean => {
    if (error.code === 'TOKEN_REFRESH_FAILED') {
      return false;
    }

    if (!error.response) {
      this.logger?.debug('Retrying due to network error');
      return true;
    }

    const config = error.config as AxiosRequestConfig;
    const method = config?.method?.toLowerCase();
    const status = error.response.status;
    const statuses = getRequestMetadata(config)?.retryableStatuses ?? this.retryableStatuses;

    if (method && this.retryableMethodsLower.has(method)) {
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
    // Use ?? not || — STATIC is enum value 0 and must not fall through to this.backoffType.
    const delay = getBackoffDelay(attempt, backoffType ?? this.backoffType);
    this.logger?.debug(`Retry delay for attempt ${attempt}: ${delay}ms; MaxRetries: ${maxRetries}`);
    return delay;
  };
}
