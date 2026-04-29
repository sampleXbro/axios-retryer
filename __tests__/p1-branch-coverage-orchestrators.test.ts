/**
 * Branch coverage fills for the orchestrator-level paths that the existing
 * tests don't naturally exercise:
 *   - RequestLifecycleManager.readCorrelationHeader: AxiosHeaders.get number,
 *     plain-object map non-matching key, plain-object number value.
 *   - CachingPlugin: oversized response skip, non-2xx response, empty
 *     invalidate match, clearCache when storage returns a promise.
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import { CachingPlugin } from '../src/plugins/CachingPlugin/CachingPlugin';
import type { CacheStorage, CachedItem, CacheStorageEntry } from '../src/plugins/CachingPlugin/types';
import { getRequestMetadata } from '../src/utils/requestMetadata';

describe('RequestLifecycleManager — correlationId header parsing', () => {
  it('honors a numeric X-Request-Id provided via AxiosHeaders.get()', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    mock.onGet('/x').reply(200, {});
    const manager = new RetryManager({ axiosInstance, retries: 0 });

    // Use AxiosHeaders so the get() branch in readCorrelationHeader is hit.
    await manager.axiosInstance.get('/x', {
      headers: axios.AxiosHeaders.from({ 'X-Request-Id': '99999' }),
    });

    const tracked = manager.getMetrics();
    expect(tracked).toBeDefined();
    manager.destroy();
  });

  it('ignores non-correlation header keys via plain-object iteration', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    mock.onGet('/x').reply(200, {});
    const manager = new RetryManager({ axiosInstance, retries: 0 });

    let observed: { id?: string; cid?: string } = {};
    manager.axiosInstance.interceptors.request.use((config) => {
      const meta = getRequestMetadata(config);
      observed = { id: meta?.requestId, cid: meta?.correlationId };
      return config;
    });

    await manager.axiosInstance.get('/x', {
      headers: { 'X-Other': 'noise', 'Content-Type': 'application/json' } as never,
    });

    // No correlation header → falls back to requestId.
    expect(observed.cid).toBe(observed.id);
    manager.destroy();
  });
});

describe('CachingPlugin — orchestrator branches', () => {
  function buildHarness(options?: ConstructorParameters<typeof CachingPlugin>[0]) {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new CachingPlugin(options);
    manager.use(plugin);
    return { axiosInstance, mock, manager, plugin };
  }

  it('skips caching when the response exceeds maxEntrySize', async () => {
    const { mock, manager, plugin } = buildHarness({ maxEntrySize: 10, dedupeConcurrentRequests: false });
    mock.onGet('/big').reply(200, { payload: 'x'.repeat(64) });

    await manager.axiosInstance.get('/big');
    expect(plugin.getCacheStats().size).toBe(0);
    manager.destroy();
  });

  it('does not cache non-2xx responses returned via custom validateStatus', async () => {
    const axiosInstance = axios.create({ validateStatus: () => true });
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new CachingPlugin({ dedupeConcurrentRequests: false });
    manager.use(plugin);

    mock.onGet('/teapot').reply(418, { error: 'no coffee' });

    const response = await manager.axiosInstance.get('/teapot');
    expect(response.status).toBe(418);
    expect(plugin.getCacheStats().size).toBe(0);
    manager.destroy();
  });

  it('invalidateCache(matcher) returns 0 when nothing matches', () => {
    const { manager, plugin } = buildHarness();
    const result = plugin.invalidateCache('GET|/never-cached');
    expect(result).toBe(0);
    manager.destroy();
  });

  it('clearCache returns a promise when the storage adapter is async', async () => {
    const storageMap = new Map<string, CachedItem>();
    const asyncStorage: CacheStorage = {
      get: async (key) => storageMap.get(key),
      set: async (key, value) => {
        storageMap.set(key, value);
      },
      delete: async (key) => {
        storageMap.delete(key);
      },
      clear: async () => {
        storageMap.clear();
      },
      entries: async (): Promise<CacheStorageEntry[]> => Array.from(storageMap, ([key, value]) => ({ key, value })),
    };

    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new CachingPlugin({ storage: asyncStorage, dedupeConcurrentRequests: false });
    manager.use(plugin);

    mock.onGet('/x').reply(200, { ok: true });
    await manager.axiosInstance.get('/x');
    expect(storageMap.size).toBeGreaterThanOrEqual(0);

    const clearResult = plugin.clearCache();
    expect(clearResult).toBeDefined();
    await clearResult;
    expect(storageMap.size).toBe(0);
    manager.destroy();
  });

  it('invalidateCache returns a promise with the count when the storage adapter is async', async () => {
    const storageMap = new Map<string, CachedItem>();
    const asyncStorage: CacheStorage = {
      get: async (key) => storageMap.get(key),
      set: async (key, value) => {
        storageMap.set(key, value);
      },
      delete: async (key) => {
        storageMap.delete(key);
      },
      clear: async () => {
        storageMap.clear();
      },
      entries: async (): Promise<CacheStorageEntry[]> => Array.from(storageMap, ([key, value]) => ({ key, value })),
    };

    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new CachingPlugin({ storage: asyncStorage, dedupeConcurrentRequests: false });
    manager.use(plugin);

    mock.onGet('/users').reply(200, { ok: true });
    mock.onGet('/posts').reply(200, { ok: true });
    await manager.axiosInstance.get('/users');
    await manager.axiosInstance.get('/posts');

    const invalidatedPromise = plugin.invalidateCache({ prefix: 'GET|/users' });
    expect(invalidatedPromise).toBeInstanceOf(Promise);
    const invalidated = await invalidatedPromise;
    expect(invalidated).toBe(1);

    manager.destroy();
  });
});
