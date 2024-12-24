'use strict';

import type { AxiosError } from 'axios';

import type { RetryStrategy } from './types';

export class DefaultRetryStrategy implements RetryStrategy {
  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
    const isNetworkError = !error.response;
    const isServerError = error.response && error.response.status >= 400 && error.response.status < 600;
    return ((isNetworkError || isServerError) && attempt <= maxRetries) || false;
  }

  getDelay(attempt: number) {
    return 1000 * 2 ** (attempt - 1); // Exponential backoff: 1s, 2s, 4s, ...
  }
}