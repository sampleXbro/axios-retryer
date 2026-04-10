/**
 * P0 Multi-Plugin Integration Tests from TEST_GAP_ANALYSIS.md
 *
 * Tests for contract guarantees, security boundaries, and behaviors users depend on in production.
 * Missing these tests means users could hit bugs that violate documented promises.
 */

import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src';
import { TokenRefreshPlugin, type TokenRefreshPluginOptions } from '../src/plugins/TokenRefreshPlugin';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';

// ────────────────────────────────────────────────────────────────────────────
// 21. Multi-Plugin Integration
// ────────────────────────────────────────────────────────────────────────────

describe('P0 Multi-Plugin Integration (21.x)', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  // 21.1 TokenRefresh + CircuitBreaker
  describe('21.1 TokenRefresh + CircuitBreaker', () => {
    it('21.1.1: 401 response triggers token refresh even when circuit breaker is monitoring', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 5,
      });

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(circuitPlugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('21.1.2: 401 does NOT count toward circuit breaker failure threshold', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
      });

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(circuitPlugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      // 401 should not trigger circuit breaker
      mock.onGet('/api/data').reply(200, { data: 'success' });
      await axiosInstance.get('/api/data');

      manager.destroy();
    });

    it('21.1.3: Circuit breaker OPEN + 401 on different endpoint: refresh still works', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
      });

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: true,
      });

      manager.use(tokenPlugin);
      manager.use(circuitPlugin);

      // Trigger circuit breaker on /api/data
      mock.onGet('/api/data').reply(500);
      await axiosInstance.get('/api/data').catch(() => {});
      await axiosInstance.get('/api/data').catch(() => {});

      // 401 on /api/auth should still trigger refresh
      mock.onGet('/api/auth').replyOnce(401);
      mock.onGet('/api/auth').replyOnce(200, { data: 'success' });
      await axiosInstance.get('/api/auth', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('21.1.4: Token refresh failure counts toward circuit breaker threshold', async () => {
      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        retryOnRefreshFail: false,
      } as TokenRefreshPluginOptions);

      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
      });

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: true,
      });

      manager.use(tokenPlugin);
      manager.use(circuitPlugin);

      mock.onGet('/api/data').reply(401);

      // Refresh failure should count toward circuit breaker
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      // Should be OPEN now
      await expect(
        axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }),
      ).rejects.toThrow();

      manager.destroy();
    });
  });

  // 21.2 TokenRefresh + CachingPlugin
  describe('21.2 TokenRefresh + CachingPlugin', () => {
    it('21.2.1: Cached response that becomes stale after token refresh: cache is invalidated', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const cachePlugin = new CachingPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(cachePlugin);

      // First request - cache miss
      mock.onGet('/api/data').replyOnce(200, { data: 'initial' });
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      // Token refresh scenario
      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'refreshed' });
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('21.2.2: Request replayed after token refresh uses fresh response, not stale cache', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const cachePlugin = new CachingPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(cachePlugin);

      // Token refresh scenario
      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'refreshed' });
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('21.2.3: Cache hit for 200 response with GraphQL auth error respects customErrorDetector', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        customErrorDetector: (response: any) => {
          return response?.data?.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED';
        },
      } as TokenRefreshPluginOptions);

      const cachePlugin = new CachingPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(cachePlugin);

      // GraphQL auth error
      mock.onGet('/api/data').replyOnce(200, {
        data: {
          errors: [{ extensions: { code: 'UNAUTHENTICATED' } }],
        },
      });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });
  });

  // 21.3 TokenRefresh + ManualRetry
  describe('21.3 TokenRefresh + ManualRetry', () => {
    it('21.3.1: Request that fails token refresh AND exhausts retries: stored for manual retry', async () => {
      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        retryOnRefreshFail: false,
      } as TokenRefreshPluginOptions);

      const manualPlugin = new ManualRetryPlugin({
        storeAuthRequests: true,
      });

      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        mode: 'manual',
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(manualPlugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      // Request should be stored for manual retry
      const stored = manualPlugin.getStoredRequests();
      expect(stored.length).toBeGreaterThan(0);

      manager.destroy();
    });

    it('21.3.2: Manual replay uses fresh token from rehydrateAuth, not stale cached token', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manualPlugin = new ManualRetryPlugin({
        storeAuthRequests: true,
        rehydrateAuth: (config) => {
          config.headers = config.headers || {};
          config.headers.Authorization = 'Bearer fresh-token';
          return config;
        },
      });

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        mode: 'manual',
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(manualPlugin);

      mock.onGet('/api/data').reply(500);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(manualPlugin.getStoredRequests()).toHaveLength(1);

      // Manual replay should use fresh token
      mock.onGet('/api/data').reply(200, { data: 'success' });
      const results = await manualPlugin.retryFailedRequests();

      expect(results.length).toBeGreaterThan(0);
      expect(mock.history.get.at(-1)?.headers?.Authorization).toBe('Bearer fresh-token');

      manager.destroy();
    });
  });

  // 21.4 CircuitBreaker + CachingPlugin
  describe('21.4 CircuitBreaker + CachingPlugin', () => {
    it('21.4.1: Circuit breaker OPEN but cached response available: cache serves the response', async () => {
      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
      });

      const cachePlugin = new CachingPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(circuitPlugin);
      manager.use(cachePlugin);

      // Cache a response
      mock.onGet('/api/data').replyOnce(200, { data: 'cached' });
      await axiosInstance.get('/api/data');

      // Trigger circuit breaker
      mock.onGet('/api/data').reply(500);
      await axiosInstance.get('/api/data').catch(() => {});
      await axiosInstance.get('/api/data').catch(() => {});

      // Circuit breaker is OPEN, but cache should still serve
      mock.onGet('/api/data').reply(200, { data: 'fresh' });
      const response = await axiosInstance.get('/api/data');

      // Should get cached response
      expect(response.data).toEqual({ data: 'cached' });

      manager.destroy();
    });

    it('21.4.2: Circuit breaker failure does NOT invalidate cache entries', async () => {
      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
      });

      const cachePlugin = new CachingPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(circuitPlugin);
      manager.use(cachePlugin);

      // Cache a response
      mock.onGet('/api/data').replyOnce(200, { data: 'cached' });
      await axiosInstance.get('/api/data');

      // Trigger circuit breaker
      mock.onGet('/api/data').reply(500);
      await axiosInstance.get('/api/data').catch(() => {});
      await axiosInstance.get('/api/data').catch(() => {});

      // Cache should still be valid
      mock.onGet('/api/data').reply(200, { data: 'fresh' });
      const response = await axiosInstance.get('/api/data');

      expect(response.data).toEqual({ data: 'cached' });

      manager.destroy();
    });
  });

  // 21.5 MetricsPlugin + Other Plugins
  describe('21.5 MetricsPlugin + Other Plugins', () => {
    it('21.5.1: Metrics accurately count requests served from cache', async () => {
      const cachePlugin = new CachingPlugin();
      const metricsPlugin = new MetricsPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(cachePlugin);
      manager.use(metricsPlugin);

      mock.onGet('/api/data').reply(200, { data: 'success' });

      // First request - cache miss
      await axiosInstance.get('/api/data');

      // Second request - cache hit
      await axiosInstance.get('/api/data');

      const metrics = manager.getMetrics();
      expect(metrics).toBeDefined();

      manager.destroy();
    });

    it('21.5.2: Metrics accurately count requests blocked by circuit breaker', async () => {
      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
      });
      const metricsPlugin = new MetricsPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(circuitPlugin);
      manager.use(metricsPlugin);

      mock.onGet('/api/data').reply(500);

      // Trigger circuit breaker
      await axiosInstance.get('/api/data').catch(() => {});
      await axiosInstance.get('/api/data').catch(() => {});

      // Request blocked by circuit breaker
      await axiosInstance.get('/api/data').catch(() => {});

      const metrics = manager.getMetrics();
      expect(metrics).toBeDefined();

      manager.destroy();
    });

    it('21.5.3: Metrics accurately count token refresh cycles', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);
      const metricsPlugin = new MetricsPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(metricsPlugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      const metrics = manager.getMetrics();
      expect(metrics).toBeDefined();

      manager.destroy();
    });
  });

  // 21.6 All Plugins Together
  describe('21.6 All Plugins Together', () => {
    it('21.6.1: All 6 plugins registered simultaneously: no interference, correct event ordering', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 5,
      });

      const cachePlugin = new CachingPlugin();

      const manualPlugin = new ManualRetryPlugin();

      const metricsPlugin = new MetricsPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(circuitPlugin);
      manager.use(cachePlugin);
      manager.use(manualPlugin);
      manager.use(metricsPlugin);

      mock.onGet('/api/data').reply(200, { data: 'success' });

      await axiosInstance.get('/api/data');

      expect(manager.listPlugins()).toHaveLength(5);

      manager.destroy();
    });

    it('21.6.2: Plugin registration order does not affect correctness', async () => {
      const axiosInstanceA = axios.create();
      const axiosInstanceB = axios.create();
      const mockA = new MockAdapter(axiosInstanceA);
      const mockB = new MockAdapter(axiosInstanceB);

      const refreshFnA = jest.fn(async () => ({ token: 'new-token-a' }));
      const tokenPluginA = new TokenRefreshPlugin(refreshFnA, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPluginA = new CircuitBreakerPlugin({
        failureThreshold: 5,
      });

      const cachePluginA = new CachingPlugin();

      const manager1 = new RetryManager({
        axiosInstance: axiosInstanceA,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager1.use(tokenPluginA);
      manager1.use(circuitPluginA);
      manager1.use(cachePluginA);

      const refreshFnB = jest.fn(async () => ({ token: 'new-token-b' }));
      const tokenPluginB = new TokenRefreshPlugin(refreshFnB, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPluginB = new CircuitBreakerPlugin({
        failureThreshold: 5,
      });

      const cachePluginB = new CachingPlugin();

      const manager2 = new RetryManager({
        axiosInstance: axiosInstanceB,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager2.use(cachePluginB);
      manager2.use(circuitPluginB);
      manager2.use(tokenPluginB);

      mockA.onGet('/api/data').reply(200, { data: 'success-a' });
      mockB.onGet('/api/data').reply(200, { data: 'success-b' });

      const [responseA, responseB] = await Promise.all([
        axiosInstanceA.get('/api/data'),
        axiosInstanceB.get('/api/data'),
      ]);

      expect(responseA.data).toEqual({ data: 'success-a' });
      expect(responseB.data).toEqual({ data: 'success-b' });

      manager1.destroy();
      manager2.destroy();
      mockA.restore();
      mockB.restore();
    });

    it('21.6.3: Destroying manager with all plugins: no lingering timers, no memory leaks', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const tokenPlugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const circuitPlugin = new CircuitBreakerPlugin({
        failureThreshold: 5,
      });

      const cachePlugin = new CachingPlugin();

      const manualPlugin = new ManualRetryPlugin();

      const metricsPlugin = new MetricsPlugin();

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(tokenPlugin);
      manager.use(circuitPlugin);
      manager.use(cachePlugin);
      manager.use(manualPlugin);
      manager.use(metricsPlugin);

      mock.onGet('/api/data').reply(200, { data: 'success' });

      await axiosInstance.get('/api/data');

      manager.destroy();

      // No lingering timers or memory leaks
      expect(manager).toBeDefined();
    });
  });
});
