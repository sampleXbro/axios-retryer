import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../../src/core/RetryManager';
import {
  CachingPlugin,
  type CachedItem,
  type CacheStorage,
  type CacheStorageEntry,
} from '../../src/plugins/CachingPlugin';

class AsyncIndexedCacheStorage implements CacheStorage {
  private readonly storage = new Map<string, CachedItem>();

  public async get(key: string): Promise<CachedItem | undefined> {
    return this.storage.get(key);
  }

  public async set(key: string, value: CachedItem): Promise<void> {
    this.storage.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }

  public async clear(): Promise<void> {
    this.storage.clear();
  }

  public async entries(): Promise<readonly CacheStorageEntry[]> {
    return Array.from(this.storage, ([key, value]) => ({ key, value }));
  }

  public seed(key: string, value: CachedItem): void {
    this.storage.set(key, value);
  }
}

function createCachedItem(
  url: string,
  data: unknown,
  overrides: Partial<Pick<CachedItem, 'timestamp' | 'ttr' | 'lastAccessedAt'>> = {},
): CachedItem {
  const timestamp = overrides.timestamp ?? Date.now();

  return {
    response: {
      config: { method: 'get', url } as AxiosRequestConfig,
      data,
      headers: {},
      status: 200,
      statusText: 'OK',
    } as AxiosResponse<unknown>,
    timestamp,
    ttr: overrides.ttr,
    lastAccessedAt: overrides.lastAccessedAt ?? timestamp,
  };
}

describe('CachingPlugin indexed storage integration', () => {
  test('serves cached responses from indexed storage after restart', async () => {
    const storage = new AsyncIndexedCacheStorage();

    const axiosA = axios.create();
    const mockA = new AxiosMockAdapter(axiosA);
    const managerA = new RetryManager({ axiosInstance: axiosA, retries: 0, debug: false });
    const pluginA = new CachingPlugin({ storage, dedupeConcurrentRequests: false });
    managerA.use(pluginA);

    mockA.onGet('/profile').replyOnce(200, { id: 1, source: 'network' });
    const first = await managerA.axiosInstance.get('/profile');
    expect(first.data).toEqual({ id: 1, source: 'network' });

    managerA.destroy();
    mockA.restore();

    const axiosB = axios.create();
    const mockB = new AxiosMockAdapter(axiosB);
    const managerB = new RetryManager({ axiosInstance: axiosB, retries: 0, debug: false });
    managerB.use(new CachingPlugin({ storage, dedupeConcurrentRequests: false }));

    mockB.onGet('/profile').replyOnce(200, { id: 2, source: 'network-after-restart' });

    const second = await managerB.axiosInstance.get('/profile');

    expect(second.data).toEqual({ id: 1, source: 'network' });
    expect(mockB.history.get).toHaveLength(0);

    managerB.destroy();
    mockB.restore();
  });

  test('invalidates persisted prefix matches after restart', async () => {
    const storage = new AsyncIndexedCacheStorage();

    const axiosA = axios.create();
    const mockA = new AxiosMockAdapter(axiosA);
    const managerA = new RetryManager({ axiosInstance: axiosA, retries: 0, debug: false });
    const pluginA = new CachingPlugin({ storage, dedupeConcurrentRequests: false });
    managerA.use(pluginA);

    mockA.onGet('/users/1').replyOnce(200, { id: 1 });
    mockA.onGet('/users/2').replyOnce(200, { id: 2 });

    await managerA.axiosInstance.get('/users/1');
    await managerA.axiosInstance.get('/users/2');

    managerA.destroy();
    mockA.restore();

    const axiosB = axios.create();
    const mockB = new AxiosMockAdapter(axiosB);
    const managerB = new RetryManager({ axiosInstance: axiosB, retries: 0, debug: false });
    const pluginB = new CachingPlugin({ storage, dedupeConcurrentRequests: false });
    managerB.use(pluginB);

    await expect(pluginB.invalidateCache({ prefix: 'GET|/users/' })).resolves.toBe(2);
    await expect(storage.entries()).resolves.toHaveLength(0);

    mockB.onGet('/users/1').replyOnce(200, { id: 'fresh' });
    const response = await managerB.axiosInstance.get('/users/1');

    expect(response.data).toEqual({ id: 'fresh' });
    expect(mockB.history.get).toHaveLength(1);

    managerB.destroy();
    mockB.restore();
  });

  test('cleans up stale persisted entries after restart', async () => {
    const storage = new AsyncIndexedCacheStorage();
    const now = Date.now();

    storage.seed('GET|/stale|||', createCachedItem('/stale', { id: 'stale' }, { timestamp: now - 10_000 }));
    storage.seed('GET|/fresh|||', createCachedItem('/fresh', { id: 'fresh' }, { timestamp: now - 100 }));

    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
    const plugin = new CachingPlugin({
      storage,
      maxAge: 1_000,
      dedupeConcurrentRequests: false,
    });
    manager.use(plugin);

    await (plugin as unknown as { runCacheCleanup(): Promise<void> }).runCacheCleanup();

    const remainingEntries = await storage.entries();
    expect(remainingEntries).toHaveLength(1);
    expect(remainingEntries[0].key).toBe('GET|/fresh|||');

    mock.onGet('/stale').replyOnce(200, { id: 'network' });
    const response = await manager.axiosInstance.get('/stale');

    expect(response.data).toEqual({ id: 'network' });
    expect(mock.history.get).toHaveLength(1);

    manager.destroy();
    mock.restore();
  });
});
