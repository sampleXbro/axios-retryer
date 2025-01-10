'use strict';

import type { AxiosError } from 'axios';

import type { RetryStrategy } from '../types';

export class DefaultRetryStrategy implements RetryStrategy {
  getIsRetryable(error: AxiosError): boolean {
    // Network errors
    if (!error.response) {
      return true;
    }

    // Specific HTTP status codes
    const retryableStatuses = [408, 429, 500, 502, 503, 504];

    // Method-based decisions
    const retryableMethods = ['get', 'head', 'options', 'put'];
    const method = error.config?.method?.toLowerCase();

    if (
      method &&
      retryableMethods.indexOf(method) !== -1 &&
      error.response.status &&
      retryableStatuses.indexOf(error.response.status) !== -1
    ) {
      return true;
    }

    // Special case for POST - check idempotency header
    if (method === 'post' && error.config?.headers?.['Idempotency-Key']) {
      return true;
    }

    return false;
  }

  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
    return this.getIsRetryable(error) && attempt <= maxRetries;
  }

  getDelay(attempt: number) {
    return 1000 * 2 ** (attempt - 1); // Exponential backoff: 1s, 2s, 4s, ...
  }
}
