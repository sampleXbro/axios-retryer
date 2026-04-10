/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §10 RequestLifecycleManager, §11 RetryScheduler & TimerManager.
 */
import type { AxiosRequestConfig } from 'axios';

import { DefaultRetryStrategy } from '../src/core/strategies/DefaultRetryStrategy';
import { RequestLifecycleManager } from '../src/core/RequestLifecycleManager';
import { RequestQueue } from '../src/core/requestQueue';
import { RetryScheduler } from '../src/core/RetryScheduler';
import { TimerManager } from '../src/core/TimerManager';
import type { Logger, RetryStrategy } from '../src/types';
import { assignRequestMetadata } from '../src/utils/requestMetadata';

function createLogger(): Logger {
  return {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };
}

function createLifecycleFixture(): {
  rlm: RequestLifecycleManager;
  scheduler: RetryScheduler;
  onRequestCancelled: jest.Mock;
} {
  const logger = createLogger();
  const requestQueue = new RequestQueue({ maxConcurrent: 5, maxQueueSize: 100 });
  const scheduler = new RetryScheduler(logger, new DefaultRetryStrategy());
  const onRequestCancelled = jest.fn();
  const rlm = new RequestLifecycleManager({
    logger,
    requestQueue,
    retryScheduler: scheduler,
    onRequestCancelled,
  });
  return { rlm, scheduler, onRequestCancelled };
}

describe('P1 RequestLifecycleManager (§10)', () => {
  it('10.1.1 beginRequest assigns req_-prefixed id when none provided', () => {
    const { rlm } = createLifecycleFixture();
    const cfg: AxiosRequestConfig = { url: '/a' };
    const r = rlm.beginRequest(cfg);
    expect(r.requestId).toMatch(/^req_/);
    rlm.release(cfg);
  });

  it('10.1.2 beginRequest preserves user-supplied requestId', () => {
    const { rlm } = createLifecycleFixture();
    const cfg: AxiosRequestConfig = { url: '/b' };
    assignRequestMetadata(cfg, { requestId: 'user-req-1' });
    const r = rlm.beginRequest(cfg);
    expect(r.requestId).toBe('user-req-1');
    rlm.release(cfg);
  });

  it('10.1.4 pre-aborted caller signal yields callerAborted without tracking', () => {
    const { rlm } = createLifecycleFixture();
    const ac = new AbortController();
    ac.abort();
    const cfg: AxiosRequestConfig = { url: '/c', signal: ac.signal };
    const r = rlm.beginRequest(cfg);
    expect(r.callerAborted).toBe(true);
    expect(rlm.getActiveCount()).toBe(0);
  });

  it('10.1.5 getActiveCount increments on beginRequest and decrements on release', () => {
    const { rlm } = createLifecycleFixture();
    const cfg: AxiosRequestConfig = { url: '/d' };
    rlm.beginRequest(cfg);
    expect(rlm.getActiveCount()).toBe(1);
    rlm.release(cfg);
    expect(rlm.getActiveCount()).toBe(0);
  });

  it('10.1.6 release without requestId metadata returns released: false', () => {
    const { rlm } = createLifecycleFixture();
    expect(rlm.release({ url: '/z' }).released).toBe(false);
  });

  it('10.1.7 removeById for unknown id returns false', () => {
    const { rlm } = createLifecycleFixture();
    expect(rlm.removeById('req_nonexistent')).toBe(false);
  });

  it('10.3.2 cancelRequest for unknown id does not throw', () => {
    const { rlm, onRequestCancelled } = createLifecycleFixture();
    expect(() => rlm.cancelRequest('missing')).not.toThrow();
    expect(onRequestCancelled).not.toHaveBeenCalled();
  });

  it('10.4.1 generated ids use req_ prefix (10.4.2 uniqueness sequential)', () => {
    const { rlm } = createLifecycleFixture();
    const cfg1: AxiosRequestConfig = { url: '/1' };
    const a = rlm.beginRequest(cfg1).requestId;
    rlm.release(cfg1);
    const cfg2: AxiosRequestConfig = { url: '/2' };
    const b = rlm.beginRequest(cfg2).requestId;
    expect(a.startsWith('req_')).toBe(true);
    expect(b.startsWith('req_')).toBe(true);
    expect(a).not.toBe(b);
    rlm.release(cfg2);
  });
});

describe('P1 RetryScheduler (§11.1–11.2)', () => {
  const logger = createLogger();

  it('11.1.1 getRetryDelay uses strategy when metadata has no retryAfterMs', () => {
    const strategy: RetryStrategy = {
      getIsRetryable: () => true,
      shouldRetry: () => true,
      getDelay: jest.fn(() => 750),
    };
    const scheduler = new RetryScheduler(logger, strategy);
    const cfg: AxiosRequestConfig = { url: '/x' };
    assignRequestMetadata(cfg, { requestId: 'r1' });
    expect(scheduler.getRetryDelay(cfg, 0, 3)).toBe(750);
    expect(strategy.getDelay).toHaveBeenCalled();
  });

  it('11.1.2 getRetryDelay prefers retryAfterMs when it exceeds strategy delay', () => {
    const strategy: RetryStrategy = {
      getIsRetryable: () => true,
      shouldRetry: () => true,
      getDelay: () => 100,
    };
    const scheduler = new RetryScheduler(logger, strategy);
    const cfg: AxiosRequestConfig = { url: '/x' };
    assignRequestMetadata(cfg, { requestId: 'r2', retryAfterMs: 5000 });
    expect(scheduler.getRetryDelay(cfg, 0, 3)).toBe(5000);
  });

  it('11.1.3 getRetryDelay keeps strategy when retryAfterMs is smaller', () => {
    const strategy: RetryStrategy = {
      getIsRetryable: () => true,
      shouldRetry: () => true,
      getDelay: () => 2000,
    };
    const scheduler = new RetryScheduler(logger, strategy);
    const cfg: AxiosRequestConfig = { url: '/x' };
    assignRequestMetadata(cfg, { requestId: 'r3', retryAfterMs: 100 });
    expect(scheduler.getRetryDelay(cfg, 0, 3)).toBe(2000);
  });

  it('11.2.1 waitForRetryDelay resolves true after delay', async () => {
    jest.useFakeTimers();
    const scheduler = new RetryScheduler(logger, new DefaultRetryStrategy());
    const cfg: AxiosRequestConfig = { url: '/t' };
    assignRequestMetadata(cfg, { requestId: 't1' });
    const p = scheduler.waitForRetryDelay(cfg, 1000);
    jest.advanceTimersByTime(1000);
    await expect(p).resolves.toBe(true);
    jest.useRealTimers();
  });

  it('11.2.2 cancelling retry timer makes waitForRetryDelay resolve false', async () => {
    jest.useFakeTimers();
    const scheduler = new RetryScheduler(logger, new DefaultRetryStrategy());
    const cfg: AxiosRequestConfig = { url: '/t' };
    assignRequestMetadata(cfg, { requestId: 't2' });
    const p = scheduler.waitForRetryDelay(cfg, 10_000);
    expect(scheduler.cancelRetryTimer('t2')).toBe(true);
    await expect(p).resolves.toBe(false);
    jest.useRealTimers();
  });

  it('11.2.3 cancelRetryTimer for unknown id returns false', () => {
    const scheduler = new RetryScheduler(logger, new DefaultRetryStrategy());
    expect(scheduler.cancelRetryTimer('nope')).toBe(false);
  });

  it('11.2.6 waitForRetryDelay with 0 delay resolves true', async () => {
    const scheduler = new RetryScheduler(logger, new DefaultRetryStrategy());
    const cfg: AxiosRequestConfig = { url: '/t' };
    assignRequestMetadata(cfg, { requestId: 't0' });
    await expect(scheduler.waitForRetryDelay(cfg, 0)).resolves.toBe(true);
  });
});

describe('P1 TimerManager (§11.3)', () => {
  it('11.3.1 createTimeout runs callback after delay', async () => {
    jest.useFakeTimers();
    const tm = new TimerManager();
    const cb = jest.fn();
    tm.createTimeout(cb, 1000);
    jest.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('11.3.2 createTimeout cancel prevents callback', async () => {
    jest.useFakeTimers();
    const tm = new TimerManager();
    const cb = jest.fn();
    const { cancel } = tm.createTimeout(cb, 1000);
    cancel();
    jest.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('11.3.3 createSleep resolves after delay', async () => {
    jest.useFakeTimers();
    const tm = new TimerManager();
    const { promise } = tm.createSleep(500);
    jest.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
    jest.useRealTimers();
  });

  it('11.3.4 createSleep cancel rejects the promise', async () => {
    jest.useFakeTimers();
    const tm = new TimerManager();
    const { promise, cancel } = tm.createSleep(10_000);
    cancel();
    await expect(promise).rejects.toMatchObject({ code: 'ETIMER_CANCELLED' });
    jest.useRealTimers();
  });

  it('11.3.5–11.3.7 destroy clears active timers and zeroes count', async () => {
    jest.useFakeTimers();
    const tm = new TimerManager();
    tm.createTimeout(jest.fn(), 9999);
    expect(tm.getActiveTimerCount()).toBeGreaterThan(0);
    tm.destroy();
    jest.advanceTimersByTime(20_000);
    expect(tm.getActiveTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
