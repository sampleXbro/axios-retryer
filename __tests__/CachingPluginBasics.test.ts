//@ts-nocheck
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { RetryManager } from '../src';

describe('CachingPlugin Core Functionality', () => {
  let axiosInstance;
  let mock;
  let manager;
  let cachingPlugin;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new AxiosMockAdapter(axiosInstance);
    manager = new RetryManager({
      axiosInstance,
      debug: false,
    });
  });

  afterEach(() => {
    mock.restore();
    if (cachingPlugin) {
      try {
        manager.unuse('CachingPlugin');
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
    jest.useRealTimers();
  });

  test('generateCacheKey handles different data types', () => {
    cachingPlugin = new CachingPlugin();
    manager.use(cachingPlugin);

    // Access the private method for testing
    const generateCacheKey = cachingPlugin['buildCacheKey'].bind(cachingPlugin);

    // Test with string URL and no extra params
    const key1 = generateCacheKey({
      method: 'GET',
      url: '/test',
    });
    expect(key1).toBe('GET|/test|||');

    // Test with params as object
    const key2 = generateCacheKey({
      method: 'GET',
      url: '/test',
      params: { id: 123 },
    });
    expect(key2).toBe('GET|/test|{"id":123}||');

    // Test with data
    const key3 = generateCacheKey({
      method: 'POST',
      url: '/test',
      data: { name: 'test' },
    });
    expect(key3).toBe('POST|/test||{"name":"test"}|');

    // Test with headers when compareHeaders is true
    cachingPlugin = new CachingPlugin({ compareHeaders: true });
    manager.unuse('CachingPlugin');
    manager.use(cachingPlugin);

    const generateCacheKeyWithHeaders = cachingPlugin['buildCacheKey'].bind(cachingPlugin);
    const key4 = generateCacheKeyWithHeaders({
      method: 'GET',
      url: '/test',
      headers: { Authorization: 'Bearer token' },
    });
    expect(key4).toContain('Bearer token');
  });

  test('invalidateCache with RegExp removes matching entries', async () => {
    cachingPlugin = new CachingPlugin();
    manager.use(cachingPlugin);

    const storage = cachingPlugin['storage'];

    // Add test entries to storage
    storage.set('GET|/api/users/1|||', {
      response: { data: { id: 1 } },
      timestamp: Date.now(),
    });
    storage.set('GET|/api/users/2|||', {
      response: { data: { id: 2 } },
      timestamp: Date.now(),
    });
    storage.set('GET|/api/products/1|||', {
      response: { data: { id: 1 } },
      timestamp: Date.now(),
    });

    // Test RegExp invalidation
    const count = await cachingPlugin.invalidateCache(/users/);
    const entries = storage.entries();
    expect(count).toBe(2);
    expect(entries).toHaveLength(1);

    // Verify right cache entry remains
    expect(entries[0].key).toBe('GET|/api/products/1|||');
  });

  test('runCacheCleanup removes expired items', async () => {
    jest.useFakeTimers();
    const now = Date.now();

    // Create plugin with maxAge setting
    cachingPlugin = new CachingPlugin({
      maxAge: 1000, // 1 second max age
    });
    manager.use(cachingPlugin);

    const storage = cachingPlugin['storage'];

    // Add test entries with different ages
    storage.set('fresh', {
      response: { data: 'fresh' },
      timestamp: now,
    });

    storage.set('old', {
      response: { data: 'old' },
      timestamp: now - 2000, // 2 seconds old, should be expired
    });

    // Before cleanup
    expect(storage.entries()).toHaveLength(2);

    // Run cleanup
    const runCacheCleanup = cachingPlugin['runCacheCleanup'].bind(cachingPlugin);
    await runCacheCleanup();
    const entries = storage.entries();

    // Verify old item was removed
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('fresh');
  });

  test('runCacheCleanup enforces maxItems', async () => {
    // Create plugin with maxItems
    cachingPlugin = new CachingPlugin({
      maxItems: 2,
    });
    manager.use(cachingPlugin);

    const storage = cachingPlugin['storage'];

    // Add test entries with timestamps in order
    const now = Date.now();
    storage.set('oldest', {
      response: { data: 'oldest' },
      timestamp: now - 3000, // Oldest
    });

    storage.set('middle', {
      response: { data: 'middle' },
      timestamp: now - 2000,
    });

    storage.set('newest', {
      response: { data: 'newest' },
      timestamp: now - 1000, // Newest
    });

    // Before cleanup
    expect(storage.entries()).toHaveLength(3);

    // Run cleanup
    const runCacheCleanup = cachingPlugin['runCacheCleanup'].bind(cachingPlugin);
    await runCacheCleanup();
    const keys = storage.entries().map((entry) => entry.key);

    // Should keep only the 2 newest items
    expect(keys).toHaveLength(2);
    expect(keys).not.toContain('oldest');
    expect(keys).toContain('middle');
    expect(keys).toContain('newest');
  });

  test('cleanup runner start/stop', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    // Create plugin with cleanup interval
    cachingPlugin = new CachingPlugin({
      cleanupInterval: 1000,
    });

    // The CleanupRunner wraps setInterval/clearInterval; reach in to exercise it directly.
    const runner = cachingPlugin['cleanup'] as { start: () => void; stop: () => void };
    runner.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    runner.stop();

    expect(clearIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  test('getCacheStats returns correct statistics', () => {
    cachingPlugin = new CachingPlugin();
    manager.use(cachingPlugin);

    // Set up direct cache access for testing
    const cache = cachingPlugin['cache'];

    // Empty cache
    const emptyStats = cachingPlugin.getCacheStats();
    expect(emptyStats.size).toBe(0);
    expect(emptyStats.oldestItemAge).toBe(0);
    expect(emptyStats.newestItemAge).toBe(0);
    expect(emptyStats.averageAge).toBe(0);

    // Add test entries with timestamps
    const now = Date.now();
    cache.set('old', {
      response: { data: 'old' },
      timestamp: now - 2000,
    });

    cache.set('new', {
      response: { data: 'new' },
      timestamp: now - 1000,
    });

    // Stats with data
    const stats = cachingPlugin.getCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.oldestItemAge).toBeGreaterThanOrEqual(2000);
    expect(stats.newestItemAge).toBeGreaterThanOrEqual(1000);
    expect(stats.newestItemAge).toBeLessThan(stats.oldestItemAge);
    expect(stats.averageAge).toBeGreaterThanOrEqual(1500);
  });
});
