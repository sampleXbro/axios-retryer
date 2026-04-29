/**
 * Branch coverage fills targeting the modules with the lowest branch ratios:
 *   - CachingPlugin/managers/InflightDedupe.ts: undefined-config and missing-leader paths.
 *   - CachingPlugin/managers/CleanupRunner.ts: disabled-interval start, stop without timer.
 *   - CachingPlugin/utils/response.ts: sensitive header deletion.
 *   - CachingPlugin index: createCachePlugin functional alternative.
 *   - CachingPlugin configs: validation throws for non-integer / negative inputs.
 *   - CircuitBreakerPlugin/managers/AdaptiveTimeoutTracker.ts: missing-url and empty-times paths.
 *   - DebugSanitizationPlugin/DebugSanitizationPlugin.ts: error without response, request without method/headers.
 *   - DebugSanitizationPlugin/configs: passing options.sanitizeOptions.
 *   - TokenRefreshPlugin/errors: status field, abort instance.
 *   - TokenRefreshPlugin/errors/TokenRefreshTimeoutError: default message.
 *   - services/logger: debug-mode-off branch.
 *   - core/EventBus: strict listener limit throw.
 *   - core/strategies/DefaultRetryStrategy: idempotency header bypass for POST.
 *   - core/RequestLifecycleManager: correlation header readers (number value, no headers).
 */
import axios, { AxiosError } from 'axios';

import { RetryManager } from '../src';
import { EventBus } from '../src/core/EventBus';
import { DefaultRetryStrategy } from '../src/core/strategies/DefaultRetryStrategy';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { createCachePlugin } from '../src/plugins/CachingPlugin';
import { CleanupRunner } from '../src/plugins/CachingPlugin/managers/CleanupRunner';
import { InflightDedupe } from '../src/plugins/CachingPlugin/managers/InflightDedupe';
import { createCachedResponseSnapshot } from '../src/plugins/CachingPlugin/utils/response';
import { validateCachingPluginOptions } from '../src/plugins/CachingPlugin/configs';
import { resolveCachingPluginOptions } from '../src/plugins/CachingPlugin/configs';
import { AdaptiveTimeoutTracker } from '../src/plugins/CircuitBreakerPlugin/managers/AdaptiveTimeoutTracker';
import { DebugSanitizationPlugin } from '../src/plugins/DebugSanitizationPlugin';
import { resolveSanitizeOptions } from '../src/plugins/DebugSanitizationPlugin/configs';
import {
  shouldRetryRefreshError,
  toTokenRefreshError,
  TokenRefreshAbortError,
} from '../src/plugins/TokenRefreshPlugin/errors';
import { TokenRefreshTimeoutError } from '../src/plugins/TokenRefreshPlugin/errors';
import { RetryLogger } from '../src/services/logger';

describe('InflightDedupe — branch coverage', () => {
  const dedupe = new InflightDedupe({ getLogger: () => null });

  it('consumeFollower returns false when config is undefined', () => {
    expect(dedupe.consumeFollower(undefined)).toBe(false);
  });

  it('consumeFollower returns false when no follower entry exists', () => {
    expect(dedupe.consumeFollower({ url: '/x' })).toBe(false);
  });

  it('consumeServedFromCache returns false when config is undefined', () => {
    expect(dedupe.consumeServedFromCache(undefined)).toBe(false);
  });

  it('consumeServedFromCache returns false when no entry exists for the request', () => {
    expect(dedupe.consumeServedFromCache({ url: '/y' })).toBe(false);
  });

  it('resolve returns early when config is undefined', () => {
    const fakeResponse = { data: null, headers: {}, status: 200, statusText: 'OK', config: {} } as never;
    expect(() => dedupe.resolve(undefined, fakeResponse)).not.toThrow();
  });

  it('resolve returns early when no leader entry exists for this config', () => {
    const fakeResponse = { data: null, headers: {}, status: 200, statusText: 'OK', config: {} } as never;
    expect(() => dedupe.resolve({ url: '/no-leader' }, fakeResponse)).not.toThrow();
  });

  it('reject returns early when no leader entry exists for this config', () => {
    expect(() => dedupe.reject({ url: '/no-leader' }, new Error('boom'))).not.toThrow();
  });

  it('falls back to a generated tracking id and warns once', () => {
    const warn = jest.fn();
    const local = new InflightDedupe({
      getLogger: () => ({ log: jest.fn(), error: jest.fn(), warn, debug: jest.fn() }),
    });
    const config = { url: '/fallback' };
    // First call assigns and warns; second call reuses the cached id.
    const id1 = local.getOrAssignTrackingId(config);
    const id2 = local.getOrAssignTrackingId(config);
    expect(id1).toBe(id2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('CleanupRunner — branch coverage', () => {
  it('start is a no-op when intervalMs is non-positive', () => {
    const runner = new CleanupRunner({
      intervalMs: 0,
      timeoutMs: 1_000,
      disableAfterFailures: 3,
      runCleanup: () => Promise.resolve(),
      getLogger: () => null,
    });
    runner.start();
    // No timer was scheduled — stopping is also a no-op.
    expect(() => runner.stop()).not.toThrow();
  });

  it('stop is a no-op when start has not been called', () => {
    const runner = new CleanupRunner({
      intervalMs: 1_000,
      timeoutMs: 1_000,
      disableAfterFailures: 3,
      runCleanup: () => Promise.resolve(),
      getLogger: () => null,
    });
    expect(() => runner.stop()).not.toThrow();
  });

  it('disables the runner after consecutive failures cross the threshold', async () => {
    const warn = jest.fn();
    const error = jest.fn();
    let cleanupSettle!: () => void;
    const cleanup = jest.fn(
      () =>
        new Promise<void>((_, reject) => {
          cleanupSettle = () => reject(new Error('boom'));
        }),
    );
    const runner = new CleanupRunner({
      intervalMs: 10,
      timeoutMs: 1_000,
      disableAfterFailures: 1,
      runCleanup: cleanup,
      getLogger: () => ({ log: jest.fn(), error, warn, debug: jest.fn() }),
    });
    runner.start();
    // Wait for the interval to fire at least once so the cleanup promise is created.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cleanup).toHaveBeenCalled();
    cleanupSettle();
    // Allow the rejection chain to resolve through Promise.race -> then -> catch.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.consecutiveFailureCount).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Disabling cleanup'), expect.any(Object));
    runner.stop();
  });
});

describe('CachingPlugin response utils — branch coverage', () => {
  it('deletes sensitive headers from the response snapshot', () => {
    const response = {
      data: { ok: true },
      headers: { 'Set-Cookie': 'session=secret', 'X-Public': 'ok' } as Record<string, unknown>,
      status: 200,
      statusText: 'OK',
      config: {},
    } as never;

    const snap = createCachedResponseSnapshot(response, ['set-cookie']);
    expect(snap.headers).not.toHaveProperty('Set-Cookie');
    expect(snap.headers).toHaveProperty('X-Public', 'ok');
  });

  it('keeps every header when sensitiveHeaders is empty', () => {
    const response = {
      data: null,
      headers: { Foo: 'bar' } as Record<string, unknown>,
      status: 200,
      statusText: 'OK',
      config: {},
    } as never;
    const snap = createCachedResponseSnapshot(response, []);
    expect(snap.headers).toEqual({ Foo: 'bar' });
  });
});

describe('CachingPlugin config validation — branch coverage', () => {
  it('throws on non-integer cleanupInterval', () => {
    const opts = resolveCachingPluginOptions({ cleanupInterval: 1.5 });
    expect(() => validateCachingPluginOptions(opts)).toThrow(/cleanupInterval/);
  });

  it('throws on negative maxAge', () => {
    const opts = resolveCachingPluginOptions({ maxAge: -1 });
    expect(() => validateCachingPluginOptions(opts)).toThrow(/maxAge/);
  });

  it('throws on negative maxItems', () => {
    const opts = resolveCachingPluginOptions({ maxItems: -1 });
    expect(() => validateCachingPluginOptions(opts)).toThrow(/maxItems/);
  });

  it('throws on non-integer maxEntrySize', () => {
    const opts = resolveCachingPluginOptions({ maxEntrySize: 1.2 });
    expect(() => validateCachingPluginOptions(opts)).toThrow(/maxEntrySize/);
  });

  it('throws on negative timeToRevalidate', () => {
    const opts = resolveCachingPluginOptions({ timeToRevalidate: -10 });
    expect(() => validateCachingPluginOptions(opts)).toThrow(/timeToRevalidate/);
  });
});

describe('CachingPlugin index — branch coverage', () => {
  it('createCachePlugin returns a configured CachingPlugin instance', () => {
    const plugin = createCachePlugin({ maxItems: 5 });
    expect(plugin).toBeInstanceOf(CachingPlugin);
  });
});

describe('AdaptiveTimeoutTracker — branch coverage', () => {
  it('returns early when response.config.url is missing', () => {
    const tracker = new AdaptiveTimeoutTracker({
      percentile: 0.95,
      sampleSize: 5,
      multiplier: 1.5,
      maxTrackedScopes: 10,
    });
    tracker.trackResponseTime(
      {
        config: { url: undefined as unknown as string },
        headers: {},
        status: 200,
        statusText: 'OK',
        data: null,
      } as never,
      'scope-A',
      '/x',
    );
    expect(Object.keys(tracker.responseMetrics)).toEqual([]);
  });

  it('returns undefined timeout when scope has not collected the full sample', () => {
    const tracker = new AdaptiveTimeoutTracker({
      percentile: 0.95,
      sampleSize: 5,
      multiplier: 1.5,
      maxTrackedScopes: 10,
    });
    tracker.trackResponseTime(
      {
        config: { url: '/x' },
        headers: { 'x-response-time': '50' },
        status: 200,
        statusText: 'OK',
        data: null,
      } as never,
      'scope-A',
      '/x',
    );
    expect(tracker.getComputedTimeout('scope-A')).toBeUndefined();
  });

  it('does not throw when updatePercentile sees no entry for the scope', () => {
    const tracker = new AdaptiveTimeoutTracker({
      percentile: 0.95,
      sampleSize: 1,
      multiplier: 1.5,
      maxTrackedScopes: 10,
    });
    // Reset cleared the map; getAdaptiveTimeoutMetrics on empty map exercises the empty branch.
    tracker.reset();
    expect(tracker.getAdaptiveTimeoutMetrics()).toEqual([]);
  });

  it('evicts the oldest scope when maxTrackedScopes is reached', () => {
    const tracker = new AdaptiveTimeoutTracker({
      percentile: 0.95,
      sampleSize: 1,
      multiplier: 1.5,
      maxTrackedScopes: 2,
    });
    const baseResp = (url: string) =>
      ({ config: { url }, headers: { 'x-response-time': '50' }, status: 200, statusText: 'OK', data: null }) as never;

    tracker.trackResponseTime(baseResp('/a'), 'scope-A', '/a');
    tracker.trackResponseTime(baseResp('/b'), 'scope-B', '/b');
    tracker.trackResponseTime(baseResp('/c'), 'scope-C', '/c');
    expect(Object.keys(tracker.responseMetrics)).toEqual(['scope-B', 'scope-C']);
  });

  it('uses fallback responseTime=100 when both header and timestamp metadata are missing', () => {
    const tracker = new AdaptiveTimeoutTracker({
      percentile: 0.5,
      sampleSize: 1,
      multiplier: 2,
      maxTrackedScopes: 10,
    });
    tracker.trackResponseTime(
      { config: { url: '/x' }, headers: {}, status: 200, statusText: 'OK', data: null } as never,
      'scope-A',
      '/x',
    );
    expect(tracker.getComputedTimeout('scope-A')).toBe(200);
  });
});

describe('DebugSanitizationPlugin — branch coverage', () => {
  function makePluginContext() {
    const debug = jest.fn();
    const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug };
    const axiosInstance = axios.create();
    const context = {
      axiosInstance,
      getLogger: () => logger,
    } as unknown as Parameters<DebugSanitizationPlugin['initialize']>[0];
    return { context, axiosInstance, debug };
  }

  it('logSanitizedRequest handles a config without method or headers', () => {
    const plugin = new DebugSanitizationPlugin();
    const { context, debug } = makePluginContext();
    plugin.initialize(context);

    const fn = (plugin as unknown as { logSanitizedRequest: (config: unknown) => void }).logSanitizedRequest.bind(
      plugin,
    );
    fn({ url: '/x' });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('Sanitized request'),
      expect.objectContaining({ method: undefined }),
    );
  });

  it('logSanitizedError omits response section when error.response is undefined', () => {
    const plugin = new DebugSanitizationPlugin({
      sanitizeOptions: { sanitizeRequestData: false, sanitizeResponseData: false },
    });
    const { context, debug } = makePluginContext();
    plugin.initialize(context);

    const fn = (
      plugin as unknown as {
        logSanitizedError: (config: unknown, error: AxiosError) => void;
      }
    ).logSanitizedError.bind(plugin);
    const error = new AxiosError('boom', 'ERR_BOOM');
    fn({ url: '/x', method: 'POST', headers: { Authorization: 'Bearer x' } }, error);

    const calls = debug.mock.calls.find((c) => String(c[0]).includes('Sanitized error'));
    expect(calls).toBeDefined();
    const payload = (calls as unknown as [string, Record<string, unknown>])[1];
    expect(payload.response).toBeUndefined();
    expect(payload.data).toBeUndefined();
  });
});

describe('DebugSanitizationPlugin configs — branch coverage', () => {
  it('returns the provided sanitizeOptions when given', () => {
    expect(resolveSanitizeOptions({ sanitizeOptions: { redactionChar: '#' } })).toEqual({ redactionChar: '#' });
  });

  it('returns an empty object when no sanitizeOptions are provided', () => {
    expect(resolveSanitizeOptions({})).toEqual({});
    expect(resolveSanitizeOptions()).toEqual({});
  });
});

describe('TokenRefresh errors — branch coverage', () => {
  it('toTokenRefreshError copies status when present on the candidate', () => {
    const err = toTokenRefreshError({ message: 'fail', status: 401 });
    expect((err as Error & { status?: unknown }).status).toBe(401);
  });

  it('shouldRetryRefreshError returns false for TokenRefreshAbortError instances', () => {
    expect(shouldRetryRefreshError(new TokenRefreshAbortError('aborted'))).toBe(false);
  });

  it('TokenRefreshTimeoutError uses the default message when none provided', () => {
    const err = new TokenRefreshTimeoutError();
    expect(err.message).toBe('Token refresh timeout');
  });
});

describe('RetryLogger — branch coverage', () => {
  it('debug() suppresses output when debugMode is false', () => {
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const logger = new RetryLogger(false);
      logger.debug('hidden');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('debug() emits when debugMode is true', () => {
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const logger = new RetryLogger(true);
      logger.debug('shown');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('EventBus — branch coverage', () => {
  it('throws when strictListenerLimit is set and the cap is exceeded', () => {
    const bus = new EventBus(
      { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      { maxListenersPerEvent: 1, strictListenerLimit: true },
    );
    bus.on('beforeRetry', () => {});
    expect(() => bus.on('beforeRetry', () => {})).toThrow(/listener limit/);
  });

  it('warns and rejects extra listeners when strictListenerLimit is false', () => {
    const warn = jest.fn();
    const bus = new EventBus(
      { log: jest.fn(), error: jest.fn(), warn, debug: jest.fn() },
      { maxListenersPerEvent: 1, strictListenerLimit: false },
    );
    bus.on('beforeRetry', () => {});
    bus.on('beforeRetry', () => {});
    expect(warn).toHaveBeenCalled();
  });
});

describe('DefaultRetryStrategy — branch coverage', () => {
  it('treats POST as retryable when an idempotency header is present (case-insensitive)', () => {
    const strategy = new DefaultRetryStrategy();
    const error = new AxiosError('Server error', 'ECONNRESET');
    error.response = { status: 500, statusText: 'Server Error', headers: {}, data: null, config: {} } as never;
    error.config = {
      method: 'post',
      headers: { 'IDEMPOTENCY-KEY': 'abc' },
    } as never;

    expect(strategy.shouldRetry(error, 1, 3)).toBe(true);
  });

  it('refuses to retry POST without an idempotency header', () => {
    const strategy = new DefaultRetryStrategy();
    const error = new AxiosError('Server error', 'ECONNRESET');
    error.response = { status: 500, statusText: 'Server Error', headers: {}, data: null, config: {} } as never;
    error.config = { method: 'post', headers: {} } as never;

    expect(strategy.shouldRetry(error, 1, 3)).toBe(false);
  });
});

describe('RetryManager — correlation id branch coverage', () => {
  it('reads correlation id from a numeric x-request-id header', async () => {
    const axiosInstance = axios.create();
    const debug = jest.fn();
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug },
    });

    axiosInstance.defaults.adapter = () =>
      Promise.resolve({ data: 'ok', status: 200, statusText: 'OK', headers: {}, config: {} as never });
    await axiosInstance.get('/x', { headers: { 'X-Request-Id': 12345 } as never });

    const meta = debug.mock.calls.find((c) => String(c[0]) === 'New request created')?.[1] as
      | { correlationId?: string }
      | undefined;
    expect(meta?.correlationId).toBe('12345');

    manager.destroy();
  });
});
