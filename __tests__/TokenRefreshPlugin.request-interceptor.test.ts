import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';

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

describe('TokenRefreshPlugin request interception', () => {
  let axiosInstance: AxiosInstance;
  let mockAxios: MockAdapter;
  let manager: RetryManager;
  let refreshFn: jest.Mock;

  beforeEach(() => {
    axiosInstance = axios.create();
    mockAxios = new MockAdapter(axiosInstance);
    refreshFn = jest.fn(async () => ({ token: 'fresh-token' }));

    manager = new RetryManager({ axiosInstance });
    manager.use(
      new TokenRefreshPlugin(refreshFn, {
        retryOnRefreshFail: true,
        maxRefreshAttempts: 2,
        refreshTimeout: 3000,
        authHeaderName: 'Authorization',
        tokenPrefix: 'Bearer ',
        refreshStatusCodes: [401],
      }),
    );
  });

  afterEach(() => {
    manager.destroy();
    mockAxios.restore();
    jest.clearAllMocks();
  });

  it('queues requests carrying lowercase auth headers until refresh completes', async () => {
    let releaseRefresh: ((value: { token: string }) => void) | undefined;
    refreshFn.mockImplementation(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseRefresh = resolve;
        }),
    );

    mockAxios
      .onGet('/needs-refresh')
      .replyOnce(401)
      .onGet('/needs-refresh')
      .replyOnce((config) => {
        return getHeader(config, 'Authorization') === 'Bearer fresh-token'
          ? [200, { ok: 'refreshed-request' }]
          : [401, { error: 'stale token' }];
      });

    let queuedRequestCalls = 0;
    mockAxios.onGet('/queued-during-refresh').reply((config) => {
      queuedRequestCalls++;
      return getHeader(config, 'Authorization') === 'Bearer fresh-token'
        ? [200, { ok: 'queued-request' }]
        : [401, { error: 'stale token' }];
    });

    const firstRequest = axiosInstance.get('/needs-refresh', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    const queuedRequest = axiosInstance.get('/queued-during-refresh', {
      headers: { authorization: 'Bearer stale-token' },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(queuedRequestCalls).toBe(0);

    releaseRefresh?.({ token: 'fresh-token' });

    await expect(firstRequest).resolves.toMatchObject({ data: { ok: 'refreshed-request' } });
    await expect(queuedRequest).resolves.toMatchObject({ data: { ok: 'queued-request' } });
    expect(queuedRequestCalls).toBe(1);
  });

  it('updates AxiosHeaders auth values from defaults before dispatching', async () => {
    axiosInstance.defaults.headers.common.Authorization = 'Bearer server-token';

    let observedHeader: string | undefined;
    mockAxios.onGet('/axios-headers').reply((config) => {
      observedHeader = getHeader(config, 'Authorization');
      return [200, { ok: true }];
    });

    const response = await axiosInstance.get('/axios-headers', {
      headers: new AxiosHeaders({ authorization: 'Bearer stale-token' }),
    });

    expect(response.status).toBe(200);
    expect(observedHeader).toBe('Bearer server-token');
  });

  it('allows requests without auth headers to continue while refresh is in progress', async () => {
    let releaseRefresh: ((value: { token: string }) => void) | undefined;
    refreshFn.mockImplementation(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseRefresh = resolve;
        }),
    );

    mockAxios
      .onGet('/needs-refresh')
      .replyOnce(401)
      .onGet('/needs-refresh')
      .replyOnce(200, { secure: true });

    let publicCalls = 0;
    mockAxios.onGet('/public-endpoint').reply(() => {
      publicCalls++;
      return [200, { public: true }];
    });

    const protectedRequest = axiosInstance.get('/needs-refresh', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    const publicRequest = axiosInstance.get('/public-endpoint');

    await waitForAssertion(() => {
      expect(publicCalls).toBe(1);
    });

    releaseRefresh?.({ token: 'fresh-token' });

    await expect(publicRequest).resolves.toMatchObject({ data: { public: true } });
    await expect(protectedRequest).resolves.toMatchObject({ data: { secure: true } });
  });
});
