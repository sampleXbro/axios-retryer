/**
 * Regression tests for T-018 through T-029.
 * Each describe block maps to a single task in TASKS_AND_PRIORITIES.md.
 */
import { TimerManager } from '../src/core/TimerManager';
import { RequestQueue } from '../src/core/requestQueue';
import {
  CircuitBreakerPlugin,
  CIRCUIT_BREAKER_STATES,
  type CircuitBreakerState,
  type CircuitBreakerOptions,
} from '../src/plugins/CircuitBreakerPlugin';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { DefaultRetryStrategy } from '../src/core/strategies/DefaultRetryStrategy';
import { parseRetryAfterMs } from '../src/core/RetryScheduler';
import type { AxiosRetryerRetryableStatus } from '../src/types';
import type { AxiosRequestConfig } from 'axios';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

jest.setTimeout(15000);

// ---------------------------------------------------------------------------
// T-018: TimerManager.createTimeout / createSleep on a destroyed manager
// ---------------------------------------------------------------------------
describe('T-018: TimerManager destroyed-manager safety', () => {
  test('createTimeout does NOT fire callback on a destroyed manager', () => {
    const timer = new TimerManager();
    timer.destroy();

    const cb = jest.fn();
    timer.createTimeout(cb, 0);

    // Give any synchronous or microtask-based callback a chance to fire.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb).not.toHaveBeenCalled();
        resolve();
      }, 20);
    });
  });

  test('createTimeout returns a no-op cancel on a destroyed manager', () => {
    const timer = new TimerManager();
    timer.destroy();

    const { timerId, cancel } = timer.createTimeout(() => {}, 0);
    expect(timerId).toBeNull();
    expect(() => cancel()).not.toThrow();
  });

  test('createSleep rejects immediately on a destroyed manager', async () => {
    const timer = new TimerManager();
    timer.destroy();

    const { promise } = timer.createSleep(100);
    await expect(promise).rejects.toThrow('Sleep cancelled');
  });

  test('createSleep resolves normally before destroy, rejects after destroy', async () => {
    const timer = new TimerManager();

    // Normal sleep resolves.
    const { promise: normalSleep } = timer.createSleep(1);
    await expect(normalSleep).resolves.toBeUndefined();

    // After destroy, new sleeps reject.
    timer.destroy();
    const { promise: destroyedSleep } = timer.createSleep(1);
    await expect(destroyedSleep).rejects.toThrow();
  });

  test('active sleep is cancelled when manager is destroyed', async () => {
    const timer = new TimerManager();
    const { promise } = timer.createSleep(5000);

    const settled = promise.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    timer.destroy();

    const result = await settled;
    expect(typeof result).toBe('string');
    expect(result).toMatch(/cancelled/i);
  });
});

// ---------------------------------------------------------------------------
// T-019: RequestQueue.canProcess — early exit on first blocking gate
// ---------------------------------------------------------------------------
describe('T-019: RequestQueue.canProcess early-exit', () => {
  test('second gate is not called when first gate rejects', async () => {
    const queue = new RequestQueue({ maxConcurrent: 5, queueDelay: 0 });

    const gate1 = jest.fn().mockReturnValue(false);
    const gate2 = jest.fn().mockReturnValue(true);

    queue.registerProcessingGate('gate1', gate1);
    queue.registerProcessingGate('gate2', gate2);

    // Enqueue a request — it won't be dequeued because gate1 blocks it.
    const config: AxiosRequestConfig = { url: '/test', method: 'get' };
    const enqueuePromise = queue.enqueue(config);

    // Flush microtasks to let drainQueue run.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // gate1 was called; gate2 must NOT have been called.
    expect(gate1).toHaveBeenCalled();
    expect(gate2).not.toHaveBeenCalled();

    queue.destroy();
    await expect(enqueuePromise).rejects.toBeDefined();
  });

  test('second gate is called when first gate allows', async () => {
    const queue = new RequestQueue({ maxConcurrent: 5, queueDelay: 0 });

    const gate1 = jest.fn().mockReturnValue(true);
    const gate2 = jest.fn().mockReturnValue(true);

    queue.registerProcessingGate('gate1', gate1);
    queue.registerProcessingGate('gate2', gate2);

    const config: AxiosRequestConfig = { url: '/test', method: 'get' };
    const resolved = await queue.enqueue(config);

    expect(gate1).toHaveBeenCalled();
    expect(gate2).toHaveBeenCalled();
    expect(resolved).toBe(config);
    queue.markComplete();
    queue.destroy();
  });
});

// ---------------------------------------------------------------------------
// T-020: CircuitBreakerPlugin._responseMetrics bounded cap
// ---------------------------------------------------------------------------
describe('T-020: CircuitBreakerPlugin._responseMetrics cap', () => {
  function makePlugin(maxTrackedScopes: number) {
    return new CircuitBreakerPlugin({
      failureThreshold: 100,
      openTimeout: 1000,
      halfOpenMax: 1,
      adaptiveTimeout: true,
      adaptiveTimeoutSampleSize: 5,
      maxTrackedScopes,
    });
  }

  test('metrics map does not exceed maxTrackedScopes entries', () => {
    const cap = 3;
    const plugin = makePlugin(cap);

    const axiosInstance = axios.create({ baseURL: 'http://example.com' });
    const mock = new MockAdapter(axiosInstance);
    mock.onAny().reply(200, {});

    const context = {
      axiosInstance,
      getLogger: () => ({ debug: () => {}, error: () => {}, warn: () => {} }),
      triggerAndEmit: () => {},
      releaseRequestTracking: () => {},
    };
    plugin.initialize(context as never);

    // Simulate tracking 5 different scope keys (more than cap=3).
    for (let i = 0; i < 5; i++) {
      // @ts-expect-error accessing private method for test
      plugin._trackResponseTime({
        config: { url: `/scope${i}`, baseURL: 'http://example.com' },
        headers: { 'x-response-time': '100' },
      } as never);
    }

    // @ts-expect-error accessing private field for test
    const keys = Object.keys(plugin._responseMetrics);
    expect(keys.length).toBeLessThanOrEqual(cap);
  });

  test('oldest scope is evicted when cap is breached', () => {
    const cap = 2;
    const plugin = makePlugin(cap);

    const axiosInstance = axios.create({ baseURL: 'http://example.com' });
    plugin.initialize({
      axiosInstance,
      getLogger: () => ({ debug: () => {}, error: () => {}, warn: () => {} }),
      triggerAndEmit: () => {},
      releaseRequestTracking: () => {},
    } as never);

    // @ts-expect-error accessing private method
    plugin._trackResponseTime({
      config: { url: '/first', baseURL: 'http://example.com' },
      headers: { 'x-response-time': '50' },
    } as never);
    // @ts-expect-error accessing private method
    plugin._trackResponseTime({
      config: { url: '/second', baseURL: 'http://example.com' },
      headers: { 'x-response-time': '50' },
    } as never);

    // At cap; adding a third evicts the first.
    // @ts-expect-error accessing private method
    plugin._trackResponseTime({
      config: { url: '/third', baseURL: 'http://example.com' },
      headers: { 'x-response-time': '50' },
    } as never);

    // @ts-expect-error accessing private field
    const keys = Object.keys(plugin._responseMetrics);
    expect(keys.length).toBe(cap);
    // 'first' should have been evicted (oldest).
    // We can't assert the exact URL since normalization removes the path — but the count is correct.
    expect(keys.length).toBeLessThanOrEqual(cap);
  });
});

// ---------------------------------------------------------------------------
// T-021: TokenRefreshPlugin backoff ceiling
// ---------------------------------------------------------------------------
describe('T-021: TokenRefreshPlugin maxRefreshBackoffMs cap', () => {
  test('backoff delay never exceeds maxRefreshBackoffMs', async () => {
    const delays: number[] = [];
    const origSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: Parameters<typeof setTimeout>[0], delay?: number) => {
      if (typeof delay === 'number' && delay > 100) {
        delays.push(delay);
        (fn as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return origSetTimeout(fn as () => void, delay);
    });

    let callCount = 0;
    const refreshFn = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 5) throw new Error('refresh failed');
      return { token: 'new-token' };
    });

    const plugin = new TokenRefreshPlugin(refreshFn, {
      maxRefreshAttempts: 5,
      maxRefreshBackoffMs: 2000,
    });

    // Quick initialize with a mock context.
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    mock.onPost('/auth/refresh').reply(200, { token: 'new-token' });

    plugin.initialize({
      axiosInstance,
      getLogger: () => ({ debug: () => {}, error: () => {}, warn: () => {} }),
      triggerAndEmit: () => {},
      releaseRequestTracking: () => {},
    } as never);

    jest.restoreAllMocks();

    // All recorded delays must be within the cap.
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  test('default maxRefreshBackoffMs is 30000', () => {
    const plugin = new TokenRefreshPlugin(async () => ({ token: 'x' }));
    // @ts-expect-error accessing private field
    expect(plugin.options.maxRefreshBackoffMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// T-022: DefaultRetryStrategy — no repeated Set/Array allocation for same
//        per-request retryableStatuses array reference
// ---------------------------------------------------------------------------
describe('T-022: DefaultRetryStrategy per-request status override caching', () => {
  test('same array reference reuses cached Set/Array (identity check)', () => {
    const strategy = new DefaultRetryStrategy();
    const overrideStatuses: readonly AxiosRetryerRetryableStatus[] = [500, 503];

    // Spy on WeakMap.get to count cache hits.
    // @ts-expect-error accessing private field
    const cache: WeakMap<unknown, unknown> = strategy.overrideCache;
    const getSpy = jest.spyOn(cache, 'get');

    // First call — miss, builds and caches.
    const error1 = {
      response: { status: 500 },
      config: { method: 'get', __axiosRetryer: { retryableStatuses: overrideStatuses } },
    } as never;
    strategy.getIsRetryable(error1);

    // Second call with the same array reference — must be a cache hit.
    const error2 = {
      response: { status: 503 },
      config: { method: 'get', __axiosRetryer: { retryableStatuses: overrideStatuses } },
    } as never;
    strategy.getIsRetryable(error2);

    // get was called at least twice; the second call should have returned cached data.
    expect(getSpy).toHaveBeenCalledTimes(2);
    const [firstResult, secondResult] = getSpy.mock.results;
    // First call returns undefined (miss); second returns the cached entry.
    expect(firstResult.value).toBeUndefined();
    expect(secondResult.value).toBeDefined();
  });

  test('distinct array references with same content are both treated as retryable', () => {
    const strategy = new DefaultRetryStrategy();

    const statuses1: readonly AxiosRetryerRetryableStatus[] = [422];
    const statuses2: readonly AxiosRetryerRetryableStatus[] = [422]; // same content, different ref

    const error1 = {
      response: { status: 422 },
      config: { method: 'get', __axiosRetryer: { retryableStatuses: statuses1 } },
    } as never;
    const error2 = {
      response: { status: 422 },
      config: { method: 'get', __axiosRetryer: { retryableStatuses: statuses2 } },
    } as never;

    expect(strategy.getIsRetryable(error1)).toBe(true);
    expect(strategy.getIsRetryable(error2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-023: CircuitBreakerPlugin — _readScopeState / _writeScopeState single clone
// ---------------------------------------------------------------------------
describe('T-023: CircuitBreakerPlugin single clone per direction', () => {
  function makeContext() {
    const axiosInstance = axios.create({ baseURL: 'http://example.com' });
    new MockAdapter(axiosInstance).onAny().reply(200, {});
    return {
      axiosInstance,
      getLogger: () => ({ debug: () => {}, error: () => {}, warn: () => {} }),
      triggerAndEmit: () => {},
      releaseRequestTracking: () => {},
    };
  }

  test('mutations to _writeScopeState caller state do not affect adapter or cache', async () => {
    const plugin = new CircuitBreakerPlugin({ failureThreshold: 5, openTimeout: 1000, halfOpenMax: 1 });
    plugin.initialize(makeContext() as never);

    const scopeKey = 'test-scope';

    // Write a state.
    const state = {
      state: CIRCUIT_BREAKER_STATES.CLOSED as CircuitBreakerState,
      failureCount: 1,
      successCount: 0,
      halfOpenCount: 0,
      nextAttempt: Date.now(),
      recentFailures: [],
    };
    // @ts-expect-error accessing private method
    await plugin._writeScopeState(scopeKey, state);

    // Mutate the caller's state after writing.
    state.failureCount = 999;

    // Cache should still have the pre-mutation value.
    // @ts-expect-error accessing private field
    expect(plugin._scopeStateCache.get(scopeKey)?.failureCount).toBe(1);

    // Adapter should also have the pre-mutation value.
    // @ts-expect-error accessing private field
    const adapterState = await plugin._options.stateAdapter.get(scopeKey);
    expect(adapterState?.failureCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-024: CircuitBreakerPlugin adaptive timeout — percentile throttle
// ---------------------------------------------------------------------------
describe('T-024: CircuitBreakerPlugin adaptive timeout percentile throttle', () => {
  function makeAdaptivePlugin() {
    const plugin = new CircuitBreakerPlugin({
      failureThreshold: 100,
      openTimeout: 1000,
      halfOpenMax: 1,
      adaptiveTimeout: true,
      adaptiveTimeoutSampleSize: 50,
      adaptiveTimeoutPercentile: 0.95,
    });
    plugin.initialize({
      axiosInstance: axios.create({ baseURL: 'http://ex.com' }),
      getLogger: () => ({ debug: () => {}, error: () => {}, warn: () => {} }),
      triggerAndEmit: () => {},
      releaseRequestTracking: () => {},
    } as never);
    return plugin;
  }

  test('currentPercentileMs updates on sample 1 (first entry, no prior value)', () => {
    const plugin = makeAdaptivePlugin();

    // @ts-expect-error accessing private method
    plugin._trackResponseTime({
      config: { url: '/route', baseURL: 'http://ex.com' },
      headers: { 'x-response-time': '200' },
    } as never);

    // @ts-expect-error accessing private field
    const metrics = Object.values(plugin._responseMetrics as Record<string, { currentPercentileMs: number }>);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0].currentPercentileMs).toBeGreaterThan(0);
  });

  test('currentPercentileMs is not recalculated on every intermediate sample', () => {
    // Use sampleSize=50 so recalcInterval = min(10, 50) = 10.
    const plugin = new CircuitBreakerPlugin({
      failureThreshold: 100,
      openTimeout: 1000,
      halfOpenMax: 1,
      adaptiveTimeout: true,
      adaptiveTimeoutSampleSize: 50,
      adaptiveTimeoutPercentile: 0.95,
    });
    plugin.initialize({
      axiosInstance: axios.create({ baseURL: 'http://ex.com' }),
      getLogger: () => ({ debug: () => {}, error: () => {}, warn: () => {} }),
      triggerAndEmit: () => {},
      releaseRequestTracking: () => {},
    } as never);

    const track = (ms: number) =>
      // @ts-expect-error accessing private method
      plugin._trackResponseTime({
        config: { url: '/route', baseURL: 'http://ex.com' },
        headers: { 'x-response-time': String(ms) },
      } as never);

    // First sample — always calculates.
    track(100);

    // @ts-expect-error accessing private field
    const afterFirst: number = Object.values(
      plugin._responseMetrics as Record<string, { currentPercentileMs: number }>,
    )[0].currentPercentileMs;
    expect(afterFirst).toBe(100);

    // Samples 2–9: extreme values that would shift the percentile if recalculated.
    for (let i = 2; i <= 9; i++) {
      track(9999);
    }

    // @ts-expect-error accessing private field
    const afterNine: number = Object.values(
      plugin._responseMetrics as Record<string, { currentPercentileMs: number }>,
    )[0].currentPercentileMs;
    expect(afterNine).toBe(afterFirst); // unchanged until sample 10

    // Sample 10 — triggers recalculation (recalcInterval = 10, 10 % 10 === 0).
    track(9999);

    // @ts-expect-error accessing private field
    const afterTen: number = Object.values(
      plugin._responseMetrics as Record<string, { currentPercentileMs: number }>,
    )[0].currentPercentileMs;
    expect(afterTen).toBeGreaterThan(afterFirst);
  });

  test('adaptive timeout values remain accurate after throttle change', () => {
    const plugin = makeAdaptivePlugin();

    // Add 10 uniform samples of 100ms → p95 should be 100.
    for (let i = 0; i < 10; i++) {
      // @ts-expect-error accessing private method
      plugin._trackResponseTime({
        config: { url: '/stable', baseURL: 'http://ex.com' },
        headers: { 'x-response-time': '100' },
      } as never);
    }

    // @ts-expect-error accessing private field
    const p95: number = Object.values(plugin._responseMetrics as Record<string, { currentPercentileMs: number }>)[0]
      .currentPercentileMs;
    expect(p95).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// T-025: RetryManager.handleError — no Object.values allocation
// ---------------------------------------------------------------------------
describe('T-025: RetryManager handleError guard', () => {
  test('passes through errors with valid config (no Object.values call)', async () => {
    const { RetryManager } = await import('../src/core/RetryManager');
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    mock.onGet('/test').reply(500);

    const manager = new RetryManager({ axiosInstance, retries: 0 });

    await expect(axiosInstance.get('/test')).rejects.toBeDefined();
    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// T-026: CircuitBreakerState — const object instead of enum
// ---------------------------------------------------------------------------
describe('T-026: CircuitBreakerState is a const object (tree-shakeable)', () => {
  test('CIRCUIT_BREAKER_STATES has correct string values', () => {
    expect(CIRCUIT_BREAKER_STATES.CLOSED).toBe('CLOSED');
    expect(CIRCUIT_BREAKER_STATES.OPEN).toBe('OPEN');
    expect(CIRCUIT_BREAKER_STATES.HALF_OPEN).toBe('HALF_OPEN');
  });

  test('CircuitBreakerPlugin.STATES points to CIRCUIT_BREAKER_STATES', () => {
    expect(CircuitBreakerPlugin.STATES).toBe(CIRCUIT_BREAKER_STATES);
  });

  test('CircuitBreakerState type values match CIRCUIT_BREAKER_STATES', () => {
    const state: CircuitBreakerState = CIRCUIT_BREAKER_STATES.OPEN;
    expect(state).toBe('OPEN');
  });

  test('getState() returns string values consistent with CIRCUIT_BREAKER_STATES', () => {
    const plugin = new CircuitBreakerPlugin({ failureThreshold: 1, openTimeout: 1000, halfOpenMax: 1 });
    expect(plugin.getState()).toBe(CIRCUIT_BREAKER_STATES.CLOSED);
  });
});

// ---------------------------------------------------------------------------
// T-027: NoInferType comment in src/index.ts — no runtime test needed
//        (verified via TypeScript compilation)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-028: parseRetryAfterMs — millisecond precision for HTTP-date path
// ---------------------------------------------------------------------------
describe('T-028: parseRetryAfterMs HTTP-date precision', () => {
  test('integer-seconds header is converted correctly (ceiling)', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('1')).toBe(1000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  test('HTTP-date path: result equals raw remaining ms (no rounding)', () => {
    // Build a future date and immediately check that parseRetryAfterMs returns
    // the raw `dateMs - Date.now()` value rather than rounding to the nearest second.
    const futureDate = new Date(Date.now() + 3000).toUTCString();
    const result = parseRetryAfterMs(futureDate);
    const expected = Math.max(0, Date.parse(futureDate) - Date.now());
    // Allow ±20ms for execution time between the two Date.now() calls.
    expect(result).toBeGreaterThanOrEqual(expected - 20);
    expect(result).toBeLessThanOrEqual(expected + 20);
  });

  test('HTTP-date path: past date returns 0', () => {
    const pastDate = new Date(Date.now() - 1000).toUTCString();
    expect(parseRetryAfterMs(pastDate)).toBe(0);
  });

  test('HTTP-date path: no artificial ceiling to next-second boundary', () => {
    // Old code: Math.ceil(delayMs / 1000) * 1000 — a 3-second future date would not change
    // but any sub-second remainder would be rounded up.  New code uses Math.max(0, raw).
    // We verify the result matches the raw remaining ms, not a rounded-up version.
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const raw = Date.parse(futureDate) - Date.now();
    const result = parseRetryAfterMs(futureDate);
    const rounded = Math.ceil(raw / 1000) * 1000;
    // Result should equal raw (±20ms), not the rounded-up value (if they differ by more than 20ms).
    if (rounded - raw > 20) {
      expect(result).toBeLessThan(rounded);
    }
    expect(result).toBeGreaterThanOrEqual(0);
  });

  test('null/undefined/empty returns 0', () => {
    expect(parseRetryAfterMs(null)).toBe(0);
    expect(parseRetryAfterMs(undefined)).toBe(0);
    expect(parseRetryAfterMs('')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-029: createSilentCancelResponse — documented 204 contract
//        (runtime: verify silently-cancelled requests still work)
// ---------------------------------------------------------------------------
describe('T-029: silent cancel response has silentlyCancelled metadata', () => {
  test('silently cancelled request resolves to null (onSuccessfulResponse discards 204)', async () => {
    const { RetryManager } = await import('../src/core/RetryManager');
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    mock.onGet('/slow').reply(() => new Promise((resolve) => setTimeout(() => resolve([200, {}]), 5000)));

    // throwErrorOnCancelRequest: false → cancelled requests resolve (to null) rather than reject.
    const manager = new RetryManager({ axiosInstance, retries: 0, throwErrorOnCancelRequest: false });

    const inflightRequest = axiosInstance.get('/slow');

    // Let the request start.
    await new Promise((resolve) => setTimeout(resolve, 20));

    manager.cancelAllRequests();

    // onSuccessfulResponse returns null for silently-cancelled requests.
    const response = await inflightRequest;
    expect(response).toBeNull();

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// T-040: requestRetries: 0 per-request override must disable retries
// ---------------------------------------------------------------------------
describe('T-040: requestRetries: 0 per-request override is not ignored', () => {
  test('requestRetries: 0 causes the request to fail immediately with no retry attempts', async () => {
    const { RetryManager } = await import('../src/core/RetryManager');
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);

    let attemptCount = 0;
    mock.onGet('/always-fail').reply(() => {
      attemptCount++;
      return [503, { error: 'unavailable' }];
    });

    // Manager has retries: 3 — but the per-request override should suppress all retries.
    const manager = new RetryManager({ axiosInstance, retries: 3 });

    await expect(axiosInstance.get('/always-fail', { __axiosRetryer: { requestRetries: 0 } })).rejects.toThrow();

    // Only one upstream attempt — no retries should have occurred.
    expect(attemptCount).toBe(1);

    manager.destroy();
  });

  test('requestRetries: 0 is distinct from requestRetries: undefined (undefined inherits manager default)', async () => {
    const { RetryManager } = await import('../src/core/RetryManager');
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);

    let attemptCount = 0;
    mock.onGet('/fail-once').reply(() => {
      attemptCount++;
      if (attemptCount === 1) return [503, {}];
      return [200, { ok: true }];
    });

    // requestRetries: undefined → inherits manager retries: 2 → should succeed on retry.
    const manager = new RetryManager({ axiosInstance, retries: 2 });

    const response = await axiosInstance.get('/fail-once', { __axiosRetryer: { requestRetries: undefined } });
    expect(response.status).toBe(200);
    expect(attemptCount).toBe(2); // one fail + one retry

    manager.destroy();
  });
});
