//@ts-nocheck
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src/core/RetryManager';
import { RequestQueue } from '../src/core/requestQueue';
import {
  CachingPlugin,
  InMemoryCacheStorage,
} from '../src/plugins/CachingPlugin';
import {
  CircuitBreakerPlugin,
  CIRCUIT_BREAKER_STATES,
  CircuitBreakerState,
  InMemoryCircuitBreakerStateAdapter,
} from '../src/plugins/CircuitBreakerPlugin';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';

describe('P3 Scalability Tasks', () => {
  describe('T-021/T-025/T-028: Circuit breaker scoped and shared state', () => {
    test('should trip only the normalized endpoint scope and leave other endpoints available', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://svc.example.com' });
      const mock = new AxiosMockAdapter(axiosInstance);
      const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 3,
        openTimeout: 10000,
      });

      manager.use(plugin);

      mock.onGet('/users/1').reply(500);
      for (let i = 0; i < 3; i++) {
        await expect(manager.axiosInstance.get('/users/1')).rejects.toThrow();
      }

      await expect(manager.axiosInstance.get('/users/2')).rejects.toThrow(/Circuit is open/);

      mock.onGet('/orders/1').reply(200, { ok: true });
      const response = await manager.axiosInstance.get('/orders/1');

      expect(response.data).toEqual({ ok: true });
      expect(plugin.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

      const metrics = plugin.getMetrics();
      expect(
        metrics.scopeMetrics.some((scope) => scope.url === '/users/:id' && scope.state === CIRCUIT_BREAKER_STATES.OPEN),
      ).toBe(true);

      manager.destroy();
      mock.restore();
    });

    test('should share circuit state across plugin instances through the state adapter', async () => {
      const sharedAdapter = new InMemoryCircuitBreakerStateAdapter();

      const axiosA = axios.create({ baseURL: 'https://svc.example.com' });
      const axiosB = axios.create({ baseURL: 'https://svc.example.com' });
      const mockA = new AxiosMockAdapter(axiosA);
      const mockB = new AxiosMockAdapter(axiosB);

      const managerA = new RetryManager({ axiosInstance: axiosA, retries: 0, debug: false });
      const managerB = new RetryManager({ axiosInstance: axiosB, retries: 0, debug: false });

      const pluginA = new CircuitBreakerPlugin({
        failureThreshold: 2,
        openTimeout: 10000,
        stateAdapter: sharedAdapter,
      });
      const pluginB = new CircuitBreakerPlugin({
        failureThreshold: 2,
        openTimeout: 10000,
        stateAdapter: sharedAdapter,
      });

      managerA.use(pluginA);
      managerB.use(pluginB);

      mockA.onGet('/shared/1').reply(500);
      await expect(managerA.axiosInstance.get('/shared/1')).rejects.toThrow();
      await expect(managerA.axiosInstance.get('/shared/1')).rejects.toThrow();

      await expect(managerB.axiosInstance.get('/shared/2')).rejects.toThrow(/Circuit is open/);
      expect(pluginB.getState()).toBe(CIRCUIT_BREAKER_STATES.OPEN);

      managerA.destroy();
      managerB.destroy();
      mockA.restore();
      mockB.restore();
    });
  });

  describe('T-022/T-023: Cache storage interface and request deduplication', () => {
    test('should use a custom async cache storage backend', async () => {
      const axiosInstance = axios.create();
      const mock = new AxiosMockAdapter(axiosInstance);
      const storageMap = new Map();
      const storage = {
        entries: jest.fn(async () => Array.from(storageMap, ([key, value]) => ({ key, value }))),
        get: jest.fn(async (key) => storageMap.get(key)),
        set: jest.fn(async (key, value) => {
          storageMap.set(key, value);
        }),
        delete: jest.fn(async (key) => {
          storageMap.delete(key);
        }),
        clear: jest.fn(async () => {
          storageMap.clear();
        }),
      };

      const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
      manager.use(
        new CachingPlugin({
          storage,
          cacheMethods: ['GET'],
          dedupeConcurrentRequests: false,
        }),
      );

      mock.onGet('/profile').replyOnce(200, { id: 1 });

      const first = await manager.axiosInstance.get('/profile');
      const second = await manager.axiosInstance.get('/profile');

      expect(first.data).toEqual({ id: 1 });
      expect(second.data).toEqual({ id: 1 });
      expect(storage.set).toHaveBeenCalled();
      expect(storage.get).toHaveBeenCalledTimes(1);

      manager.destroy();
      mock.restore();
    });

    test('should deduplicate concurrent identical cacheable requests', async () => {
      const axiosInstance = axios.create();
      const mock = new AxiosMockAdapter(axiosInstance);
      const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
      manager.use(
        new CachingPlugin({
          cacheMethods: ['GET'],
        }),
      );

      mock.onGet('/dedupe').reply(() => {
        return new Promise((resolve) => {
          setTimeout(() => resolve([200, { ok: true }]), 25);
        });
      });

      const [first, second] = await Promise.all([
        manager.axiosInstance.get('/dedupe'),
        manager.axiosInstance.get('/dedupe'),
      ]);

      expect(first.data).toEqual({ ok: true });
      expect(second.data).toEqual({ ok: true });
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
      mock.restore();
    });
  });

  describe('T-024/T-026: metrics reset and request IDs', () => {
    test('should reset collected metrics', async () => {
      const axiosInstance = axios.create();
      const mock = new AxiosMockAdapter(axiosInstance);
      const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
      manager.use(new MetricsPlugin());

      mock.onGet('/metrics').reply(200, { ok: true });

      await manager.axiosInstance.get('/metrics');
      expect(manager.getMetrics().totalRequests).toBe(1);

      manager.resetMetrics();

      const metrics = manager.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.successfulRetries).toBe(0);
      expect(metrics.failedRetries).toBe(0);
      expect(metrics.avgQueueWait).toBe(0);
      expect(metrics.avgRetryDelay).toBe(0);

      manager.destroy();
      mock.restore();
    });

    test('should generate request IDs without using Math.random', async () => {
      const axiosInstance = axios.create();
      const mock = new AxiosMockAdapter(axiosInstance);
      const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
      const randomSpy = jest.spyOn(Math, 'random');

      mock.onGet('/ids').reply(200, { ok: true });
      await manager.axiosInstance.get('/ids');

      expect(randomSpy).not.toHaveBeenCalled();

      randomSpy.mockRestore();
      manager.destroy();
      mock.restore();
    });
  });

  describe('T-027: cached sorted queue snapshots', () => {
    test('should cache getAll sorting until the heap changes', () => {
      const queue = new RequestQueue({
        maxConcurrent: 5,
        queueDelay: 0,
        canProcess: () => true,
      });

      queue.enqueue({ url: '/low', __axiosRetryer: { priority: 0, timestamp: 1, requestId: 'low' } });
      queue.enqueue({ url: '/high', __axiosRetryer: { priority: 3, timestamp: 2, requestId: 'high' } });

      const firstSnapshot = queue.getWaiting();
      const sortedCache = queue['waiting']['sortedCache'];

      expect(firstSnapshot[0].config.__axiosRetryer?.requestId).toBe('high');
      expect(sortedCache).not.toBeNull();

      const secondSnapshot = queue.getWaiting();
      expect(queue['waiting']['sortedCache']).toBe(sortedCache);
      expect(secondSnapshot[0].config.__axiosRetryer?.requestId).toBe('high');

      queue.enqueue({ url: '/critical', __axiosRetryer: { priority: 4, timestamp: 3, requestId: 'critical' } });
      expect(queue['waiting']['sortedCache']).toBeNull();
    });
  });

  describe('T-029: eqeqeq suppressions removed', () => {
    test('should still eject token refresh interceptors when ids are present', async () => {
      const axiosInstance = axios.create();
      const manager = new RetryManager({ axiosInstance, retries: 0, debug: false });
      const plugin = new TokenRefreshPlugin(async () => ({ token: 'token' }));

      manager.use(plugin);
      expect(() => manager.unuse('TokenRefreshPlugin')).not.toThrow();
      manager.destroy();
    });
  });
});
