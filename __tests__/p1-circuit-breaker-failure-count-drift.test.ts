//@ts-nocheck
import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';

import { type RetryManager } from '../src';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';

/**
 * Verifies that `_cleanupOldFailures` keeps `failureCount` aligned with the
 * in-window `recentFailures` list when the sliding window evicts old entries.
 * Without this fix, `failureCount` drifted upward forever because it was only
 * incremented, never decremented when entries aged out.
 */
describe('CircuitBreakerPlugin sliding window failureCount drift', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let manager: RetryManager;
  let plugin: CircuitBreakerPlugin;

  const fakeLogger = {
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });

    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
    manager = {
      axiosInstance,
      getLogger: () => fakeLogger,
    } as unknown as RetryManager;

    plugin = new CircuitBreakerPlugin({
      failureThreshold: 100, // do NOT trip; we want to observe count drift
      openTimeout: 60_000,
      halfOpenMax: 1,
      successThreshold: 1,
      useSlidingWindow: true,
      slidingWindowSize: 1_000, // 1 second window
    });
    plugin.initialize(manager);
  });

  afterEach(() => {
    jest.useRealTimers();
    mock.reset();
    jest.clearAllMocks();
  });

  it('decrements failureCount as old entries fall out of the sliding window', async () => {
    mock.onGet('/api/data').reply(500);

    // Fire 3 failures in the first window.
    for (let i = 0; i < 3; i += 1) {
      await expect(axiosInstance.get('/api/data')).rejects.toThrow();
    }

    expect(plugin.getMetrics().failureCount).toBe(3);
    expect(plugin.getMetrics().failuresInWindow).toBe(3);

    // Advance past the sliding window. Earlier failures should age out.
    jest.advanceTimersByTime(1_500);

    // Trigger a single new failure inside the new window.
    await expect(axiosInstance.get('/api/data')).rejects.toThrow();

    const metrics = plugin.getMetrics();
    // Only the most recent failure should be inside the window.
    expect(metrics.failuresInWindow).toBe(1);
    // Without the fix, failureCount would be 4. With the fix, drift is corrected
    // when entries age out, so it ends at 1 (3 evicted, then 1 added).
    expect(metrics.failureCount).toBe(1);
  });

  it('keeps failureCount and failuresInWindow in sync after multiple eviction cycles', async () => {
    mock.onGet('/api/data').reply(500);

    // 4 cycles: fail 2x, advance window so they age out before the next batch.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await expect(axiosInstance.get('/api/data')).rejects.toThrow();
      await expect(axiosInstance.get('/api/data')).rejects.toThrow();
      jest.advanceTimersByTime(1_500);
    }

    // After every fresh failure, recordFailure() runs cleanup() which evicts
    // out-of-window entries AND now decrements failureCount. So at the start of
    // each new cycle, the prior 2 entries are evicted before the new ones
    // increment. Net result over 4 cycles: failureCount must equal the most
    // recent batch (2), not 8 as it would without the fix.
    await expect(axiosInstance.get('/api/data')).rejects.toThrow();
    const metrics = plugin.getMetrics();
    expect(metrics.failuresInWindow).toBe(1);
    expect(metrics.failureCount).toBe(1);
  });
});
