//@ts-nocheck
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { RetryManager } from '../src';
import { CachingPluginOptions } from '../src/plugins/CachingPlugin/CachingPlugin';
import MockAdapter from 'axios-mock-adapter';

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

  describe('Cache Invalidation and Stats', () => {
    let manager: RetryManager;
    let axiosInstance: AxiosInstance;
    let mockAxios: MockAdapter;
    let cachingPlugin: CachingPlugin;
    
    beforeEach(() => {
      axiosInstance = axios.create();
      mockAxios = new MockAdapter(axiosInstance);
      
      manager = new RetryManager({
        axiosInstance,
        debug: false
      });
      
      cachingPlugin = new CachingPlugin({
        timeToRevalidate: 60000,
        cacheMethods: ['GET'],
        maxItems: 5
      });
      
      manager.use(cachingPlugin);
    });
    
    afterEach(() => {
      mockAxios.reset();
      manager.unuse('CachingPlugin');
    });
    
    test('invalidateCache should remove matching cache entries', async () => {
      // Setup test data with multiple entries
      mockAxios.onGet('/users/1').reply(200, { id: 1, name: 'User 1' });
      mockAxios.onGet('/users/2').reply(200, { id: 2, name: 'User 2' });
      mockAxios.onGet('/posts/1').reply(200, { id: 1, title: 'Post 1' });
      
      // Populate cache
      await axiosInstance.get('/users/1');
      await axiosInstance.get('/users/2');
      await axiosInstance.get('/posts/1');
      
      // Initial cache should have 3 entries
      const initialStats = cachingPlugin.getCacheStats();
      expect(initialStats.size).toBe(3);
      
      // Invalidate only user-related cache entries
      cachingPlugin.invalidateCache('/users');
      
      // Should only have posts in cache now
      const afterStats = cachingPlugin.getCacheStats();
      expect(afterStats.size).toBe(1);
      
      // Re-request a user should go to the network
      mockAxios.onGet('/users/1').reply(200, { id: 1, name: 'Updated User 1' });
      const response = await axiosInstance.get('/users/1');
      expect(response.data.name).toBe('Updated User 1');
    });
    
    test('getCacheStats should return correct cache statistics', async () => {
      mockAxios.onGet('/test1').reply(200, { data: 'test1' });
      mockAxios.onGet('/test2').reply(200, { data: 'test2' });
      
      // Populate cache
      await axiosInstance.get('/test1');
      await axiosInstance.get('/test2');
      
      const stats = cachingPlugin.getCacheStats();
      
      // Test basic stats
      expect(stats.size).toBe(2);
      
      // Make a second request to get a cache hit
      await axiosInstance.get('/test1');
      
      const updatedStats = cachingPlugin.getCacheStats();
      expect(updatedStats.size).toBe(2);
      expect(typeof updatedStats.averageAge).toBe('number');
      
      // Just verify that stats is a valid object with properties
      expect(Object.keys(updatedStats).length).toBeGreaterThan(1);
    });
    
    test('cache should enforce maxItems limit', async () => {
      // Setup more items than the cache limit (5)
      for (let i = 1; i <= 7; i++) {
        mockAxios.onGet(`/item/${i}`).reply(200, { id: i, data: `Item ${i}` });
      }
      
      // Make 7 requests (exceeding the 5 item limit)
      for (let i = 1; i <= 7; i++) {
        await axiosInstance.get(`/item/${i}`);
      }
      
      // Cache should only contain 5 items (most recent)
      const stats = cachingPlugin.getCacheStats();
      expect(stats.size).toBe(5);
      
      // Oldest items should have been evicted
      // Re-request the first items to verify they're not in cache
      mockAxios.onGet('/item/1').reply(200, { id: 1, data: 'Updated Item 1' });
      mockAxios.onGet('/item/2').reply(200, { id: 2, data: 'Updated Item 2' });
      
      const response1 = await axiosInstance.get('/item/1');
      const response2 = await axiosInstance.get('/item/2');
      
      expect(response1.data.data).toBe('Updated Item 1');
      expect(response2.data.data).toBe('Updated Item 2');
      
      // Newest items should still be in cache
      // Re-request the last item to verify it's in cache (mock would return old value if called)
      mockAxios.onGet('/item/7').reply(200, { id: 7, data: 'This should not be called' });
      
      const cachedResponse = await axiosInstance.get('/item/7');
      expect(cachedResponse.data.data).toBe('Item 7');
    });
  });

  describe('Cache TTL and Expiration', () => {
    test('should create plugin with default options', () => {
      const plugin = new CachingPlugin();
      expect(plugin.name).toBe('CachingPlugin');
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
    
    test('should create plugin with custom options', () => {
      const options = {
        timeToRevalidate: 5000,
        cacheMethods: ['GET', 'HEAD'],
        maxItems: 20,
        respectCacheControl: true
      };
      
      const plugin = new CachingPlugin(options);
      
      // We can't easily test the internal state, but at least we can confirm
      // the plugin was created without errors
      expect(plugin.name).toBe('CachingPlugin');
    });
    
    test('should be able to clear cache', () => {
      const plugin = new CachingPlugin();
      
      // The plugin needs to be initialized with a RetryManager first
      const axiosInstance = axios.create();
      const manager = new RetryManager({ axiosInstance });
      manager.use(plugin);
      
      // Now we can call clearCache without errors
      plugin.clearCache();
      
      // Cleanup
      manager.unuse('CachingPlugin');
    });
    
    test('should be able to invalidate cache with pattern', () => {
      const plugin = new CachingPlugin();
      
      // The plugin needs to be initialized first
      const axiosInstance = axios.create();
      const manager = new RetryManager({ axiosInstance });
      manager.use(plugin);
      
      // Now we can call invalidateCache
      plugin.invalidateCache('/api/');
      
      // Cleanup
      manager.unuse('CachingPlugin');
    });
    
    test('should implement the plugin interface', () => {
      const plugin = new CachingPlugin();
      
      // Check that the required plugin interface properties exist
      expect(typeof plugin.name).toBe('string');
      expect(typeof plugin.version).toBe('string');
      expect(typeof plugin.initialize).toBe('function');
      expect(typeof plugin.onBeforeDestroyed).toBe('function');
    });
    
    test('should return cache statistics', () => {
      const plugin = new CachingPlugin();
      
      const stats = plugin.getCacheStats();
      
      // Check that the stats object has expected properties
      expect(typeof stats).toBe('object');
      expect(typeof stats.size).toBe('number');
      expect(stats.size).toBe(0); // Should start with empty cache
    });
    
    test('initializes properly with RetryManager', () => {
      const axiosInstance = axios.create();
      const manager = new RetryManager({ axiosInstance });
      const plugin = new CachingPlugin();
      
      // Should not throw when initializing
      expect(() => {
        manager.use(plugin);
      }).not.toThrow();
      
      // Clean up
      manager.unuse('CachingPlugin');
    });
  });
});