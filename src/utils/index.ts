import type { AxiosRetryerBackoffType } from '../types';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../types';

/**
 * Returns a delay (in milliseconds) given an attempt number and a backoff strategy.
 *
 * @param attempt - The number of the current retry attempt (1-based)
 * @param backoffType - 'static', 'linear', or 'exponential'
 *    - 'static': returns a fixed 1000ms delay
 *    - 'linear': grows linearly with attempt (1000 * attempt)
 *    - 'exponential': doubles with each attempt (1000 * 2^(attempt - 1))

 * @returns The calculated delay in milliseconds.
 *
 * @example
 *   getBackoffDelay(1, 'static')                -> 1000
 *   getBackoffDelay(3, 'linear')                -> 3000
 *   getBackoffDelay(4, 'exponential')      -> 8000 ± up to 500 ms
 */
export function getBackoffDelay(attempt: number, backoffType: AxiosRetryerBackoffType): number {
  let baseDelay: number;

  switch (backoffType) {
    case AXIOS_RETRYER_BACKOFF_TYPES.STATIC:
      // Always 1000ms
      baseDelay = 1000;
      break;
    case AXIOS_RETRYER_BACKOFF_TYPES.LINEAR:
      // 1000ms * attempt
      baseDelay = 1000 * attempt;
      break;
    case AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL:
    default:
      // 1s, 2s, 4s, 8s, ...
      baseDelay = 1000 * 2 ** (attempt - 1);
      break;
  }

  return baseDelay;
}
