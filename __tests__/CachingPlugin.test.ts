//@ts-nocheck
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { RetryManager } from '../src';
import { CachingPluginOptions } from '../src/plugins/CachingPlugin/CachingPlugin';

// A minimal fake logger to capture debug calls
const createFakeLogger = () => ({
  debug: jest.fn(),
});

// A fake manager that exposes only what our plugin needs
const createFakeManager = (axiosInstance: AxiosInstance, logger = createFakeLogger()) => ({
  axiosInstance,
  getLogger: () => logger,
});

describe('CachingPlugin', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let fakeLogger: ReturnType<typeof createFakeLogger>;
  let fakeManager: ReturnType<typeof createFakeManager>;
  let cachingPlugin: CachingPlugin;

  beforeEach(() => {
    // Create a fresh axios instance and adapter for each test
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
    fakeLogger = createFakeLogger();
    fakeManager = createFakeManager(axiosInstance, fakeLogger);
  });

  afterEach(() => {
    mock.restore();
    // Clean up the plugin (remove interceptors and timers)
    if (cachingPlugin) {
      cachingPlugin.onBeforeDestroyed();
    }
    jest.useRealTimers();
  });

  test('should cache GET requests and serve subsequent calls from cache', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/test';
    const responseData = { data: 'response' };

    // First GET: reply with the given data.
    mock.onGet(url).replyOnce(200, responseData);

    // First call: will go to network.
    const res1 = await axiosInstance.get(url);
    expect(res1.data).toEqual(responseData);
    // The adapter history should show one GET.
    expect(mock.history.get.length).toBe(1);

    // Second call: should be served from cache.
    const res2 = await axiosInstance.get(url);
    expect(res2.data).toEqual(responseData);
    // No new network call should have been made.
    expect(mock.history.get.length).toBe(1);

    // Verify that a cache hit debug message was logged.
    expect(
      fakeLogger.debug.mock.calls.some((args) => args[0].includes('Cache hit'))
    ).toBe(true);
  });

  test('should not cache non-GET methods', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/post';
    const postData = { key: 'value' };
    const responseData = { success: true };

    // Setup mock reply for POST
    mock.onPost(url).replyOnce(200, responseData);

    // First POST call
    const res1 = await axiosInstance.post(url, postData);
    expect(res1.data).toEqual(responseData);
    expect(mock.history.post.length).toBe(1);

    // Second POST call (no caching for POST requests)
    mock.onPost(url).replyOnce(200, responseData);
    const res2 = await axiosInstance.post(url, postData);
    expect(res2.data).toEqual(responseData);
    expect(mock.history.post.length).toBe(2);
  });

  test('should not cache when cacheOnlyRetriedRequests is true and __isRetrying is false', async () => {
    // Set cacheOnlyRetriedRequests option to true.
    const options: CachingPluginOptions = { cacheOnlyRetriedRequests: true };
    cachingPlugin = new CachingPlugin(options);
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/test';
    const responseData = { data: 'response' };

    // First GET: request does NOT have __isRetrying set.
    mock.onGet(url).replyOnce(200, responseData);
    const res1 = await axiosInstance.get(url);
    expect(res1.data).toEqual(responseData);

    // Second GET: still without __isRetrying, so should not be cached.
    mock.onGet(url).replyOnce(200, responseData);
    const res2 = await axiosInstance.get(url);
    expect(res2.data).toEqual(responseData);

    // Two network calls should have been made.
    expect(mock.history.get.length).toBe(2);
  });

  test('should cache when cacheOnlyRetriedRequests is true and __isRetrying is true', async () => {
    const options: CachingPluginOptions = { cacheOnlyRetriedRequests: true };
    cachingPlugin = new CachingPlugin(options);
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/test';
    const responseData = { data: 'response' };

    // First GET with __isRetrying true.
    mock.onGet(url).replyOnce(200, responseData);
    const res1 = await axiosInstance.get(url, { __isRetrying: true });
    expect(res1.data).toEqual(responseData);

    // Second GET with __isRetrying true should hit cache.
    const res2 = await axiosInstance.get(url, { __isRetrying: true });
    expect(res2.data).toEqual(responseData);

    // Only one network call should have been made.
    expect(mock.history.get.length).toBe(1);
  });

  test('should not serve cache if timeToRevalidate is exceeded', async () => {
    // Use a short timeToRevalidate value.
    const options: CachingPluginOptions = { timeToRevalidate: 100 };
    cachingPlugin = new CachingPlugin(options);
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/test';
    const responseData = { data: 'response' };

    // First GET request – should be cached.
    mock.onGet(url).replyOnce(200, responseData);
    const res1 = await axiosInstance.get(url);
    expect(res1.data).toEqual(responseData);
    expect(mock.history.get.length).toBe(1);

    // Advance time beyond timeToRevalidate.
    jest.useFakeTimers();
    jest.advanceTimersByTime(150);

    // Second GET request – cache should be stale; new network call expected.
    mock.onGet(url).replyOnce(200, responseData);
    const res2 = await axiosInstance.get(url);
    expect(res2.data).toEqual(responseData);
    expect(mock.history.get.length).toBe(2);

    // Verify that stale cache removal debug message was logged.
    expect(
      fakeLogger.debug.mock.calls.some((args) => args[0].includes('Cache stale'))
    ).toBe(true);
  });

  test('should enforce maxItems by removing oldest items', async () => {
    // Set maxItems to 2.
    const options: CachingPluginOptions = { maxItems: 2 };
    cachingPlugin = new CachingPlugin(options);
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url1 = '/test1';
    const url2 = '/test2';
    const url3 = '/test3';
    const responseData = { data: 'response' };

    // Simulate responses for three different URLs.
    mock.onGet(url1).replyOnce(200, responseData);
    mock.onGet(url2).replyOnce(200, responseData);
    mock.onGet(url3).replyOnce(200, responseData);

    // Request each URL sequentially.
    await axiosInstance.get(url1);
    await axiosInstance.get(url2);
    await axiosInstance.get(url3);

    // At this point, maxItems is 2, so the oldest (url1) should have been removed.
    const stats = cachingPlugin.getCacheStats();
    expect(stats.size).toBeLessThanOrEqual(2);
  });

  test('should clear cache via clearCache and report stats correctly', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/test';
    const responseData = { data: 'response' };

    // Make one GET request.
    mock.onGet(url).replyOnce(200, responseData);
    await axiosInstance.get(url);

    // Verify cache stats show one item.
    let stats = cachingPlugin.getCacheStats();
    expect(stats.size).toBe(1);

    // Clear the cache.
    cachingPlugin.clearCache();
    stats = cachingPlugin.getCacheStats();
    expect(stats.size).toBe(0);

    expect(fakeLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache cleared'));
  });

  test('should include headers in cache key when compareHeaders is true', async () => {
    const options: CachingPluginOptions = { compareHeaders: true };
    cachingPlugin = new CachingPlugin(options);
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/test';
    const responseData = { data: 'response' };

    // First GET with header A.
    mock.onGet(url).replyOnce(200, responseData);
    const configA: AxiosRequestConfig = {
      headers: { 'X-Custom': 'A' },
    };
    const res1 = await axiosInstance.get(url, configA);
    expect(res1.data).toEqual(responseData);

    // Second GET with a different header value should not hit the cache.
    mock.onGet(url).replyOnce(200, responseData);
    const configB: AxiosRequestConfig = {
      headers: { 'X-Custom': 'B' },
    };
    const res2 = await axiosInstance.get(url, configB);
    expect(res2.data).toEqual(responseData);

    // The first call used the network and the second call as well.
    expect(mock.history.get.length).toBe(2);
  });
});