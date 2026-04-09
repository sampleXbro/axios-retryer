/**
 * Contract tests for public event emissions (conditions + payloads).
 *
 * Also covered elsewhere (this file avoids duplicating them):
 * - Core: onRequestQueued, onRequestDispatched, onRequestSucceeded, onRequestError, onFailure,
 *   onRetryProcessFinished, beforeRetry, afterRetry (failure), onRequestCancelled, onInternetConnectionError,
 *   onBlockingRequestFailed — RetryManager.test.ts, coverage-targeted.regressions.test.ts
 * - onAllBlockingRequestsResolved — integration/core-features.e2e.test.ts
 * - Token refresh deep scenarios — integration/token-refresh-plugin.integration.test.ts
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { AXIOS_RETRYER_HTTP_METHODS, RETRY_MODES, RetryManager } from '../src';
import { createCachePlugin } from '../src/plugins/CachingPlugin';
import { CircuitBreakerPlugin, CIRCUIT_BREAKER_STATES } from '../src/plugins/CircuitBreakerPlugin';
import { createTokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';
describe('Public event surface (emission conditions)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits onRetryProcessStarted when automatic retry is scheduled, and afterRetry(config, true) when retry succeeds', async () => {
    const manager = new RetryManager({
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
      axiosInstance: axios.create(),
    }).use(new MetricsPlugin());

    const onRetryProcessStarted = jest.fn();
    const afterRetry = jest.fn();
    manager.on('onRetryProcessStarted', onRetryProcessStarted);
    manager.on('afterRetry', afterRetry);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/retry-ok').replyOnce(500).onGet('/retry-ok').replyOnce(200, { ok: true });

    await manager.axiosInstance.get('/retry-ok');

    expect(onRetryProcessStarted).toHaveBeenCalledTimes(1);
    expect(afterRetry).toHaveBeenCalledTimes(1);
    expect(afterRetry).toHaveBeenCalledWith(expect.objectContaining({ url: '/retry-ok' }), true);

    mock.restore();
    manager.destroy();
  });

  it('does not emit onInternetConnectionError when the terminal failure has an HTTP response', async () => {
    const manager = new RetryManager({
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: axios.create(),
    });
    const internet = jest.fn();
    manager.on('onInternetConnectionError', internet);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/http-fail').reply(500, { err: true });

    await manager.axiosInstance.get('/http-fail').catch(() => {});

    expect(internet).not.toHaveBeenCalled();

    mock.restore();
    manager.destroy();
  });

  it('CachingPlugin: onCacheMiss (empty) then onCacheHit; clearCache emits onCacheInvalidated', async () => {
    const cachePlugin = createCachePlugin({
      cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET],
      timeToRevalidate: 60_000,
    });
    const manager = new RetryManager({ retries: 0, axiosInstance: axios.create() }).use(cachePlugin);

    const onCacheHit = jest.fn();
    const onCacheMiss = jest.fn();
    const onCacheInvalidated = jest.fn();
    manager.on('onCacheHit', onCacheHit);
    manager.on('onCacheMiss', onCacheMiss);
    manager.on('onCacheInvalidated', onCacheInvalidated);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/cached-path').replyOnce(200, { n: 1 });

    await manager.axiosInstance.get('/cached-path');
    expect(onCacheMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'empty',
        config: expect.objectContaining({ url: '/cached-path' }),
      }),
    );
    expect(onCacheHit).not.toHaveBeenCalled();

    await manager.axiosInstance.get('/cached-path');
    expect(onCacheHit).toHaveBeenCalledTimes(1);
    expect(onCacheHit.mock.calls[0][0]).toMatchObject({
      config: expect.objectContaining({ url: '/cached-path' }),
    });
    expect(typeof onCacheHit.mock.calls[0][0].ageMs).toBe('number');

    cachePlugin.clearCache();
    expect(onCacheInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ matcher: 'all', count: expect.any(Number) }),
    );

    onCacheInvalidated.mockClear();
    mock.onGet('/inv-a').replyOnce(200, { a: 1 });
    mock.onGet('/inv-b').replyOnce(200, { b: 1 });
    await manager.axiosInstance.get('/inv-a');
    await manager.axiosInstance.get('/inv-b');
    cachePlugin.invalidateCache({ prefix: 'GET|/inv-a' });
    expect(onCacheInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ matcher: 'custom', count: expect.any(Number) }),
    );

    mock.restore();
    manager.destroy();
  });

  it('CachingPlugin: onCacheMiss with reason stale after TTR elapses', async () => {
    let now = 1_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    const cachePlugin = createCachePlugin({
      cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET],
      timeToRevalidate: 5_000,
    });
    const manager = new RetryManager({ retries: 0, axiosInstance: axios.create() }).use(cachePlugin);
    const onCacheMiss = jest.fn();
    manager.on('onCacheMiss', onCacheMiss);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/stale-key').reply(200, { v: 1 });

    await manager.axiosInstance.get('/stale-key');
    const callsAfterSeed = onCacheMiss.mock.calls.length;

    now += 6_000;
    mock.onGet('/stale-key').reply(200, { v: 2 });
    await manager.axiosInstance.get('/stale-key');

    expect(onCacheMiss.mock.calls.length).toBeGreaterThan(callsAfterSeed);
    expect(onCacheMiss.mock.calls.some((c) => c[0].reason === 'stale')).toBe(true);

    dateSpy.mockRestore();
    mock.restore();
    manager.destroy();
  });

  it('CircuitBreakerPlugin: emits onCircuitStateChanged when circuit opens', async () => {
    const manager = new RetryManager({
      retries: 0,
      axiosInstance: axios.create(),
    }).use(
      new CircuitBreakerPlugin({
        failureThreshold: 2,
        openTimeout: 60_000,
        useSlidingWindow: false,
        adaptiveTimeout: false,
        halfOpenMax: 1,
      }),
    );

    const onCircuitStateChanged = jest.fn();
    manager.on('onCircuitStateChanged', onCircuitStateChanged);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/trip-cb').reply(500);

    await expect(manager.axiosInstance.get('/trip-cb')).rejects.toThrow();
    await expect(manager.axiosInstance.get('/trip-cb')).rejects.toThrow();

    expect(
      onCircuitStateChanged.mock.calls.some(
        (c) => c[0].to === CIRCUIT_BREAKER_STATES.OPEN && c[0].from === CIRCUIT_BREAKER_STATES.CLOSED,
      ),
    ).toBe(true);

    mock.restore();
    manager.destroy();
  });

  it('ManualRetryPlugin: emits onManualRetryProcessStarted when retryFailedRequests runs with work', async () => {
    const manual = new ManualRetryPlugin({ maxRequestsToStore: 20 });
    const manager = new RetryManager({
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: axios.create(),
    }).use(manual);

    const onManualRetryProcessStarted = jest.fn();
    manager.on('onManualRetryProcessStarted', onManualRetryProcessStarted);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/manual-replay').replyOnce(500).onGet('/manual-replay').replyOnce(200, { ok: true });

    await manager.axiosInstance.get('/manual-replay').catch(() => {});

    expect(manual.getStoredRequests()).toHaveLength(1);

    await manual.retryFailedRequests();

    expect(onManualRetryProcessStarted).toHaveBeenCalledTimes(1);

    mock.restore();
    manager.destroy();
  });

  it('ManualRetryPlugin: emits onRequestRemovedFromStore when store exceeds maxRequestsToStore', async () => {
    const manual = new ManualRetryPlugin({ maxRequestsToStore: 1 });
    const manager = new RetryManager({
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: axios.create(),
    }).use(manual);

    const onRequestRemovedFromStore = jest.fn();
    manager.on('onRequestRemovedFromStore', onRequestRemovedFromStore);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/first').reply(500);
    mock.onGet('/second').reply(500);

    await manager.axiosInstance.get('/first').catch(() => {});
    await manager.axiosInstance.get('/second').catch(() => {});

    expect(onRequestRemovedFromStore).toHaveBeenCalledTimes(1);
    expect(onRequestRemovedFromStore).toHaveBeenCalledWith(expect.objectContaining({ url: '/first' }));

    mock.restore();
    manager.destroy();
  });

  it('createTokenRefreshPlugin: onBeforeTokenRefresh and onTokenRefreshed on successful 401 refresh', async () => {
    const manager = new RetryManager({
      retries: 0,
      axiosInstance: axios.create(),
    }).use(
      createTokenRefreshPlugin(async () => ({ token: 'refreshed-access' }), {
        refreshStatusCodes: [401],
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
      }),
    );

    const onBeforeTokenRefresh = jest.fn();
    const onTokenRefreshed = jest.fn();
    const onTokenRefreshFailed = jest.fn();
    manager.on('onBeforeTokenRefresh', onBeforeTokenRefresh);
    manager.on('onTokenRefreshed', onTokenRefreshed);
    manager.on('onTokenRefreshFailed', onTokenRefreshFailed);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/protected').replyOnce(401).onGet('/protected').replyOnce(200, { data: 'ok' });

    await manager.axiosInstance.get('/protected', {
      headers: { Authorization: 'Bearer old' },
    });

    expect(onBeforeTokenRefresh).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).toHaveBeenCalledWith('refreshed-access');
    expect(onTokenRefreshFailed).not.toHaveBeenCalled();

    mock.restore();
    manager.destroy();
  });

  it('createTokenRefreshPlugin: emits onTokenRefreshFailed when refresh exhausts attempts', async () => {
    const manager = new RetryManager({
      retries: 0,
      axiosInstance: axios.create(),
    }).use(
      createTokenRefreshPlugin(
        async () => {
          throw new Error('refresh denied');
        },
        {
          refreshStatusCodes: [401],
          maxRefreshAttempts: 1,
          retryOnRefreshFail: false,
        },
      ),
    );

    const onTokenRefreshFailed = jest.fn();
    const onTokenRefreshed = jest.fn();
    manager.on('onTokenRefreshFailed', onTokenRefreshFailed);
    manager.on('onTokenRefreshed', onTokenRefreshed);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/denied').reply(401);

    await manager.axiosInstance.get('/denied', { headers: { Authorization: 'Bearer x' } }).catch(() => {});

    expect(onTokenRefreshFailed).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).not.toHaveBeenCalled();

    mock.restore();
    manager.destroy();
  });

  it('MetricsPlugin: emits onMetricsUpdated after a completed request', async () => {
    const manager = new RetryManager({ retries: 0, axiosInstance: axios.create() }).use(new MetricsPlugin());
    const onMetricsUpdated = jest.fn();
    manager.on('onMetricsUpdated', onMetricsUpdated);

    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/metric-path').reply(200, { x: 1 });

    await manager.axiosInstance.get('/metric-path');

    expect(onMetricsUpdated).toHaveBeenCalled();
    const last = onMetricsUpdated.mock.calls[onMetricsUpdated.mock.calls.length - 1][0];
    expect(last.totalRequests).toBe(1);

    mock.restore();
    manager.destroy();
  });
});
