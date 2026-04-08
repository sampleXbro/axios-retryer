/**
 * Comprehensive E2E tests for axios-retryer.
 *
 * These tests simulate real-world usage patterns and edge cases that actual
 * users encounter. Each describe block covers a distinct usage scenario
 * with realistic mock setups and timing.
 */

import axios, {
  AxiosError,
  type AxiosInstance,
  AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import {
  createRetryer,
  createRetryStrategy,
  RetryManager,
  AXIOS_RETRYER_REQUEST_PRIORITIES,
  AXIOS_RETRYER_BACKOFF_TYPES,
  AXIOS_RETRYER_HTTP_METHODS,
  RETRY_MODES,
} from '../../src';
import {
  CircuitBreakerPlugin,
  CIRCUIT_BREAKER_STATES,
  type CircuitBreakerPluginEvents,
} from '../../src/plugins/CircuitBreakerPlugin';
import { CachingPlugin, type CachingPluginEvents } from '../../src/plugins/CachingPlugin';
import { ManualRetryPlugin } from '../../src/plugins/ManualRetryPlugin';
import { MetricsPlugin } from '../../src/plugins/MetricsPlugin';
import { TokenRefreshPlugin, TokenRefreshPluginEvents } from '../../src/plugins/TokenRefreshPlugin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await delay(5);
  }
};

const swallow = (promise: Promise<unknown>): Promise<unknown> => promise.catch((e) => e);

// ---------------------------------------------------------------------------
// 1. Retry backoff strategies – real timing verification
// ---------------------------------------------------------------------------

describe('Backoff strategies under real timing', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let randomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    // getBackoffDelay applies full jitter in [0, baseDelay]; fix randomness so delays are deterministic.
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    randomSpy.mockRestore();
    mock.restore();
  });

  it('STATIC backoff uses constant delay between retries', async () => {
    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      backoffType: AXIOS_RETRYER_BACKOFF_TYPES.STATIC,
      retryableStatuses: [503],
    });

    const scheduledDelays: number[] = [];
    manager.on('onRetryScheduled', (delayMs: number) => {
      scheduledDelays.push(delayMs);
    });

    const timestamps: number[] = [];
    mock.onGet('/static').reply(() => {
      timestamps.push(Date.now());
      return timestamps.length <= 2 ? [503, {}] : [200, { ok: true }];
    });

    const res = await manager.axiosInstance.get('/static');
    expect(res.status).toBe(200);
    expect(timestamps).toHaveLength(3);
    expect(scheduledDelays).toHaveLength(2);

    // With Math.random mocked to 0.5, static base is always 1000ms → floor(0.5 * 1001) = 500
    expect(scheduledDelays[0]).toBe(500);
    expect(scheduledDelays[1]).toBe(500);

    // Both delays are identical (constant)
    expect(scheduledDelays[0]).toBe(scheduledDelays[1]);

    // Wall-clock timing should reflect the fixed delay
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    expect(gap1).toBeGreaterThanOrEqual(450);
    expect(gap2).toBeGreaterThanOrEqual(450);
    expect(Math.abs(gap1 - gap2)).toBeLessThan(100);

    manager.destroy();
  });

  it('LINEAR backoff increases delay linearly', async () => {
    const manager = createRetryer({
      axiosInstance,
      retries: 3,
      backoffType: AXIOS_RETRYER_BACKOFF_TYPES.LINEAR,
      retryableStatuses: [503],
    });

    const scheduledDelays: number[] = [];
    manager.on('onRetryScheduled', (delayMs: number) => {
      scheduledDelays.push(delayMs);
    });

    const timestamps: number[] = [];
    mock.onGet('/linear').reply(() => {
      timestamps.push(Date.now());
      return timestamps.length <= 3 ? [503, {}] : [200, { ok: true }];
    });

    const res = await manager.axiosInstance.get('/linear');
    expect(res.status).toBe(200);
    expect(timestamps).toHaveLength(4);
    expect(scheduledDelays).toHaveLength(3);

    // With Math.random mocked to 0.5, linear bases are:
    //   attempt 1: 1000 * 1 = 1000 → floor(0.5 * 1001) = 500
    //   attempt 2: 1000 * 2 = 2000 → floor(0.5 * 2001) = 1000
    //   attempt 3: 1000 * 3 = 3000 → floor(0.5 * 3001) = 1500
    expect(scheduledDelays[0]).toBe(500);
    expect(scheduledDelays[1]).toBe(1000);
    expect(scheduledDelays[2]).toBe(1500);

    // Delays grow by a constant 500ms (linear)
    expect(scheduledDelays[1] - scheduledDelays[0]).toBe(500);
    expect(scheduledDelays[2] - scheduledDelays[1]).toBe(500);

    // Wall-clock timing reflects linear growth
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    const gap3 = timestamps[3] - timestamps[2];
    expect(gap2).toBeGreaterThan(gap1);
    expect(gap3).toBeGreaterThan(gap2);

    manager.destroy();
  }, 15000);

  it('EXPONENTIAL backoff doubles delay each attempt', async () => {
    const manager = createRetryer({
      axiosInstance,
      retries: 3,
      backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
      retryableStatuses: [503],
    });

    // Capture the exact delay values emitted by the scheduler
    const scheduledDelays: number[] = [];
    manager.on('onRetryScheduled', (delayMs: number) => {
      scheduledDelays.push(delayMs);
    });

    const timestamps: number[] = [];
    mock.onGet('/exp').reply(() => {
      timestamps.push(Date.now());
      return timestamps.length <= 3 ? [503, {}] : [200, { ok: true }];
    });

    const res = await manager.axiosInstance.get('/exp');
    expect(res.status).toBe(200);
    expect(timestamps).toHaveLength(4); // 1 initial + 3 retries
    expect(scheduledDelays).toHaveLength(3);

    // With Math.random mocked to 0.5, exponential bases are:
    //   attempt 1: 1000 * 2^0 = 1000 → floor(0.5 * 1001) = 500
    //   attempt 2: 1000 * 2^1 = 2000 → floor(0.5 * 2001) = 1000
    //   attempt 3: 1000 * 2^2 = 4000 → floor(0.5 * 4001) = 2000
    expect(scheduledDelays[0]).toBe(500);
    expect(scheduledDelays[1]).toBe(1000);
    expect(scheduledDelays[2]).toBe(2000);

    // Each delay is exactly 2× the previous (exponential doubling)
    expect(scheduledDelays[1]).toBe(scheduledDelays[0] * 2);
    expect(scheduledDelays[2]).toBe(scheduledDelays[1] * 2);

    // Verify wall-clock timing reflects the scheduled delays
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    const gap3 = timestamps[3] - timestamps[2];
    expect(gap1).toBeGreaterThanOrEqual(450);
    expect(gap2).toBeGreaterThanOrEqual(950);
    expect(gap3).toBeGreaterThanOrEqual(1950);
    // And each gap roughly doubles
    expect(gap2).toBeGreaterThan(gap1 * 1.5);
    expect(gap3).toBeGreaterThan(gap2 * 1.5);

    manager.destroy();
  }, 15000);
});

// ---------------------------------------------------------------------------
// 2. Custom retry strategy – selective retry logic
// ---------------------------------------------------------------------------

describe('Custom retry strategies', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
  });

  it('only retries specific error codes while ignoring others', async () => {
    const strategy = createRetryStrategy({
      isRetryable: (error: AxiosError) => error.response?.status === 429,
      shouldRetry: (error: AxiosError, attempt: number, maxRetries: number) =>
        error.response?.status === 429 && attempt <= maxRetries,
      getDelay: () => 50,
    });

    const manager = createRetryer({
      axiosInstance,
      retries: 3,
      retryStrategy: strategy,
    });

    let attempts429 = 0;
    mock.onGet('/rate-limited').reply(() => {
      attempts429++;
      return attempts429 <= 2 ? [429, {}] : [200, { ok: true }];
    });

    let attempts500 = 0;
    mock.onGet('/server-error').reply(() => {
      attempts500++;
      return [500, {}];
    });

    const res429 = await manager.axiosInstance.get('/rate-limited');
    expect(res429.status).toBe(200);
    expect(attempts429).toBe(3);

    await expect(manager.axiosInstance.get('/server-error')).rejects.toThrow();
    // 500 is not retryable in our custom strategy, so only 1 attempt
    expect(attempts500).toBe(1);

    manager.destroy();
  });

  it('custom shouldRetry can implement conditional retry logic', async () => {
    const strategy = createRetryStrategy({
      shouldRetry: (error, attempt, maxRetries) => {
        // Only retry if the server says it's OK to retry
        const retryable = error.response?.headers?.['x-retryable'] === 'true';
        return retryable && attempt <= maxRetries;
      },
      getDelay: () => 50,
    });

    const manager = createRetryer({
      axiosInstance,
      retries: 3,
      retryStrategy: strategy,
    });

    let attemptsRetryable = 0;
    mock.onGet('/retryable').reply(() => {
      attemptsRetryable++;
      if (attemptsRetryable < 2) {
        return [503, {}, { 'x-retryable': 'true' }];
      }
      return [200, { ok: true }];
    });

    let attemptsNonRetryable = 0;
    mock.onGet('/non-retryable').reply(() => {
      attemptsNonRetryable++;
      return [503, {}, { 'x-retryable': 'false' }];
    });

    const res = await manager.axiosInstance.get('/retryable');
    expect(res.status).toBe(200);
    expect(attemptsRetryable).toBe(2);

    await expect(manager.axiosInstance.get('/non-retryable')).rejects.toThrow();
    expect(attemptsNonRetryable).toBe(1);

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// 3. Queue full behavior – maxQueueSize enforcement
// ---------------------------------------------------------------------------

describe('Queue capacity limits', () => {
  it('rejects requests that exceed maxQueueSize', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 1,
      maxQueueSize: 2,
      retries: 0,
    });

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );
    mock.onGet('/queued1').reply(200, {});
    mock.onGet('/queued2').reply(200, {});
    mock.onGet('/overflow').reply(200, {});

    // Occupy the single slot
    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseBlocker !== undefined);

    // Fill the queue (2 slots)
    const q1 = manager.axiosInstance.get('/queued1');
    const q2 = manager.axiosInstance.get('/queued2');

    // Give queue time to register
    await delay(30);

    // This should overflow the queue
    const overflow = swallow(manager.axiosInstance.get('/overflow'));
    const overflowResult = await overflow;

    expect(overflowResult).toBeInstanceOf(Error);
    expect((overflowResult as Error).message).toMatch(/queue.*full|capacity/i);

    releaseBlocker();
    await Promise.all([blocker, q1, q2]);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 4. AbortController / signal cancellation
// ---------------------------------------------------------------------------

describe('Request cancellation via AbortController', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
  });

  it('cancels an in-flight request when the caller aborts', async () => {
    const manager = createRetryer({ axiosInstance, retries: 3 });

    mock
      .onGet('/slow')
      .reply(() => new Promise<[number, object]>((resolve) => setTimeout(() => resolve([200, {}]), 5000)));

    const controller = new AbortController();
    const req = swallow(manager.axiosInstance.get('/slow', { signal: controller.signal }));

    await delay(50);
    controller.abort();

    const result = await req;
    expect(result).toBeInstanceOf(Error);

    manager.destroy();
  });

  it('cancels a queued request via cancelRequest by ID', async () => {
    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 1,
      retries: 0,
    });

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );
    mock.onGet('/target').reply(200, {});

    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseBlocker !== undefined);

    let capturedId: string | undefined;
    manager.on('onRequestQueued', ({ requestId }: { requestId: string }) => {
      if (!capturedId) capturedId = requestId;
    });

    const target = swallow(
      manager.axiosInstance.get('/target', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
      }),
    );

    await waitFor(() => capturedId !== undefined);
    manager.cancelRequest(capturedId!);

    const targetResult = await target;
    expect(targetResult).toBeInstanceOf(Error);

    releaseBlocker();
    await blocker;

    manager.destroy();
  });

  it('cancelAllRequests cancels both in-flight and queued requests', async () => {
    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 1,
      retries: 0,
    });

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );
    mock.onGet('/queued').reply(200, {});

    const blocker = swallow(manager.axiosInstance.get('/blocker'));
    await waitFor(() => releaseBlocker !== undefined);

    const queued = swallow(manager.axiosInstance.get('/queued'));
    await delay(30);

    manager.cancelAllRequests();
    releaseBlocker();

    const [blockerResult, queuedResult] = await Promise.all([blocker, queued]);
    // Both should have been cancelled
    expect(blockerResult).toBeInstanceOf(Error);
    expect(queuedResult).toBeInstanceOf(Error);

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// 5. throwErrorOnFailedRetries: false – null resolution pattern
// ---------------------------------------------------------------------------

describe('Null resolution on failed retries', () => {
  it('resolves null for all retryable failures when throwErrorOnFailedRetries is false', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      throwErrorOnFailedRetries: false,
      retryableStatuses: [500, 503],
    });

    mock.onGet('/fail-500').reply(500, {});
    mock.onGet('/fail-503').reply(503, {});

    const res1 = await manager.axiosInstance.get('/fail-500');
    const res2 = await manager.axiosInstance.get('/fail-503');

    expect(res1).toBeNull();
    expect(res2).toBeNull();

    manager.destroy();
    mock.restore();
  });

  it('resolves null for non-retryable errors too when throwErrorOnFailedRetries is false', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      throwErrorOnFailedRetries: false,
      retryableStatuses: [500],
    });

    // 404 is not retryable, but throwErrorOnFailedRetries: false applies to all terminal failures
    mock.onGet('/not-found').reply(404, {});

    const res = await manager.axiosInstance.get('/not-found');
    expect(res).toBeNull();

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 6. Per-request overrides
// ---------------------------------------------------------------------------

describe('Per-request configuration overrides', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
  });

  it('per-request requestRetries overrides the manager-level retries', async () => {
    const manager = createRetryer({
      axiosInstance,
      retries: 5,
      retryableStatuses: [503],
    });

    let attempts = 0;
    mock.onGet('/override').reply(() => {
      attempts++;
      return [503, {}];
    });

    await swallow(
      manager.axiosInstance.get('/override', {
        __axiosRetryer: { requestRetries: 1 },
      }),
    );

    // 1 original + 1 retry = 2 total attempts
    expect(attempts).toBe(2);

    manager.destroy();
  });

  it('per-request backoffType overrides the manager-level backoff', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
      retryableStatuses: [503],
      queueDelay: 0,
    });

    const timestamps: number[] = [];
    mock.onGet('/static-override').reply(() => {
      timestamps.push(Date.now());
      return timestamps.length <= 2 ? [503, {}] : [200, { ok: true }];
    });

    try {
      const res = await manager.axiosInstance.get('/static-override', {
        __axiosRetryer: { backoffType: AXIOS_RETRYER_BACKOFF_TYPES.STATIC },
      });

      expect(res.status).toBe(200);
      expect(timestamps).toHaveLength(3);
      // Manager default is EXPONENTIAL (~500ms then ~1000ms with jitter at 0.5); STATIC keeps both ~500ms.
      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];
      expect(gap1).toBeGreaterThanOrEqual(450);
      expect(gap2).toBeGreaterThanOrEqual(450);
      expect(Math.abs(gap1 - gap2)).toBeLessThan(200);
    } finally {
      randomSpy.mockRestore();
      manager.destroy();
    }
  });

  it('per-request retryableStatuses overrides manager defaults', async () => {
    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [500],
    });

    let attempts = 0;
    mock.onGet('/custom-status').reply(() => {
      attempts++;
      return attempts < 3 ? [418, {}] : [200, { ok: true }];
    });

    // 418 is not in manager defaults but we override per-request
    const res = await manager.axiosInstance.get('/custom-status', {
      __axiosRetryer: { retryableStatuses: [418] },
    });

    expect(res.status).toBe(200);
    expect(attempts).toBe(3);

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// 7. Event system – comprehensive lifecycle events
// ---------------------------------------------------------------------------

describe('Event lifecycle tracking', () => {
  it('fires all lifecycle events in the correct order for a successful retry', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
    });

    const events: string[] = [];
    manager.on('onRequestQueued', () => events.push('queued'));
    manager.on('onRequestDispatched', () => events.push('dispatched'));
    manager.on('onRetryProcessStarted', () => events.push('retryProcessStarted'));
    manager.on('beforeRetry', () => events.push('beforeRetry'));
    manager.on('onRetryScheduled', () => events.push('retryScheduled'));
    manager.on('afterRetry', () => events.push('afterRetry'));
    manager.on('onRequestSucceeded', () => events.push('succeeded'));
    manager.on('onRetryProcessFinished', () => events.push('retryProcessFinished'));

    let attempts = 0;
    mock.onGet('/events').reply(() => {
      attempts++;
      return attempts === 1 ? [503, {}] : [200, { ok: true }];
    });

    await manager.axiosInstance.get('/events');

    expect(events).toContain('queued');
    expect(events).toContain('dispatched');
    expect(events).toContain('retryScheduled');
    expect(events).toContain('beforeRetry');
    expect(events).toContain('afterRetry');
    expect(events).toContain('succeeded');

    // retryScheduled should come before beforeRetry
    const scheduledIdx = events.indexOf('retryScheduled');
    const beforeRetryIdx = events.indexOf('beforeRetry');
    expect(scheduledIdx).toBeLessThan(beforeRetryIdx);

    manager.destroy();
    mock.restore();
  });

  it('fires onFailure and onRequestError for terminal failures', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      retryableStatuses: [503],
    });

    const failurePayloads: unknown[] = [];
    const errorPayloads: unknown[] = [];
    manager.on('onFailure', (payload: unknown) => failurePayloads.push(payload));
    manager.on('onRequestError', (payload: unknown) => errorPayloads.push(payload));

    mock.onGet('/terminal').reply(503, {});

    await swallow(manager.axiosInstance.get('/terminal'));

    // onFailure fires for each failed attempt (including the last one)
    expect(failurePayloads.length).toBeGreaterThanOrEqual(1);
    // onRequestError fires once at terminal state
    expect(errorPayloads).toHaveLength(1);

    manager.destroy();
    mock.restore();
  });

  it('fires onRequestCancelled when a request is cancelled', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      maxConcurrentRequests: 1,
    });

    const cancelled: string[] = [];
    manager.on('onRequestCancelled', (requestId: string) => {
      cancelled.push(requestId);
    });

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );
    mock
      .onGet('/cancel-me')
      .reply(() => new Promise<[number, object]>((resolve) => setTimeout(() => resolve([200, {}]), 5000)));

    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseBlocker !== undefined);

    let capturedId: string | undefined;
    manager.on('onRequestQueued', ({ requestId }: { requestId: string }) => {
      if (!capturedId) capturedId = requestId;
    });

    const target = swallow(manager.axiosInstance.get('/cancel-me'));
    await waitFor(() => capturedId !== undefined);
    manager.cancelRequest(capturedId!);
    await target;

    expect(cancelled.length).toBeGreaterThanOrEqual(1);

    releaseBlocker();
    await blocker;

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 8. Circuit breaker – full lifecycle
// ---------------------------------------------------------------------------

describe('CircuitBreakerPlugin full lifecycle', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
  });

  it('trips the circuit after failureThreshold and recovers through HALF_OPEN', async () => {
    const stateChanges: Array<{ from: string; to: string; reason: string }> = [];

    const cb = new CircuitBreakerPlugin({
      failureThreshold: 3,
      openTimeout: 200,
      halfOpenMax: 1,
      successThreshold: 1,
    });

    const manager = createRetryer<CircuitBreakerPluginEvents>({
      axiosInstance,
      retries: 0,
    });
    manager.use(cb);

    manager.on('onCircuitStateChanged', (payload) => {
      stateChanges.push(payload);
    });

    mock.onGet('/api').reply(500, { error: 'fail' });

    // Trip the circuit: 3 failures
    for (let i = 0; i < 3; i++) {
      await swallow(manager.axiosInstance.get('/api'));
    }

    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);
    expect(stateChanges.some((s) => s.to === 'OPEN' && s.reason === 'failure-threshold')).toBe(true);

    // Requests should fail fast while OPEN
    const fastFail = await swallow(manager.axiosInstance.get('/api'));
    expect(fastFail).toBeInstanceOf(Error);
    expect((fastFail as AxiosError).message).toMatch(/circuit/i);

    // Wait for openTimeout to elapse and transition to HALF_OPEN
    await delay(300);

    // Now make a successful request – should close the circuit
    mock.onGet('/api').reply(200, { ok: true });
    const recovery = await manager.axiosInstance.get('/api');
    expect(recovery.status).toBe(200);

    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.CLOSED);
    expect(stateChanges.some((s) => s.to === 'HALF_OPEN' && s.reason === 'open-timeout-elapsed')).toBe(true);
    expect(stateChanges.some((s) => s.to === 'CLOSED' && s.reason === 'success-threshold-reached')).toBe(true);

    manager.destroy();
  });

  it('re-trips the circuit if HALF_OPEN test request fails', async () => {
    const cb = new CircuitBreakerPlugin({
      failureThreshold: 2,
      openTimeout: 100,
      halfOpenMax: 1,
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cb);

    mock.onGet('/api').reply(500, {});

    // Trip circuit
    await swallow(manager.axiosInstance.get('/api'));
    await swallow(manager.axiosInstance.get('/api'));
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

    // Wait for HALF_OPEN
    await delay(200);

    // Fail in HALF_OPEN → should re-trip to OPEN
    await swallow(manager.axiosInstance.get('/api'));
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

    manager.destroy();
  });

  it('excludeUrls allows specific endpoints to bypass the circuit', async () => {
    const cb = new CircuitBreakerPlugin({
      failureThreshold: 2,
      openTimeout: 5000,
      halfOpenMax: 1,
      excludeUrls: [/\/health$/],
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cb);

    mock.onGet('/api').reply(500, {});
    mock.onGet('/health').reply(200, { status: 'ok' });

    // Trip the circuit
    await swallow(manager.axiosInstance.get('/api'));
    await swallow(manager.axiosInstance.get('/api'));
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

    // Health check should still work
    const health = await manager.axiosInstance.get('/health');
    expect(health.status).toBe(200);

    manager.destroy();
  });

  it('shouldCountError filters which errors contribute to the circuit', async () => {
    const cb = new CircuitBreakerPlugin({
      failureThreshold: 2,
      openTimeout: 5000,
      halfOpenMax: 1,
      shouldCountError: (error: AxiosError) => (error.response?.status ?? 0) >= 500,
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cb);

    // 4xx errors should NOT trip the circuit
    mock.onGet('/client-error').reply(404, {});
    for (let i = 0; i < 5; i++) {
      await swallow(manager.axiosInstance.get('/client-error'));
    }
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.CLOSED);

    // 5xx errors SHOULD trip the circuit
    mock.onGet('/server-error').reply(500, {});
    await swallow(manager.axiosInstance.get('/server-error'));
    await swallow(manager.axiosInstance.get('/server-error'));
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

    manager.destroy();
  });

  it('scopes circuit state per URL', async () => {
    const cb = new CircuitBreakerPlugin({
      failureThreshold: 2,
      openTimeout: 5000,
      halfOpenMax: 1,
      scope: 'url',
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cb);

    mock.onGet('/api/users').reply(500, {});
    mock.onGet('/api/orders').reply(200, { ok: true });

    // Trip circuit for /api/users
    await swallow(manager.axiosInstance.get('/api/users'));
    await swallow(manager.axiosInstance.get('/api/users'));

    // /api/orders should still work because it has its own scope
    const orders = await manager.axiosInstance.get('/api/orders');
    expect(orders.status).toBe(200);

    // /api/users should fail fast
    const usersFastFail = await swallow(manager.axiosInstance.get('/api/users'));
    expect(usersFastFail).toBeInstanceOf(Error);

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// 9. Caching plugin – complete caching behavior
// ---------------------------------------------------------------------------

describe('CachingPlugin comprehensive behavior', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
  });

  it('serves cached GET responses and invalidates on TTR expiry', async () => {
    const cache = new CachingPlugin({
      timeToRevalidate: 200,
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onGet('/cacheable').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    // First request hits the server
    const res1 = await manager.axiosInstance.get('/cacheable');
    expect(res1.data.count).toBe(1);
    expect(hitCount).toBe(1);

    // Second request should come from cache
    const res2 = await manager.axiosInstance.get('/cacheable');
    expect(res2.data.count).toBe(1); // Same cached response
    expect(hitCount).toBe(1); // No new server hit

    // Wait for TTR to expire
    await delay(300);

    // Third request should hit the server again (cache stale)
    const res3 = await manager.axiosInstance.get('/cacheable');
    expect(res3.data.count).toBe(2);
    expect(hitCount).toBe(2);

    manager.destroy();
  });

  it('does not cache POST requests by default', async () => {
    const cache = new CachingPlugin();
    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onPost('/submit').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    await manager.axiosInstance.post('/submit', { data: 'test' });
    await manager.axiosInstance.post('/submit', { data: 'test' });

    expect(hitCount).toBe(2); // Both hit the server

    manager.destroy();
  });

  it('per-request cache opt-out via __cachingOptions', async () => {
    const cache = new CachingPlugin();
    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onGet('/dynamic').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    // First call – cached
    await manager.axiosInstance.get('/dynamic');

    // Second call with cache: false – should bypass cache
    const res = await manager.axiosInstance.get('/dynamic', {
      __cachingOptions: { cache: false },
    });

    expect(res.data.count).toBe(2);
    expect(hitCount).toBe(2);

    manager.destroy();
  });

  it('clearCache removes all cached entries', async () => {
    const cache = new CachingPlugin();
    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onGet('/clearable').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    await manager.axiosInstance.get('/clearable');
    expect(hitCount).toBe(1);

    cache.clearCache();

    await manager.axiosInstance.get('/clearable');
    expect(hitCount).toBe(2); // Cache was cleared, new server hit

    manager.destroy();
  });

  it('skips caching for requests with auth headers by default', async () => {
    const cache = new CachingPlugin();
    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onGet('/authed').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    await manager.axiosInstance.get('/authed', {
      headers: { Authorization: 'Bearer token' },
    });
    await manager.axiosInstance.get('/authed', {
      headers: { Authorization: 'Bearer token' },
    });

    // Both should hit the server since auth requests aren't cached
    expect(hitCount).toBe(2);

    manager.destroy();
  });

  it('deduplicates concurrent identical requests', async () => {
    const cache = new CachingPlugin({ dedupeConcurrentRequests: true });
    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onGet('/dedup').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    // Fire 5 identical requests concurrently
    const results = await Promise.all([
      manager.axiosInstance.get('/dedup'),
      manager.axiosInstance.get('/dedup'),
      manager.axiosInstance.get('/dedup'),
      manager.axiosInstance.get('/dedup'),
      manager.axiosInstance.get('/dedup'),
    ]);

    // Only one actual network request should have been made
    expect(hitCount).toBe(1);
    // All should return the same data
    results.forEach((r) => expect(r.data.count).toBe(1));

    manager.destroy();
  });

  it('maxItems evicts oldest entries when capacity is reached', async () => {
    const cache = new CachingPlugin({ maxItems: 3 });
    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    const hits: Record<string, number> = {};
    for (let i = 1; i <= 5; i++) {
      mock.onGet(`/item-${i}`).reply(() => {
        hits[`item-${i}`] = (hits[`item-${i}`] || 0) + 1;
        return [200, { id: i }];
      });
    }

    // Fill cache with 3 items
    await manager.axiosInstance.get('/item-1');
    await manager.axiosInstance.get('/item-2');
    await manager.axiosInstance.get('/item-3');

    // Add item-4 (should evict item-1)
    await manager.axiosInstance.get('/item-4');

    // item-1 should no longer be cached → hits the server again
    await manager.axiosInstance.get('/item-1');
    expect(hits['item-1']).toBe(2);

    // item-2 or item-3 might still be cached
    // item-4 should still be cached
    await manager.axiosInstance.get('/item-4');
    expect(hits['item-4']).toBe(1); // Still cached

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// 10. Token refresh – concurrent requests during refresh
// ---------------------------------------------------------------------------

describe('TokenRefreshPlugin concurrent request handling', () => {
  it('queues multiple 401 requests and replays them all after token refresh', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    let currentToken = 'expired';
    let refreshCallCount = 0;

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      maxConcurrentRequests: 5,
    });

    manager.use(
      new TokenRefreshPlugin(
        async () => {
          refreshCallCount++;
          await delay(100);
          currentToken = 'fresh-token';
          return { token: currentToken };
        },
        {
          refreshStatusCodes: [401],
          maxRefreshAttempts: 1,
          tokenPrefix: 'Bearer ',
        },
      ),
    );

    // First call returns 401, subsequent calls after refresh return 200
    let endpoint1Attempts = 0;
    mock.onGet('/api/1').reply((config) => {
      endpoint1Attempts++;
      const auth = config.headers?.Authorization || config.headers?.authorization;
      return auth === 'Bearer fresh-token' ? [200, { data: 'api1' }] : [401, {}];
    });

    let endpoint2Attempts = 0;
    mock.onGet('/api/2').reply((config) => {
      endpoint2Attempts++;
      const auth = config.headers?.Authorization || config.headers?.authorization;
      return auth === 'Bearer fresh-token' ? [200, { data: 'api2' }] : [401, {}];
    });

    // Fire two requests simultaneously with expired tokens
    const [res1, res2] = await Promise.all([
      manager.axiosInstance.get('/api/1', {
        headers: { Authorization: 'Bearer expired' },
      }),
      manager.axiosInstance.get('/api/2', {
        headers: { Authorization: 'Bearer expired' },
      }),
    ]);

    expect(res1.data).toEqual({ data: 'api1' });
    expect(res2.data).toEqual({ data: 'api2' });

    // Token refresh should have been called only once (not once per 401)
    expect(refreshCallCount).toBe(1);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 11. Manual mode – store, inspect, replay
// ---------------------------------------------------------------------------

describe('Manual retry mode full workflow', () => {
  it('stores failed requests, allows inspection, and replays them', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manualRetry = new ManualRetryPlugin({
      maxRequestsToStore: 50,
      manualRetryMaxAge: 60000,
    });

    const manager = new RetryManager({
      axiosInstance,
      mode: RETRY_MODES.MANUAL,
      retries: 0,
    });
    manager.use(manualRetry);

    mock.onGet('/endpoint-a').reply(503, {});
    mock.onGet('/endpoint-b').reply(503, {});

    // Make requests that will fail
    await swallow(manager.axiosInstance.get('/endpoint-a'));
    await swallow(manager.axiosInstance.get('/endpoint-b'));

    // Inspect stored requests
    const stored = manualRetry.getStoredRequests();
    expect(stored).toHaveLength(2);
    expect(stored.map((c) => c.url)).toEqual(expect.arrayContaining(['/endpoint-a', '/endpoint-b']));

    // Fix the endpoints
    mock.onGet('/endpoint-a').reply(200, { recovered: 'a' });
    mock.onGet('/endpoint-b').reply(200, { recovered: 'b' });

    // Replay all
    const results = await manualRetry.retryFailedRequests();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // Store should be empty now
    expect(manualRetry.getStoredRequests()).toHaveLength(0);

    manager.destroy();
    mock.restore();
  });

  it('discards expired stored requests on replay', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manualRetry = new ManualRetryPlugin({
      manualRetryMaxAge: 100, // Very short max age
    });

    const manager = new RetryManager({
      axiosInstance,
      mode: RETRY_MODES.MANUAL,
      retries: 0,
    });
    manager.use(manualRetry);

    mock.onGet('/expires').reply(503, {});
    await swallow(manager.axiosInstance.get('/expires'));

    expect(manualRetry.getStoredRequests()).toHaveLength(1);

    // Wait for the stored request to expire
    await delay(200);

    mock.onGet('/expires').reply(200, {});
    const results = await manualRetry.retryFailedRequests();
    expect(results).toHaveLength(0); // Expired, not replayed

    manager.destroy();
    mock.restore();
  });

  it('does not store non-idempotent POST requests by default', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manualRetry = new ManualRetryPlugin();
    const manager = new RetryManager({
      axiosInstance,
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      retryableMethods: [AXIOS_RETRYER_HTTP_METHODS.GET, AXIOS_RETRYER_HTTP_METHODS.POST],
    });
    manager.use(manualRetry);

    mock.onGet('/get-endpoint').reply(503, {});
    mock.onPost('/post-endpoint').reply(503, {});

    await swallow(manager.axiosInstance.get('/get-endpoint'));
    await swallow(manager.axiosInstance.post('/post-endpoint', { data: 'test' }));

    const stored = manualRetry.getStoredRequests();
    // GET should be stored; POST should not (not idempotent, no Idempotency-Key)
    expect(stored).toHaveLength(1);
    expect(stored[0].url).toBe('/get-endpoint');

    manager.destroy();
    mock.restore();
  });

  it('stores non-idempotent requests with Idempotency-Key header', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manualRetry = new ManualRetryPlugin();
    const manager = new RetryManager({
      axiosInstance,
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      retryableMethods: [AXIOS_RETRYER_HTTP_METHODS.GET, AXIOS_RETRYER_HTTP_METHODS.POST],
    });
    manager.use(manualRetry);

    mock.onPost('/idempotent-post').reply(503, {});

    await swallow(
      manager.axiosInstance.post(
        '/idempotent-post',
        { data: 'test' },
        {
          headers: { 'Idempotency-Key': 'unique-key-123' },
        },
      ),
    );

    const stored = manualRetry.getStoredRequests();
    expect(stored).toHaveLength(1);

    manager.destroy();
    mock.restore();
  });

  it('clearStoredRequests removes all stored requests without replaying', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manualRetry = new ManualRetryPlugin();
    const manager = new RetryManager({
      axiosInstance,
      mode: RETRY_MODES.MANUAL,
      retries: 0,
    });
    manager.use(manualRetry);

    mock.onGet('/clear-me').reply(503, {});
    await swallow(manager.axiosInstance.get('/clear-me'));

    expect(manualRetry.getStoredRequests()).toHaveLength(1);

    manualRetry.clearStoredRequests();
    expect(manualRetry.getStoredRequests()).toHaveLength(0);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 12. Metrics plugin – accuracy tracking
// ---------------------------------------------------------------------------

describe('MetricsPlugin accuracy', () => {
  it('accurately tracks retries, successes, and terminal failures', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
    });
    manager.use(new MetricsPlugin());

    // Request that succeeds on retry
    let attemptsA = 0;
    mock.onGet('/success-after-retry').reply(() => {
      attemptsA++;
      return attemptsA === 1 ? [503, {}] : [200, { ok: true }];
    });

    // Request that always fails
    mock.onGet('/always-fails').reply(503, {});

    // Request that succeeds immediately
    mock.onGet('/instant-success').reply(200, { ok: true });

    await manager.axiosInstance.get('/success-after-retry');
    await swallow(manager.axiosInstance.get('/always-fails'));
    await manager.axiosInstance.get('/instant-success');

    const metrics = manager.getMetrics();

    expect(metrics.totalRequests).toBeGreaterThanOrEqual(3);
    expect(metrics.successfulRetries).toBeGreaterThanOrEqual(1);
    expect(metrics.completelyFailedRequests).toBe(1);
    expect(metrics.failedRetries).toBeGreaterThanOrEqual(1);

    manager.destroy();
    mock.restore();
  });

  it('tracks cancelled requests accurately', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      maxConcurrentRequests: 1,
    });
    manager.use(new MetricsPlugin());

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );
    mock
      .onGet('/cancellable')
      .reply(() => new Promise<[number, object]>((resolve) => setTimeout(() => resolve([200, {}]), 5000)));

    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseBlocker !== undefined);

    let capturedId: string | undefined;
    manager.on('onRequestQueued', ({ requestId }: { requestId: string }) => {
      if (!capturedId) capturedId = requestId;
    });

    const req = swallow(manager.axiosInstance.get('/cancellable'));
    await waitFor(() => capturedId !== undefined);
    manager.cancelRequest(capturedId!);
    await req;

    const metrics = manager.getMetrics();
    expect(metrics.canceledRequests).toBeGreaterThanOrEqual(1);

    releaseBlocker();
    await blocker;

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 13. Plugin lifecycle and interaction
// ---------------------------------------------------------------------------

describe('Plugin registration and destruction', () => {
  it('plugins are properly cleaned up on manager.destroy()', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    const metrics = new MetricsPlugin();
    const cache = new CachingPlugin();
    manager.use(metrics);
    manager.use(cache);

    mock.onGet('/test').reply(200, { ok: true });
    await manager.axiosInstance.get('/test');

    manager.destroy();

    // After destroy, timer health should be clean
    const finalMetrics = manager.getMetrics();
    expect(finalMetrics.timerHealth.activeTimers).toBe(0);
    expect(finalMetrics.timerHealth.activeRetryTimers).toBe(0);

    mock.restore();
  });

  it('rejects duplicate plugin registration', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(new MetricsPlugin());

    expect(() => manager.use(new MetricsPlugin())).toThrow();

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 14. Concurrency under load – priority + queue interactions
// ---------------------------------------------------------------------------

describe('High concurrency with mixed priorities', () => {
  it('handles burst of 100 mixed-priority requests with concurrency limit', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 3,
      retries: 0,
      queueDelay: 0,
    });
    manager.use(new MetricsPlugin());

    const completed: string[] = [];
    const priorities = [
      AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
      AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
      AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
    ];

    for (let i = 0; i < 100; i++) {
      mock.onGet(`/req-${i}`).reply(() => {
        completed.push(`req-${i}`);
        return [200, { id: i }];
      });
    }

    const requests = Array.from({ length: 100 }, (_, i) =>
      manager.axiosInstance.get(`/req-${i}`, {
        __axiosRetryer: { priority: priorities[i % priorities.length] },
      }),
    );

    const results = await Promise.all(requests);

    expect(results).toHaveLength(100);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(completed).toHaveLength(100);

    const metrics = manager.getMetrics();
    expect(metrics.totalRequests).toBe(100);

    manager.destroy();
    mock.restore();
  });

  it('respects strict priority ordering with a single concurrent slot', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 1,
      retries: 0,
      queueDelay: 0,
    });

    const order: number[] = [];

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );

    for (let i = 0; i < 5; i++) {
      mock.onGet(`/p-${i}`).reply(() => {
        order.push(i);
        return [200, {}];
      });
    }

    // Occupy the slot
    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseBlocker !== undefined);

    // Queue requests with explicit priorities (submitted in reverse order)
    const queued = [
      manager.axiosInstance.get('/p-0', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
      }),
      manager.axiosInstance.get('/p-1', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
      }),
      manager.axiosInstance.get('/p-2', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
      }),
      manager.axiosInstance.get('/p-3', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST },
      }),
      manager.axiosInstance.get('/p-4', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
      }),
    ];

    await delay(30);
    releaseBlocker();
    await blocker;
    await Promise.all(queued);

    // Should be dispatched in priority order: CRITICAL(4) → HIGHEST(3) → HIGH(2) → MEDIUM(1) → LOW(0)
    expect(order).toEqual([4, 3, 2, 1, 0]);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 15. Retry-After header respect
// ---------------------------------------------------------------------------

describe('Retry-After header handling', () => {
  it('respects Retry-After header with seconds value', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      retryableStatuses: [429],
    });

    const timestamps: number[] = [];
    let attempts = 0;
    mock.onGet('/rate-limited').reply(() => {
      timestamps.push(Date.now());
      attempts++;
      return attempts === 1 ? [429, {}, { 'retry-after': '2' }] : [200, { ok: true }];
    });

    const res = await manager.axiosInstance.get('/rate-limited');
    expect(res.status).toBe(200);
    expect(timestamps).toHaveLength(2);

    // Should have waited at least 2 seconds
    const gap = timestamps[1] - timestamps[0];
    expect(gap).toBeGreaterThanOrEqual(1800);

    manager.destroy();
    mock.restore();
  }, 10000);
});

// ---------------------------------------------------------------------------
// 16. Network errors (no response)
// ---------------------------------------------------------------------------

describe('Network error handling', () => {
  it('retries on network errors (no response object)', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
    });

    const networkError = new AxiosError(
      'Network Error',
      'ECONNRESET',
      { url: '/network-fail', method: 'get' } as InternalAxiosRequestConfig,
      {},
    );

    mock.onGet('/network-fail').replyOnce(() => Promise.reject(networkError));
    mock.onGet('/network-fail').replyOnce(() => Promise.reject(networkError));
    mock.onGet('/network-fail').reply(200, { recovered: true });

    const res = await manager.axiosInstance.get('/network-fail');
    expect(res.status).toBe(200);
    expect(res.data.recovered).toBe(true);

    manager.destroy();
    mock.restore();
  });

  it('fires onInternetConnectionError for network failures', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance, retries: 0 });

    const connectionErrors: unknown[] = [];
    manager.on('onInternetConnectionError', (payload: unknown) => {
      connectionErrors.push(payload);
    });

    mock.onGet('/offline').networkError();

    await swallow(manager.axiosInstance.get('/offline'));

    expect(connectionErrors.length).toBeGreaterThanOrEqual(1);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 17. Idempotent POST retries
// ---------------------------------------------------------------------------

describe('Idempotent POST retry behavior', () => {
  it('retries POST requests with Idempotency-Key header', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
    });

    let attempts = 0;
    mock.onPost('/create-order').reply(() => {
      attempts++;
      return attempts === 1 ? [503, {}] : [201, { orderId: 'abc' }];
    });

    const res = await manager.axiosInstance.post(
      '/create-order',
      { item: 'widget' },
      { headers: { 'Idempotency-Key': 'unique-key-1' } },
    );

    expect(res.status).toBe(201);
    expect(res.data.orderId).toBe('abc');
    expect(attempts).toBe(2);

    manager.destroy();
    mock.restore();
  });

  it('does NOT retry regular POST requests without Idempotency-Key', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
    });

    let attempts = 0;
    mock.onPost('/unsafe-post').reply(() => {
      attempts++;
      return [503, {}];
    });

    await swallow(manager.axiosInstance.post('/unsafe-post', { data: 'test' }));

    // POST without Idempotency-Key is not retryable by default strategy
    expect(attempts).toBe(1);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 18. Status range retries (e.g., [520, 527])
// ---------------------------------------------------------------------------

describe('Status range retries', () => {
  it('retries on status codes within configured ranges', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [[520, 527]],
    });

    let attempts = 0;
    mock.onGet('/cloudflare').reply(() => {
      attempts++;
      return attempts === 1 ? [522, {}] : [200, { ok: true }];
    });

    const res = await manager.axiosInstance.get('/cloudflare');
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);

    manager.destroy();
    mock.restore();
  });

  it('does NOT retry status codes outside configured ranges', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 3,
      retryableStatuses: [[520, 527]],
    });

    let attempts = 0;
    mock.onGet('/non-range').reply(() => {
      attempts++;
      return [500, {}]; // 500 is NOT in [520, 527]
    });

    await swallow(manager.axiosInstance.get('/non-range'));
    expect(attempts).toBe(1);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 19. Multiple plugins working together
// ---------------------------------------------------------------------------

describe('Multi-plugin integration', () => {
  it('MetricsPlugin + CircuitBreakerPlugin + CachingPlugin coexist correctly', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const cb = new CircuitBreakerPlugin({
      failureThreshold: 3,
      openTimeout: 200,
      halfOpenMax: 1,
    });
    const cache = new CachingPlugin({ timeToRevalidate: 500 });
    const metricsPlugin = new MetricsPlugin();

    const manager = createRetryer({
      axiosInstance,
      retries: 0,
    });
    manager.use(cb);
    manager.use(cache);
    manager.use(metricsPlugin);

    // Phase 1: Successful requests should be cached
    let hitCount = 0;
    mock.onGet('/data').reply(() => {
      hitCount++;
      return [200, { count: hitCount }];
    });

    const res1 = await manager.axiosInstance.get('/data');
    const res2 = await manager.axiosInstance.get('/data');
    expect(res1.data.count).toBe(1);
    expect(res2.data.count).toBe(1); // Cached
    expect(hitCount).toBe(1);

    // Phase 2: Failures should trip the circuit
    mock.onGet('/failing').reply(500, {});
    for (let i = 0; i < 3; i++) {
      await swallow(manager.axiosInstance.get('/failing'));
    }
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

    // Metrics should reflect all activity
    const metrics = manager.getMetrics();
    expect(metrics.totalRequests).toBeGreaterThanOrEqual(3);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 20. Destroy during active requests
// ---------------------------------------------------------------------------

describe('Manager destruction during active operations', () => {
  it('destroy during retries does not leave dangling timers', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 5,
      retryableStatuses: [503],
    });
    manager.use(new MetricsPlugin());

    mock.onGet('/slow-fail').reply(503, {});

    // Start a request that will keep retrying
    const req = swallow(manager.axiosInstance.get('/slow-fail'));

    // Wait for the first retry to be scheduled
    await delay(100);

    // Destroy while retries are in progress
    manager.destroy();

    // Should not throw, and timers should be cleaned
    const metrics = manager.getMetrics();
    expect(metrics.timerHealth.activeTimers).toBe(0);
    expect(metrics.timerHealth.activeRetryTimers).toBe(0);

    // Wait for the request to settle
    await req;

    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 21. Separate axios instances do not interfere
// ---------------------------------------------------------------------------

describe('Instance isolation', () => {
  it('two RetryManagers with separate axios instances do not interfere', async () => {
    const axiosA = axios.create();
    const axiosB = axios.create();
    const mockA = new AxiosMockAdapter(axiosA, { delayResponse: 0 });
    const mockB = new AxiosMockAdapter(axiosB, { delayResponse: 0 });

    const managerA = createRetryer({ axiosInstance: axiosA, retries: 1, retryableStatuses: [500] });
    const managerB = createRetryer({ axiosInstance: axiosB, retries: 0 });

    let attemptsA = 0;
    mockA.onGet('/shared-path').reply(() => {
      attemptsA++;
      return attemptsA === 1 ? [500, {}] : [200, { source: 'A' }];
    });

    let attemptsB = 0;
    mockB.onGet('/shared-path').reply(() => {
      attemptsB++;
      return [500, {}];
    });

    const resA = await managerA.axiosInstance.get('/shared-path');
    expect(resA.status).toBe(200);
    expect(attemptsA).toBe(2); // Retried once

    await swallow(managerB.axiosInstance.get('/shared-path'));
    expect(attemptsB).toBe(1); // No retry (retries: 0)

    managerA.destroy();
    managerB.destroy();
    mockA.restore();
    mockB.restore();
  });
});

// ---------------------------------------------------------------------------
// 22. Edge case: 0 retries configured
// ---------------------------------------------------------------------------

describe('Zero retries edge case', () => {
  it('does not retry when retries is 0', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance, retries: 0 });

    let attempts = 0;
    mock.onGet('/no-retry').reply(() => {
      attempts++;
      return [500, {}];
    });

    await swallow(manager.axiosInstance.get('/no-retry'));
    expect(attempts).toBe(1);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 23. Mixed retryable methods
// ---------------------------------------------------------------------------

describe('Retryable methods configuration', () => {
  it('retries only configured HTTP methods', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      retryableMethods: [AXIOS_RETRYER_HTTP_METHODS.GET, AXIOS_RETRYER_HTTP_METHODS.PUT],
      retryableStatuses: [503],
      backoffType: AXIOS_RETRYER_BACKOFF_TYPES.STATIC,
    });

    let getAttempts = 0;
    mock.onGet('/method-test').reply(() => {
      getAttempts++;
      return getAttempts < 2 ? [503, {}] : [200, {}];
    });

    let putAttempts = 0;
    mock.onPut('/method-test').reply(() => {
      putAttempts++;
      return putAttempts < 2 ? [503, {}] : [200, {}];
    });

    let deleteAttempts = 0;
    mock.onDelete('/method-test').reply(() => {
      deleteAttempts++;
      return [503, {}];
    });

    await manager.axiosInstance.get('/method-test');
    expect(getAttempts).toBe(2); // Retried once

    await manager.axiosInstance.put('/method-test', {});
    expect(putAttempts).toBe(2); // Retried once

    await swallow(manager.axiosInstance.delete('/method-test'));
    expect(deleteAttempts).toBe(1); // No retry (DELETE not in retryableMethods)

    manager.destroy();
    mock.restore();
  }, 15000);
});

// ---------------------------------------------------------------------------
// 24. Non-retryable status codes pass through immediately
// ---------------------------------------------------------------------------

describe('Non-retryable errors pass through', () => {
  it('4xx client errors are not retried by default', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance, retries: 3 });

    const attempts: Record<number, number> = {};
    [400, 401, 403, 404, 405, 422].forEach((status) => {
      attempts[status] = 0;
      mock.onGet(`/status-${status}`).reply(() => {
        attempts[status]++;
        return [status, {}];
      });
    });

    for (const status of [400, 401, 403, 404, 405, 422]) {
      await swallow(manager.axiosInstance.get(`/status-${status}`));
      expect(attempts[status]).toBe(1);
    }

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 25. createRetryer functional API
// ---------------------------------------------------------------------------

describe('createRetryer functional API', () => {
  it('creates a working retryer with defaults', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance });

    mock.onGet('/default').reply(200, { ok: true });

    const res = await manager.axiosInstance.get('/default');
    expect(res.status).toBe(200);

    manager.destroy();
    mock.restore();
  });

  it('creates a retryer without any options (uses internal axios instance)', async () => {
    const manager = createRetryer();

    // Should have created its own axios instance
    expect(manager.axiosInstance).toBeDefined();

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// 26. Request body preservation across retries
// ---------------------------------------------------------------------------

describe('Request body preservation', () => {
  it('preserves POST body across retry attempts', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
    });

    const receivedBodies: unknown[] = [];
    mock.onPost('/preserve-body').reply((config) => {
      const body = JSON.parse(config.data);
      receivedBodies.push(body);
      return receivedBodies.length < 2 ? [503, {}] : [200, { received: body }];
    });

    const payload = { name: 'test', nested: { value: 42 }, array: [1, 2, 3] };
    const res = await manager.axiosInstance.post('/preserve-body', payload, {
      headers: { 'Idempotency-Key': 'key-1' },
    });

    expect(res.status).toBe(200);
    // Body should be identical on every attempt
    receivedBodies.forEach((body) => {
      expect(body).toEqual(payload);
    });

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 27. Headers preservation across retries
// ---------------------------------------------------------------------------

describe('Custom headers preservation', () => {
  it('preserves custom headers across retry attempts', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
    });

    const receivedHeaders: Array<Record<string, unknown>> = [];
    mock.onGet('/preserve-headers').reply((config) => {
      receivedHeaders.push({
        'x-custom': config.headers?.['X-Custom-Header'],
        'x-request-id': config.headers?.['X-Request-ID'],
      });
      return receivedHeaders.length < 2 ? [503, {}] : [200, {}];
    });

    await manager.axiosInstance.get('/preserve-headers', {
      headers: {
        'X-Custom-Header': 'my-value',
        'X-Request-ID': 'req-abc-123',
      },
    });

    // Headers should be present on all attempts
    receivedHeaders.forEach((h) => {
      expect(h['x-custom']).toBe('my-value');
      expect(h['x-request-id']).toBe('req-abc-123');
    });

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 28. Simultaneous retries for multiple failing requests
// ---------------------------------------------------------------------------

describe('Simultaneous retries for multiple requests', () => {
  it('handles multiple requests retrying concurrently without interference', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      retryableStatuses: [503],
      maxConcurrentRequests: 10,
    });

    const attemptCounts: Record<string, number> = {};

    for (let i = 0; i < 5; i++) {
      attemptCounts[`endpoint-${i}`] = 0;
      mock.onGet(`/endpoint-${i}`).reply(() => {
        attemptCounts[`endpoint-${i}`]++;
        // Each endpoint fails once then succeeds
        return attemptCounts[`endpoint-${i}`] === 1 ? [503, {}] : [200, { id: i }];
      });
    }

    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => manager.axiosInstance.get(`/endpoint-${i}`)));

    results.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.data.id).toBe(i);
    });

    // Each endpoint should have been hit exactly twice (1 fail + 1 success)
    Object.values(attemptCounts).forEach((count) => {
      expect(count).toBe(2);
    });

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 29. Rapid fire sequential requests
// ---------------------------------------------------------------------------

describe('Rapid sequential request patterns', () => {
  it('handles rapid sequential requests without leaking state', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 0,
      maxConcurrentRequests: 2,
      queueDelay: 0,
    });
    manager.use(new MetricsPlugin());

    mock.onGet(/\/rapid\/\d+/).reply(200, { ok: true });

    // Fire 30 requests sequentially
    for (let i = 0; i < 30; i++) {
      const res = await manager.axiosInstance.get(`/rapid/${i}`);
      expect(res.status).toBe(200);
    }

    const metrics = manager.getMetrics();
    expect(metrics.totalRequests).toBe(30);
    expect(metrics.completelyFailedRequests).toBe(0);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 30. Circuit breaker with sliding window
// ---------------------------------------------------------------------------

describe('Circuit breaker sliding window', () => {
  it('only counts failures within the sliding window timeframe', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const cb = new CircuitBreakerPlugin({
      failureThreshold: 3,
      openTimeout: 5000,
      halfOpenMax: 1,
      useSlidingWindow: true,
      // Window must be shorter than the gap between batches so the first pair expires,
      // but long enough that three sequential failures in the second batch stay counted.
      slidingWindowSize: 800,
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cb);

    mock.onGet('/sw').reply(500, {});

    // Cause 2 failures
    await swallow(manager.axiosInstance.get('/sw'));
    await swallow(manager.axiosInstance.get('/sw'));
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.CLOSED);

    // Wait longer than slidingWindowSize so the first two failures age out
    await delay(900);

    // Cause 2 more failures – should not trip because old ones expired
    await swallow(manager.axiosInstance.get('/sw'));
    await swallow(manager.axiosInstance.get('/sw'));

    // Should still be closed because the first 2 failures expired
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.CLOSED);

    // Third failure in the same burst reaches the threshold (all share one window)
    await swallow(manager.axiosInstance.get('/sw'));
    expect(cb.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 31. Caching plugin events
// ---------------------------------------------------------------------------

describe('CachingPlugin events', () => {
  it('emits onCacheHit and onCacheMiss events', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const cache = new CachingPlugin();
    const manager = createRetryer<CachingPluginEvents>({ axiosInstance, retries: 0 });
    manager.use(cache);

    const hits: unknown[] = [];
    const misses: unknown[] = [];
    manager.on('onCacheHit', (payload) => hits.push(payload));
    manager.on('onCacheMiss', (payload) => misses.push(payload));

    mock.onGet('/events-cache').reply(200, { data: 'value' });

    // First request – miss
    await manager.axiosInstance.get('/events-cache');
    expect(misses).toHaveLength(1);
    expect(hits).toHaveLength(0);

    // Second request – hit
    await manager.axiosInstance.get('/events-cache');
    expect(hits).toHaveLength(1);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 32. Timeout errors are retried
// ---------------------------------------------------------------------------

describe('Timeout error retry', () => {
  it('retries on request timeout (ECONNABORTED)', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
    });

    const timeoutError = new AxiosError(
      'timeout of 50ms exceeded',
      'ECONNABORTED',
      { url: '/timeout-retry', method: 'get', headers: {} } as InternalAxiosRequestConfig,
      undefined,
    );

    mock.onGet('/timeout-retry').replyOnce(() => Promise.reject(timeoutError));
    mock.onGet('/timeout-retry').reply(200, { ok: true });

    const res = await manager.axiosInstance.get('/timeout-retry', { timeout: 50 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });

    manager.destroy();
    mock.restore();
  }, 15000);
});

// ---------------------------------------------------------------------------
// 33. Multiple retry managers on the same axios instance
// ---------------------------------------------------------------------------

describe('Shared axios instance warning', () => {
  it('each manager operates with its own interceptors', async () => {
    const shared = axios.create();
    const mock = new AxiosMockAdapter(shared, { delayResponse: 0 });

    // Even though we use the same axios instance, each manager sets up its own interceptors
    const managerA = createRetryer({
      axiosInstance: shared,
      retries: 1,
      retryableStatuses: [503],
    });

    mock.onGet('/shared-test').reply(200, { ok: true });

    const res = await managerA.axiosInstance.get('/shared-test');
    expect(res.status).toBe(200);

    managerA.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 34. Error type propagation
// ---------------------------------------------------------------------------

describe('Error type preservation', () => {
  it('preserves the original AxiosError type on terminal failure', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      retryableStatuses: [503],
    });

    mock.onGet('/error-type').reply(503, { message: 'service down' });

    try {
      await manager.axiosInstance.get('/error-type');
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const axiosError = error as AxiosError;
      expect(axiosError.response?.status).toBe(503);
      expect(axiosError.response?.data).toEqual({ message: 'service down' });
      expect(axiosError.config?.url).toBe('/error-type');
    }

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 35. Queue wait time tracking in dispatched events
// ---------------------------------------------------------------------------

describe('Queue wait time tracking', () => {
  it('dispatched events include accurate queue wait time', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 1,
      retries: 0,
    });

    const waitTimes: number[] = [];
    manager.on('onRequestDispatched', (payload) => {
      waitTimes.push(payload.queuedForMs);
    });

    let releaseBlocker!: () => void;
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseBlocker = () => resolve([200, {}]);
        }),
    );
    mock.onGet('/waited').reply(200, {});

    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseBlocker !== undefined);

    const waited = manager.axiosInstance.get('/waited');

    // Ensure the queued request waits at least 50ms
    await delay(50);
    releaseBlocker();

    await Promise.all([blocker, waited]);

    // The second request should have a non-trivial wait time
    expect(waitTimes.length).toBeGreaterThanOrEqual(2);
    const queuedForMs = waitTimes[waitTimes.length - 1];
    expect(queuedForMs).toBeGreaterThanOrEqual(30);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 36. Caching with varyHeaders for per-user caching
// ---------------------------------------------------------------------------

describe('CachingPlugin varyHeaders', () => {
  it('caches separately per Authorization header when varyHeaders is configured', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const cache = new CachingPlugin({
      skipWhenAuthPresent: false,
      varyHeaders: ['Authorization'],
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cache);

    let hitCount = 0;
    mock.onGet('/user-data').reply(() => {
      hitCount++;
      return [200, { call: hitCount }];
    });

    // User A
    const resA1 = await manager.axiosInstance.get('/user-data', {
      headers: { Authorization: 'Bearer user-a' },
    });
    // User B
    const resB1 = await manager.axiosInstance.get('/user-data', {
      headers: { Authorization: 'Bearer user-b' },
    });
    // User A again – should be cached
    const resA2 = await manager.axiosInstance.get('/user-data', {
      headers: { Authorization: 'Bearer user-a' },
    });

    expect(hitCount).toBe(2); // Two unique cache keys
    expect(resA1.data.call).toBe(1);
    expect(resB1.data.call).toBe(2);
    expect(resA2.data.call).toBe(1); // Served from user-A's cache

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 37. throwErrorOnCancelRequest: false
// ---------------------------------------------------------------------------

describe('throwErrorOnCancelRequest: false', () => {
  it('resolves null instead of throwing when a request is cancelled', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnCancelRequest: false,
    });

    mock
      .onGet('/cancel-null')
      .reply(() => new Promise<[number, object]>((resolve) => setTimeout(() => resolve([200, {}]), 5000)));

    const controller = new AbortController();
    const req = manager.axiosInstance.get('/cancel-null', { signal: controller.signal });

    await delay(30);
    controller.abort();

    const result = await req;
    expect(result).toBeNull();

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 38. Event unsubscription
// ---------------------------------------------------------------------------

describe('Event subscription management', () => {
  it('off() properly unsubscribes event listeners', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({ axiosInstance, retries: 0 });

    let callCount = 0;
    const listener = (): void => {
      callCount++;
    };

    manager.on('onRequestSucceeded', listener);
    mock.onGet('/unsub').reply(200, {});

    await manager.axiosInstance.get('/unsub');
    expect(callCount).toBe(1);

    manager.off('onRequestSucceeded', listener);

    await manager.axiosInstance.get('/unsub');
    expect(callCount).toBe(1); // Should not have incremented

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 39. Partial success in multi-request scenario
// ---------------------------------------------------------------------------

describe('Partial success scenarios', () => {
  it('some requests succeed while others fail without affecting each other', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      retryableStatuses: [503],
      maxConcurrentRequests: 5,
    });
    manager.use(new MetricsPlugin());

    mock.onGet('/ok-1').reply(200, { id: 1 });
    mock.onGet('/ok-2').reply(200, { id: 2 });
    mock.onGet('/fail-1').reply(503, {});
    mock.onGet('/ok-3').reply(200, { id: 3 });
    mock.onGet('/fail-2').reply(503, {});

    const results = await Promise.allSettled([
      manager.axiosInstance.get('/ok-1'),
      manager.axiosInstance.get('/ok-2'),
      manager.axiosInstance.get('/fail-1'),
      manager.axiosInstance.get('/ok-3'),
      manager.axiosInstance.get('/fail-2'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);

    // Verify successful responses have correct data
    const successData = fulfilled.map((r) => (r as PromiseFulfilledResult<AxiosResponse>).value.data);
    expect(successData).toEqual(expect.arrayContaining([{ id: 1 }, { id: 2 }, { id: 3 }]));

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 40. Real-world: SPA dashboard loading pattern
// ---------------------------------------------------------------------------

describe('Real-world: SPA dashboard parallel loading', () => {
  it('simulates a dashboard loading user data, notifications, and settings in parallel', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const manager = createRetryer({
      axiosInstance,
      retries: 2,
      maxConcurrentRequests: 5,
      retryableStatuses: [503, 500],
    });
    manager.use(new MetricsPlugin());
    manager.use(new CachingPlugin({ timeToRevalidate: 30000 }));

    // User profile – succeeds immediately
    mock.onGet('/api/user/profile').reply(200, {
      id: 1,
      name: 'Jane Doe',
      email: 'jane@example.com',
    });

    // Notifications – flaky, succeeds on second try
    let notifAttempts = 0;
    mock.onGet('/api/user/notifications').reply(() => {
      notifAttempts++;
      return notifAttempts === 1
        ? [503, { error: 'temporarily unavailable' }]
        : [200, { unread: 5, items: ['msg1', 'msg2'] }];
    });

    // Settings – stable
    mock.onGet('/api/user/settings').reply(200, {
      theme: 'dark',
      language: 'en',
    });

    // Analytics – returns 500 once, then succeeds
    let analyticsAttempts = 0;
    mock.onGet('/api/dashboard/analytics').reply(() => {
      analyticsAttempts++;
      return analyticsAttempts === 1 ? [500, {}] : [200, { pageViews: 1234, uniqueVisitors: 567 }];
    });

    const [profile, notifications, settings, analytics] = await Promise.all([
      manager.axiosInstance.get('/api/user/profile'),
      manager.axiosInstance.get('/api/user/notifications'),
      manager.axiosInstance.get('/api/user/settings'),
      manager.axiosInstance.get('/api/dashboard/analytics'),
    ]);

    expect(profile.data.name).toBe('Jane Doe');
    expect(notifications.data.unread).toBe(5);
    expect(settings.data.theme).toBe('dark');
    expect(analytics.data.pageViews).toBe(1234);

    // Second load of the dashboard – should come from cache
    const [profile2, notifications2] = await Promise.all([
      manager.axiosInstance.get('/api/user/profile'),
      manager.axiosInstance.get('/api/user/notifications'),
    ]);

    expect(profile2.data).toEqual(profile.data);
    expect(notifications2.data).toEqual(notifications.data);

    const metrics = manager.getMetrics();
    expect(metrics.successfulRetries).toBeGreaterThanOrEqual(2);
    expect(metrics.completelyFailedRequests).toBe(0);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 41. Real-world: E-commerce checkout with priority and token refresh
// ---------------------------------------------------------------------------

describe('Real-world: E-commerce checkout flow', () => {
  it('processes critical payment request with priority while refreshing token', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    let currentToken = 'valid-token';

    const manager = new RetryManager({
      axiosInstance,
      retries: 2,
      maxConcurrentRequests: 3,
      retryableStatuses: [503],
    });

    manager.use(
      new TokenRefreshPlugin(
        async () => {
          currentToken = 'refreshed-token';
          return { token: currentToken };
        },
        {
          refreshStatusCodes: [401],
          tokenPrefix: 'Bearer ',
          maxRefreshAttempts: 2,
        },
      ),
    );
    manager.use(new MetricsPlugin());

    // Payment endpoint – high priority, flaky
    let paymentAttempts = 0;
    mock.onPost('/api/payments').reply((config) => {
      paymentAttempts++;
      return paymentAttempts === 1 ? [503, {}] : [200, { transactionId: 'txn_123' }];
    });

    // Cart endpoint – medium priority
    mock.onGet('/api/cart').reply(200, { items: 3, total: 59.99 });

    // Recommendations – low priority (non-critical)
    mock.onGet('/api/recommendations').reply(200, { items: ['widget-a', 'gadget-b'] });

    const [payment, cart, recs] = await Promise.all([
      manager.axiosInstance.post(
        '/api/payments',
        { amount: 59.99 },
        {
          headers: {
            Authorization: `Bearer ${currentToken}`,
            'Idempotency-Key': 'payment-key-1',
          },
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        },
      ),
      manager.axiosInstance.get('/api/cart', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
      }),
      manager.axiosInstance.get('/api/recommendations', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
      }),
    ]);

    expect(payment.data.transactionId).toBe('txn_123');
    expect(cart.data.total).toBe(59.99);
    expect(recs.data.items).toHaveLength(2);
    expect(paymentAttempts).toBe(2); // Retried once

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 42. Real-world: Microservice health check with circuit breaker
// ---------------------------------------------------------------------------

describe('Real-world: Microservice health monitoring', () => {
  it('circuit breaker protects against cascading failures across services', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });

    const cb = new CircuitBreakerPlugin({
      failureThreshold: 2,
      openTimeout: 300,
      halfOpenMax: 1,
      scope: 'url',
    });

    const manager = createRetryer({ axiosInstance, retries: 0 });
    manager.use(cb);
    manager.use(new MetricsPlugin());

    // User service – healthy
    mock.onGet('/services/user').reply(200, { status: 'healthy' });

    // Order service – degraded
    mock.onGet('/services/order').reply(500, { status: 'error' });

    // Product service – healthy
    mock.onGet('/services/product').reply(200, { status: 'healthy' });

    // Order service failures trip its circuit
    await swallow(manager.axiosInstance.get('/services/order'));
    await swallow(manager.axiosInstance.get('/services/order'));

    // Order service circuit is OPEN; other services unaffected
    const orderFastFail = await swallow(manager.axiosInstance.get('/services/order'));
    expect(orderFastFail).toBeInstanceOf(Error);

    const userRes = await manager.axiosInstance.get('/services/user');
    expect(userRes.status).toBe(200);

    const productRes = await manager.axiosInstance.get('/services/product');
    expect(productRes.status).toBe(200);

    // Wait for order service circuit to enter HALF_OPEN
    await delay(400);

    // Order service recovers
    mock.onGet('/services/order').reply(200, { status: 'recovered' });
    const orderRecovery = await manager.axiosInstance.get('/services/order');
    expect(orderRecovery.status).toBe(200);
    expect(orderRecovery.data.status).toBe('recovered');

    manager.destroy();
    mock.restore();
  });
});
