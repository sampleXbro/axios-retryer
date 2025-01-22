'use strict';

import type { AxiosError } from 'axios';

import type { AxiosRetryerBackoffType, RetryStrategy } from '../types';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../types';
import { getBackoffDelay, isInRangeOrExact } from '../utils';

export class DefaultRetryStrategy implements RetryStrategy {
  private readonly normalizedMethods: Set<string>;
  private readonly retryableStatusMap: Set<number>;
  private readonly retryableRanges: [number, number][];

  constructor(
    private readonly retryableStatuses: (number | [number, number])[] = [408, 429, 500, 502, 503, 504],
    private readonly retryableMethods: string[] = ['get', 'head', 'options'],
    private readonly backoffType: AxiosRetryerBackoffType = AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
    private readonly idempotencyHeaders: string[] = ['Idempotency-Key'],
    private readonly logger?: (message: string) => void,
  ) {
    this.normalizedMethods = new Set(this.retryableMethods.map((method) => method.toLowerCase()));
    this.retryableStatusMap = new Set(
      this.retryableStatuses.filter((s) => typeof s === 'number') as number[]
    );
    this.retryableRanges = this.retryableStatuses.filter(
      (s) => Array.isArray(s)
    ) as [number, number][];
  }

  private isRetryableStatus(status: number): boolean {
    if (this.retryableStatusMap.has(status)) {
      return true;
    }
    return this.retryableRanges.some(([start, end]) => status >= start && status <= end);
  }

  public getIsRetryable = (error: AxiosError): boolean => {
    if (!error.response) {
      this.logger?.('Retrying due to network error');
      return true;
    }

    const method = error.config?.method?.toLowerCase();
    const status = error.response.status;

    if (method && this.normalizedMethods.has(method) && status && this.isRetryableStatus(status)) {
      this.logger?.(`Retrying request with status ${status} and method ${method}`);
      return true;
    }

    if (
      (method === 'post' || method === 'put' || method === 'patch') &&
      this.idempotencyHeaders.some((header) => !!error.config?.headers?.[header])
    ) {
      this.logger?.(`Retrying idempotent request with method ${method}`);
      return true;
    }

    this.logger?.(`Not retrying request with method ${method} and status ${status}`);
    return false;
  };

  public shouldRetry = (error: AxiosError, attempt: number, maxRetries: number): boolean => {
    const shouldRetry = this.getIsRetryable(error) && attempt <= maxRetries;
    this.logger?.(`Should retry: ${shouldRetry}, attempt ${attempt}/${maxRetries}`);
    return shouldRetry;
  };

  public getDelay = (attempt: number) => {
    const delay = getBackoffDelay(attempt, this.backoffType);
    this.logger?.(`Retry delay for attempt ${attempt}: ${delay}ms`);
    return delay;
  };
}