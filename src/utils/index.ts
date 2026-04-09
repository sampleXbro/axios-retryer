import type { AxiosRetryerBackoffType } from '../types';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../types';

/**
 * Maximum delay for any backoff strategy. Caps exponential growth to prevent
 * exceeding setTimeout's safe range (~2^31 ms) and to bound retry wait times.
 */
export const MAX_BACKOFF_DELAY_MS = 60_000;

/**
 * Returns a delay (in milliseconds) given an attempt number and a backoff strategy.
 *
 * @param attempt - The number of the current retry attempt (1-based)
 * @param backoffType - 'static', 'linear', or 'exponential'
 *    - 'static': returns a fixed 1000ms delay
 *    - 'linear': grows linearly with attempt (1000 * attempt)
 *    - 'exponential': doubles with each attempt (1000 * 2^(attempt - 1))
 *
 * All strategies are capped at MAX_BACKOFF_DELAY_MS (60 s) before jitter is applied.
 *
 * @returns The calculated delay in milliseconds.
 *
 * @example
 *   getBackoffDelay(1, 'static')                -> 1000
 *   getBackoffDelay(3, 'linear')                -> 3000
 *   getBackoffDelay(4, 'exponential')      -> 8000 ± up to 500 ms
 */
export function getBackoffDelay(attempt: number, backoffType: AxiosRetryerBackoffType): number {
  let baseDelay = 0;

  if (attempt <= 0) return baseDelay;

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

  // Cap before jitter to prevent exceeding setTimeout's safe integer range.
  baseDelay = Math.min(baseDelay, MAX_BACKOFF_DELAY_MS);

  // Full jitter: randomize between 0 and baseDelay to prevent thundering herd
  return Math.floor(Math.random() * (baseDelay + 1));
}
