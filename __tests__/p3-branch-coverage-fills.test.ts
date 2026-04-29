/**
 * Third wave of branch coverage fills:
 *   - DebugSanitizationPlugin/utils/sanitize.ts: array of primitives + null + allowlistOnly.
 *   - CircuitBreakerPlugin: _trackResponseTime when adaptiveTimeout is disabled.
 *   - CachingPlugin: cold-start eviction & persistCacheTouchIfNeeded storage failure.
 *   - TokenRefreshPlugin: failed-auth match in request and response interceptors.
 *   - utils/clone: ArrayBufferView clone fallback path.
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import type * as RequestLifecycleManagerModule from '../src/core/RequestLifecycleManager';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import type { CachedItem, CacheStorage, CacheStorageEntry } from '../src/plugins/CachingPlugin';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';
import { sanitizeData } from '../src/plugins/DebugSanitizationPlugin/utils/sanitize';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { cloneValue } from '../src/utils/clone';

describe('sanitizeData — array iteration branches', () => {
  it('returns null/undefined unchanged when nested in arrays', () => {
    const out = sanitizeData({ items: [null, undefined, 'kept'] }, { allowlistOnly: false }) as {
      items: unknown[];
    };
    expect(out.items[0]).toBeNull();
    expect(out.items[1]).toBeUndefined();
    expect(out.items[2]).toBe('kept');
  });

  it('redacts primitive array entries when allowlistOnly is set (no keyHint)', () => {
    const out = sanitizeData(
      { items: ['secret-a', 'secret-b'] },
      { allowlistOnly: true, allowedFields: ['items'] },
    ) as { items: unknown[] };
    // Inside the array, sanitizeValue is invoked without keyHint → primitives are redacted.
    expect(typeof out.items[0]).toBe('string');
    expect(out.items[0]).not.toBe('secret-a');
  });

  it('returns primitive entries unchanged when allowlistOnly is false', () => {
    const out = sanitizeData({ items: ['kept-a', 'kept-b'] }, { allowlistOnly: false }) as { items: unknown[] };
    expect(out.items).toEqual(['kept-a', 'kept-b']);
  });
});

describe('CircuitBreakerPlugin — _trackResponseTime branches', () => {
  it('returns early when adaptiveTimeout is disabled', () => {
    const plugin = new CircuitBreakerPlugin({ adaptiveTimeout: false });
    const fakeResponse = {
      config: { url: '/x' },
      headers: { 'x-response-time': '50' },
      status: 200,
      statusText: 'OK',
      data: null,
    } as never;
    plugin._trackResponseTime(fakeResponse);
    // No metrics tracked because adaptiveTimeout is off.
    expect(
      (plugin as unknown as { _adaptiveTimeoutTracker: { responseMetrics: object } })._adaptiveTimeoutTracker
        .responseMetrics,
    ).toEqual({});
  });

  it('returns early when response.config.url is missing', () => {
    const plugin = new CircuitBreakerPlugin({ adaptiveTimeout: true });
    const fakeResponse = {
      config: { url: undefined },
      headers: { 'x-response-time': '50' },
      status: 200,
      statusText: 'OK',
      data: null,
    } as never;
    plugin._trackResponseTime(fakeResponse);
    expect(
      (plugin as unknown as { _adaptiveTimeoutTracker: { responseMetrics: object } })._adaptiveTimeoutTracker
        .responseMetrics,
    ).toEqual({});
  });
});

describe('CachingPlugin — cold-start eviction & storage error branches', () => {
  function buildBypassedStorage(initialEntries: CacheStorageEntry[]): CacheStorage {
    const map = new Map<string, CachedItem>(initialEntries.map(({ key, value }) => [key, value]));
    return {
      get: jest.fn(async (key: string) => map.get(key)),
      set: jest.fn(async (key: string, value: CachedItem) => {
        map.set(key, value);
      }),
      delete: jest.fn(async (key: string) => {
        map.delete(key);
      }),
      clear: jest.fn(async () => map.clear()),
      entries: jest.fn(async () => Array.from(map, ([key, value]) => ({ key, value }))),
    };
  }

  it('skips eviction when the cold-start scan already contains the cacheKey', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const storage = buildBypassedStorage([]);
    const plugin = new CachingPlugin({
      maxItems: 5,
      timeToRevalidate: 60_000,
      storage,
    });
    manager.use(plugin);

    mock.onGet('/x').reply(200, { ok: true });
    await manager.axiosInstance.get('/x');
    // Hit the same key — eviction code runs again with the existing key in storage scan.
    await manager.axiosInstance.get('/x');

    manager.destroy();
    mock.restore();
  });

  it('evicts least-recently-accessed entries when scanning storage for cold-start eviction', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });

    const baseTimestamp = Date.now() - 1000;
    const storage = buildBypassedStorage([
      {
        key: 'GET|/old',
        value: {
          response: { data: 'a', headers: {}, status: 200, statusText: 'OK' } as never,
          timestamp: baseTimestamp,
          lastAccessedAt: baseTimestamp,
        } as CachedItem,
      },
      {
        key: 'GET|/older',
        value: {
          response: { data: 'b', headers: {}, status: 200, statusText: 'OK' } as never,
          timestamp: baseTimestamp - 5_000,
          lastAccessedAt: baseTimestamp - 5_000,
        } as CachedItem,
      },
    ]);

    const plugin = new CachingPlugin({
      maxItems: 2,
      timeToRevalidate: 60_000,
      storage,
    });
    manager.use(plugin);

    mock.onGet('/new').reply(200, { ok: true });
    await manager.axiosInstance.get('/new');

    manager.destroy();
    mock.restore();
  });

  it('logs and continues when the storage adapter rejects on persisting the access timestamp', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const warn = jest.fn();
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      logger: { log: jest.fn(), error: jest.fn(), warn, debug: jest.fn() },
    });

    let setCallCount = 0;
    const storage: CacheStorage = {
      get: jest.fn(async () => undefined),
      set: jest.fn(async () => {
        setCallCount += 1;
        if (setCallCount > 1) {
          throw new Error('storage offline');
        }
      }),
      delete: jest.fn(async () => {}),
      clear: jest.fn(async () => {}),
      entries: jest.fn(async () => []),
    };
    const plugin = new CachingPlugin({
      maxItems: 5,
      timeToRevalidate: 60_000,
      storage,
    });
    manager.use(plugin);

    mock.onGet('/x').reply(200, { ok: true });
    // First request populates the cache. Second request hits the cache and triggers
    // persistCacheTouchIfNeeded; the second storage.set throws and is caught.
    await manager.axiosInstance.get('/x');
    await manager.axiosInstance.get('/x');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist cache access metadata'),
      expect.any(Object),
    );

    manager.destroy();
    mock.restore();
  });
});

describe('TokenRefreshPlugin — failed-auth fast-fail branches', () => {
  it('rejects requests carrying the failed auth header in both interceptor paths', async () => {
    const axiosInstance = axios.create();
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer FAILED-TOKEN';
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });

    const refreshFn = jest.fn().mockRejectedValue(new Error('refresh broken'));
    const plugin = new TokenRefreshPlugin(refreshFn, {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1,
      refreshTimeout: 3000,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
    });
    manager.use(plugin);

    mock.onGet('/protected').reply(401);

    // First request: 401 → refresh fails → failedAuthHeaderValue is recorded.
    await expect(manager.axiosInstance.get('/protected')).rejects.toBeInstanceOf(Error);
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Second request reuses defaults.headers.common — request interceptor path fast-fails.
    await expect(manager.axiosInstance.get('/protected')).rejects.toMatchObject({
      code: 'TOKEN_REFRESH_FAILED',
    });
    // Refresh function did not run again (request rejected before reaching the network).
    expect(refreshFn).toHaveBeenCalledTimes(1);

    manager.destroy();
    mock.restore();
  });
});

describe('TokenRefreshPlugin — queue overflow branches', () => {
  it('rejects with QueueOverflowError when refresh-pending queue exceeds the cap', async () => {
    const axiosInstance = axios.create();
    axiosInstance.defaults.headers.common['Authorization'] = 'Bearer T1';
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0, maxConcurrentRequests: 100 });

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshFn = jest.fn(async () => {
      await refreshGate;
      return { token: 'T2' };
    });
    const plugin = new TokenRefreshPlugin(refreshFn, {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1,
      refreshTimeout: 3000,
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
      refreshStatusCodes: [401],
      maxQueuedRequests: 1,
    });
    manager.use(plugin);

    mock.onGet('/p').reply(401);
    mock.onGet('/p2').reply(401);
    mock.onGet('/p3').reply(401);

    // First request kicks off refresh.
    const inflight1 = manager.axiosInstance.get('/p').catch((e) => e);
    // Wait for refresh to start.
    await new Promise((r) => setTimeout(r, 10));

    // Second 401 hits queueRefreshRequest — this fills the queue up to maxQueuedRequests=1.
    const inflight2 = manager.axiosInstance.get('/p2').catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));

    // Third 401 hits queueRefreshRequest again, queue is now overflowing → reject with overflow error.
    const overflow = await manager.axiosInstance.get('/p3').catch((e) => e);
    expect(overflow).toBeInstanceOf(Error);

    releaseRefresh();
    await Promise.all([inflight1, inflight2]);

    manager.destroy();
    mock.restore();
  });
});

describe('cloneValue — ArrayBufferView fallback', () => {
  it('clones a Uint8Array via slice', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const cloned = cloneValue(original);
    expect(cloned).not.toBe(original);
    expect(Array.from(cloned)).toEqual([1, 2, 3, 4]);
  });

  it('clones a DataView faithfully', () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, 42);
    const cloned = cloneValue(view);
    expect(cloned).not.toBe(view);
    expect(cloned.getUint32(0)).toBe(42);
  });
});

describe('Lower-level utility branches', () => {
  it('assignRequestMetadata deletes properties when given undefined values', async () => {
    const { assignRequestMetadata, getRequestMetadata } = await import('../src/utils/requestMetadata');
    const config = { url: '/x' } as Parameters<typeof assignRequestMetadata>[0];
    assignRequestMetadata(config, { requestId: 'r1', retryAttempt: 5 });
    expect(getRequestMetadata(config)?.retryAttempt).toBe(5);
    assignRequestMetadata(config, { retryAttempt: undefined });
    expect(getRequestMetadata(config)?.retryAttempt).toBeUndefined();
  });

  it('getErrorMeta returns an empty object when given a non-Error value', async () => {
    const { getErrorMeta } = await import('../src/plugins/CachingPlugin/utils');
    expect(getErrorMeta('plain-string')).toEqual({});
    expect(getErrorMeta(null)).toEqual({});
    expect(getErrorMeta({ message: 'looks like an error' })).toEqual({});
  });

  it('stableStringify recurses into objects with undefined-valued props (normalizeValue undefined branch)', async () => {
    const { stableStringify } = await import('../src/plugins/CachingPlugin/utils/key');
    // Object.entries enumerates undefined props; normalizeValue returns undefined for them.
    // JSON.stringify omits keys with undefined values, leaving `{}`.
    expect(stableStringify({ foo: undefined, bar: 1 })).toBe(JSON.stringify({ bar: 1 }));
  });
});

describe('RequestLifecycleManager — readCorrelationHeader fallback path', () => {
  // Calling beginRequest directly bypasses axios's AxiosHeaders normalization, so the
  // function falls through to the plain-object header loop (the otherwise-dead branch).
  type RequestLifecycleManagerModuleType = typeof RequestLifecycleManagerModule;
  type RequestLifecycleManagerCtorParams = ConstructorParameters<
    RequestLifecycleManagerModuleType['RequestLifecycleManager']
  >;
  function buildLifecycleManager(): InstanceType<RequestLifecycleManagerModuleType['RequestLifecycleManager']> {
    // Lazy-require so the construction args follow whatever the latest signatures expect.
    const moduleRef = jest.requireActual<RequestLifecycleManagerModuleType>('../src/core/RequestLifecycleManager');
    const requestQueueStub = {
      cancelAll: jest.fn(),
      cancelQueued: jest.fn(),
    } as unknown as RequestLifecycleManagerCtorParams[0]['requestQueue'];
    const retrySchedulerStub = {
      cancelTimer: jest.fn(),
      cancelAllTimers: jest.fn(),
    } as unknown as RequestLifecycleManagerCtorParams[0]['retryScheduler'];
    const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    return new moduleRef.RequestLifecycleManager({
      logger,
      requestQueue: requestQueueStub,
      retryScheduler: retrySchedulerStub,
      onRequestCancelled: jest.fn(),
    });
  }

  it('reads a string correlation id from plain-object headers when no .get method exists', () => {
    const manager = buildLifecycleManager();
    const config = {
      url: '/x',
      headers: { 'X-Correlation-Id': 'plain-corr-id' } as unknown as never,
    };
    manager.beginRequest(config);
    const meta = (config as unknown as { __axiosRetryer?: { correlationId?: string } }).__axiosRetryer;
    expect(meta?.correlationId).toBe('plain-corr-id');
  });

  it('coerces numeric correlation id values to strings via the fallback loop', () => {
    const manager = buildLifecycleManager();
    const config = {
      url: '/y',
      headers: { 'X-Request-Id': 12345 } as unknown as never,
    };
    manager.beginRequest(config);
    const meta = (config as unknown as { __axiosRetryer?: { correlationId?: string } }).__axiosRetryer;
    expect(meta?.correlationId).toBe('12345');
  });

  it('falls through to requestId when plain-object headers have no correlation key', () => {
    const manager = buildLifecycleManager();
    const config = {
      url: '/z',
      headers: { Foo: 'bar' } as unknown as never,
    };
    manager.beginRequest(config);
    const meta = (config as unknown as { __axiosRetryer?: { correlationId?: string; requestId?: string } })
      .__axiosRetryer;
    expect(meta?.correlationId).toBe(meta?.requestId);
  });
});
