import { AxiosError } from 'axios';

//Mock для getBackoffDelay
jest.mock('../src/utils', () => ({
  getBackoffDelay: jest.fn((attempt: number, type: AxiosRetryerBackoffType) => {
    if (type === AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL) return 100 * Math.pow(2, attempt - 1);
    if (type === AXIOS_RETRYER_BACKOFF_TYPES.LINEAR) return 100 * attempt;
    return 0;
  }),
}));

import { DefaultRetryStrategy } from '../src/core/DefaultRetryStrategy';
import { AXIOS_RETRYER_BACKOFF_TYPES, AxiosRetryerBackoffType } from '../src';

describe('DefaultRetryStrategy - Extended Tests', () => {
  const retryableStatuses: (number | [number, number])[] = [408, 429, 500, [502, 504]];
  const retryableMethods = ['get', 'head', 'options'];
  const mockLogger = jest.fn();

  const strategy = new DefaultRetryStrategy(
    retryableStatuses,
    retryableMethods,
    AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
    ['Idempotency-Key'],
    mockLogger,
  );

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getIsRetryable - Extended', () => {
    it('should return false if error.config is undefined', () => {
      const error = {
        response: { status: 429 },
        config: undefined,
      } as AxiosError;

      expect(strategy.getIsRetryable(error)).toBe(false);
      expect(mockLogger).toHaveBeenCalledWith('Not retrying request with method undefined and status 429');
    });

    it('should return false if method is missing in config', () => {
      const error = {
        response: { status: 429 },
        config: {},
      } as AxiosError;

      expect(strategy.getIsRetryable(error)).toBe(false);
      expect(mockLogger).toHaveBeenCalledWith('Not retrying request with method undefined and status 429');
    });

    it('should handle custom idempotency headers', () => {
      const customStrategy = new DefaultRetryStrategy(
        retryableStatuses,
        retryableMethods,
        AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
        ['Custom-Idempotency-Key'],
        mockLogger,
      );

      const error = {
        response: { status: 500 },
        config: { method: 'post', headers: { 'Custom-Idempotency-Key': 'value' } },
      } as unknown as AxiosError;

      expect(customStrategy.getIsRetryable(error)).toBe(true);
      expect(mockLogger).toHaveBeenCalledWith('Retrying idempotent request with method post');
    });

    it('should return true for retryable statuses in ranges', () => {
      const error = {
        response: { status: 503 },
        config: { method: 'get' },
      } as AxiosError;

      expect(strategy.getIsRetryable(error)).toBe(true);
      expect(mockLogger).toHaveBeenCalledWith('Retrying request with status 503 and method get');
    });

    it('should return false for status outside defined ranges', () => {
      const error = {
        response: { status: 511 },
        config: { method: 'get' },
      } as AxiosError;

      expect(strategy.getIsRetryable(error)).toBe(false);
      expect(mockLogger).toHaveBeenCalledWith('Not retrying request with method get and status 511');
    });
  });

  describe('shouldRetry - Extended', () => {
    it('should handle undefined response in error', () => {
      const error = {
        response: undefined,
        config: { method: 'get' },
      } as AxiosError;

      expect(strategy.shouldRetry(error, 1, 3)).toBe(true);
      expect(mockLogger).toHaveBeenCalledWith('Should retry: true, attempt 1/3');
    });

    it('should handle custom maxRetries limit', () => {
      const error = {
        response: { status: 500 },
        config: { method: 'get' },
      } as AxiosError;

      expect(strategy.shouldRetry(error, 5, 4)).toBe(false);
      expect(mockLogger).toHaveBeenCalledWith('Should retry: false, attempt 5/4');
    });
  });

  describe('getDelay - Extended', () => {
    it('should return exponential delay', () => {
      const delay = strategy.getDelay(2);
      expect(delay).toBe(200); // 100 * 2^(2-1)
      expect(mockLogger).toHaveBeenCalledWith('Retry delay for attempt 2: 200ms');
    });

    it('should handle LINEAR backoff type', () => {
      const linearStrategy = new DefaultRetryStrategy(
        retryableStatuses,
        retryableMethods,
        AXIOS_RETRYER_BACKOFF_TYPES.LINEAR,
        ['Idempotency-Key'],
        mockLogger,
      );

      const delay = linearStrategy.getDelay(3);
      expect(delay).toBe(300); // 100 * 3
      expect(mockLogger).toHaveBeenCalledWith('Retry delay for attempt 3: 300ms');
    });

    it('should return 0 for unknown backoff type', () => {
      const customStrategy = new DefaultRetryStrategy(
        retryableStatuses,
        retryableMethods,
        'UNKNOWN' as any,
        ['Idempotency-Key'],
        mockLogger,
      );

      const delay = customStrategy.getDelay(3);
      expect(delay).toBe(0);
      expect(mockLogger).toHaveBeenCalledWith('Retry delay for attempt 3: 0ms');
    });
  });
});