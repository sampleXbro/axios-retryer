//@ts-nocheck
import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';

import { RetryManager } from '../src';
import {
  TokenRefreshPlugin,
  TokenRefreshQueueOverflowError,
  type TokenRefreshPluginOptions,
} from '../src/plugins/TokenRefreshPlugin';

/**
 * Verifies that TokenRefreshPlugin enforces `maxQueuedRequests` and rejects overflow
 * with `TokenRefreshQueueOverflowError`. This protects against unbounded memory growth
 * (and a DoS surface) under sustained 401 conditions.
 */
describe('TokenRefreshPlugin queue cap', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let manager: RetryManager;
  let plugin: TokenRefreshPlugin;
  let refreshFn: jest.Mock;
  let releaseRefresh: ((value: { token: string }) => void) | undefined;

  const waitForAssertion = async (assertion: () => void, timeoutMs = 1000): Promise<void> => {
    const startedAt = Date.now();
    while (true) {
      try {
        assertion();
        return;
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) throw error;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };

  const buildPlugin = (overrides: Partial<TokenRefreshPluginOptions> = {}): TokenRefreshPlugin => {
    refreshFn = jest.fn(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    return new TokenRefreshPlugin(refreshFn, {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1,
      refreshTimeout: 60_000,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
      ...overrides,
    });
  };

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
    manager = new RetryManager({ axiosInstance, retries: 0, maxConcurrentRequests: 100 });
    releaseRefresh = undefined;
  });

  afterEach(() => {
    if (releaseRefresh) {
      releaseRefresh({ token: 'FRESH' });
      releaseRefresh = undefined;
    }
    mock.reset();
    mock.restore();
  });

  it('rejects requests with TokenRefreshQueueOverflowError once the queue exceeds maxQueuedRequests', async () => {
    plugin = buildPlugin({ maxQueuedRequests: 3 });
    manager.use(plugin);

    // /protected returns 401 first (triggers refresh), 200 once retried with fresh token.
    mock
      .onGet('/protected')
      .replyOnce(401)
      .onGet('/protected')
      .reply((config) =>
        config.headers?.Authorization === 'Bearer FRESH' ? [200, { ok: true }] : [401, { stale: true }],
      );
    mock.onGet(/\/queued-\d+/).reply(200, { ok: true });

    const trigger = axiosInstance.get('/protected', { headers: { Authorization: 'Bearer STALE' } }).catch((err) => err);

    // Wait until refresh is in flight (refreshFn called once but not resolved).
    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(releaseRefresh).toBeDefined();
    });

    // Fire 5 concurrent requests with auth header. With cap=3, requests 4 and 5 reject with overflow.
    const requests: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      requests.push(
        axiosInstance.get(`/queued-${i}`, { headers: { Authorization: 'Bearer STALE' } }).catch((err) => err),
      );
    }

    // Wait for all five to have been handled by the request interceptor.
    // First 3 are pushed to queue; last 2 are rejected.
    await waitForAssertion(() => {
      const queueLen = (plugin as { refreshQueue: unknown[] }).refreshQueue.length;
      expect(queueLen).toBe(3);
    });

    // Release refresh; queued requests resolve normally.
    releaseRefresh!({ token: 'FRESH' });
    releaseRefresh = undefined;

    const all = await Promise.all([trigger, ...requests]);

    // Trigger should resolve to a 200 (after refresh + retry).
    expect((all[0] as { status: number }).status).toBe(200);

    let overflowCount = 0;
    let okCount = 0;
    for (let i = 1; i <= 5; i++) {
      const result = all[i];
      const cause = (result as Error & { cause?: unknown })?.cause;
      if (cause instanceof TokenRefreshQueueOverflowError) {
        overflowCount += 1;
        expect(cause.code).toBe('ETOKEN_REFRESH_QUEUE_OVERFLOW');
        expect(cause.queueSize).toBeGreaterThanOrEqual(3);
      } else if ((result as { status?: number })?.status === 200) {
        okCount += 1;
      }
    }
    expect(overflowCount).toBe(2);
    expect(okCount).toBe(3);
  }, 15_000);

  it('does not reject when maxQueuedRequests is 0 (cap disabled)', async () => {
    plugin = buildPlugin({ maxQueuedRequests: 0 });
    manager.use(plugin);

    mock
      .onGet('/protected')
      .replyOnce(401)
      .onGet('/protected')
      .reply((config) =>
        config.headers?.Authorization === 'Bearer FRESH' ? [200, { ok: true }] : [401, { stale: true }],
      );
    mock.onGet(/\/queued-\d+/).reply(200, { ok: true });

    const trigger = axiosInstance.get('/protected', { headers: { Authorization: 'Bearer STALE' } }).catch((err) => err);

    await waitForAssertion(() => {
      expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    const requests: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      requests.push(
        axiosInstance.get(`/queued-${i}`, { headers: { Authorization: 'Bearer STALE' } }).catch((err) => err),
      );
    }

    // All 10 should be queued.
    await waitForAssertion(() => {
      const queueLen = (plugin as { refreshQueue: unknown[] }).refreshQueue.length;
      expect(queueLen).toBe(10);
    });

    releaseRefresh!({ token: 'FRESH' });
    releaseRefresh = undefined;

    const all = await Promise.all([trigger, ...requests]);
    for (const result of all) {
      const cause = (result as Error & { cause?: unknown })?.cause;
      expect(cause).not.toBeInstanceOf(TokenRefreshQueueOverflowError);
    }
  }, 15_000);
});
