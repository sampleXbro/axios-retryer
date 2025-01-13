import { AXIOS_RETRYER_BACKOFF_TYPES, AxiosRetryerBackoffType } from '../types';

/**
 * Checks whether a given status code is in an array of exact codes or within any range specified.
 *
 * @example
 * // Single values match exact codes:
 * isInRangeOrExact(429, [429, [500, 504]]); // true (exact match for 429)
 * isInRangeOrExact(430, [429, [500, 504]]); // false (no exact match and not in range)
 *
 * @example
 * // Arrays denote inclusive ranges:
 * isInRangeOrExact(420, [[400, 428], 429, [500, 504]]); // true (within 400..428)
 * isInRangeOrExact(502, [[400, 428], 429, [500, 504]]); // true (within 500..504)
 *
 * @param code - The status code to check.
 * @param conditions - An array of either:
 *   - A single number for exact matching, or
 *   - A tuple [start, end] representing an inclusive range.
 *
 * @returns `true` if the code is an exact match or falls within any range; otherwise, `false`.
 */
export function isInRangeOrExact(code: number, conditions: (number | [number, number])[]): boolean {
  for (const condition of conditions) {
    if (Array.isArray(condition)) {
      const [start, end] = condition;
      if (code >= start && code <= end) {
        return true;
      }
    } else {
      if (code === condition) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns a delay (in milliseconds) given an attempt number and a backoff strategy.
 *
 * @param attempt - the number of the current retry attempt (1-based)
 * @param backoffType - 'static', 'linear', or 'exponential'
 *    - 'static': returns a fixed delay
 *    - 'linear': grows linearly with attempt
 *    - 'exponential': doubles with each attempt (2^(attempt - 1))
 *
 * Examples:
 *   calculateBackoffDelay(1, 'static')       -> 1000
 *   calculateBackoffDelay(3, 'linear')       -> 3000
 *   calculateBackoffDelay(4, 'exponential')  -> 8000
 */
export function getBackoffDelay(attempt: number, backoffType: AxiosRetryerBackoffType): number {
  switch (backoffType) {
    case AXIOS_RETRYER_BACKOFF_TYPES.STATIC:
      // Always 1000ms
      return 1000;
    case AXIOS_RETRYER_BACKOFF_TYPES.LINEAR:
      // 1000ms * attempt
      return 1000 * attempt;
    case AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL:
    default:
      // 1s, 2s, 4s, 8s, ...
      return 1000 * 2 ** (attempt - 1);
  }
}
