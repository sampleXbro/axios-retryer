'use strict';

import type { AxiosError } from 'axios';

import type { AxiosRetryerBackoffType, RetryStrategy } from '../types';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../types';
import { getBackoffDelay, isInRangeOrExact } from '../utils';

export class DefaultRetryStrategy implements RetryStrategy {
  constructor(
    private readonly retryableStatuses: (number | [number, number])[] = [408, 429, 500, 502, 503, 504],
    private readonly retryableMethods: string[] = ['get', 'head', 'options', 'put'],
    private readonly backoffType: AxiosRetryerBackoffType = AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
  ) {}

  public getIsRetryable = (error: AxiosError): boolean => {
    // Network errors
    if (!error.response) {
      return true;
    }

    const method = error.config?.method?.toLowerCase();
    const status = error.response.status;

    if (
      method &&
      this.retryableMethods.includes(method) &&
      status &&
      isInRangeOrExact(status, this.retryableStatuses)
    ) {
      return true;
    }

    // Special case for POST - check idempotency header
    if (method === 'post' && error.config?.headers?.['Idempotency-Key']) {
      return true;
    }

    return false;
  };

  public shouldRetry = (error: AxiosError, attempt: number, maxRetries: number): boolean => {
    return this.getIsRetryable(error) && attempt <= maxRetries;
  };

  public getDelay = (attempt: number) => {
    return getBackoffDelay(attempt, this.backoffType);
  };
}
