import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { RetryHooks, RetryManager } from '../../src';
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
  let hooks: RetryHooks<TokenRefreshPluginEvents>;
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
    retryManager = new RetryManager<TokenRefreshPluginEvents>({
      axiosInstance,
      hooks,
    });
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
});
