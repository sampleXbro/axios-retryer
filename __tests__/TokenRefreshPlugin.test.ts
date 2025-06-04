//@ts-nocheck
import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';
import { RetryManager, RetryHooks } from '../src';
import { RetryLogger } from '../src/services/logger';
import { TokenRefreshPlugin, TokenRefreshPluginOptions } from '../src/plugins/TokenRefreshPlugin';

describe('TokenRefreshPlugin', () => {
  let mockAxios: MockAdapter;
  let axiosInstance: AxiosInstance;
  let manager: RetryManager;
  let mockLogger: RetryLogger;
  let refreshFn: jest.Mock;
  let plugin: TokenRefreshPlugin;

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
    mockAxios.reset();
    jest.clearAllMocks();
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

    await expect(axiosInstance.get('/test')).rejects.toThrow(
      'No token refresh handler provided'
    );
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

  it('should queue multiple requests while refreshing token, then retry all once refresh completes', async () => {
    refreshFn.mockResolvedValue({ token: 'REFRESHED_TOKEN' });

    mockAxios
      .onGet('/parallel1')
      .replyOnce(401)
      .onGet('/parallel1')
      .replyOnce(200, { result: 'OK1' });

    mockAxios
      .onGet('/parallel2')
      .replyOnce(401)
      .onGet('/parallel2')
      .replyOnce(200, { result: 'OK2' });

    const [resp1, resp2] = await Promise.all([
      axiosInstance.get('/parallel1'),
      axiosInstance.get('/parallel2'),
    ]);

    expect(resp1.data).toEqual({ result: 'OK1' });
    expect(resp2.data).toEqual({ result: 'OK2' });
    expect(refreshFn).toHaveBeenCalledTimes(1);
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
    const promises = endpoints.map(endpoint => axiosInstance.get(endpoint));
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

  it('should respect maxRefreshAttempts and retryOnRefreshFail, failing if refresh keeps failing', async () => {
    // With maxRefreshAttempts=2 and retryOnRefreshFail=true,
    // total attempts should be 3.
    refreshFn
      .mockRejectedValueOnce(new Error('Refresh error!'))
      .mockRejectedValueOnce(new Error('Refresh error!'))
      .mockRejectedValueOnce(new Error('Refresh error!'));

    mockAxios.onGet('/repeated-401').reply(401);

    await expect(axiosInstance.get('/repeated-401')).rejects.toThrow('Refresh error!');

    // Expect refreshFn to have been called 2 times.
    expect(refreshFn).toHaveBeenCalledTimes(2);

    // Optionally, if your manager exposes an emit method you could assert:
    // expect(manager.emit).toHaveBeenCalledWith('onTokenRefreshFailed');
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
        })
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

    mockAxios
      .onGet('/endpoint')
      .replyOnce(401)
      .onGet('/endpoint')
      .replyOnce(200, { success: true });

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

  it('should skip refresh if originalRequest.__isRetryRefreshRequest is already set', async () => {
    refreshFn.mockResolvedValue({ token: 'NEW_TOKEN' });

    // Force the request to have __isRetryRefreshRequest = true.
    mockAxios.onGet('/skip-refresh').reply((config: AxiosRequestConfig) => {
      (config as any).__isRetryRefreshRequest = true;
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

    await expect(axiosInstance.get('/server-error')).rejects.toMatchObject({
      response: { status: 500 },
    });
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

    mockAxios
      .onGet('/custom-code')
      .replyOnce(419)
      .onGet('/custom-code')
      .replyOnce(200, { success: true });

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

    mockAxios
      .onGet('/401')
      .replyOnce(401)
      .onGet('/401')
      .replyOnce(200, { after: 'refresh' });

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

  it('should detect custom auth errors in 200 OK responses and refresh token', async () => {
    // Setup a custom error detector for GraphQL-like errors
    const customErrorDetector = (response: any) => {
      return response?.errors?.some((error: any) => 
        error.extensions?.code === 'UNAUTHENTICATED' || 
        error.message?.includes('token expired')
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
      customErrorDetector
    });
    manager.use(graphqlPlugin);
    
    refreshFn.mockResolvedValue({ token: 'NEW_GRAPHQL_TOKEN' });
    
    // Mock a GraphQL error response with 200 status
    mockAxios
      .onPost('/graphql')
      .replyOnce(200, { 
        data: null, 
        errors: [{ 
          message: 'User not authenticated, token expired', 
          extensions: { code: 'UNAUTHENTICATED' } 
        }] 
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
      return response?.errors?.some((error: any) => 
        error.extensions?.code === 'UNAUTHENTICATED' || 
        error.message?.includes('token expired')
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
      customErrorDetector
    });
    manager.use(concurrentGraphqlPlugin);
    
    refreshFn.mockResolvedValue({ token: 'CONCURRENT_GRAPHQL_TOKEN' });
    
    // Mock 5 different GraphQL queries that all return 200 with auth errors first, then success
    const queries = [
      { endpoint: '/graphql/user', query: 'query { user { id name } }', successData: { user: { id: 1, name: 'User1' } } },
      { endpoint: '/graphql/posts', query: 'query { posts { title } }', successData: { posts: [{ title: 'Post1' }] } },
      { endpoint: '/graphql/profile', query: 'query { profile { email } }', successData: { profile: { email: 'test@example.com' } } },
      { endpoint: '/graphql/settings', query: 'query { settings { theme } }', successData: { settings: { theme: 'dark' } } },
      { endpoint: '/graphql/notifications', query: 'query { notifications { count } }', successData: { notifications: { count: 5 } } }
    ];

    queries.forEach(({ endpoint, successData }) => {
      mockAxios
        .onPost(endpoint)
        .replyOnce(200, { 
          data: null, 
          errors: [{ 
            message: 'User not authenticated, token expired', 
            extensions: { code: 'UNAUTHENTICATED' } 
          }] 
        })
        .onPost(endpoint)
        .replyOnce(200, { data: successData });
    });

    // Send all 5 GraphQL requests simultaneously 
    const promises = queries.map(({ endpoint, query }) => 
      axiosInstance.post(endpoint, { query })
    );
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
});