//@ts-nocheck
import axios, { AxiosError, type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';
import { RetryManager, RetryHooks } from '../src';
import { type RetryLogger } from '../src/services/logger';
import {
  TokenRefreshFailedError,
  TokenRefreshPlugin,
  type TokenRefreshPluginOptions,
} from '../src/plugins/TokenRefreshPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';
import { toTokenRefreshError } from '../src/plugins/TokenRefreshPlugin/TokenRefreshAbortError';

describe('TokenRefreshPlugin', () => {
  let mockAxios: MockAdapter;
  let axiosInstance: AxiosInstance;
  let manager: RetryManager;
  let mockLogger: RetryLogger;
  let refreshFn: jest.Mock;
  let plugin: TokenRefreshPlugin;

  const createRetryableRefreshFailure = (
    message: string,
  ): Error & { response: { status: number }; isAxiosError: true } =>
    Object.assign(new Error(message), {
      response: { status: 500 },
      isAxiosError: true as const,
    });

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

  beforeEach(() => {
    // 1) Create a real Axios instance and mock it.
    axiosInstance = axios.create();
    mockAxios = new MockAdapter(axiosInstance);

    // 2) Create a minimal logger.
    mockLogger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as RetryLogger;

    // 3) Build a RetryManager using the axios instance.
    manager = new RetryManager({
      axiosInstance,
      // (Other RetryManager config can be added as needed)
    });
    manager.use(new MetricsPlugin());

    // 4) Reset the refresh function mock as an async function.
    refreshFn = jest.fn(async () => {
      return { token: 'DUMMY_TOKEN' };
    });

    // 6) Create plugin options.
    const pluginOptions: TokenRefreshPluginOptions = {
      retryOnRefreshFail: true,
      maxRefreshAttempts: 2,
      refreshTimeout: 3000,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
    };

    // 7) Now create the plugin.
    plugin = new TokenRefreshPlugin(refreshFn, pluginOptions);

    // 8) Register the plugin with the RetryManager.
    manager.use(plugin);
  });

  afterEach(() => {
    if (manager) {
      manager.destroy();
    }
    mockAxios.reset();
    jest.clearAllMocks();
  });

  it('should validate refreshTimeout during construction', () => {
    expect(() => {
      new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 0,
      });
    }).toThrow('refreshTimeout must be a positive integer');
  });

  it('should normalize object-shaped refresh errors without prototype pollution', () => {
    const cause = new Error('root cause');
    const normalized = toTokenRefreshError(
      JSON.parse('{"message":"refresh exploded","code":"EREFRESH_UPSTREAM","__proto__":{"polluted":true}}'),
    ) as TokenRefreshFailedError & {
      cause?: unknown;
      request?: unknown;
      response?: unknown;
    };

    const enriched = toTokenRefreshError({
      cause,
      message: 'refresh exploded',
      request: { url: '/auth/refresh' },
      response: { status: 500 },
    }) as TokenRefreshFailedError & {
      cause?: unknown;
      request?: unknown;
      response?: unknown;
    };

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized).toBeInstanceOf(TokenRefreshFailedError);
    expect(normalized.message).toBe('refresh exploded');
    expect(normalized.code).toBe('EREFRESH_UPSTREAM');
    expect(normalized instanceof TokenRefreshFailedError).toBe(true);
    expect(Object.getPrototypeOf(normalized)).toBe(TokenRefreshFailedError.prototype);
    expect((normalized as Record<string, unknown>).polluted).toBeUndefined();

    expect(enriched.cause).toBe(cause);
    expect(enriched.request).toEqual({ url: '/auth/refresh' });
    expect(enriched.response).toEqual({ status: 500 });
  });

  afterAll(() => {
    mockAxios.restore();
  });

  it('should throw error if no refreshToken is provided and refresh is needed', async () => {
    manager.unuse('TokenRefreshPlugin');
    // Create a new manager with a faulty plugin (no refreshToken)
    const faultyManager = new RetryManager({ axiosInstance });

    const faultyPlugin = new TokenRefreshPlugin(undefined, {
      refreshStatusCodes: [401],
    } as TokenRefreshPluginOptions);

    faultyManager.use(faultyPlugin);

    mockAxios.onGet('/test').reply(401);

    await expect(axiosInstance.get('/test')).rejects.toThrow('No token refresh handler provided');
  });

  it('should NOT refresh if error status is not in refreshStatusCodes', async () => {
    refreshFn.mockResolvedValue({ token: 'NEW_TOKEN' });
    // Force a 403 error
    mockAxios.onGet('/forbidden').reply(403);

    await expect(axiosInstance.get('/forbidden')).rejects.toMatchObject({
      response: { status: 403 },
    });

    // No refresh logic should be triggered
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('should skip refresh when handler returns token null — original 401, no onTokenRefreshFailed', async () => {
    const onFailed = jest.fn();
    manager.on('onTokenRefreshFailed', onFailed);
    refreshFn.mockResolvedValue({ token: null });

    mockAxios.onGet('/skip-null-token').replyOnce(401);

    await expect(axiosInstance.get('/skip-null-token')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('should skip refresh when handler returns token undefined — same as null', async () => {
    refreshFn.mockResolvedValue({ token: undefined });

    mockAxios.onGet('/skip-undefined-token').replyOnce(401);

    await expect(axiosInstance.get('/skip-undefined-token')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should release a request queued during refresh when handler skips (no TokenRefreshFailedError)', async () => {
    let finishRefresh: (value: { token: undefined }) => void;
    const deferredRefresh = new Promise<{ token: undefined }>((resolve) => {
      finishRefresh = resolve;
    });
    refreshFn.mockImplementation(() => deferredRefresh);

    mockAxios.onGet('/queued-skip').replyOnce(401).onGet('/queued-skip').reply(200, { released: true });

    const p1 = axiosInstance.get('/queued-skip', { headers: { Authorization: 'Bearer a' } });
    await waitForAssertion(() => expect(refreshFn).toHaveBeenCalledTimes(1));
    const p2 = axiosInstance.get('/queued-skip', { headers: { Authorization: 'Bearer a' } });
    await waitForAssertion(() =>
      expect((plugin as unknown as { refreshQueue: unknown[] }).refreshQueue.length).toBe(1),
    );

    finishRefresh!({ token: undefined });

    const [e1, res2] = await Promise.all([
      p1.then(
        () => {
          throw new Error('expected p1 to reject');
        },
        (e) => e,
      ),
      p2,
    ]);
    expect(e1).toMatchObject({ response: { status: 401 } });
    expect(res2.data).toEqual({ released: true });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should return original 200 body when customErrorDetector fires and handler skips refresh', async () => {
    manager.unuse('TokenRefreshPlugin');
    const customErrorDetector = (response: unknown) => {
      if (typeof response !== 'object' || response === null) return false;
      return 'errors' in response;
    };
    const gqlPlugin = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401],
      refreshTimeout: 3000,
      maxRefreshAttempts: 1,
      retryOnRefreshFail: false,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      customErrorDetector,
    });
    manager.use(gqlPlugin);

    refreshFn.mockResolvedValue({ token: null });
    const graphqlErrorBody = {
      data: null,
      errors: [{ message: 'unauthenticated', extensions: { code: 'UNAUTHENTICATED' } }],
    };
    mockAxios.onPost('/graphql-skip').reply(200, graphqlErrorBody);

    const res = await axiosInstance.post('/graphql-skip', { query: '{}' });
    expect(res.status).toBe(200);
    expect(res.data).toEqual(graphqlErrorBody);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should refresh token when response is 401, then retry the original request', async () => {
    refreshFn.mockResolvedValue({ token: 'REFRESHED_TOKEN' });

    mockAxios
      .onGet('/needs-refresh')
      .replyOnce(401) // triggers refresh
      .onGet('/needs-refresh')
      .replyOnce(200, { data: 'OK after refresh' });

    const response = await axiosInstance.get('/needs-refresh');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: 'OK after refresh' });

    // Refresh function was called once.
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Check that the manager's default header has been updated.
    expect(axiosInstance.defaults.headers.common['Authorization']).toBe('Bearer REFRESHED_TOKEN');
  });

  it('should replay the protected request through the retry manager pipeline', async () => {
    refreshFn.mockResolvedValue({ token: 'REFRESHED_TOKEN' });

    mockAxios
      .onGet('/pipeline-check')
      .replyOnce(401)
      .onGet('/pipeline-check')
      .replyOnce(200, { data: 'OK after refresh' });

    const response = await manager.axiosInstance.get('/pipeline-check');

    expect(response.status).toBe(200);
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(manager.getMetrics().totalRequests).toBe(2);
    expect(manager.getMetrics().requestCountsByPriority[1]).toBe(2);
  });

  it('should queue multiple requests while refreshing token, then retry all once refresh completes', async () => {
    refreshFn.mockResolvedValue({ token: 'REFRESHED_TOKEN' });

    mockAxios.onGet('/parallel1').replyOnce(401).onGet('/parallel1').replyOnce(200, { result: 'OK1' });

    mockAxios.onGet('/parallel2').replyOnce(401).onGet('/parallel2').replyOnce(200, { result: 'OK2' });

    const [resp1, resp2] = await Promise.all([axiosInstance.get('/parallel1'), axiosInstance.get('/parallel2')]);

    expect(resp1.data).toEqual({ result: 'OK1' });
    expect(resp2.data).toEqual({ result: 'OK2' });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should hold auth-bearing requests until an in-flight refresh completes', async () => {
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
        return config.headers?.Authorization === 'Bearer FRESH_TOKEN'
          ? [200, { data: 'refreshed' }]
          : [401, { error: 'stale token' }];
      });

    let protectedDuringRefreshCalls = 0;
    mockAxios.onGet('/during-refresh').reply((config) => {
      protectedDuringRefreshCalls++;
      return config.headers?.Authorization === 'Bearer FRESH_TOKEN'
        ? [200, { data: 'used fresh token' }]
        : [401, { error: 'stale token sent early' }];
    });

    const firstRequest = axiosInstance.get('/needs-refresh', {
      headers: { Authorization: 'Bearer STALE_TOKEN' },
    });

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    const queuedRequest = axiosInstance.get('/during-refresh', {
      headers: { Authorization: 'Bearer STALE_TOKEN' },
    });

    await waitForAssertion(() => {
      expect((plugin as any).refreshQueue).toHaveLength(1);
    });
    expect(protectedDuringRefreshCalls).toBe(0);

    releaseRefresh?.({ token: 'FRESH_TOKEN' });

    const [firstResponse, queuedResponse] = await Promise.all([firstRequest, queuedRequest]);

    expect(firstResponse.data).toEqual({ data: 'refreshed' });
    expect(queuedResponse.data).toEqual({ data: 'used fresh token' });
    expect(protectedDuringRefreshCalls).toBe(1);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should allow requests without the auth header to continue while refresh is in progress', async () => {
    let releaseRefresh: ((value: { token: string }) => void) | undefined;
    refreshFn.mockImplementation(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseRefresh = resolve;
        }),
    );

    mockAxios.onGet('/secure').replyOnce(401).onGet('/secure').replyOnce(200, { secure: true });

    let publicRequestCalls = 0;
    mockAxios.onGet('/public').reply(() => {
      publicRequestCalls++;
      return [200, { public: true }];
    });

    const secureRequest = axiosInstance.get('/secure', {
      headers: { Authorization: 'Bearer STALE_TOKEN' },
    });

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    const publicRequest = axiosInstance.get('/public').then((response) => {
      return response;
    });

    await waitForAssertion(() => {
      expect(publicRequestCalls).toBe(1);
    });

    releaseRefresh?.({ token: 'FRESH_TOKEN' });

    const [publicResponse, secureResponse] = await Promise.all([publicRequest, secureRequest]);

    expect(publicResponse.data).toEqual({ public: true });
    expect(secureResponse.data).toEqual({ secure: true });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should reject auth-bearing requests that were waiting if refresh ultimately fails', async () => {
    manager.unuse('TokenRefreshPlugin');
    plugin = new TokenRefreshPlugin(refreshFn, {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1,
      refreshTimeout: 3000,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
    });
    manager.use(plugin);

    let rejectRefresh: ((error: Error) => void) | undefined;
    refreshFn.mockImplementation(
      () =>
        new Promise<{ token: string }>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );

    mockAxios.onGet('/fails-refresh').replyOnce(401);

    let protectedDuringRefreshCalls = 0;
    mockAxios.onGet('/waiting-auth-request').reply(() => {
      protectedDuringRefreshCalls++;
      return [200, { shouldNotHappen: true }];
    });

    const firstRequest = axiosInstance.get('/fails-refresh', {
      headers: { Authorization: 'Bearer STALE_TOKEN' },
    });

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(rejectRefresh).toBeDefined();
    });

    const waitingRequest = axiosInstance.get('/waiting-auth-request', {
      headers: { Authorization: 'Bearer STALE_TOKEN' },
    });

    await waitForAssertion(() => {
      expect((plugin as any).refreshQueue).toHaveLength(1);
    });
    expect(protectedDuringRefreshCalls).toBe(0);

    rejectRefresh?.(new Error('Refresh failed hard'));

    await expect(firstRequest).rejects.toThrow('Refresh failed hard');
    await expect(waitingRequest).rejects.toThrow('Refresh failed hard');
    expect(protectedDuringRefreshCalls).toBe(0);
  });

  it('should queue 4-5 concurrent requests when all hit 401 simultaneously and only refresh token once', async () => {
    refreshFn.mockResolvedValue({ token: 'BATCH_REFRESHED_TOKEN' });

    // Mock each endpoint to return 401 first, then 200 with success data
    const endpoints = ['/batch1', '/batch2', '/batch3', '/batch4', '/batch5'];
    endpoints.forEach((endpoint, index) => {
      mockAxios
        .onGet(endpoint)
        .replyOnce(401, { error: 'Unauthorized' })
        .onGet(endpoint)
        .replyOnce(200, { batchResult: `success-${index + 1}` });
    });

    // Send all 5 requests simultaneously
    const promises = endpoints.map((endpoint) => axiosInstance.get(endpoint));
    const responses = await Promise.all(promises);

    // Verify all requests succeeded with refreshed token
    responses.forEach((response, index) => {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ batchResult: `success-${index + 1}` });
    });

    // Critical: Token refresh should only be called ONCE despite 5 concurrent 401s
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Verify the auth header was updated globally
    expect(axiosInstance.defaults.headers.common['Authorization']).toBe('Bearer BATCH_REFRESHED_TOKEN');
  });

  it('should reject concurrent 401s with AxiosError bound to each request when refresh fails with AxiosError', async () => {
    manager.unuse('TokenRefreshPlugin');
    const axios500 = new AxiosError(
      'Request failed with status code 500',
      'ERR_BAD_RESPONSE',
      {},
      {},
      { status: 500, statusText: 'Internal Server Error', data: { error: 'refresh down' }, headers: {}, config: {} },
    );
    refreshFn.mockRejectedValue(axios500);
    plugin = new TokenRefreshPlugin(refreshFn, {
      maxRefreshAttempts: 1,
      retryOnRefreshFail: false,
      refreshStatusCodes: [401],
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
    });
    manager.use(plugin);

    mockAxios.onGet('/a').replyOnce(401);
    mockAxios.onGet('/b').replyOnce(401);

    const results = await Promise.allSettled([
      axiosInstance.get('/a', { headers: { Authorization: 'Bearer STALE' } }),
      axiosInstance.get('/b', { headers: { Authorization: 'Bearer STALE' } }),
    ]);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results) {
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(AxiosError);
      expect((r.reason as AxiosError).code).toBe('TOKEN_REFRESH_FAILED');
      expect(r.reason.message).toBe('Token refresh failed');
      expect((r.reason as AxiosError).config).toBeDefined();
    }
    const withCause = results.find(
      (r) => r.status === 'rejected' && (r.reason as Error & { cause?: unknown }).cause === axios500,
    );
    expect(withCause).toBeDefined();
  });

  it('should reuse the latest refreshed token for late 401 responses from stale in-flight requests', async () => {
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer STALE_TOKEN';
    refreshFn.mockImplementation(async () => ({ token: 'FRESH_TOKEN' }));

    mockAxios
      .onGet('/race-a')
      .replyOnce(() => new Promise((resolve) => setTimeout(() => resolve([401, { error: 'Unauthorized' }]), 10)))
      .onGet('/race-a')
      .replyOnce((config) => {
        return config.headers?.Authorization === 'Bearer FRESH_TOKEN'
          ? [200, { ok: 'a-fresh' }]
          : [401, { error: 'still stale' }];
      });

    mockAxios
      .onGet('/race-b')
      .replyOnce(() => new Promise((resolve) => setTimeout(() => resolve([401, { error: 'Unauthorized' }]), 80)))
      .onGet('/race-b')
      .replyOnce((config) => {
        return config.headers?.Authorization === 'Bearer FRESH_TOKEN'
          ? [200, { ok: 'b-fresh' }]
          : [401, { error: 'still stale' }];
      });

    const [respA, respB] = await Promise.all([axiosInstance.get('/race-a'), axiosInstance.get('/race-b')]);

    expect(respA.data).toEqual({ ok: 'a-fresh' });
    expect(respB.data).toEqual({ ok: 'b-fresh' });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should respect maxRefreshAttempts and retryOnRefreshFail, failing if refresh keeps failing', async () => {
    const refreshFailure = createRetryableRefreshFailure('Refresh error!');
    refreshFn
      .mockRejectedValueOnce(refreshFailure)
      .mockRejectedValueOnce(refreshFailure)
      .mockRejectedValueOnce(refreshFailure);

    mockAxios.onGet('/repeated-401').reply(401);

    await expect(axiosInstance.get('/repeated-401')).rejects.toThrow('Refresh error!');

    // Expect refreshFn to have been called 2 times.
    expect(refreshFn).toHaveBeenCalledTimes(2);

    // Optionally, if your manager exposes an emit method you could assert:
    // expect(manager.emit).toHaveBeenCalledWith('onTokenRefreshFailed');
  });

  it('should stop refresh retries immediately when the refresh callback throws a terminal error', async () => {
    const missingTokenRefreshFn = jest.fn(async () => {
      throw new Error('Refresh token not found');
    });

    manager.unuse('TokenRefreshPlugin');
    const terminalPlugin = new TokenRefreshPlugin(missingTokenRefreshFn, {
      retryOnRefreshFail: true,
      maxRefreshAttempts: 3,
      refreshTimeout: 3000,
      refreshStatusCodes: [401, 419],
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
    });
    manager.use(terminalPlugin);

    mockAxios.onGet('/missing-refresh-token').reply(401);

    await expect(axiosInstance.get('/missing-refresh-token')).rejects.toThrow('Refresh token not found');
    expect(missingTokenRefreshFn).toHaveBeenCalledTimes(1);
  });

  it('should fail immediately if refresh fails and retryOnRefreshFail is false', async () => {
    const singleFailRefreshFn = jest.fn().mockRejectedValue(new Error('Refresh broke'));
    manager.unuse('TokenRefreshPlugin');
    // Rebuild plugin with retryOnRefreshFail = false.
    const singleFailPlugin = new TokenRefreshPlugin(singleFailRefreshFn, {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 3,
      refreshTimeout: 3000,
      refreshStatusCodes: [401],
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
    });
    manager.use(singleFailPlugin);

    mockAxios.onGet('/test-no-retry').reply(401);

    await expect(axiosInstance.get('/test-no-retry')).rejects.toThrow('Refresh broke');

    // Should be called only once.
    expect(singleFailRefreshFn).toHaveBeenCalledTimes(1);
  });

  it('should timeout if refresh function takes too long', async () => {
    refreshFn.mockImplementation(
      async () =>
        new Promise<{ token: string }>((resolve) => {
          // never resolves quickly => triggers timeout
          setTimeout(() => resolve({ token: 'NEVER_HAPPEN' }), 9999);
        }),
    );

    // Reinitialize plugin with a very short timeout.
    manager.unuse('TokenRefreshPlugin');
    const slowPlugin = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401],
      refreshTimeout: 100,
      maxRefreshAttempts: 1,
      retryOnRefreshFail: false,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
    });
    manager.use(slowPlugin);

    mockAxios.onGet('/timeout-test').reply(401);

    await expect(axiosInstance.get('/timeout-test')).rejects.toThrow('Token refresh timeout');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should set the axios default header after successful refresh', async () => {
    refreshFn.mockResolvedValue({ token: 'NEW_TOKEN' });

    manager.unuse('TokenRefreshPlugin');
    const plugin2 = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401],
      authHeaderName: 'X-Auth-Header',
      tokenPrefix: 'Prefix ',
    });
    manager.use(plugin2);

    mockAxios.onGet('/endpoint').replyOnce(401).onGet('/endpoint').replyOnce(200, { success: true });

    const resp = await axiosInstance.get('/endpoint');
    expect(resp.data).toEqual({ success: true });

    // Check refresh function was called.
    expect(refreshFn).toHaveBeenCalled();

    // Check default headers updated.
    expect(axiosInstance.defaults.headers.common['X-Auth-Header']).toBe('Prefix NEW_TOKEN');
  });

  it('should attach new token to the retried request in the queue', async () => {
    refreshFn.mockResolvedValue({ token: 'QUEUED_TOKEN' });

    mockAxios
      .onGet('/queue-test')
      .replyOnce(401)
      .onGet('/queue-test')
      .replyOnce((config: AxiosRequestConfig) => {
        if (
          config.headers?.Authorization === 'QUEUED_TOKEN' ||
          config.headers?.Authorization === 'Bearer QUEUED_TOKEN'
        ) {
          return [200, { success: 'ok' }];
        }
        return [400, { error: 'Wrong token' }];
      });

    const res = await axiosInstance.get('/queue-test');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ success: 'ok' });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should skip refresh if originalRequest.__axiosRetryer.isRetryRefreshRequest is already set', async () => {
    refreshFn.mockResolvedValue({ token: 'NEW_TOKEN' });

    // Force the request to have __axiosRetryer.isRetryRefreshRequest = true.
    mockAxios.onGet('/skip-refresh').reply((config: AxiosRequestConfig) => {
      (config as any).__axiosRetryer = { ...(config as any).__axiosRetryer, isRetryRefreshRequest: true };
      return [401];
    });

    await expect(axiosInstance.get('/skip-refresh')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('should fail if refresh function returns a response with no token field', async () => {
    refreshFn.mockResolvedValue({});

    mockAxios.onGet('/no-token').replyOnce(401);

    await expect(axiosInstance.get('/no-token')).rejects.toThrowError();
  });

  it('should reject if refresh endpoint returns 400 or 500 instead of success', async () => {
    refreshFn.mockRejectedValue({ response: { status: 500, data: 'Server error' } });

    mockAxios.onGet('/server-error').reply(401);

    const serverErr = await axiosInstance.get('/server-error').catch((e) => e);
    expect(serverErr).toBeInstanceOf(AxiosError);
    expect(serverErr.code).toBe('TOKEN_REFRESH_FAILED');
    expect(serverErr.config?.url).toContain('/server-error');
    expect((serverErr as Error & { cause?: unknown }).cause).toBeInstanceOf(TokenRefreshFailedError);
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it('should reject immediately if error.response is undefined (network error)', async () => {
    refreshFn.mockResolvedValue({ token: 'SHOULD_NOT_USE' });
    // simulate a network error
    mockAxios.onGet('/no-response').networkError();

    await expect(axiosInstance.get('/no-response')).rejects.toThrow();
    expect(refreshFn).not.toHaveBeenCalled();
  }, 10000);

  it('should refresh when a custom refresh status code (e.g., 419) is returned', async () => {
    refreshFn.mockResolvedValue({ token: 'REFRESHED' });

    manager.unuse('TokenRefreshPlugin');
    const plugin2 = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401, 419],
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
    });
    manager.use(plugin2);

    mockAxios.onGet('/custom-code').replyOnce(419).onGet('/custom-code').replyOnce(200, { success: true });

    const resp = await axiosInstance.get('/custom-code');
    expect(resp.data).toEqual({ success: true });
    expect(refreshFn).toHaveBeenCalled();
  });

  it('should allow new refresh attempts on subsequent requests if isRefreshing was reset', async () => {
    // For this test, we want the first refresh cycle to fail immediately.
    // Therefore, we create plugin options with retryOnRefreshFail set to false.
    const options: TokenRefreshPluginOptions = {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1, // total attempts = 1 (i.e. no retry)
      refreshTimeout: 2000,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
    };

    // Reinitialize the plugin with the new options.
    plugin = new TokenRefreshPlugin(refreshFn, options);
    manager.unuse('TokenRefreshPlugin'); // remove previous instance
    manager.use(plugin);

    // For the first refresh cycle: force refreshFn to reject.
    refreshFn.mockRejectedValueOnce(new Error('First refresh fails'));

    // First request triggers refresh; mock a 401 for the original request.
    mockAxios.onGet('/first-try').replyOnce(401);

    // Expect the first request to fail with the error.
    await expect(axiosInstance.get('/first-try')).rejects.toThrow('First refresh fails');

    // Now, for the second refresh cycle, we want a successful refresh.
    refreshFn.mockResolvedValueOnce({ token: 'NEW_TOKEN_2' });

    // Reset handlers so the next request is a fresh one.
    mockAxios.resetHandlers();
    mockAxios
      .onGet('/second-try')
      .replyOnce(401) // trigger refresh
      .onGet('/second-try')
      .replyOnce(200, { data: 'Success after second attempt' });

    // Second request triggers a new refresh cycle.
    const resp = await axiosInstance.get('/second-try');
    expect(resp.data).toEqual({ data: 'Success after second attempt' });

    // We expect refreshFn to have been called once for the first cycle and once for the second.
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it('should only queue refresh for 401 requests, other status codes fail immediately', async () => {
    refreshFn.mockResolvedValue({ token: 'REFRESHED' });

    mockAxios.onGet('/401').replyOnce(401).onGet('/401').replyOnce(200, { after: 'refresh' });

    mockAxios.onGet('/403').replyOnce(403, { msg: 'Forbidden' });
    mockAxios.onGet('/500').replyOnce(500, { msg: 'Server error' });

    const results = await Promise.allSettled([
      axiosInstance.get('/401'),
      axiosInstance.get('/403'),
      axiosInstance.get('/500'),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('rejected');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('should use updated tokenPrefix if the plugin options change after init (if supported)', async () => {
    refreshFn.mockResolvedValue({ token: 'XYZ' });
    // Manually change the plugin's tokenPrefix.
    (plugin as any).options.tokenPrefix = 'Prefix2 ';

    mockAxios
      .onGet('/change-prefix')
      .replyOnce(401)
      .onGet('/change-prefix')
      .replyOnce((config) => {
        if (config.headers?.Authorization === 'Prefix2 XYZ') {
          return [200, { success: true }];
        }
        return [400, { error: 'Incorrect prefix' }];
      });

    const res = await axiosInstance.get('/change-prefix');
    expect(res.data).toEqual({ success: true });
  });

  it('should queue 401 requests and re-dispatch them after a successful refresh', async () => {
    mockAxios.onGet('/queued').replyOnce(401);

    mockAxios.onGet('/queued').reply(200, { data: 'Success after refresh' });

    const req1 = axiosInstance.get('/queued');
    const req2 = axiosInstance.get('/queued');

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1.data).toEqual({ data: 'Success after refresh' });
    expect(res2.data).toEqual({ data: 'Success after refresh' });

    expect(refreshFn).toHaveBeenCalledTimes(1);

    expect(plugin['refreshQueue'].length).toBe(0);
  });

  it('should eject request and response interceptors on teardown', () => {
    manager.unuse('TokenRefreshPlugin');
    const detectorPlugin = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401],
      customErrorDetector: () => false,
    });
    manager.use(detectorPlugin);

    const requestEjectSpy = jest.spyOn(manager.axiosInstance.interceptors.request, 'eject');
    const responseEjectSpy = jest.spyOn(manager.axiosInstance.interceptors.response, 'eject');

    const requestInterceptorId = (detectorPlugin as any).requestInterceptorId;
    const interceptorId = (detectorPlugin as any).interceptorId;
    const responseInterceptorId = (detectorPlugin as any).responseInterceptorId;

    detectorPlugin.onBeforeDestroyed(manager);

    expect(requestEjectSpy).toHaveBeenCalledWith(requestInterceptorId);
    expect(responseEjectSpy).toHaveBeenCalledWith(interceptorId);
    expect(responseEjectSpy).toHaveBeenCalledWith(responseInterceptorId);
  });

  it('should detect custom auth errors in 200 OK responses and refresh token', async () => {
    // Setup a custom error detector for GraphQL-like errors
    const customErrorDetector = (response: any) => {
      return response?.errors?.some(
        (error: any) => error.extensions?.code === 'UNAUTHENTICATED' || error.message?.includes('token expired'),
      );
    };

    // Reinitialize with custom error detector
    manager.unuse('TokenRefreshPlugin');
    const graphqlPlugin = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401],
      refreshTimeout: 3000,
      maxRefreshAttempts: 2,
      retryOnRefreshFail: true,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      customErrorDetector,
    });
    manager.use(graphqlPlugin);

    refreshFn.mockResolvedValue({ token: 'NEW_GRAPHQL_TOKEN' });

    // Mock a GraphQL error response with 200 status
    mockAxios
      .onPost('/graphql')
      .replyOnce(200, {
        data: null,
        errors: [
          {
            message: 'User not authenticated, token expired',
            extensions: { code: 'UNAUTHENTICATED' },
          },
        ],
      })
      .onPost('/graphql')
      .replyOnce(200, { data: { user: { id: 1, name: 'Test User' } } });

    const response = await axiosInstance.post('/graphql', { query: 'query { user { id name } }' });

    // Verify the final response is good
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: { user: { id: 1, name: 'Test User' } } });

    // Verify token refresh was triggered
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Check that auth header was updated
    expect(axiosInstance.defaults.headers.common['Authorization']).toBe('Bearer NEW_GRAPHQL_TOKEN');
  });

  it('should queue 4-5 concurrent requests with custom auth errors in 200 OK responses and only refresh token once', async () => {
    // Setup a custom error detector for GraphQL-like errors
    const customErrorDetector = (response: any) => {
      return response?.errors?.some(
        (error: any) => error.extensions?.code === 'UNAUTHENTICATED' || error.message?.includes('token expired'),
      );
    };

    // Reinitialize with custom error detector
    manager.unuse('TokenRefreshPlugin');
    const concurrentGraphqlPlugin = new TokenRefreshPlugin(refreshFn, {
      refreshStatusCodes: [401],
      refreshTimeout: 3000,
      maxRefreshAttempts: 2,
      retryOnRefreshFail: true,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      customErrorDetector,
    });
    manager.use(concurrentGraphqlPlugin);

    refreshFn.mockResolvedValue({ token: 'CONCURRENT_GRAPHQL_TOKEN' });

    // Mock 5 different GraphQL queries that all return 200 with auth errors first, then success
    const queries = [
      {
        endpoint: '/graphql/user',
        query: 'query { user { id name } }',
        successData: { user: { id: 1, name: 'User1' } },
      },
      { endpoint: '/graphql/posts', query: 'query { posts { title } }', successData: { posts: [{ title: 'Post1' }] } },
      {
        endpoint: '/graphql/profile',
        query: 'query { profile { email } }',
        successData: { profile: { email: 'test@example.com' } },
      },
      {
        endpoint: '/graphql/settings',
        query: 'query { settings { theme } }',
        successData: { settings: { theme: 'dark' } },
      },
      {
        endpoint: '/graphql/notifications',
        query: 'query { notifications { count } }',
        successData: { notifications: { count: 5 } },
      },
    ];

    queries.forEach(({ endpoint, successData }) => {
      mockAxios
        .onPost(endpoint)
        .replyOnce(200, {
          data: null,
          errors: [
            {
              message: 'User not authenticated, token expired',
              extensions: { code: 'UNAUTHENTICATED' },
            },
          ],
        })
        .onPost(endpoint)
        .replyOnce(200, { data: successData });
    });

    // Send all 5 GraphQL requests simultaneously
    const promises = queries.map(({ endpoint, query }) => axiosInstance.post(endpoint, { query }));
    const responses = await Promise.all(promises);

    // Verify all requests succeeded with refreshed token
    responses.forEach((response, index) => {
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ data: queries[index].successData });
    });

    // Critical: Token refresh should only be called ONCE despite 5 concurrent auth errors in 200 responses
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Verify the auth header was updated globally
    expect(axiosInstance.defaults.headers.common['Authorization']).toBe('Bearer CONCURRENT_GRAPHQL_TOKEN');
  });

  describe('timer cleanup on destroy', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('cancels the refresh timeout timer when the plugin is destroyed mid-refresh', async () => {
      let resolveRefresh: (value: { token: string }) => void;
      const hangingRefresh = new Promise<{ token: string }>((resolve) => {
        resolveRefresh = resolve;
      });

      const timeoutPlugin = new TokenRefreshPlugin(() => hangingRefresh, {
        refreshStatusCodes: [401],
        refreshTimeout: 5000,
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
      });

      const timeoutAxios = axios.create();
      const timeoutMock = new MockAdapter(timeoutAxios);
      const timeoutManager = new RetryManager({ axiosInstance: timeoutAxios, retries: 0 });
      timeoutManager.use(timeoutPlugin);

      timeoutMock.onGet('/guarded').reply(401);

      const requestPromise = timeoutAxios.get('/guarded').catch(() => {});

      // Advance enough to trigger the interceptor but not the refresh timeout
      jest.advanceTimersByTime(100);

      // Destroy the manager — this should cancel all timers
      timeoutManager.destroy();

      // Advance past the refresh timeout — no callbacks should fire
      const timeoutCb = jest.fn();
      setTimeout(timeoutCb, 0);
      jest.runAllTimers();

      await requestPromise;

      // The timerManager inside the plugin should have been destroyed
      expect(timeoutPlugin['timerManager']['isDestroyed']).toBe(true);
      expect(timeoutPlugin['timerManager'].getActiveTimerCount()).toBe(0);

      timeoutMock.restore();
    });

    it('cancels the backoff sleep timer when the plugin is destroyed during retry backoff', async () => {
      let callCount = 0;
      const failThenHang = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First attempt fails with a retryable error
          return Promise.reject(
            Object.assign(new Error('server error'), {
              response: { status: 500 },
              isAxiosError: true,
            }),
          );
        }
        // Second attempt hangs forever
        return new Promise(() => {});
      });

      const backoffPlugin = new TokenRefreshPlugin(failThenHang, {
        refreshStatusCodes: [401],
        refreshTimeout: 10000,
        maxRefreshAttempts: 3,
        retryOnRefreshFail: true,
      });

      const backoffAxios = axios.create();
      const backoffMock = new MockAdapter(backoffAxios);
      const backoffManager = new RetryManager({ axiosInstance: backoffAxios, retries: 0 });
      backoffManager.use(backoffPlugin);

      backoffMock.onGet('/backoff').reply(401);

      const requestPromise = backoffAxios.get('/backoff').catch(() => {});

      // Let the first refresh attempt run and fail
      await Promise.resolve();
      jest.advanceTimersByTime(50);
      await Promise.resolve();

      // Destroy during the backoff sleep
      backoffManager.destroy();

      jest.runAllTimers();
      await requestPromise;

      // Timer manager should be cleaned up
      expect(backoffPlugin['timerManager']['isDestroyed']).toBe(true);
      expect(backoffPlugin['timerManager'].getActiveTimerCount()).toBe(0);

      backoffMock.restore();
    });
  });
});
