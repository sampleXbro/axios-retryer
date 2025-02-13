import { AXIOS_RETRYER_BACKOFF_TYPES } from '../src';
import { getBackoffDelay } from '../src/utils'

describe('getBackoffDelay', () => {
  describe('Static Backoff', () => {
    it('should return 1000ms for any attempt', () => {
      expect(getBackoffDelay(1, AXIOS_RETRYER_BACKOFF_TYPES.STATIC)).toBe(1000);
      expect(getBackoffDelay(5, AXIOS_RETRYER_BACKOFF_TYPES.STATIC)).toBe(1000);
      expect(getBackoffDelay(10, AXIOS_RETRYER_BACKOFF_TYPES.STATIC)).toBe(1000);
    });
  });

  describe('Linear Backoff', () => {
    it('should return 1000ms multiplied by the attempt number', () => {
      expect(getBackoffDelay(1, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(1000);
      expect(getBackoffDelay(2, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(2000);
      expect(getBackoffDelay(5, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(5000);
    });

    it('should return 0 for 0 or negative attempts', () => {
      expect(getBackoffDelay(0, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(0);
      expect(getBackoffDelay(-1, AXIOS_RETRYER_BACKOFF_TYPES.LINEAR)).toBe(0);
    });
  });

  describe('Exponential Backoff', () => {
    it('should double the delay with each attempt', () => {
      expect(getBackoffDelay(1, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(1000); // 2^0 * 1000
      expect(getBackoffDelay(2, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(2000); // 2^1 * 1000
      expect(getBackoffDelay(3, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(4000); // 2^2 * 1000
      expect(getBackoffDelay(5, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(16000); // 2^4 * 1000
    });

    it('should return 0 for 0 or negative attempts', () => {
      expect(getBackoffDelay(0, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(0);
      expect(getBackoffDelay(-1, AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL)).toBe(0);
    });
  });

  describe('Default Behavior', () => {
    it('should default to exponential backoff for unsupported backoff types', () => {
      expect(getBackoffDelay(1, 'UNKNOWN_TYPE' as any)).toBe(1000); // 2^0 * 1000
      expect(getBackoffDelay(3, 'UNKNOWN_TYPE' as any)).toBe(4000); // 2^2 * 1000
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
});