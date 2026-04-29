import type { AxiosRetryerBackoffType } from '../types';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../types';

/**
 * Default cap for any backoff strategy. Bounds exponential growth and keeps
 * `setTimeout` arguments inside the safe integer range. Override per-instance
 * via `RetryManagerOptions.maxBackoffDelayMs`.
 */
export const MAX_BACKOFF_DELAY_MS = 60_000;

/**
 * Returns a delay (in milliseconds) given an attempt number, a backoff strategy,
 * and an optional cap.
 *
 * @param attempt - The number of the current retry attempt (1-based)
 * @param backoffType - 'static', 'linear', or 'exponential'
 *    - 'static': returns a fixed 1000ms delay
 *    - 'linear': grows linearly with attempt (1000 * attempt)
 *    - 'exponential': doubles with each attempt (1000 * 2^(attempt - 1))
 * @param maxDelayMs - Optional cap for the base delay before jitter. Falls back
 *    to {@link MAX_BACKOFF_DELAY_MS} when omitted or non-positive.
 *
 * All strategies are capped before jitter is applied.
 *
 * @returns The calculated delay in milliseconds.
 *
 * @example
 *   getBackoffDelay(1, 'static')                  -> 1000
 *   getBackoffDelay(3, 'linear')                  -> 3000
 *   getBackoffDelay(4, 'exponential')             -> 8000 ± jitter
 *   getBackoffDelay(10, 'exponential', 30_000)    -> capped at 30_000 ± jitter
 */
export function getBackoffDelay(attempt: number, backoffType: AxiosRetryerBackoffType, maxDelayMs?: number): number {
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

  const cap = Number.isFinite(maxDelayMs) && (maxDelayMs as number) > 0 ? (maxDelayMs as number) : MAX_BACKOFF_DELAY_MS;
  // Cap before jitter to prevent exceeding setTimeout's safe integer range.
  baseDelay = Math.min(baseDelay, cap);

  // Full jitter: randomize between 0 and baseDelay to prevent thundering herd
  return Math.floor(Math.random() * (baseDelay + 1));
}
