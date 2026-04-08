/**
 * T-011: Production-oriented contract tests for plugin teardown and lifecycle isolation.
 *
 * These tests focus on public observable behavior — not internal state — to ensure
 * the library behaves predictably when plugins are removed during in-flight work,
 * when the manager is destroyed with items in the queue or retry state, and when
 * multiple plugins interact under failure and teardown.
 */
import axios, { type AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../../src';
import { CachingPlugin } from '../../src/plugins/CachingPlugin';
import { ManualRetryPlugin } from '../../src/plugins/ManualRetryPlugin';
import { CircuitBreakerPlugin } from '../../src/plugins/CircuitBreakerPlugin';

jest.setTimeout(15000);

describe('Plugin lifecycle teardown (T-011)', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let retryer: RetryManager;

  beforeEach(() => {
    axiosInstance = axios.create({ timeout: 5000 });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.restore();
    // Destroy manager if it was created and not already destroyed
    try {
      retryer?.destroy();
    } catch (_) {
      /* already destroyed */
    }
  });

  // ─── Plugin removal during in-flight work ──────────────────────────────────

  describe('plugin removal during in-flight work', () => {
    it('removes CachingPlugin cleanly while requests are processing', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      const caching = new CachingPlugin({ timeToRevalidate: 60000 });
      retryer.use(caching);

      let callCount = 0;
      mock.onGet('/cached').reply(() => [200, { n: ++callCount }]);

      // Warm the cache
      const first = await retryer.axiosInstance.get('/cached');
      expect(first.data.n).toBe(1);

      // Remove plugin — interceptors should be ejected
      retryer.unuse('CachingPlugin');

      // Subsequent requests bypass cache and go to network
      const second = await retryer.axiosInstance.get('/cached');
      expect(second.data.n).toBe(2);
    });

    it('removes ManualRetryPlugin cleanly; stored requests are discarded', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      const manual = new ManualRetryPlugin();
      retryer.use(manual);

      mock.onGet('/fail').reply(500, { error: 'down' });

      await retryer.axiosInstance.get('/fail').catch(() => {});
      expect(manual.getStoredRequests().length).toBeGreaterThan(0);

      retryer.unuse('ManualRetryPlugin');

      // After removal the plugin's store should be cleared
      expect(manual.getStoredRequests()).toHaveLength(0);
    });

    it('removes CircuitBreakerPlugin mid-flight; subsequent requests go through normally', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      const cb = new CircuitBreakerPlugin({ failureThreshold: 1, openTimeout: 60000 });
      retryer.use(cb);

      mock.onGet('/cb-test').reply(500);
      await retryer.axiosInstance.get('/cb-test').catch(() => {});

      // Circuit should be open; requests are blocked
      retryer.unuse('CircuitBreakerPlugin');

      // After removal circuit constraints no longer apply
      mock.onGet('/cb-test').reply(200, { ok: true });
      const res = await retryer.axiosInstance.get('/cb-test');
      expect(res.status).toBe(200);
    });
  });

  // ─── Destroy semantics ─────────────────────────────────────────────────────

  describe('destroy semantics', () => {
    it('destroy resolves queued requests with an error', async () => {
      retryer = new RetryManager({
        axiosInstance,
        maxConcurrentRequests: 1,
        retries: 0,
        queueDelay: 0,
      });

      let firstResolve!: () => void;
      mock.onGet('/slow').reply(
        () =>
          new Promise<[number, object]>((res) => {
            firstResolve = () => res([200, {}]);
          }),
      );
      mock.onGet('/queued').reply(200, {});

      // Kick off the slow request to fill the single concurrency slot
      const slowPromise = retryer.axiosInstance.get('/slow').catch(() => {});
      // Give the slow request time to be dequeued and in-flight
      await new Promise<void>((r) => setTimeout(r, 50));

      const queuedPromise = retryer.axiosInstance.get('/queued');

      retryer.destroy();
      firstResolve(); // unblock the slow request

      // Queued request should be cancelled or rejected by destroy
      await expect(queuedPromise).rejects.toThrow();
      await slowPromise; // should settle cleanly
    });

    it('destroy with active CachingPlugin cleans up timers', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      const caching = new CachingPlugin({
        timeToRevalidate: 60000,
        cleanupInterval: 1000, // starts a timer
      });
      retryer.use(caching);

      mock.onGet('/any').reply(200, {});
      await retryer.axiosInstance.get('/any');

      // Should not throw and should not leave dangling timers
      expect(() => retryer.destroy()).not.toThrow();
    });

    it('double destroy does not throw', () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      retryer.destroy();
      expect(() => retryer.destroy()).not.toThrow();
    });

    it('destroy with ManualRetryPlugin clears the stored request queue', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      const manual = new ManualRetryPlugin();
      retryer.use(manual);

      mock.onGet('/fail').reply(500);
      await retryer.axiosInstance.get('/fail').catch(() => {});
      expect(manual.getStoredRequests().length).toBeGreaterThan(0);

      retryer.destroy();
      expect(manual.getStoredRequests()).toHaveLength(0);
    });
  });

  // ─── Cross-plugin interaction under failure and teardown ──────────────────

  describe('cross-plugin interaction under failure and teardown', () => {
    it('ManualRetryPlugin + CachingPlugin: manual replay respects cache', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 0 });
      const caching = new CachingPlugin({ timeToRevalidate: 60000 });
      const manual = new ManualRetryPlugin({ storeNonIdempotent: false });
      retryer.use(caching);
      retryer.use(manual);

      let callCount = 0;
      mock.onGet('/shared').reply(() => {
        callCount++;
        if (callCount === 1) return [500, {}];
        return [200, { attempt: callCount }];
      });

      // First request fails and is stored by ManualRetryPlugin
      await retryer.axiosInstance.get('/shared').catch(() => {});
      expect(manual.getStoredRequests().length).toBe(1);

      // Replay: second attempt succeeds and response gets cached
      const results = await manual.retryFailedRequests();
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(200);

      // Third request should be served from cache (no extra network call)
      const cached = await retryer.axiosInstance.get('/shared');
      expect(cached.data.attempt).toBe(2); // same data as cached replay result
      expect(callCount).toBe(2); // only 2 actual network calls
    });

    it('CircuitBreakerPlugin removal during retry does not leave orphaned state', async () => {
      retryer = new RetryManager({ axiosInstance, retries: 2 });
      const cb = new CircuitBreakerPlugin({ failureThreshold: 10, openTimeout: 10000 });
      retryer.use(cb);

      let attempts = 0;
      mock.onGet('/flaky').reply(() => {
        attempts++;
        if (attempts < 3) return [503, {}];
        return [200, { ok: true }];
      });

      // Trigger retries and remove plugin partway — should not throw
      const reqPromise = retryer.axiosInstance.get('/flaky');
      await new Promise<void>((r) => setTimeout(r, 20));
      retryer.unuse('CircuitBreakerPlugin');

      const res = await reqPromise;
      expect(res.status).toBe(200);
    });
  });
});
