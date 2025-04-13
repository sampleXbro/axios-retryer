//@ts-nocheck
import axios, { AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { RetryManager } from '../src';
import { CachingPluginOptions } from '../src/plugins/CachingPlugin/CachingPlugin';

describe('CachingPlugin Advanced Tests', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let manager: RetryManager;
  let cachingPlugin: CachingPlugin;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
    manager = new RetryManager({
      axiosInstance,
      debug: false
    });
  });

  afterEach(() => {
    mock.restore();
    if (cachingPlugin) {
      manager.unuse('CachingPlugin');
    }
    jest.useRealTimers();
  });

  describe('Periodic Cleanup Tests', () => {
    test('should start and stop periodic cleanup', () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      
      // Create plugin with cleanup interval
      cachingPlugin = new CachingPlugin({
        cleanupInterval: 1000, 
        maxAge: 2000
      });
      
      // Initialize should start periodic cleanup
      manager.use(cachingPlugin);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      
      // Destroying should stop periodic cleanup
      manager.unuse('CachingPlugin');
      expect(clearIntervalSpy).toHaveBeenCalled();
      
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
    
    test('should clean up expired items based on maxAge', async () => {
      // Create plugin with cleanup and age settings
      cachingPlugin = new CachingPlugin({
        cleanupInterval: 1000,
        maxAge: 2000
      });
      
      manager.use(cachingPlugin);
      
      // Get direct access to cache for testing
      const cache = cachingPlugin['cache'];
      
      // Manually add test entries with expired timestamps
      const now = Date.now();
      cache.set('test1-key', {
        response: { data: { data: 'test1' }, status: 200, headers: {}, config: {} },
        timestamp: now - 3000 // 3 seconds old (older than maxAge)
      });
      
      cache.set('test2-key', {
        response: { data: { data: 'test2' }, status: 200, headers: {}, config: {} },
        timestamp: now - 1000 // 1 second old (fresher than maxAge)
      });
      
      // Initial cache size should be 2
      expect(cache.size).toBe(2);
      
      // Run cleanup to remove expired items
      (cachingPlugin as any).runCacheCleanup();
      
      // Only the expired item should be removed
      expect(cache.size).toBe(1);
      expect(cache.has('test1-key')).toBe(false);
      expect(cache.has('test2-key')).toBe(true);
    }, 30000); // Increased timeout
    
    test('runCacheCleanup should handle empty cache', () => {
      cachingPlugin = new CachingPlugin({
        maxAge: 1000
      });
      
      manager.use(cachingPlugin);
      
      // Manually trigger cleanup (accessing private method for testing)
      (cachingPlugin as any).runCacheCleanup();
      
      // Should not throw errors on empty cache
      expect(cachingPlugin.getCacheStats().size).toBe(0);
    });
  });

  describe('Cache Key Generation & Edge Cases', () => {
    test('should handle various data types in cache key generation', async () => {
      cachingPlugin = new CachingPlugin();
      manager.use(cachingPlugin);
      
      // Access the private method for testing
      const generateCacheKey = cachingPlugin['generateCacheKey'].bind(cachingPlugin);
      
      // Test with string URL and no extra params
      const key1 = generateCacheKey({ 
        method: 'GET', 
        url: '/test'
      });
      expect(key1).toBe('GET|/test|||');
      
      // Test with string params
      const key2 = generateCacheKey({ 
        method: 'GET', 
        url: '/test',
        params: 'stringParam'
      });
      expect(key2).toBe('GET|/test|stringParam||');
      
      // Test with number params
      const key3 = generateCacheKey({ 
        method: 'GET', 
        url: '/test',
        params: 123
      });
      expect(key3).toBe('GET|/test|123||');
      
      // Test with object params
      const key4 = generateCacheKey({ 
        method: 'GET', 
        url: '/test',
        params: { key: 'value' }
      });
      expect(key4).toBe('GET|/test|{"key":"value"}||');
      
      // Test with array params
      const key5 = generateCacheKey({ 
        method: 'GET', 
        url: '/test',
        params: [1, 2, 3]
      });
      expect(key5).toBe('GET|/test|[1,2,3]||');
      
      // Test with request body data
      const key6 = generateCacheKey({
        method: 'POST',
        url: '/test-post',
        data: { key: 'value' }
      });
      expect(key6).toBe('POST|/test-post||{"key":"value"}|');
    });
    
    test('should throw error for missing URL in cache key generation', async () => {
      cachingPlugin = new CachingPlugin();
      manager.use(cachingPlugin);
      
      // Create a config without URL
      const invalidConfig = {
        method: 'GET'
        // missing url
      };
      
      // Direct access to generateCacheKey for testing
      expect(() => {
        (cachingPlugin as any).generateCacheKey(invalidConfig);
      }).toThrow('URL is required for cache key generation');
    });
    
    test('should handle null/undefined values in cache key generation', async () => {
      cachingPlugin = new CachingPlugin();
      manager.use(cachingPlugin);
      
      mock.onGet('/null-test').reply(200, { success: true });
      
      // Test with null headers, params and data
      await axiosInstance.get('/null-test', {
        headers: null,
        params: null,
        data: null
      });
      
      // Should have created a cache entry without errors
      expect(cachingPlugin.getCacheStats().size).toBe(1);
    });
  });

  describe('Cache Invalidation', () => {
    test('should invalidate cache entries using RegExp pattern', async () => {
      cachingPlugin = new CachingPlugin();
      manager.use(cachingPlugin);
      
      // Add various items to cache
      mock.onGet('/api/users/1').reply(200, { user: 1 });
      mock.onGet('/api/users/2').reply(200, { user: 2 });
      mock.onGet('/api/products/1').reply(200, { product: 1 });
      mock.onGet('/api/categories/5').reply(200, { category: 5 });
      
      // Populate cache
      await axiosInstance.get('/api/users/1');
      await axiosInstance.get('/api/users/2');
      await axiosInstance.get('/api/products/1');
      await axiosInstance.get('/api/categories/5');
      
      expect(cachingPlugin.getCacheStats().size).toBe(4);
      
      // Invalidate with RegExp - only user entries
      const count = cachingPlugin.invalidateCache(/\/api\/users\/\d+/);
      
      // Should have removed 2 entries
      expect(count).toBe(2);
      expect(cachingPlugin.getCacheStats().size).toBe(2);
      
      // User requests should go to network, others still cached
      mock.onGet('/api/users/1').reply(200, { user: 'updated' });
      
      const res1 = await axiosInstance.get('/api/users/1');
      const res2 = await axiosInstance.get('/api/products/1');
      
      expect(res1.data.user).toBe('updated');
      expect(res2.data.product).toBe(1); // From cache
    });
    
    test('should handle no matches when invalidating cache', async () => {
      cachingPlugin = new CachingPlugin();
      manager.use(cachingPlugin);
      
      // Add item to cache
      mock.onGet('/test').reply(200, { data: 'test' });
      await axiosInstance.get('/test');
      
      // Try to invalidate with non-matching pattern
      const countStr = cachingPlugin.invalidateCache('nonexistent');
      const countRegex = cachingPlugin.invalidateCache(/nonexistent/);
      
      // Should return 0 for both attempts
      expect(countStr).toBe(0);
      expect(countRegex).toBe(0);
      
      // Cache should still have the item
      expect(cachingPlugin.getCacheStats().size).toBe(1);
    });
  });

  describe('Comprehensive Stats Testing', () => {
    test('getCacheStats should return accurate statistics', async () => {
      // Don't use fake timers here
      cachingPlugin = new CachingPlugin();
      manager.use(cachingPlugin);
      
      // Clear any previous cache entries
      cachingPlugin.clearCache();
      
      // Empty cache stats
      const emptyStats = cachingPlugin.getCacheStats();
      expect(emptyStats.size).toBe(0);
      expect(emptyStats.oldestItemAge).toBe(0);
      expect(emptyStats.newestItemAge).toBe(0);
      expect(emptyStats.averageAge).toBe(0);
      
      // Add items to cache with manually set timestamps
      mock.onGet('/item1').reply(200, { id: 1 });
      mock.onGet('/item2').reply(200, { id: 2 });
      mock.onGet('/item3').reply(200, { id: 3 });
      
      // Fetch the items to populate cache
      await axiosInstance.get('/item1');
      await axiosInstance.get('/item2');
      await axiosInstance.get('/item3');
      
      // Manually modify timestamps
      const now = Date.now();
      const cache = cachingPlugin['cache'];
      const entries = Array.from(cache.entries());
      
      // Update each entry with controlled timestamps for predictable ages
      entries[0][1].timestamp = now - 3000; // 3 seconds old
      entries[1][1].timestamp = now - 2000; // 2 seconds old
      entries[2][1].timestamp = now - 1000; // 1 second old
      
      // Get stats with manual timestamps
      const stats = cachingPlugin.getCacheStats();
      
      // Check basic stats
      expect(stats.size).toBe(3);
      
      // Verify age calculations (approximate due to execution time)
      expect(stats.oldestItemAge).toBeGreaterThanOrEqual(3000);
      expect(stats.oldestItemAge).toBeLessThan(4000);
      expect(stats.newestItemAge).toBeGreaterThanOrEqual(1000);
      expect(stats.newestItemAge).toBeLessThan(2000);
      expect(stats.averageAge).toBeGreaterThanOrEqual(2000);
      expect(stats.averageAge).toBeLessThan(3000);
      
      // Clear cache and check stats again
      cachingPlugin.clearCache();
      const clearedStats = cachingPlugin.getCacheStats();
      expect(clearedStats.size).toBe(0);
      expect(clearedStats.oldestItemAge).toBe(0);
    });
  });

  describe('Custom Cache Methods', () => {
    test('should cache non-GET methods when specified in options', async () => {
      cachingPlugin = new CachingPlugin({
        cacheMethods: ['GET', 'POST']
      });
      manager.use(cachingPlugin);
      
      // Clear cache to start fresh
      cachingPlugin.clearCache();
      
      // Test POST caching
      mock.onPost('/api/data').reply(200, { success: true, data: 'original' });
      
      // First POST request
      const res1 = await axiosInstance.post('/api/data', { test: true });
      expect(res1.data.data).toBe('original');
      
      // Verify entry is in cache
      expect(cachingPlugin.getCacheStats().size).toBe(1);
      
      // Change mock response for the second request
      mock.resetHistory();
      mock.onPost('/api/data').reply(200, { success: true, data: 'updated' });
      
      // Second POST with same data should be from cache
      const res2 = await axiosInstance.post('/api/data', { test: true });
      
      // Should get cached response, not the updated mock
      expect(res2.data.data).toBe('original');
      
      // Different POST data should be a cache miss
      const res3 = await axiosInstance.post('/api/data', { test: false });
      expect(res3.data.data).toBe('updated');
      
      // Verify we now have 2 cache entries
      expect(cachingPlugin.getCacheStats().size).toBe(2);
    });
  });
}); 