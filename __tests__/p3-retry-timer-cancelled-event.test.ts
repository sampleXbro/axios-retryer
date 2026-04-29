//@ts-nocheck
import { jest } from '@jest/globals';

import { RetryScheduler } from '../src/core/RetryScheduler';
import type { Logger, RetryStrategy } from '../src/types';

/**
 * Verifies that the RetryScheduler emits `onRetryTimerCancelled` with proper
 * source attribution when timers are cancelled.
 */
describe('RetryScheduler emits onRetryTimerCancelled', () => {
  let logger: Logger;
  let retryStrategy: RetryStrategy;
  let emitEvent: jest.Mock;

  beforeEach(() => {
    logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    retryStrategy = {
      getIsRetryable: () => true,
      shouldRetry: () => true,
      getDelay: () => 0,
    };
    emitEvent = jest.fn();
  });

  it("emits onRetryTimerCancelled with source 'user' when cancelRetryTimer is called", async () => {
    const scheduler = new RetryScheduler(logger, retryStrategy, emitEvent);
    const config = { url: '/x', __axiosRetryer: { requestId: 'req-1' } };
    const sleepPromise = scheduler.waitForRetryDelay(config, 60_000);

    // Cancel the in-flight timer immediately.
    expect(scheduler.cancelRetryTimer('req-1')).toBe(true);
    await sleepPromise;

    expect(emitEvent).toHaveBeenCalledWith('onRetryTimerCancelled', {
      requestId: 'req-1',
      source: 'user',
    });
  });

  it("emits onRetryTimerCancelled with source 'system' when cancelAllRetryTimers is called", async () => {
    const scheduler = new RetryScheduler(logger, retryStrategy, emitEvent);
    const c1 = { url: '/a', __axiosRetryer: { requestId: 'a' } };
    const c2 = { url: '/b', __axiosRetryer: { requestId: 'b' } };
    const p1 = scheduler.waitForRetryDelay(c1, 60_000);
    const p2 = scheduler.waitForRetryDelay(c2, 60_000);

    scheduler.cancelAllRetryTimers();
    await Promise.all([p1, p2]);

    const events = emitEvent.mock.calls.filter(([name]) => name === 'onRetryTimerCancelled');
    expect(events.length).toBe(2);
    for (const [, payload] of events) {
      expect(payload.source).toBe('system');
    }
    const seenIds = events.map(([, p]) => p.requestId).sort();
    expect(seenIds).toEqual(['a', 'b']);
  });

  it('does not emit when there is no active timer for the given requestId', () => {
    const scheduler = new RetryScheduler(logger, retryStrategy, emitEvent);
    expect(scheduler.cancelRetryTimer('non-existent')).toBe(false);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('respects an explicit source argument from cancelRetryTimer', async () => {
    const scheduler = new RetryScheduler(logger, retryStrategy, emitEvent);
    const config = { url: '/y', __axiosRetryer: { requestId: 'sys-cancel' } };
    const sleepPromise = scheduler.waitForRetryDelay(config, 60_000);

    expect(scheduler.cancelRetryTimer('sys-cancel', 'system')).toBe(true);
    await sleepPromise;

    expect(emitEvent).toHaveBeenCalledWith('onRetryTimerCancelled', {
      requestId: 'sys-cancel',
      source: 'system',
    });
  });
});
