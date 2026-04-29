//@ts-nocheck
import { jest } from '@jest/globals';
import axios from 'axios';

import { RetryManager } from '../src';
import { CachingPlugin } from '../src/plugins/CachingPlugin/CachingPlugin';

/**
 * Verifies that periodic cache cleanup is wrapped in a timeout and that the
 * cleanup interval auto-disables after repeated consecutive failures.
 */
describe('CachingPlugin periodic cleanup timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('auto-disables the cleanup interval after CACHE_CLEANUP_DISABLE_AFTER consecutive failures', async () => {
    const errorLog = jest.fn();
    const warnLog = jest.fn();

    const axiosInstance = axios.create();
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      logger: {
        log: jest.fn(),
        debug: jest.fn(),
        warn: warnLog,
        error: errorLog,
      },
    });

    // Make runCacheCleanup throw synchronously by stubbing storage.entries() to reject.
    const plugin = new CachingPlugin({
      cleanupInterval: 1_000,
      maxAge: 0, // disables age-based cleanup but the periodic loop still runs
    });

    manager.use(plugin);

    // Force every cleanup invocation to fail by replacing the private runCacheCleanup
    // method with one that always rejects.
    (plugin as { runCacheCleanup: () => Promise<void> }).runCacheCleanup = jest.fn(() =>
      Promise.reject(new Error('storage exploded')),
    );

    // Advance through 5 cleanup cycles. Each rejects synchronously, so a single
    // microtask flush per tick is enough.
    for (let i = 0; i < 5; i += 1) {
      jest.advanceTimersByTime(1_001);
      // Allow the rejected promise + .catch handler to run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    // After 5 failures, the cleanup interval should have been cleared.
    const runner = (plugin as { cleanup: { timer: unknown; consecutiveFailureCount: number } }).cleanup;
    expect(runner.timer).toBeNull();

    // The "disabling" error log should have fired exactly once.
    expect(errorLog).toHaveBeenCalledWith(
      '[CachingPlugin] Disabling cleanup after repeated failures',
      expect.objectContaining({ consecutiveFailures: 5 }),
    );

    // Subsequent ticks should NOT increment failure counter further.
    const failuresAtDisable = runner.consecutiveFailureCount;
    jest.advanceTimersByTime(5_000);
    expect(runner.consecutiveFailureCount).toBe(failuresAtDisable);
  });

  it('resets failure counter when cleanup succeeds', async () => {
    const axiosInstance = axios.create();
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      logger: { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const plugin = new CachingPlugin({ cleanupInterval: 1_000, maxAge: 0 });
    manager.use(plugin);

    // First two ticks fail, third succeeds.
    let callCount = 0;
    (plugin as { runCacheCleanup: () => Promise<void> }).runCacheCleanup = jest.fn(() => {
      callCount += 1;
      if (callCount <= 2) return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });

    for (let i = 0; i < 3; i += 1) {
      jest.advanceTimersByTime(1_001);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    const runner = (plugin as { cleanup: { timer: unknown; consecutiveFailureCount: number } }).cleanup;
    expect(runner.consecutiveFailureCount).toBe(0);
    expect(runner.timer).not.toBeNull();
  });
});
