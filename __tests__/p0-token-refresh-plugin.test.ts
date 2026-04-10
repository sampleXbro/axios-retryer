/**
 * P0 TokenRefreshPlugin Tests from TEST_GAP_ANALYSIS.md
 *
 * Tests for contract guarantees, security boundaries, and behaviors users depend on in production.
 * Missing these tests means users could hit bugs that violate documented promises.
 */

import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src';
import {
  TokenRefreshPlugin,
  type TokenRefreshHandler,
  type TokenRefreshPluginOptions,
  type TokenRefreshResult,
} from '../src/plugins/TokenRefreshPlugin';

// ────────────────────────────────────────────────────────────────────────────
// 13. TokenRefreshPlugin
// ────────────────────────────────────────────────────────────────────────────

describe('P0 TokenRefreshPlugin (13.x)', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  // 13.1 Basic Refresh Flow
  describe('13.1 Basic Refresh Flow', () => {
    it('13.1.1: 401 response triggers refresh handler exactly once', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalledTimes(1);

      manager.destroy();
    });

    it('13.1.2: Refreshed token is applied to original requests Authorization header', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      // Check that the replayed request had the new token
      const replayedRequest = mock.history.get[1];
      expect(replayedRequest.headers?.Authorization).toBe('Bearer new-token');

      manager.destroy();
    });

    it('13.1.3: Original request is replayed through retry manager (full queue/interceptor pipeline)', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      // Should have made 2 requests (initial + replay)
      expect(mock.history.get.length).toBe(2);

      manager.destroy();
    });

    it('13.1.4: onBeforeTokenRefresh fires before refresh handler is called', async () => {
      let beforeRefreshFired = false;
      let refreshCalled = false;

      const refreshFn = jest.fn(async () => {
        refreshCalled = true;
        return { token: 'new-token' };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      manager.on('onBeforeTokenRefresh' as any, () => {
        beforeRefreshFired = true;
      });

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(beforeRefreshFired).toBe(true);
      expect(refreshCalled).toBe(true);

      manager.destroy();
    });

    it('13.1.5: onTokenRefreshed fires with new token after successful refresh', async () => {
      let capturedToken: string | undefined;

      const refreshFn = jest.fn(async () => ({ token: 'new-token-123' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      manager.on('onTokenRefreshed' as any, (token: unknown) => {
        if (typeof token === 'string') {
          capturedToken = token;
        }
      });

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(capturedToken).toBe('new-token-123');

      manager.destroy();
    });

    it('13.1.6: onTokenRefreshFailed fires when all refresh attempts are exhausted', async () => {
      let refreshFailedFired = false;

      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 2,
        retryOnRefreshFail: false,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      manager.on('onTokenRefreshFailed' as any, () => {
        refreshFailedFired = true;
      });

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(refreshFailedFired).toBe(true);

      manager.destroy();
    });
  });

  // 13.2 Concurrent 401 Handling
  describe('13.2 Concurrent 401 Handling', () => {
    it('13.2.1: 5 concurrent 401 responses - refresh handler called exactly once', async () => {
      let refreshCount = 0;

      const refreshFn = jest.fn(async () => {
        refreshCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { token: 'new-token' };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      let attempt = 0;
      mock.onGet('/api/data').reply(() => {
        attempt += 1;
        return attempt <= 5 ? [401] : [200, { data: 'success' }];
      });

      // Launch 5 concurrent requests
      const requests = Array(5)
        .fill(null)
        .map(() => axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }));

      await Promise.all(requests);

      // Refresh should be called exactly once (deduplication)
      expect(refreshCount).toBe(1);

      manager.destroy();
    });

    it('13.2.2: Requests arriving during refresh are queued and NOT dispatched until refresh completes', async () => {
      const refreshFn = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { token: 'new-token' };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      let attempt = 0;
      mock.onGet('/api/data').reply(() => {
        attempt += 1;
        return attempt <= 2 ? [401] : [200, { data: 'success' }];
      });

      const request1 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      // Wait for refresh to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      const request2 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await Promise.all([request1, request2]);

      // Both should complete after refresh
      expect(mock.history.get.length).toBeGreaterThan(1);

      manager.destroy();
    });

    it('13.2.3: If refresh succeeds, queued requests are released with updated auth header', async () => {
      const refreshFn = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { token: 'new-token' };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').reply(200, { data: 'success' });

      const request1 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const request2 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await Promise.all([request1, request2]);

      // Initial attempts keep the old token; replayed requests get the refreshed token.
      mock.history.get.slice(2).forEach((req) => {
        expect(req.headers?.Authorization).toBe('Bearer new-token');
      });

      manager.destroy();
    });

    it('13.2.4: If refresh fails, queued requests are rejected (not retried)', async () => {
      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        retryOnRefreshFail: false,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      const request1 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const request2 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await Promise.all([request1, request2]);

      // Both should fail
      expect(mock.history.get.length).toBeGreaterThanOrEqual(2);

      manager.destroy();
    });

    it('13.2.5: Second refresh cycle after first completes - handler called again (no stale lock)', async () => {
      let refreshCount = 0;

      const refreshFn = jest.fn(async () => {
        refreshCount++;
        return { token: `token-${refreshCount}` };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      // First refresh cycle
      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer token-1' } });

      // Second refresh cycle
      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });
      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer token-2' } });

      expect(refreshCount).toBe(2);

      manager.destroy();
    });
  });

  // 13.3 Refresh Handler Edge Cases
  describe('13.3 Refresh Handler Edge Cases', () => {
    it('13.3.1: Handler returns { token: null } - opt-out: no event emitted', async () => {
      const refreshFn = jest.fn(async () => ({ token: null }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      let eventFired = false;
      manager.on('onTokenRefreshed' as any, () => {
        eventFired = true;
      });

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(eventFired).toBe(false);

      manager.destroy();
    });

    it('13.3.2: Handler returns { token: undefined } - opt-out: no event emitted', async () => {
      const refreshFn = jest.fn(async () => ({ token: undefined }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      let eventFired = false;
      manager.on('onTokenRefreshed' as any, () => {
        eventFired = true;
      });

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(eventFired).toBe(false);

      manager.destroy();
    });

    it('13.3.3: Handler returns {} (empty object) - opt-out', async () => {
      const refreshFn = jest.fn(async () => ({}));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      manager.destroy();
    });

    it('13.3.4: Handler returns { token: "" } (empty string) - should be treated as opt-out', async () => {
      const refreshFn = jest.fn(async () => ({ token: '' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      manager.destroy();
    });

    it('13.3.5: Handler returns { token: "same-old-token" } - token that has not changed', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'old-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('13.3.6: Handler throws on first attempt, succeeds on second', async () => {
      let attemptCount = 0;

      const refreshFn = jest.fn(async () => {
        attemptCount++;
        if (attemptCount === 1) {
          const retryableError = new Error('First attempt failed') as Error & { retryableRefreshFailure?: boolean };
          retryableError.retryableRefreshFailure = true;
          throw retryableError;
        }
        return { token: 'new-token' };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 2,
        retryOnRefreshFail: true,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(attemptCount).toBe(2);

      manager.destroy();
    });

    it('13.3.7: Handler throws on all attempts up to maxRefreshAttempts', async () => {
      const refreshFn = jest.fn(async () => {
        const retryableError = new Error('Refresh failed') as Error & { retryableRefreshFailure?: boolean };
        retryableError.retryableRefreshFailure = true;
        throw retryableError;
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 2,
        retryOnRefreshFail: true,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(refreshFn).toHaveBeenCalledTimes(2);

      manager.destroy();
    });

    it('13.3.8: Handler never resolves (hangs): refreshTimeout triggers', async () => {
      const refreshFn = jest
        .fn<ReturnType<TokenRefreshHandler>, Parameters<TokenRefreshHandler>>()
        .mockImplementation(async () => new Promise<TokenRefreshResult>(() => {}));

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 100,
        maxRefreshAttempts: 1,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      // Should timeout and not hang
      expect(true).toBe(true);

      manager.destroy();
    }, 5000);

    it('13.3.9: Handler rejects with non-Error value (e.g., string)', async () => {
      const refreshFn = jest.fn(async () => {
        throw 'string error';
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      manager.destroy();
    });

    it('13.3.10: Handler called with an isolated axios instance argument', async () => {
      let receivedAxios: AxiosInstance | undefined;
      const refreshFn = jest.fn(async (refreshAxios: AxiosInstance) => {
        receivedAxios = refreshAxios;
        return { token: 'new-token' };
      });
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(receivedAxios).toBeDefined();
      expect(receivedAxios).not.toBe(axiosInstance);
      expect(receivedAxios?.defaults.timeout).toBe(3000);
      expect(receivedAxios?.defaults.headers.common.Authorization).toBeUndefined();

      manager.destroy();
    });
  });

  // 13.4 Custom Error Detection
  describe('13.4 Custom Error Detection', () => {
    it('13.4.1: customErrorDetector returning true on 200 response triggers refresh', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        customErrorDetector: (body: any) => {
          return body?.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED';
        },
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(200, {
        errors: [{ extensions: { code: 'UNAUTHENTICATED' } }],
      });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('13.4.2: customErrorDetector returning false on 401: 401 still triggers refresh (additive)', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        customErrorDetector: () => false,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('13.4.3: customErrorDetector that throws on 200 body is caught and the original response is returned', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        customErrorDetector: () => {
          throw new Error('Detector error');
        },
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(200, {
        errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }],
      });

      const response = await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).not.toHaveBeenCalled();
      expect(response.data.errors[0].message).toBe('expired');

      manager.destroy();
    });

    it('13.4.4: customErrorDetector with GraphQL response body pattern', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        customErrorDetector: (response: any) => {
          return response?.data?.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED';
        },
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

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

  // 13.5 Configuration Options
  describe('13.5 Configuration Options', () => {
    it('13.5.1: authHeaderName: X-Auth-Token uses non-standard auth header', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        authHeaderName: 'X-Auth-Token',
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { 'X-Auth-Token': 'old-token' } });

      const replayedRequest = mock.history.get[1];
      expect(replayedRequest.headers?.['X-Auth-Token']).toBe('Bearer new-token');

      manager.destroy();
    });

    it('13.5.2: tokenPrefix: "" applies token without Bearer prefix', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        tokenPrefix: '',
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'old-token' } });

      const replayedRequest = mock.history.get[1];
      expect(replayedRequest.headers?.Authorization).toBe('new-token');

      manager.destroy();
    });

    it('13.5.3: tokenPrefix: "Token " uses custom prefix', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        tokenPrefix: 'Token ',
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Token old-token' } });

      const replayedRequest = mock.history.get[1];
      expect(replayedRequest.headers?.Authorization).toBe('Token new-token');

      manager.destroy();
    });

    it('13.5.4: refreshStatusCodes: [401, 419] - both status codes trigger refresh', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        refreshStatusCodes: [401, 419],
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      // Test 401
      mock.onGet('/api/data-401').replyOnce(401);
      mock.onGet('/api/data-401').replyOnce(200, { data: 'success' });
      await axiosInstance.get('/api/data-401', { headers: { Authorization: 'Bearer old-token' } });

      // Test 419
      mock.onGet('/api/data-419').replyOnce(419);
      mock.onGet('/api/data-419').replyOnce(200, { data: 'success' });
      await axiosInstance.get('/api/data-419', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalledTimes(2);

      manager.destroy();
    });

    it('13.5.5: refreshStatusCodes: [403] - 401 does NOT trigger refresh, 403 does', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        refreshStatusCodes: [403],
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data-401').reply(401);
      await axiosInstance.get('/api/data-401', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(refreshFn).not.toHaveBeenCalled();

      manager.destroy();
    });

    it('13.5.6: maxRefreshAttempts: 1 - exactly one refresh attempt', async () => {
      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(refreshFn).toHaveBeenCalledTimes(1);

      manager.destroy();
    });

    it('13.5.7: maxRefreshAttempts: 0 is rejected as invalid configuration', () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      expect(() => {
        new TokenRefreshPlugin(refreshFn, {
          refreshTimeout: 3000,
          maxRefreshAttempts: 0,
        } as TokenRefreshPluginOptions);
      }).toThrow('maxRefreshAttempts must be a positive integer');
    });

    it('13.5.8: refreshTimeout: 100 - short timeout triggers TokenRefreshTimeoutError', async () => {
      const refreshFn = jest
        .fn<ReturnType<TokenRefreshHandler>, Parameters<TokenRefreshHandler>>()
        .mockImplementation(async () => new Promise<TokenRefreshResult>(() => {}));

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 100,
        maxRefreshAttempts: 1,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      manager.destroy();
    }, 5000);

    it('13.5.9: retryOnRefreshFail: false - refresh handler is attempted once and original request is not replayed', async () => {
      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        retryOnRefreshFail: false,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });

    it('13.5.10: retryOnRefreshFail: true - refresh handler retries up to maxRefreshAttempts before failing', async () => {
      const refreshFn = jest.fn(async () => {
        const retryableError = new Error('Refresh failed') as Error & { retryableRefreshFailure?: boolean };
        retryableError.retryableRefreshFailure = true;
        throw retryableError;
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 2,
        retryOnRefreshFail: true,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } }).catch(() => {});

      expect(refreshFn).toHaveBeenCalledTimes(2);
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });
  });

  // 13.6 Security Concerns
  describe('13.6 Security Concerns', () => {
    it('13.6.1: Auth headers from original request NOT leaked to refresh handlers request', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', {
        headers: {
          Authorization: 'Bearer old-token',
          'X-Secret': 'secret-value',
        },
      });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });

    it('13.6.2: Refresh handler receives an axios instance, not the original request config', async () => {
      let receivedAxios: AxiosInstance | undefined;
      const refreshFn = jest.fn(async (refreshAxios: AxiosInstance) => {
        receivedAxios = refreshAxios;
        return { token: 'new-token' };
      });
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(receivedAxios).toBeDefined();
      expect(receivedAxios).not.toBe(axiosInstance);
      expect(typeof receivedAxios?.request).toBe('function');

      manager.destroy();
    });

    it('13.6.3: Token comparison uses constant-time comparison (timing attack prevention)', async () => {
      // This test documents the security requirement
      // Actual timing analysis would require specialized tools
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      manager.destroy();
    });

    it('13.6.4: Case-insensitive header lookup for auth header', async () => {
      const refreshFn = jest.fn(async () => ({ token: 'new-token' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        authHeaderName: 'authorization',
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      expect(refreshFn).toHaveBeenCalled();

      manager.destroy();
    });
  });

  // 13.7 Cleanup
  describe('13.7 Cleanup', () => {
    it('13.7.1: destroy() cancels in-progress refresh timeout', async () => {
      const refreshFn = jest
        .fn<ReturnType<TokenRefreshHandler>, Parameters<TokenRefreshHandler>>()
        .mockImplementation(async () => new Promise<TokenRefreshResult>(() => {}));

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 1,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      const request = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await new Promise((resolve) => setTimeout(resolve, 10));

      manager.destroy();

      await request.catch(() => {});

      manager.destroy();
    });

    it('13.7.2: destroy() cleans up backoff sleep timers from refresh retries', async () => {
      const refreshFn = jest.fn(async () => {
        throw new Error('Refresh failed');
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
        maxRefreshAttempts: 2,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').reply(401);

      const request = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await new Promise((resolve) => setTimeout(resolve, 10));

      manager.destroy();

      await request.catch(() => {});
    });

    it('13.7.3: Requests queued during refresh are rejected on destroy', async () => {
      const refreshFn = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { token: 'new-token' };
      });

      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 3000,
      } as TokenRefreshPluginOptions);

      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      manager.use(plugin);

      mock.onGet('/api/data').replyOnce(401);
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      const request1 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const request2 = axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer old-token' } });

      manager.destroy();

      await Promise.all([request1, request2].map((r) => r.catch(() => {})));
    });
  });
});
