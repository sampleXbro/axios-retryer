/**
 * Verifies that the new `maxBackoffDelayMs` option threads through getBackoffDelay
 * via DefaultRetryStrategy and the RetryManager constructor.
 *
 * Default behavior (60_000) is preserved when the option is omitted.
 */
import { getBackoffDelay, MAX_BACKOFF_DELAY_MS } from '../src/utils';
import { DefaultRetryStrategy } from '../src/core/strategies/DefaultRetryStrategy';
import { RetryManager } from '../src/core/RetryManager';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../src/types';

describe('maxBackoffDelayMs', () => {
  describe('getBackoffDelay()', () => {
    let randomSpy: jest.SpyInstance;

    beforeEach(() => {
      // Force jitter to its maximum (Math.floor(1.0 * (n + 1)) === n) so we read
      // the cap directly without random fluctuation.
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.999_999_999);
    });

    afterEach(() => {
      randomSpy.mockRestore();
    });

    it('falls back to MAX_BACKOFF_DELAY_MS when no cap is provided', () => {
      const delay = getBackoffDelay(20, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL);
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_DELAY_MS);
    });

    it('honors a custom cap', () => {
      const delay = getBackoffDelay(20, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL, 5_000);
      expect(delay).toBeLessThanOrEqual(5_000);
    });

    it('rejects non-positive caps and falls back to default', () => {
      const zero = getBackoffDelay(20, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL, 0);
      const negative = getBackoffDelay(20, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL, -1);
      expect(zero).toBeLessThanOrEqual(MAX_BACKOFF_DELAY_MS);
      expect(negative).toBeLessThanOrEqual(MAX_BACKOFF_DELAY_MS);
    });
  });

  describe('DefaultRetryStrategy', () => {
    it('forwards maxBackoffDelayMs to getBackoffDelay', () => {
      const strategy = new DefaultRetryStrategy(
        undefined,
        undefined,
        AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
        undefined,
        undefined,
        2_000,
      );
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.999_999_999);
      try {
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          expect(strategy.getDelay(attempt, 10)).toBeLessThanOrEqual(2_000);
        }
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe('RetryManager option validation', () => {
    it('accepts a positive integer', () => {
      expect(() => new RetryManager({ maxBackoffDelayMs: 5_000 })).not.toThrow();
    });

    it('rejects zero, negatives, and non-integers', () => {
      expect(() => new RetryManager({ maxBackoffDelayMs: 0 })).toThrow();
      expect(() => new RetryManager({ maxBackoffDelayMs: -1 })).toThrow();
      expect(() => new RetryManager({ maxBackoffDelayMs: 1.5 })).toThrow();
    });
  });
});
