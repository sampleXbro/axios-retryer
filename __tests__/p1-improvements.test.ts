import axios, { AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src/core/RetryManager';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin/TokenRefreshPlugin';
import { CachingPlugin } from '../src/plugins/CachingPlugin/CachingPlugin';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin';
import { DefaultRetryStrategy } from '../src/core/strategies/DefaultRetryStrategy';
import { AXIOS_RETRYER_BACKOFF_TYPES } from '../src/types';

describe('P1 Improvements', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({ baseURL: 'http://test.local', timeout: 5000 });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
  });

  // ─── T-006: Sandbox TokenRefreshPlugin axios instance ───────────────────────

  describe('T-006: Sandbox TokenRefreshPlugin axios instance', () => {
    it('should create a minimal refresh axios instance without inheriting parent headers', () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
      });

      // Set custom headers on the main instance that should NOT leak
      axiosInstance.defaults.headers.common['Authorization'] = 'Bearer stale-token';
      axiosInstance.defaults.headers.common['X-Custom-Header'] = 'should-not-leak';

      let capturedRefreshAxios: AxiosInstance | null = null;

      const plugin = new TokenRefreshPlugin(
        async (refreshAxios) => {
          capturedRefreshAxios = refreshAxios;
          return { token: 'new-token' };
        },
        { refreshStatusCodes: [401] },
      );

      manager.use(plugin);

      // Trigger a 401 to start refresh flow
      mock.onGet('/test').replyOnce(401);
      mock.onGet('/test').reply(200, { ok: true });

      return manager.axiosInstance.get('/test').then(() => {
        expect(capturedRefreshAxios).not.toBeNull();
        // The sandboxed instance should NOT have inherited auth headers
        const refreshDefaults = capturedRefreshAxios!.defaults;
        expect(refreshDefaults.headers?.common?.['Authorization']).toBeUndefined();
        expect(refreshDefaults.headers?.common?.['X-Custom-Header']).toBeUndefined();
        // But it should have the baseURL
        expect(refreshDefaults.baseURL).toBe('http://test.local');
        manager.destroy();
      });
    });
  });

  // ─── T-007: Add backoff between token refresh retries ───────────────────────

  describe('T-007: Token refresh backoff', () => {
    it('should add exponential backoff delay between refresh retries', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
      });

      const attemptTimestamps: number[] = [];
      let attempt = 0;

      const plugin = new TokenRefreshPlugin(
        async (_axiosInst) => {
          attemptTimestamps.push(Date.now());
          attempt++;
          if (attempt < 3) {
            throw Object.assign(new Error('Refresh failed'), {
              response: { status: 500 },
              isAxiosError: true,
            });
          }
          return { token: 'good-token' };
        },
        {
          refreshStatusCodes: [401],
          maxRefreshAttempts: 3,
          retryOnRefreshFail: true,
          refreshTimeout: 5000,
        },
      );

      manager.use(plugin);

      mock.onGet('/test').replyOnce(401);
      mock.onGet('/test').reply(200, { ok: true });

      await manager.axiosInstance.get('/test');

      expect(attemptTimestamps.length).toBe(3);

      // Between attempt 1 and 2: ~1000ms backoff
      const gap1 = attemptTimestamps[1] - attemptTimestamps[0];
      expect(gap1).toBeGreaterThanOrEqual(900); // Allow 100ms tolerance

      // Between attempt 2 and 3: ~2000ms backoff
      const gap2 = attemptTimestamps[2] - attemptTimestamps[1];
      expect(gap2).toBeGreaterThanOrEqual(1800); // Allow 200ms tolerance

      manager.destroy();
    }, 15000);
  });

  // ─── T-008: CachingPlugin LRU eviction O(1) ────────────────────────────────

  describe('T-008: CachingPlugin LRU eviction', () => {
    it('should evict least recently used entry when cache is full', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
      });

      const cachingPlugin = new CachingPlugin({
        maxItems: 3,
        cacheMethods: ['GET'],
      });

      manager.use(cachingPlugin);

      // Fill cache with 3 items
      mock.onGet('/a').reply(200, { data: 'a' });
      mock.onGet('/b').reply(200, { data: 'b' });
      mock.onGet('/c').reply(200, { data: 'c' });

      await manager.axiosInstance.get('/a');
      await manager.axiosInstance.get('/b');
      await manager.axiosInstance.get('/c');

      expect(cachingPlugin.getCacheStats().size).toBe(3);

      // Access /a to make it recently used (LRU touch)
      await manager.axiosInstance.get('/a');

      // Add a 4th item — should evict /b (LRU), not /a (recently touched)
      mock.onGet('/d').reply(200, { data: 'd' });
      await manager.axiosInstance.get('/d');

      expect(cachingPlugin.getCacheStats().size).toBe(3);

      // /a should still be cached (it was touched)
      let apiCalled = false;
      mock.onGet('/a').reply(() => {
        apiCalled = true;
        return [200, { data: 'a-new' }];
      });
      const respA = await manager.axiosInstance.get('/a');
      expect(apiCalled).toBe(false); // served from cache

      manager.destroy();
    });

    it('should use Set for dedup in runCacheCleanup', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
      });

      const cachingPlugin = new CachingPlugin({
        maxItems: 2,
        maxAge: 1, // 1ms — everything expires immediately
        cleanupInterval: 50,
        cacheMethods: ['GET'],
      });

      manager.use(cachingPlugin);

      mock.onGet('/x').reply(200, { data: 'x' });
      mock.onGet('/y').reply(200, { data: 'y' });
      mock.onGet('/z').reply(200, { data: 'z' });

      await manager.axiosInstance.get('/x');
      await manager.axiosInstance.get('/y');
      await manager.axiosInstance.get('/z');

      // Wait for cleanup to run
      await new Promise((r) => setTimeout(r, 100));

      // All should be cleaned up — expired by maxAge
      expect(cachingPlugin.getCacheStats().size).toBe(0);

      manager.destroy();
    });
  });

  // ─── T-009: CircuitBreaker URL normalization ────────────────────────────────

  describe('T-009: CircuitBreaker URL normalization', () => {
    it('should normalize numeric path segments to :id', () => {
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 5,
        openTimeout: 30000,
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 5,
      });

      // Access the private method via any cast for testing
      const normalize = (plugin as any)._normalizeUrl.bind(plugin);

      expect(normalize('/users/123')).toBe('/users/:id');
      expect(normalize('/users/123/posts/456')).toBe('/users/:id/posts/:id');
      expect(normalize('/api/v2/items/99')).toBe('/api/v2/items/:id');
      expect(normalize('/users')).toBe('/users');
    });

    it('should strip query strings', () => {
      const plugin = new CircuitBreakerPlugin();
      const normalize = (plugin as any)._normalizeUrl.bind(plugin);

      expect(normalize('/users/123?include=posts')).toBe('/users/:id');
      expect(normalize('/search?q=test&page=2')).toBe('/search');
    });

    it('should normalize UUID path segments to :id', () => {
      const plugin = new CircuitBreakerPlugin();
      const normalize = (plugin as any)._normalizeUrl.bind(plugin);

      expect(normalize('/users/550e8400-e29b-41d4-a716-446655440000')).toBe('/users/:id');
      expect(normalize('/items/123e4567-e89b-12d3-a456-426614174000/details')).toBe('/items/:id/details');
    });

    it('should strip hash fragments', () => {
      const plugin = new CircuitBreakerPlugin();
      const normalize = (plugin as any)._normalizeUrl.bind(plugin);

      expect(normalize('/page#section')).toBe('/page');
      expect(normalize('/users/42#profile')).toBe('/users/:id');
    });
  });

  // ─── T-010: Respect Retry-After header on 429 responses ────────────────────

  describe('T-010: Respect Retry-After header', () => {
    it('should use Retry-After seconds as minimum delay on 429', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
      });

      const startTime = Date.now();

      // First request: 429 with Retry-After: 2 (seconds)
      mock.onGet('/rate-limited').replyOnce(429, { error: 'Too Many Requests' }, { 'retry-after': '2' });
      mock.onGet('/rate-limited').reply(200, { ok: true });

      const response = await manager.axiosInstance.get('/rate-limited');

      const elapsed = Date.now() - startTime;
      expect(response.status).toBe(200);
      // Should have waited at least ~2000ms due to Retry-After
      expect(elapsed).toBeGreaterThanOrEqual(1800);

      manager.destroy();
    }, 10000);

    it('should use Retry-After HTTP-date format', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
      });

      // Set Retry-After to 2 seconds in the future as HTTP-date
      const futureDate = new Date(Date.now() + 2000).toUTCString();
      const startTime = Date.now();

      mock
        .onGet('/rate-limited-date')
        .replyOnce(429, { error: 'Too Many Requests' }, { 'retry-after': futureDate });
      mock.onGet('/rate-limited-date').reply(200, { ok: true });

      const response = await manager.axiosInstance.get('/rate-limited-date');

      const elapsed = Date.now() - startTime;
      expect(response.status).toBe(200);
      // HTTP-date values are second-precision, so serializing with toUTCString() can drop
      // up to ~999ms from the target time before Retry-After is parsed back.
      expect(elapsed).toBeGreaterThanOrEqual(900);

      manager.destroy();
    }, 10000);

    it('should fall back to normal backoff when no Retry-After header', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
      });

      const startTime = Date.now();

      mock.onGet('/server-error').replyOnce(500, { error: 'Server Error' });
      mock.onGet('/server-error').reply(200, { ok: true });

      const response = await manager.axiosInstance.get('/server-error');

      const elapsed = Date.now() - startTime;
      expect(response.status).toBe(200);
      // Without Retry-After, delay is from normal backoff (jittered, much less than 2s)
      expect(elapsed).toBeLessThan(2000);

      manager.destroy();
    }, 10000);
  });
});
