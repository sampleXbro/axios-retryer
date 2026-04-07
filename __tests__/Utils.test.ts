import { AXIOS_RETRYER_BACKOFF_TYPES } from '../src';
import { getBackoffDelay } from '../src/utils'

describe('getBackoffDelay', () => {
  describe('Static Backoff', () => {
    it('should return a value between 0 and 1000ms (full jitter)', () => {
      for (let i = 0; i < 50; i++) {
        const delay = getBackoffDelay(1, AXIOS_RETRYER_BACKOFF_TYPES.STATIC);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(1000);
      }
    });

    it('should return the same jitter range regardless of attempt number', () => {
      for (const attempt of [1, 5, 10]) {
        const delay = getBackoffDelay(attempt, AXIOS_RETRYER_BACKOFF_TYPES.STATIC);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(1000);
      }
    });
  });

  describe('Linear Backoff', () => {
    it('should return a value within jitter range of linear base delay', () => {
      for (const attempt of [1, 2, 5]) {
        const maxDelay = 1000 * attempt;
        for (let i = 0; i < 20; i++) {
          const delay = getBackoffDelay(attempt, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(maxDelay);
        }
      }
    });

    it('should return 0 for 0 or negative attempts', () => {
      expect(getBackoffDelay(0, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(0);
      expect(getBackoffDelay(-1, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(0);
    });
  });

  describe('Exponential Backoff', () => {
    it('should return a value within jitter range of exponential base delay', () => {
      const cases = [
        { attempt: 1, maxDelay: 1000 },   // 2^0 * 1000
        { attempt: 2, maxDelay: 2000 },   // 2^1 * 1000
        { attempt: 3, maxDelay: 4000 },   // 2^2 * 1000
        { attempt: 5, maxDelay: 16000 },  // 2^4 * 1000
      ];
      for (const { attempt, maxDelay } of cases) {
        for (let i = 0; i < 20; i++) {
          const delay = getBackoffDelay(attempt, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(maxDelay);
        }
      }
    });

    it('should return 0 for 0 or negative attempts', () => {
      expect(getBackoffDelay(0, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(0);
      expect(getBackoffDelay(-1, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(0);
    });
  });

  describe('Default Behavior', () => {
    it('should default to exponential backoff for unsupported backoff types', () => {
      const delay1 = getBackoffDelay(1, 'UNKNOWN_TYPE' as any);
      expect(delay1).toBeGreaterThanOrEqual(0);
      expect(delay1).toBeLessThanOrEqual(1000);

      const delay3 = getBackoffDelay(3, 'UNKNOWN_TYPE' as any);
      expect(delay3).toBeGreaterThanOrEqual(0);
      expect(delay3).toBeLessThanOrEqual(4000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle 0 or negative attempts for all backoff types', () => {
      // @ts-ignore
      Object.values(AXIOS_RETRYER_BACKOFF_TYPES).forEach((type) => {
        expect(getBackoffDelay(0, type)).toBe(0);
        expect(getBackoffDelay(-1, type)).toBe(0);
      });
    });
  });

  describe('Jitter', () => {
    it('should produce varying delays across multiple calls (not deterministic)', () => {
      const delays = new Set<number>();
      for (let i = 0; i < 100; i++) {
        delays.add(getBackoffDelay(3, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL));
      }
      // With full jitter over 0..4000, 100 calls should produce multiple distinct values
      expect(delays.size).toBeGreaterThan(1);
    });
  });
});
