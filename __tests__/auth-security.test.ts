//@ts-nocheck
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { RetryManager } from '../src';

import { createMinimalPluginContext } from './helpers/minimalPluginContext';

const createFakeLogger = () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
});

const createFakeManager = (axiosInstance: AxiosInstance, logger = createFakeLogger()) =>
  createMinimalPluginContext(axiosInstance, logger);

// ────────────────────────────────────────────────────────────────────────────
// T-013: CachingPlugin auth-aware guard
// ────────────────────────────────────────────────────────────────────────────

describe('CachingPlugin — auth-aware caching', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let fakeLogger: ReturnType<typeof createFakeLogger>;
  let fakeManager: ReturnType<typeof createFakeManager>;
  let cachingPlugin: CachingPlugin;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
    fakeLogger = createFakeLogger();
    fakeManager = createFakeManager(axiosInstance, fakeLogger);
  });

  afterEach(() => {
    mock.restore();
    if (cachingPlugin) {
      cachingPlugin.onBeforeDestroyed();
    }
  });

  // ── skipWhenAuthPresent (default = true) ───────────────────────────────

  test('should skip caching when Authorization header is present (default)', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/me';
    mock.onGet(url).reply(200, { user: 'alice' });

    // First request with auth
    await axiosInstance.get(url, { headers: { Authorization: 'Bearer token-alice' } });
    // Second request with auth — should NOT be served from cache
    await axiosInstance.get(url, { headers: { Authorization: 'Bearer token-alice' } });

    // Both requests should have hit the network
    expect(mock.history.get.length).toBe(2);

    expect(
      fakeLogger.debug.mock.calls.some((args) => args[0].includes('Skipping cache for authenticated request')),
    ).toBe(true);
  });

  test('should skip caching when Cookie header is present (default)', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/profile';
    mock.onGet(url).reply(200, { name: 'bob' });

    await axiosInstance.get(url, { headers: { Cookie: 'session=abc' } });
    await axiosInstance.get(url, { headers: { Cookie: 'session=abc' } });

    expect(mock.history.get.length).toBe(2);
  });

  test('should skip caching for X-Auth-Token header', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/data';
    mock.onGet(url).reply(200, { data: 1 });

    await axiosInstance.get(url, { headers: { 'X-Auth-Token': 'tok123' } });
    await axiosInstance.get(url, { headers: { 'X-Auth-Token': 'tok123' } });

    expect(mock.history.get.length).toBe(2);
  });

  test('should still cache unauthenticated requests normally', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/public';
    mock.onGet(url).replyOnce(200, { ok: true });

    await axiosInstance.get(url);
    const res2 = await axiosInstance.get(url);

    // Second call served from cache
    expect(mock.history.get.length).toBe(1);
    expect(res2.data).toEqual({ ok: true });
  });

  // ── cross-principal collision prevention ────────────────────────────────

  test('should prevent cross-principal cache collision (default config)', async () => {
    cachingPlugin = new CachingPlugin();
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/me';
    mock.onGet(url).reply(200, { user: 'anyone' });

    // User A
    const resA = await axiosInstance.get(url, { headers: { Authorization: 'Bearer user-a' } });
    // User B — same URL, different identity
    const resB = await axiosInstance.get(url, { headers: { Authorization: 'Bearer user-b' } });

    // Both should go to network (no cross-principal cache hit)
    expect(mock.history.get.length).toBe(2);
  });

  // ── skipWhenAuthPresent: false (opt-out) ────────────────────────────────

  test('should cache authenticated requests when skipWhenAuthPresent is false', async () => {
    cachingPlugin = new CachingPlugin({ skipWhenAuthPresent: false, compareHeaders: true });
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/shared';
    mock.onGet(url).replyOnce(200, { shared: true });

    await axiosInstance.get(url, { headers: { Authorization: 'Bearer shared-token' } });
    const res2 = await axiosInstance.get(url, { headers: { Authorization: 'Bearer shared-token' } });

    // Second call served from cache
    expect(mock.history.get.length).toBe(1);
    expect(res2.data).toEqual({ shared: true });
  });

  // ── varyHeaders: per-principal caching ──────────────────────────────────

  test('should scope cache entries by varyHeaders values', async () => {
    cachingPlugin = new CachingPlugin({
      skipWhenAuthPresent: false,
      varyHeaders: ['Authorization'],
    });
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/me';
    mock.onGet(url).reply((config) => {
      const token = config.headers?.Authorization;
      return [200, { identity: token }];
    });

    // User A — first request (misses cache)
    const resA1 = await axiosInstance.get(url, { headers: { Authorization: 'Bearer alice' } });
    expect(resA1.data).toEqual({ identity: 'Bearer alice' });

    // User A — second request (should hit cache)
    const resA2 = await axiosInstance.get(url, { headers: { Authorization: 'Bearer alice' } });
    expect(resA2.data).toEqual({ identity: 'Bearer alice' });

    // User B — different token means different cache entry
    const resB1 = await axiosInstance.get(url, { headers: { Authorization: 'Bearer bob' } });
    expect(resB1.data).toEqual({ identity: 'Bearer bob' });

    // Alice: 1 network call (2nd was cached), Bob: 1 network call
    expect(mock.history.get.length).toBe(2);
  });

  test('varyHeaders is case-insensitive', async () => {
    cachingPlugin = new CachingPlugin({
      skipWhenAuthPresent: false,
      varyHeaders: ['authorization'],
    });
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/case';
    mock.onGet(url).replyOnce(200, { ok: true });

    await axiosInstance.get(url, { headers: { Authorization: 'Bearer token' } });
    const res2 = await axiosInstance.get(url, { headers: { Authorization: 'Bearer token' } });

    expect(mock.history.get.length).toBe(1);
    expect(res2.data).toEqual({ ok: true });
  });

  test('varyHeaders separates entries when header values differ', async () => {
    cachingPlugin = new CachingPlugin({
      skipWhenAuthPresent: false,
      varyHeaders: ['X-Tenant-Id'],
    });
    cachingPlugin.initialize(fakeManager as unknown as RetryManager);

    const url = '/api/tenanted';
    mock.onGet(url).reply((config) => {
      return [200, { tenant: config.headers?.['X-Tenant-Id'] }];
    });

    const resTenantA = await axiosInstance.get(url, { headers: { 'X-Tenant-Id': 'acme' } });
    const resTenantB = await axiosInstance.get(url, { headers: { 'X-Tenant-Id': 'globex' } });

    expect(resTenantA.data).toEqual({ tenant: 'acme' });
    expect(resTenantB.data).toEqual({ tenant: 'globex' });
    expect(mock.history.get.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-014: ManualRetryPlugin auth rehydration
// ────────────────────────────────────────────────────────────────────────────

describe('ManualRetryPlugin — auth rehydration security', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  test('should NOT rehydrate auth headers from defaults when no rehydrateAuth hook provided', async () => {
    const manualRetry = new ManualRetryPlugin({ storeAuthRequests: true });
    const manager = new RetryManager({
      mode: 'manual',
      retries: 0,
      axiosInstance,
      throwErrorOnFailedRetries: false,
    });
    manager.use(manualRetry);

    // Set auth on defaults BEFORE the failure
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer user-a-token';

    mock.onGet('/secure').replyOnce(500);
    try { await axiosInstance.get('/secure', { headers: { Authorization: 'Bearer user-a-token' } }); } catch {}

    // Now simulate session change — a different user is logged in
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer user-b-token';

    // Replay
    mock.onGet('/secure').reply(200, { ok: true });
    const results = await manualRetry.retryFailedRequests();

    // The replayed request should NOT carry any Authorization header
    // (auth was stripped on storage and not re-applied)
    const replayedHeaders = mock.history.get[1]?.headers || {};
    expect(replayedHeaders['Authorization']).toBeUndefined();
    expect(replayedHeaders['authorization']).toBeUndefined();

    await manager.destroy();
  });

  test('should use rehydrateAuth hook when provided', async () => {
    let currentToken = 'Bearer current-session';

    const manualRetry = new ManualRetryPlugin({
      storeAuthRequests: true,
      rehydrateAuth: (config) => {
        config.headers = config.headers || {};
        config.headers['Authorization'] = currentToken;
        return config;
      },
    });

    const manager = new RetryManager({
      mode: 'manual',
      retries: 0,
      axiosInstance,
      throwErrorOnFailedRetries: false,
    });
    manager.use(manualRetry);

    mock.onGet('/secure').replyOnce(500);
    try { await axiosInstance.get('/secure', { headers: { Authorization: 'Bearer old' } }); } catch {}

    // Replay with current session
    mock.onGet('/secure').reply(200, { ok: true });
    const results = await manualRetry.retryFailedRequests();

    const replayedHeaders = mock.history.get[1]?.headers || {};
    expect(replayedHeaders['Authorization']).toBe('Bearer current-session');

    await manager.destroy();
  });

  test('should skip replay when rehydrateAuth returns null', async () => {
    const manualRetry = new ManualRetryPlugin({
      storeAuthRequests: true,
      rehydrateAuth: () => null, // refuse all replays
    });

    const manager = new RetryManager({
      mode: 'manual',
      retries: 0,
      axiosInstance,
      throwErrorOnFailedRetries: false,
    });
    manager.use(manualRetry);

    mock.onGet('/secure').replyOnce(500);
    try { await axiosInstance.get('/secure', { headers: { Authorization: 'Bearer tok' } }); } catch {}

    mock.onGet('/secure').reply(200, { ok: true });
    const results = await manualRetry.retryFailedRequests();

    // No request should have been replayed
    expect(results).toHaveLength(0);
    expect(mock.history.get.length).toBe(1); // only the original failure

    await manager.destroy();
  });

  test('should prevent cross-principal replay (default behavior)', async () => {
    // No rehydrateAuth hook — default safe behavior
    const manualRetry = new ManualRetryPlugin({ storeAuthRequests: true });
    const manager = new RetryManager({
      mode: 'manual',
      retries: 0,
      axiosInstance,
      throwErrorOnFailedRetries: false,
    });
    manager.use(manualRetry);

    // User A makes a request that fails
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer user-a';
    mock.onGet('/api/data').replyOnce(500);
    try { await axiosInstance.get('/api/data', { headers: { Authorization: 'Bearer user-a' } }); } catch {}

    // User B logs in
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer user-b';

    // Replay — should succeed but WITHOUT any auth header (no cross-principal leak)
    mock.onGet('/api/data').reply(200, { data: 'public' });
    await manualRetry.retryFailedRequests();

    const replayedHeaders = mock.history.get[1]?.headers || {};
    expect(replayedHeaders['Authorization']).toBeUndefined();
    expect(replayedHeaders['authorization']).toBeUndefined();

    await manager.destroy();
  });

  test('rehydrateAuth can validate principal before replay', async () => {
    let currentUser = 'alice';

    const manualRetry = new ManualRetryPlugin({
      storeAuthRequests: true,
      prepareRequestForStore: (config) => {
        // Tag stored request with the originating user
        config.headers = config.headers || {};
        config.headers['X-Stored-Principal'] = currentUser;
        return config;
      },
      rehydrateAuth: (config) => {
        // Refuse replay if principal has changed
        if (config.headers?.['X-Stored-Principal'] !== currentUser) {
          return null;
        }
        config.headers['Authorization'] = `Bearer ${currentUser}-token`;
        delete config.headers['X-Stored-Principal'];
        return config;
      },
    });

    const manager = new RetryManager({
      mode: 'manual',
      retries: 0,
      axiosInstance,
      throwErrorOnFailedRetries: false,
    });
    manager.use(manualRetry);

    mock.onGet('/api/private').replyOnce(500);
    try { await axiosInstance.get('/api/private'); } catch {}

    // Principal changes
    currentUser = 'bob';

    mock.onGet('/api/private').reply(200, { ok: true });
    const results = await manualRetry.retryFailedRequests();

    // Request should be skipped — principal mismatch
    expect(results).toHaveLength(0);

    await manager.destroy();
  });
});
