import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { createRetryer } from '../../src';
import { MetricsPlugin } from '../../src/plugins/MetricsPlugin';
import { TokenRefreshPlugin } from '../../src/plugins/TokenRefreshPlugin';

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

describe('TokenRefreshPlugin end-to-end flows', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({ timeout: 5000 });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
    jest.clearAllMocks();
  });

  it('allows public traffic through while holding protected traffic until refresh finishes', async () => {
    const retryer = createRetryer({
      axiosInstance,
      retries: 1,
      debug: false,
      maxConcurrentRequests: 3,
    });

    let releaseRefresh: ((value: { token: string }) => void) | undefined;
    const refreshFn = jest.fn(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseRefresh = resolve;
        }),
    );

    retryer.use(
      new TokenRefreshPlugin(refreshFn, {
        authHeaderName: 'Authorization',
        tokenPrefix: 'Bearer ',
        refreshStatusCodes: [401],
        retryOnRefreshFail: false,
        maxRefreshAttempts: 1,
      }),
    );
    retryer.use(new MetricsPlugin());

    mock
      .onGet('/protected/orders')
      .replyOnce(401)
      .onGet('/protected/orders')
      .replyOnce((config) => {
        return getHeader(config, 'Authorization') === 'Bearer fresh-token'
          ? [200, { orders: ['a', 'b'] }]
          : [401, { error: 'stale token' }];
      });

    let queuedProtectedCalls = 0;
    mock.onGet('/protected/profile').reply((config) => {
      queuedProtectedCalls++;
      return getHeader(config, 'Authorization') === 'Bearer fresh-token'
        ? [200, { profile: { id: 1 } }]
        : [401, { error: 'stale token' }];
    });

    let publicCalls = 0;
    mock.onGet('/public/ping').reply(() => {
      publicCalls++;
      return [200, { ok: true }];
    });

    const protectedRequest = retryer.axiosInstance.get('/protected/orders', {
      headers: { Authorization: 'Bearer expired-token' },
    });

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    const queuedProtectedRequest = retryer.axiosInstance.get('/protected/profile', {
      headers: { authorization: 'Bearer expired-token' },
    });
    const publicRequest = retryer.axiosInstance.get('/public/ping');

    await waitForAssertion(() => {
      expect(publicCalls).toBe(1);
    });
    expect(queuedProtectedCalls).toBe(0);

    releaseRefresh?.({ token: 'fresh-token' });

    const [ordersResponse, profileResponse, publicResponse] = await Promise.all([
      protectedRequest,
      queuedProtectedRequest,
      publicRequest,
    ]);

    expect(ordersResponse.data).toEqual({ orders: ['a', 'b'] });
    expect(profileResponse.data).toEqual({ profile: { id: 1 } });
    expect(publicResponse.data).toEqual({ ok: true });
    expect(queuedProtectedCalls).toBe(1);
    expect(axiosInstance.defaults.headers.common.Authorization).toBe('Bearer fresh-token');

    const metrics = retryer.getMetrics();
    expect(metrics.totalRequests).toBe(4);
  });
});
