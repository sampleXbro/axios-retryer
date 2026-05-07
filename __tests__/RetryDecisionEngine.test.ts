import type { AxiosError, AxiosResponse } from 'axios';

import { decideRetry, isNonRetryableInternalError } from '../src/core/interceptors/RetryDecisionEngine';
import { RETRY_MODES, type RetryMode, type RetryStrategy } from '../src/types';
import type { InternalAxiosRetryerRequestMetadata } from '../src/utils/requestMetadata';

const mockStrategy = (overrides: Partial<RetryStrategy> = {}): RetryStrategy => ({
  shouldRetry: jest.fn().mockReturnValue(true),
  getIsRetryable: jest.fn().mockReturnValue(true),
  getDelay: jest.fn().mockReturnValue(0),
  ...overrides,
});

const baseMetadata = (
  overrides: Partial<InternalAxiosRetryerRequestMetadata> = {},
): InternalAxiosRetryerRequestMetadata =>
  ({ requestId: 'r-1', priority: 0, timestamp: 0, ...overrides }) as InternalAxiosRetryerRequestMetadata;

const buildError = (overrides: Partial<AxiosError> = {}): AxiosError =>
  ({
    isAxiosError: true,
    name: 'AxiosError',
    message: 'boom',
    config: {},
    ...overrides,
  }) as AxiosError;

describe('RetryDecisionEngine.decideRetry', () => {
  const defaultMaxRetries = 3;
  const defaultMode: RetryMode = RETRY_MODES.AUTOMATIC;

  it('returns retry when in automatic mode and the strategy says retry', () => {
    const strategy = mockStrategy();
    const decision = decideRetry({
      error: buildError(),
      metadata: baseMetadata(),
      defaultMaxRetries,
      defaultMode,
      strategy,
      cancelledInQueue: false,
    });

    expect(decision.kind).toBe('retry');
    if (decision.kind === 'retry') {
      expect(decision.attempt).toBe(1);
      expect(decision.maxRetries).toBe(3);
      expect(decision.retryAfterMs).toBe(0);
    }
    expect(strategy.shouldRetry).toHaveBeenCalledWith(expect.any(Object), 1, 3);
  });

  it('respects per-request requestRetries override', () => {
    const strategy = mockStrategy();
    const decision = decideRetry({
      error: buildError(),
      metadata: baseMetadata({ requestRetries: 7 }),
      defaultMaxRetries,
      defaultMode,
      strategy,
      cancelledInQueue: false,
    });

    expect(decision.kind).toBe('retry');
    if (decision.kind === 'retry') {
      expect(decision.maxRetries).toBe(7);
    }
  });

  it('increments attempt based on metadata.retryAttempt', () => {
    const decision = decideRetry({
      error: buildError(),
      metadata: baseMetadata({ retryAttempt: 4 }),
      defaultMaxRetries,
      defaultMode,
      strategy: mockStrategy(),
      cancelledInQueue: false,
    });

    expect(decision.kind).toBe('retry');
    if (decision.kind === 'retry') {
      expect(decision.attempt).toBe(5);
    }
  });

  it('returns no-retry when cancelledInQueue is true', () => {
    const strategy = mockStrategy();
    const decision = decideRetry({
      error: buildError(),
      metadata: baseMetadata(),
      defaultMaxRetries,
      defaultMode,
      strategy,
      cancelledInQueue: true,
    });

    expect(decision.kind).toBe('no-retry');
    expect(strategy.shouldRetry).not.toHaveBeenCalled();
  });

  it('returns no-retry when error.code is a non-retryable internal code', () => {
    for (const code of ['REQUEST_CANCELED', 'EREQUEST_ABORTED', 'QUEUE_DESTROYED', 'QUEUE_CLEARED', 'EQUEUE_FULL']) {
      const decision = decideRetry({
        error: buildError({ code }),
        metadata: baseMetadata(),
        defaultMaxRetries,
        defaultMode,
        strategy: mockStrategy(),
        cancelledInQueue: false,
      });
      expect(decision.kind).toBe('no-retry');
    }
  });

  it('returns no-retry when in MANUAL mode regardless of strategy verdict', () => {
    const strategy = mockStrategy({ shouldRetry: jest.fn().mockReturnValue(true) });
    const decision = decideRetry({
      error: buildError(),
      metadata: baseMetadata({ requestMode: RETRY_MODES.MANUAL }),
      defaultMaxRetries,
      defaultMode,
      strategy,
      cancelledInQueue: false,
    });
    expect(decision.kind).toBe('no-retry');
  });

  it('returns no-retry when strategy.shouldRetry returns false', () => {
    const strategy = mockStrategy({ shouldRetry: jest.fn().mockReturnValue(false) });
    const decision = decideRetry({
      error: buildError(),
      metadata: baseMetadata(),
      defaultMaxRetries,
      defaultMode,
      strategy,
      cancelledInQueue: false,
    });

    expect(decision.kind).toBe('no-retry');
    if (decision.kind === 'no-retry') {
      expect(decision.retryable).toBe(true); // getIsRetryable still consulted for emission
    }
  });

  it('parses Retry-After header into retryAfterMs', () => {
    const responseHeaders = { 'retry-after': '2' };
    const decision = decideRetry({
      error: buildError({
        response: {
          status: 429,
          statusText: 'Too Many Requests',
          headers: responseHeaders,
          data: null,
          config: {},
        } as unknown as AxiosResponse,
      }),
      metadata: baseMetadata(),
      defaultMaxRetries,
      defaultMode,
      strategy: mockStrategy(),
      cancelledInQueue: false,
    });

    expect(decision.kind).toBe('retry');
    if (decision.kind === 'retry') {
      expect(decision.retryAfterMs).toBe(2_000);
    }
  });
});

describe('isNonRetryableInternalError', () => {
  it('returns true for known internal codes', () => {
    for (const code of ['REQUEST_CANCELED', 'EREQUEST_ABORTED', 'QUEUE_DESTROYED', 'QUEUE_CLEARED', 'EQUEUE_FULL']) {
      expect(isNonRetryableInternalError(buildError({ code }))).toBe(true);
    }
  });

  it('returns false for unrelated codes', () => {
    expect(isNonRetryableInternalError(buildError({ code: 'ECONNREFUSED' }))).toBe(false);
    expect(isNonRetryableInternalError(buildError())).toBe(false);
  });
});
