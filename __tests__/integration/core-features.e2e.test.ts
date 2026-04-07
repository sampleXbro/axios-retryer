/**
 * E2E tests for core library features.
 *
 * Covers:
 *  - Core blocking: critical requests block lower-priority requests until resolved
 *  - TokenRefreshPlugin abort: no refresh token in storage aborts queued requests immediately
 *  - Priority queue ordering: CRITICAL → HIGHEST → HIGH → MEDIUM → LOW
 *  - Core retry mechanics: automatic retries, throwErrorOnFailedRetries, cancelAllRequests
 */

import axios, { AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { createRetryer, AXIOS_RETRYER_REQUEST_PRIORITIES, RetryManager } from '../../src';
import { MetricsPlugin } from '../../src/plugins/MetricsPlugin';
import {
  TokenRefreshPlugin,
  TokenRefreshAbortError,
} from '../../src/plugins/TokenRefreshPlugin';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(10);
  }
};

// ---------------------------------------------------------------------------
// Core queue blocking via blockingPriorityThreshold
// ---------------------------------------------------------------------------

describe('Core blocking – critical requests block lower-priority requests', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let manager: RetryManager;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
    manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 5,
      retries: 0,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
      cancelPendingOnDependencyFailure: false,
    });
  });

  afterEach(() => {
    manager.destroy();
    mock.restore();
  });

  it('holds non-critical requests in the gate while two critical requests are in flight', async () => {
    const dispatched: string[] = [];

    let releaseCritical1!: () => void;
    let releaseCritical2!: () => void;

    mock.onGet('/critical1').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseCritical1 = () => {
            dispatched.push('critical1');
            resolve([200, { id: 'c1' }]);
          };
        }),
    );

    mock.onGet('/critical2').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseCritical2 = () => {
            dispatched.push('critical2');
            resolve([200, { id: 'c2' }]);
          };
        }),
    );

    mock.onGet('/normal1').reply(() => {
      dispatched.push('normal1');
      return [200, { id: 'n1' }];
    });

    mock.onGet('/normal2').reply(() => {
      dispatched.push('normal2');
      return [200, { id: 'n2' }];
    });

    const critical1 = manager.axiosInstance.get('/critical1', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
    });
    const critical2 = manager.axiosInstance.get('/critical2', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
    });

    // Wait for both critical requests to be captured by the mock handler.
    await waitFor(() => releaseCritical1 !== undefined && releaseCritical2 !== undefined);

    const normal1 = manager.axiosInstance.get('/normal1', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
    });
    const normal2 = manager.axiosInstance.get('/normal2', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
    });

    // Normal requests must not have been dispatched yet — gate is still active.
    await delay(50);
    expect(dispatched).toEqual([]);

    // Resolve first critical. Gate still active (second critical still running).
    releaseCritical1();
    await delay(50);
    expect(dispatched).toEqual(['critical1']);
    expect(dispatched).not.toContain('normal1');
    expect(dispatched).not.toContain('normal2');

    // Resolve second critical. Gate lifts; both normals should run.
    releaseCritical2();

    await Promise.all([critical1, critical2, normal1, normal2]);

    expect(dispatched).toContain('critical2');
    expect(dispatched).toContain('normal1');
    expect(dispatched).toContain('normal2');

    // All normal requests started only after both criticals finished.
    const critical2Idx = dispatched.indexOf('critical2');
    expect(dispatched.indexOf('normal1')).toBeGreaterThan(critical2Idx);
    expect(dispatched.indexOf('normal2')).toBeGreaterThan(critical2Idx);
  });

  it('emits onAllBlockingRequestsResolved only after the last critical request succeeds', async () => {
    const resolved = jest.fn();
    manager.on('onAllBlockingRequestsResolved', resolved);

    let releaseCritical!: () => void;

    mock.onGet('/critical').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseCritical = () => resolve([200, {}]);
        }),
    );

    const req = manager.axiosInstance.get('/critical', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
    });

    await waitFor(() => releaseCritical !== undefined);
    expect(resolved).not.toHaveBeenCalled();

    releaseCritical();
    await req;

    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('cancels pending non-critical requests when a critical request fails (cancelPendingOnDependencyFailure: true)', async () => {
    // Use a fresh axios instance to avoid interceptor conflicts with the beforeEach manager.
    const freshAxios = axios.create();
    const freshMock = new AxiosMockAdapter(freshAxios);
    const cancellingManager = new RetryManager({
      axiosInstance: freshAxios,
      // Single slot forces the LOW priority request to stay in the queue while critical runs.
      maxConcurrentRequests: 1,
      retries: 0,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
      cancelPendingOnDependencyFailure: true,
    });

    const allBlockingResolved = jest.fn();
    cancellingManager.on('onAllBlockingRequestsResolved', allBlockingResolved);

    let resolveCritical!: (result: [number, object]) => void;

    freshMock.onGet('/critical-fail').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          resolveCritical = resolve;
        }),
    );

    freshMock.onGet('/pending').reply(200, { id: 'p' });

    const criticalReq = cancellingManager.axiosInstance
      .get('/critical-fail', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
      })
      .catch((e) => e);

    // Wait for the critical request to enter the mock handler.
    await waitFor(() => resolveCritical !== undefined);

    const pendingReq = cancellingManager.axiosInstance
      .get('/pending', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
      })
      .catch((e) => e);

    // Give the pending request time to register in the lifecycle and sit in the gate.
    await delay(20);

    // Fail the critical request — triggers onFailure → cancelQueuedRequests.
    resolveCritical([500, { err: 'critical failed' }]);

    const [criticalResult, pendingResult] = await Promise.all([criticalReq, pendingReq]);

    expect(criticalResult).toBeInstanceOf(Error);
    // Pending request must have been cancelled, not fulfilled with { id: 'p' }.
    expect(pendingResult).toBeInstanceOf(Error);
    expect(allBlockingResolved).not.toHaveBeenCalled();

    cancellingManager.destroy();
    freshMock.restore();
  });
});

// ---------------------------------------------------------------------------
// TokenRefreshPlugin – abort when no refresh token available
// ---------------------------------------------------------------------------

describe('TokenRefreshPlugin – abort when no refresh token in storage', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let manager: RetryManager;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
    manager = new RetryManager({ axiosInstance, retries: 0 });
  });

  afterEach(() => {
    manager.destroy();
    mock.restore();
  });

  it('rejects the original request immediately with the abort error when no token is stored', async () => {
    manager.use(
      new TokenRefreshPlugin(
        async () => {
          // Simulates reading from localStorage and finding nothing.
          throw new TokenRefreshAbortError('No refresh token in storage');
        },
        { refreshStatusCodes: [401], maxRefreshAttempts: 1 },
      ),
    );

    mock.onGet('/secure').reply(401);

    await expect(
      manager.axiosInstance.get('/secure', {
        headers: { Authorization: 'Bearer expired' },
      }),
    ).rejects.toThrow('No refresh token in storage');
  });

  it('does not call the refresh handler more than once even with retryOnRefreshFail=true when abort is thrown', async () => {
    const refreshHandler = jest.fn(async () => {
      throw new TokenRefreshAbortError('No refresh token in storage');
    });

    manager.use(
      new TokenRefreshPlugin(refreshHandler, {
        refreshStatusCodes: [401],
        maxRefreshAttempts: 3,
        retryOnRefreshFail: true,
      }),
    );

    mock.onGet('/secure').reply(401);

    await expect(
      manager.axiosInstance.get('/secure', {
        headers: { Authorization: 'Bearer expired' },
      }),
    ).rejects.toThrow('No refresh token in storage');

    // TokenRefreshAbortError stops retries immediately — handler called only once.
    expect(refreshHandler).toHaveBeenCalledTimes(1);
  });

  it('rejects all queued protected requests when abort is thrown mid-refresh', async () => {
    let rejectRefresh!: (err: Error) => void;

    const plugin = new TokenRefreshPlugin(
      () =>
        new Promise<{ token: string }>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
      {
        refreshStatusCodes: [401],
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
      },
    );
    manager.use(plugin);

    mock.onGet('/secure').reply(401);
    mock.onGet('/also-secure').reply(200, { ok: true });

    const first = manager.axiosInstance
      .get('/secure', { headers: { Authorization: 'Bearer expired' } })
      .catch((e: Error) => e);

    // Wait for the refresh handler to start and store rejectRefresh.
    await waitFor(() => rejectRefresh !== undefined);

    // Queue a second protected request while refresh is in progress.
    const second = manager.axiosInstance
      .get('/also-secure', { headers: { Authorization: 'Bearer expired' } })
      .catch((e: Error) => e);

    // Wait for the second request to enter the plugin's internal refresh queue.
    await waitFor(() => (plugin as unknown as { refreshQueue: unknown[] }).refreshQueue.length > 0);

    rejectRefresh(new TokenRefreshAbortError('No refresh token in storage'));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBeInstanceOf(Error);
    expect((firstResult as Error).message).toContain('No refresh token in storage');
    expect(secondResult).toBeInstanceOf(Error);
    expect((secondResult as Error).message).toContain('No refresh token in storage');
  });
});

// ---------------------------------------------------------------------------
// Priority queue ordering
// ---------------------------------------------------------------------------

describe('Priority queue ordering', () => {
  it('dispatches requests in CRITICAL → HIGHEST → HIGH → MEDIUM → LOW order', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance);
    // Single concurrent slot forces strict sequential ordering by priority.
    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 1,
      retries: 0,
      queueDelay: 0,
    });

    const order: string[] = [];
    let releaseFirst!: () => void;

    // First request occupies the single slot so the rest queue up.
    mock.onGet('/blocker').reply(
      () =>
        new Promise<[number, object]>((resolve) => {
          releaseFirst = () => resolve([200, {}]);
        }),
    );

    const endpoints = ['low', 'medium', 'high', 'highest', 'critical'] as const;
    for (const ep of endpoints) {
      mock.onGet(`/${ep}`).reply(() => {
        order.push(ep);
        return [200, { ep }];
      });
    }

    // Occupy the slot.
    const blocker = manager.axiosInstance.get('/blocker');
    await waitFor(() => releaseFirst !== undefined);

    // Queue all priorities while the slot is busy.
    const requests = [
      manager.axiosInstance.get('/low', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
      }),
      manager.axiosInstance.get('/medium', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
      }),
      manager.axiosInstance.get('/high', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
      }),
      manager.axiosInstance.get('/highest', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST },
      }),
      manager.axiosInstance.get('/critical', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
      }),
    ];

    releaseFirst();
    await blocker;
    await Promise.all(requests);

    expect(order).toEqual(['critical', 'highest', 'high', 'medium', 'low']);

    manager.destroy();
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// Core retry mechanics
// ---------------------------------------------------------------------------

describe('Core retry mechanics', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  it('retries on 5xx failures and succeeds on the final attempt', async () => {
    const manager = createRetryer({ axiosInstance, retries: 3, retryableStatuses: [500] });

    let attempts = 0;
    mock.onGet('/flaky').reply(() => {
      attempts++;
      return attempts < 3 ? [500, { err: 'not yet' }] : [200, { ok: true }];
    });

    const response = await manager.axiosInstance.get('/flaky');
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it('returns null instead of throwing when throwErrorOnFailedRetries is false', async () => {
    const manager = createRetryer({
      axiosInstance,
      retries: 1,
      throwErrorOnFailedRetries: false,
    });

    mock.onGet('/always-fails').reply(500);

    const response = await manager.axiosInstance.get('/always-fails');
    expect(response).toBeNull();
  });

  it('cancelAllRequests prevents a queued request from being dispatched', async () => {
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

    let queuedWasDispatched = false;
    mock.onGet('/queued').reply(() => {
      queuedWasDispatched = true;
      return [200, { ok: true }];
    });

    // Blocker occupies the single concurrent slot.
    const blocker = manager.axiosInstance.get('/blocker').catch(() => null);
    await waitFor(() => releaseBlocker !== undefined);

    // Queue a second request — it will sit in the waiting list until the slot opens.
    manager.axiosInstance.get('/queued').catch(() => null);

    // Give the queued request time to register in the lifecycle.
    await delay(20);

    // Cancel all requests before releasing the blocker.
    manager.cancelAllRequests();

    // Release the blocker so the test can complete.
    releaseBlocker();
    await blocker;

    // Allow any pending microtasks to run.
    await delay(20);

    // The queued request must never have reached the mock handler.
    expect(queuedWasDispatched).toBe(false);

    manager.destroy();
  });

  it('MetricsPlugin tracks successfulRetries and completelyFailedRequests correctly', async () => {
    const manager = createRetryer({ axiosInstance, retries: 2 });
    manager.use(new MetricsPlugin());

    let attempts = 0;
    mock.onGet('/succeed-on-retry').reply(() => {
      attempts++;
      return attempts === 1 ? [503, {}] : [200, { ok: true }];
    });

    mock.onGet('/always-fails').reply(503);

    await manager.axiosInstance.get('/succeed-on-retry');
    await manager.axiosInstance.get('/always-fails').catch(() => null);

    const metrics = manager.getMetrics();
    // At least one retry succeeded (succeed-on-retry needed one retry).
    expect(metrics.successfulRetries).toBeGreaterThanOrEqual(1);
    // Exactly one request exhausted all retries and still failed.
    expect(metrics.completelyFailedRequests).toBe(1);
    // Both eventually counted in retry metrics.
    expect(metrics.failedRetries).toBeGreaterThanOrEqual(1);
  });

  it('per-request retries override the manager default', async () => {
    const manager = createRetryer({ axiosInstance, retries: 5, retryableStatuses: [503] });

    let attempts = 0;
    mock.onGet('/override').reply(() => {
      attempts++;
      return [503, {}];
    });

    await manager.axiosInstance
      .get('/override', { __axiosRetryer: { requestRetries: 1 } })
      .catch(() => null);

    // 1 original + 1 retry = 2 total attempts despite manager allowing 5.
    expect(attempts).toBe(2);
  });
});
