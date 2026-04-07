import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../../src';
import { TokenRefreshPlugin, type TokenRefreshPluginEvents } from '../../src/plugins/TokenRefreshPlugin';

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

const getHeader = (config: AxiosRequestConfig, headerName: string): string | undefined => {
  const headers = config.headers;
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as AxiosHeaders).get === 'function') {
    const value = (headers as AxiosHeaders).get(headerName);
    return typeof value === 'string' ? value : undefined;
  }

  const entries = Object.entries(headers as Record<string, unknown>);
  const match = entries.find(([key]) => key.toLowerCase() === headerName.toLowerCase());
  return typeof match?.[1] === 'string' ? match[1] : undefined;
};

describe('TokenRefreshPlugin integration', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let hooks: Record<string, jest.Mock>;
  let retryManager: RetryManager<TokenRefreshPluginEvents>;
  let refreshFn: jest.Mock;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
    hooks = {
      onBeforeTokenRefresh: jest.fn(),
      onTokenRefreshed: jest.fn(),
      onTokenRefreshFailed: jest.fn(),
    };

    refreshFn = jest.fn(async () => ({ token: 'fresh-token' }));
    retryManager = new RetryManager<TokenRefreshPluginEvents>({ axiosInstance });
    retryManager.on('onBeforeTokenRefresh', hooks.onBeforeTokenRefresh);
    retryManager.on('onTokenRefreshed', hooks.onTokenRefreshed);
    retryManager.on('onTokenRefreshFailed', hooks.onTokenRefreshFailed);
  });

  afterEach(() => {
    retryManager.destroy();
    mock.restore();
    jest.clearAllMocks();
  });

  it('replays queued protected requests and emits refresh lifecycle hooks once', async () => {
    let releaseRefresh: ((value: { token: string }) => void) | undefined;
    refreshFn.mockImplementation(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseRefresh = resolve;
        }),
    );

    retryManager.use(
      new TokenRefreshPlugin(refreshFn, {
        authHeaderName: 'Authorization',
        tokenPrefix: 'Bearer ',
        refreshStatusCodes: [401],
        retryOnRefreshFail: false,
        maxRefreshAttempts: 1,
      }),
    );

    mock
      .onGet('/account')
      .replyOnce(401)
      .onGet('/account')
      .replyOnce((config) => {
        return getHeader(config, 'Authorization') === 'Bearer fresh-token'
          ? [200, { account: true }]
          : [401, { error: 'stale token' }];
      });

    let queuedCalls = 0;
    mock.onGet('/profile').reply((config) => {
      queuedCalls++;
      return getHeader(config, 'Authorization') === 'Bearer fresh-token'
        ? [200, { profile: true }]
        : [401, { error: 'stale token' }];
    });

    const accountRequest = retryManager.axiosInstance.get('/account', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(hooks.onBeforeTokenRefresh).toHaveBeenCalledTimes(1);
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    const profileRequest = retryManager.axiosInstance.get('/profile', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(queuedCalls).toBe(0);

    releaseRefresh?.({ token: 'fresh-token' });

    const [accountResponse, profileResponse] = await Promise.all([accountRequest, profileRequest]);

    expect(accountResponse.data).toEqual({ account: true });
    expect(profileResponse.data).toEqual({ profile: true });
    expect(queuedCalls).toBe(1);
    expect(hooks.onTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(hooks.onTokenRefreshed).toHaveBeenCalledWith('fresh-token');
    expect(hooks.onTokenRefreshFailed).not.toHaveBeenCalled();
  });

  it('rejects queued protected requests and emits the failure hook when refresh fails', async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    refreshFn.mockImplementation(
      () =>
        new Promise<{ token: string }>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );

    const plugin = new TokenRefreshPlugin(refreshFn, {
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1,
    });
    retryManager.use(plugin);

    mock.onGet('/fails-refresh').replyOnce(401);

    let queuedCalls = 0;
    mock.onGet('/waiting-protected').reply(() => {
      queuedCalls++;
      return [200, { shouldNotHappen: true }];
    });

    const firstRequest = retryManager.axiosInstance.get('/fails-refresh', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(hooks.onBeforeTokenRefresh).toHaveBeenCalledTimes(1);
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(rejectRefresh).toBeDefined();
    });

    const queuedRequest = retryManager.axiosInstance.get('/waiting-protected', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect((plugin as any).refreshQueue).toHaveLength(1);
    });
    expect(queuedCalls).toBe(0);

    rejectRefresh?.(new Error('refresh exploded'));

    await expect(firstRequest).rejects.toThrow('refresh exploded');
    await expect(queuedRequest).rejects.toThrow('refresh exploded');
    expect(queuedCalls).toBe(0);
    expect(hooks.onTokenRefreshFailed).toHaveBeenCalledTimes(1);
    expect(hooks.onTokenRefreshed).not.toHaveBeenCalled();
  });

  it('reuses the manager adapter for relative refresh requests and fans refresh in once', async () => {
    let refreshCalls = 0;
    let refreshAdapterCalls = 0;
    let releaseRefresh: (() => void) | undefined;

    axiosInstance.defaults.adapter = jest.fn(async (config) => {
      if (config.url === '/auth/refresh') {
        refreshAdapterCalls++;

        return new Promise((resolve) => {
          releaseRefresh = () => {
            resolve({
              config,
              data: { token: 'fresh-token' },
              headers: {},
              status: 200,
              statusText: 'OK',
            });
          };
        });
      }

      const token = getHeader(config, 'Authorization');
      if (token === 'Bearer fresh-token') {
        return {
          config,
          data: { ok: true, url: config.url },
          headers: {},
          status: 200,
          statusText: 'OK',
        };
      }

      const error = new Error('Unauthorized') as Error & {
        config: AxiosRequestConfig;
        response: {
          config: AxiosRequestConfig;
          data: { error: string };
          headers: Record<string, never>;
          status: number;
          statusText: string;
        };
      };
      error.config = config;
      error.response = {
        config,
        data: { error: 'Unauthorized' },
        headers: {},
        status: 401,
        statusText: 'Unauthorized',
      };
      throw error;
    });

    retryManager.use(
      new TokenRefreshPlugin(async (refreshAxios) => {
        refreshCalls++;
        const response = await refreshAxios.post('/auth/refresh');
        return { token: response.data.token };
      }, {
        authHeaderName: 'Authorization',
        tokenPrefix: 'Bearer ',
        refreshStatusCodes: [401],
        retryOnRefreshFail: false,
        maxRefreshAttempts: 1,
      }),
    );

    const accountRequest = retryManager.axiosInstance.get('/account', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(refreshCalls).toBe(1);
      expect(refreshAdapterCalls).toBe(1);
      expect(releaseRefresh).toBeDefined();
    });

    const profileRequest = retryManager.axiosInstance.get('/profile', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(refreshCalls).toBe(1);
    expect(refreshAdapterCalls).toBe(1);

    releaseRefresh?.();

    const [accountResponse, profileResponse] = await Promise.all([accountRequest, profileRequest]);

    expect(accountResponse.data).toEqual({ ok: true, url: '/account' });
    expect(profileResponse.data).toEqual({ ok: true, url: '/profile' });
    expect(refreshCalls).toBe(1);
    expect(refreshAdapterCalls).toBe(1);
  });

  it('rejects subsequent 401s immediately when the same token previously failed to refresh', async () => {
    let refreshAttempts = 0;
    const failingRefresh = jest.fn(async () => {
      refreshAttempts++;
      throw new Error('refresh endpoint down');
    });

    retryManager.use(
      new TokenRefreshPlugin(failingRefresh, {
        retryOnRefreshFail: false,
        maxRefreshAttempts: 1,
      }),
    );

    // Set the expired token as the default so it appears on every request
    retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-tok';
    mock.onGet('/protected').reply(401);

    const results = await Promise.allSettled([
      retryManager.axiosInstance.get('/protected'),
      retryManager.axiosInstance.get('/protected'),
      retryManager.axiosInstance.get('/protected'),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // Only one real refresh attempt — requests 2 and 3 are short-circuited because
    // they carry the same token value that already failed
    expect(refreshAttempts).toBe(1);
    expect(hooks.onTokenRefreshFailed).toHaveBeenCalledTimes(1);
  });

  it('allows a new refresh attempt when a different token is presented after a failure', async () => {
    let refreshAttempts = 0;

    const conditionalRefresh = jest.fn(async (axiosInst) => {
      refreshAttempts++;
      // Succeed on second call (different token triggers a new cycle)
      const response = await axiosInst.post('/auth/refresh');
      return { token: (response.data as { token: string }).token };
    });

    retryManager.use(
      new TokenRefreshPlugin(conditionalRefresh, {
        retryOnRefreshFail: false,
        maxRefreshAttempts: 1,
      }),
    );

    // First cycle: expired-v1 → refresh fails
    mock.onPost('/auth/refresh').replyOnce(500).onPost('/auth/refresh').reply(200, { token: 'fresh-token' });
    mock.onGet('/protected').reply((config) => {
      const auth = config.headers?.Authorization;
      return auth === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
    });

    retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-v1';
    const firstAttempt = await retryManager.axiosInstance.get('/protected').catch((e) => e);
    expect(firstAttempt).toBeInstanceOf(Error);
    expect(refreshAttempts).toBe(1);

    // Simulate obtaining a new (still-expired) token from a different source
    retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-v2';

    // Second cycle: expired-v2 is a different value → plugin allows a new refresh attempt
    const secondAttempt = await retryManager.axiosInstance.get('/protected');
    expect(secondAttempt.data).toEqual({ ok: true });
    expect(refreshAttempts).toBe(2);
    expect(hooks.onTokenRefreshed).toHaveBeenCalledTimes(1);
  });

  describe('ManualRetryPlugin interop', () => {
    it('should go through token refresh when a stored request is manually retried after a previous refresh failure', async () => {
      const { ManualRetryPlugin } = await import('../../src/plugins/ManualRetryPlugin');

      let refreshCallCount = 0;
      const refreshFnLocal = jest.fn(async () => {
        refreshCallCount++;
        if (refreshCallCount === 1) {
          // First refresh attempt fails
          const err = Object.assign(new Error('Refresh server down'), {
            response: { status: 503 },
            isAxiosError: true,
          });
          return Promise.reject(err);
        }
        // Second refresh attempt (during manual retry) succeeds
        return { token: 'fresh-token' };
      });

      const manualRetry = new ManualRetryPlugin({
        storeNonIdempotent: true,
        storeAuthRequests: true,
      });
      const trp = new TokenRefreshPlugin(refreshFnLocal, {
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
        refreshStatusCodes: [401],
      });

      retryManager.use(trp);
      retryManager.use(manualRetry);

      retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-token';

      // Protected endpoint always needs a valid token
      mock.onGet('/protected-manual-retry-after-refresh-fail').reply((config) => {
        const auth = config.headers?.Authorization;
        return auth === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
      });

      // First request: 401 → refresh fails → stored by ManualRetryPlugin
      await expect(
        retryManager.axiosInstance.get('/protected-manual-retry-after-refresh-fail'),
      ).rejects.toBeInstanceOf(Error);
      expect(manualRetry.getStoredRequests()).toHaveLength(1);
      expect(refreshCallCount).toBe(1);

      // Manual retry: should trigger a new token refresh, NOT fast-fail with the cached failure
      const results = await manualRetry.retryFailedRequests();
      expect(results).toHaveLength(1);
      expect(results[0].data).toEqual({ ok: true });
      expect(refreshCallCount).toBe(2);
      expect(hooks.onTokenRefreshed).toHaveBeenCalledTimes(1);
    });

    /**
     * Regression: replay without `rehydrateAuth` runs `neutralizeDefaultAuthHeaders`, which sets
     * `config.headers.authorization = undefined` so Axios does not merge defaults. TokenRefreshPlugin
     * must not treat that as a present header nor fast-fail by comparing defaults token to
     * `failedAuthHeaderValue` — otherwise the replay never reaches the network.
     */
    it('manual replay without rehydrateAuth reaches the network after refresh failure (neutralized Authorization)', async () => {
      const { ManualRetryPlugin } = await import('../../src/plugins/ManualRetryPlugin');

      let refreshCallCount = 0;
      const refreshFnLocal = jest.fn(async () => {
        refreshCallCount++;
        if (refreshCallCount === 1) {
          const err = Object.assign(new Error('Refresh server down'), {
            response: { status: 503 },
            isAxiosError: true,
          });
          return Promise.reject(err);
        }
        return { token: 'fresh-token' };
      });

      const manualRetry = new ManualRetryPlugin({
        storeNonIdempotent: true,
        storeAuthRequests: true,
      });

      const trp = new TokenRefreshPlugin(refreshFnLocal, {
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
        refreshStatusCodes: [401],
      });

      retryManager.use(trp);
      retryManager.use(manualRetry);

      retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-token';

      let protectedHits = 0;
      mock.onGet('/protected-neutralized-replay').reply((config) => {
        protectedHits++;
        const auth = getHeader(config, 'Authorization');
        return auth === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
      });

      await expect(
        retryManager.axiosInstance.get('/protected-neutralized-replay'),
      ).rejects.toBeInstanceOf(Error);
      expect(manualRetry.getStoredRequests()).toHaveLength(1);
      expect(refreshCallCount).toBe(1);
      expect(protectedHits).toBe(1);

      const results = await manualRetry.retryFailedRequests();
      expect(results).toHaveLength(1);
      expect(results[0].data).toEqual({ ok: true });
      expect(protectedHits).toBeGreaterThanOrEqual(2);
      expect(refreshCallCount).toBe(2);
    });

    it('does not store auth-bearing requests when storeAuthRequests is false', async () => {
      const { ManualRetryPlugin } = await import('../../src/plugins/ManualRetryPlugin');

      const trp = new TokenRefreshPlugin(refreshFn, {
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
        refreshStatusCodes: [401],
      });

      const manualRetry = new ManualRetryPlugin({
        storeNonIdempotent: true,
        storeAuthRequests: false,
      });

      retryManager.use(trp);
      retryManager.use(manualRetry);

      retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-token';

      mock.onGet('/protected-no-store-auth').reply((config) => {
        const auth = config.headers?.Authorization;
        return auth === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
      });

      refreshFn.mockRejectedValueOnce(
        Object.assign(new Error('Refresh server down'), {
          response: { status: 503 },
          isAxiosError: true,
        }),
      );

      await expect(retryManager.axiosInstance.get('/protected-no-store-auth')).rejects.toBeInstanceOf(Error);
      expect(manualRetry.getStoredRequests()).toHaveLength(0);
    });

    it('should run token refresh on manual replay when rehydrateAuth reapplies the same token that failed refresh', async () => {
      const { ManualRetryPlugin } = await import('../../src/plugins/ManualRetryPlugin');

      let refreshCallCount = 0;
      const refreshFnLocal = jest.fn(async () => {
        refreshCallCount++;
        if (refreshCallCount === 1) {
          const err = Object.assign(new Error('Refresh server down'), {
            response: { status: 503 },
            isAxiosError: true,
          });
          return Promise.reject(err);
        }
        return { token: 'fresh-token' };
      });

      const manualRetry = new ManualRetryPlugin({
        storeNonIdempotent: true,
        storeAuthRequests: true,
        rehydrateAuth: (config) => {
          config.headers = { ...(config.headers || {}), Authorization: 'Bearer expired-token' };
          return config;
        },
      });

      const trp = new TokenRefreshPlugin(refreshFnLocal, {
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
        refreshStatusCodes: [401],
      });

      retryManager.use(trp);
      retryManager.use(manualRetry);

      retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-token';

      mock.onGet('/protected-manual-replay-same-token').reply((config) => {
        const auth = config.headers?.Authorization;
        return auth === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
      });

      await expect(
        retryManager.axiosInstance.get('/protected-manual-replay-same-token'),
      ).rejects.toBeInstanceOf(Error);
      expect(manualRetry.getStoredRequests()).toHaveLength(1);
      expect(refreshCallCount).toBe(1);

      const results = await manualRetry.retryFailedRequests();
      expect(results).toHaveLength(1);
      expect(results[0].data).toEqual({ ok: true });
      expect(refreshCallCount).toBe(2);
      expect(hooks.onTokenRefreshed).toHaveBeenCalledTimes(1);
    });

    it('should go through token refresh when retried with rehydrateAuth providing a new token', async () => {
      const { ManualRetryPlugin } = await import('../../src/plugins/ManualRetryPlugin');

      const trp = new TokenRefreshPlugin(refreshFn, {
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
        refreshStatusCodes: [401],
      });

      const manualRetry = new ManualRetryPlugin({
        storeNonIdempotent: true,
        storeAuthRequests: true,
        rehydrateAuth: (config) => {
          config.headers = { ...(config.headers || {}), Authorization: 'Bearer fresh-token' };
          return config;
        },
      });

      retryManager.use(trp);
      retryManager.use(manualRetry);

      retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-token';

      mock.onGet('/protected-rehydrate').reply((config) => {
        const auth = config.headers?.Authorization;
        return auth === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
      });

      refreshFn.mockRejectedValueOnce(
        Object.assign(new Error('Refresh server down'), {
          response: { status: 503 },
          isAxiosError: true,
        }),
      );

      await expect(retryManager.axiosInstance.get('/protected-rehydrate')).rejects.toBeInstanceOf(Error);
      expect(manualRetry.getStoredRequests()).toHaveLength(1);

      // TokenRefreshPlugin overwrites any per-request Authorization with `defaults` when both exist;
      // mirror an app that persisted the new token to axios defaults before manual replay.
      retryManager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer fresh-token';

      const results = await manualRetry.retryFailedRequests();
      expect(results).toHaveLength(1);
      expect(results[0].data).toEqual({ ok: true });
    });
  });
});
