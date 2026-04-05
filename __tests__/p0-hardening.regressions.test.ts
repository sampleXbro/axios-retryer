// @ts-nocheck
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { RequestAbortedError, RetryManager } from '../src';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { TokenRefreshAbortError, TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { AXIOS_RETRYER_HTTP_METHODS } from '../src/types';

const waitForAssertion = async (assertion: () => void, timeoutMs = 1000) => {
  const startedAt = Date.now();

  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

const stringifyCalls = (calls: unknown[][]): string => JSON.stringify(calls);

describe('P0 hardening regressions', () => {
  test('generates opaque request IDs without URL-derived fragments', async () => {
    const manager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
    });
    const manualRetry = new ManualRetryPlugin();
    const mock = new AxiosMockAdapter(manager.axiosInstance);
    manager.use(manualRetry);

    mock.onGet('/users?token=secret-token&email=user@example.com').reply(500, { error: 'nope' });

    await manager.axiosInstance.get('/users?token=secret-token&email=user@example.com').catch(() => undefined);

    const storedRequest = manualRetry.getStoredRequests()[0];
    const requestId = storedRequest.__axiosRetryer?.requestId;

    expect(requestId).toMatch(/^req_/);
    expect(requestId).not.toContain('/users');
    expect(requestId).not.toContain('token');
    expect(requestId).not.toContain('secret-token');
    expect(requestId).not.toContain('user@example.com');

    mock.restore();
    manager.destroy();
  });

  test('keeps cache hit diagnostics free of raw query params and auth headers', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance);
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
    };
    const manager = {
      axiosInstance,
      getLogger: () => logger,
    };
    const plugin = new CachingPlugin({ compareHeaders: true, skipWhenAuthPresent: false });

    plugin.initialize(manager as unknown as RetryManager);

    mock.onGet('/profile?access_token=secret-query').replyOnce(200, { ok: true });

    await axiosInstance.get('/profile?access_token=secret-query', {
      headers: { Authorization: 'Bearer super-secret-header' },
    });
    await axiosInstance.get('/profile?access_token=secret-query', {
      headers: { Authorization: 'Bearer super-secret-header' },
    });

    const callsText = stringifyCalls(logger.debug.mock.calls);
    expect(callsText).toContain('cacheKeyFingerprint');
    expect(callsText).not.toContain('access_token=secret-query');
    expect(callsText).not.toContain('super-secret-header');

    plugin.onBeforeDestroyed();
    mock.restore();
  });

  test('keeps cache warning diagnostics free of raw body-derived keys', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance);
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
    };
    const manager = {
      axiosInstance,
      getLogger: () => logger,
    };
    const plugin = new CachingPlugin({
      cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.POST],
      storage: {
        entries: () => [],
        get: () => undefined,
        set: () => {
          throw new Error('storage write failed');
        },
        delete: () => undefined,
        clear: () => undefined,
      },
    });

    plugin.initialize(manager as unknown as RetryManager);

    mock.onPost('/payments').replyOnce(200, { ok: true });

    await axiosInstance.post('/payments', { cardNumber: '4111111111111111', secret: 'super-secret-body' });

    const callsText = stringifyCalls(logger.warn.mock.calls);
    expect(callsText).toContain('cacheKeyFingerprint');
    expect(callsText).not.toContain('4111111111111111');
    expect(callsText).not.toContain('super-secret-body');

    plugin.onBeforeDestroyed();
    mock.restore();
  });

  test('preserves caller aborts for queued requests instead of overriding them', async () => {
    const manager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
      maxConcurrentRequests: 1,
      queueDelay: 0,
    });
    const mock = new AxiosMockAdapter(manager.axiosInstance);
    let releaseSlowRequest;

    mock.onGet('/slow').reply(
      () =>
        new Promise((resolve) => {
          releaseSlowRequest = () => resolve([200, { ok: true }]);
        }),
    );
    mock.onGet('/queued').reply(200, { shouldNotRun: true });

    const slowRequest = manager.axiosInstance.get('/slow');
    await waitForAssertion(() => {
      expect(mock.history.get).toHaveLength(1);
    });

    const callerController = new AbortController();
    const queuedRequest = manager.axiosInstance.get('/queued', {
      signal: callerController.signal,
    });

    callerController.abort();

    await expect(queuedRequest).rejects.toBeInstanceOf(RequestAbortedError);
    expect(mock.history.get).toHaveLength(1);

    releaseSlowRequest();
    await expect(slowRequest).resolves.toMatchObject({ status: 200 });

    mock.restore();
    manager.destroy();
  });

  test('does not expose root manual replay APIs on RetryManager', async () => {
    const manager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
    });
    const mock = new AxiosMockAdapter(manager.axiosInstance);

    expect('requestStore' in manager).toBe(false);
    expect('retryFailedRequests' in manager).toBe(false);

    mock.onGet('/fails').reply(500, { error: 'stored' });

    await manager.axiosInstance.get('/fails').catch(() => undefined);

    mock.restore();
    manager.destroy();
  });

  test('clears ManualRetryPlugin state on manager destroy', async () => {
    const manager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
    });
    const manualRetry = new ManualRetryPlugin();
    const mock = new AxiosMockAdapter(manager.axiosInstance);

    manager.use(manualRetry);
    mock.onGet('/manual-failure').reply(500, { error: 'retry later' });

    await manager.axiosInstance.get('/manual-failure').catch(() => undefined);

    expect(manualRetry.getStoredRequests()).toHaveLength(1);

    manager.destroy();

    expect(manualRetry.getStoredRequests()).toHaveLength(0);

    mock.restore();
  });

  test('skips auth-bearing requests by default in ManualRetryPlugin', async () => {
    const manager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
    });
    const manualRetry = new ManualRetryPlugin();
    const mock = new AxiosMockAdapter(manager.axiosInstance);

    manager.use(manualRetry);
    mock.onGet('/manual-auth-failure').reply(500, { error: 'retry later' });

    await manager.axiosInstance.get('/manual-auth-failure', {
      headers: {
        Authorization: 'Bearer super-secret',
        Cookie: 'session=abc123',
      },
    }).catch(() => undefined);

    expect(manualRetry.getStoredRequests()).toHaveLength(0);

    mock.restore();
    manager.destroy();
  });

  test('applies prepareRequestForStore after stripping sensitive auth material', async () => {
    const manager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
    });
    const manualRetry = new ManualRetryPlugin({
      storeNonIdempotent: true,
      storeAuthRequests: true,
      prepareRequestForStore: (config) => ({
        ...config,
        data: { redacted: true },
      }),
    });
    const mock = new AxiosMockAdapter(manager.axiosInstance);

    manager.use(manualRetry);
    mock.onPost('/manual-sanitized-failure').reply(500, { error: 'retry later' });

    await manager.axiosInstance.post(
      '/manual-sanitized-failure',
      { secret: 'body-value' },
      {
        auth: {
          username: 'user',
          password: 'pass',
        },
        headers: {
          Authorization: 'Bearer super-secret',
          Cookie: 'session=abc123',
          'X-API-Key': 'secret-key',
        },
      },
    ).catch(() => undefined);

    const [storedRequest] = manualRetry.getStoredRequests();

    expect(storedRequest.data).toEqual({ redacted: true });
    expect(storedRequest.auth).toBeUndefined();
    expect(Object.keys(storedRequest.headers ?? {}).map((key) => key.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(storedRequest.headers ?? {}).map((key) => key.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(storedRequest.headers ?? {}).map((key) => key.toLowerCase())).not.toContain('x-api-key');

    mock.restore();
    manager.destroy();
  });

  test('rejects token refresh waiters when the plugin is removed', async () => {
    const manager = new RetryManager({ axiosInstance: axios.create() });
    const mock = new AxiosMockAdapter(manager.axiosInstance);
    let releaseRefresh;
    const refreshToken = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    const plugin = new TokenRefreshPlugin(refreshToken, {
      refreshStatusCodes: [401],
    });

    manager.use(plugin);

    mock.onGet('/protected').replyOnce(401);

    const firstRequest = manager.axiosInstance.get('/protected', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(refreshToken).toHaveBeenCalledTimes(1);
    });

    const waitingRequest = manager.axiosInstance.get('/protected', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(plugin['refreshQueue']).toHaveLength(1);
    });

    expect(manager.unuse('TokenRefreshPlugin')).toBe(true);

    await expect(firstRequest).rejects.toBeInstanceOf(TokenRefreshAbortError);
    await expect(waitingRequest).rejects.toBeInstanceOf(TokenRefreshAbortError);
    expect(plugin['refreshQueue']).toHaveLength(0);

    releaseRefresh?.({ token: 'late-token' });
    mock.restore();
    manager.destroy();
  });

  test('rejects token refresh waiters when the manager is destroyed', async () => {
    const manager = new RetryManager({ axiosInstance: axios.create() });
    const mock = new AxiosMockAdapter(manager.axiosInstance);
    const refreshToken = jest.fn(() => new Promise(() => {}));
    const plugin = new TokenRefreshPlugin(refreshToken, {
      refreshStatusCodes: [401],
    });

    manager.use(plugin);

    mock.onGet('/secure').replyOnce(401);

    const firstRequest = manager.axiosInstance.get('/secure', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(refreshToken).toHaveBeenCalledTimes(1);
    });

    const waitingRequest = manager.axiosInstance.get('/secure', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(plugin['refreshQueue']).toHaveLength(1);
    });

    manager.destroy();

    await expect(firstRequest).rejects.toBeInstanceOf(TokenRefreshAbortError);
    await expect(waitingRequest).rejects.toBeInstanceOf(TokenRefreshAbortError);
    expect(plugin['refreshQueue']).toHaveLength(0);

    mock.restore();
  });
});
