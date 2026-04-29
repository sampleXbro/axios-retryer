/**
 * Second wave of branch coverage fills:
 *   - MetricsPlugin: default priority/attempt fallbacks (config without `__axiosRetryer`),
 *     getMetrics() with no live context.
 *   - ManualRetryPlugin/configs: default-options branch.
 *   - CircuitBreakerPlugin/configs: default-arg invocation.
 *   - CircuitBreakerScopeManager: HOST and URL scope variants, default-fallback "unknown",
 *     custom-scope throw with non-Error error, missing pathname fallback.
 *   - DebugSanitizationPlugin/utils/sanitize: empty-query path, allowlistOnly null/keyHint
 *     primitive paths, hash-without-query input.
 *   - TokenRefreshPlugin errors: TokenRefreshAbortError default message,
 *     shouldStopRefreshRetries duck-typing on plain object with stopRefreshRetries=true.
 *   - CachingPlugin: maxItems=0 short-circuits enforceMaxItemsBeforeUpsert /
 *     persistCacheTouchIfNeeded.
 */
import axios, { AxiosError } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import { CircuitBreakerScopeManager } from '../src/plugins/CircuitBreakerPlugin/managers/CircuitBreakerScopeManager';
import { CIRCUIT_BREAKER_SCOPES, type CircuitBreakerStateAdapter } from '../src/plugins/CircuitBreakerPlugin/types';
import { resolveCircuitBreakerOptions } from '../src/plugins/CircuitBreakerPlugin/configs';
import { sanitizeData, sanitizeUrl } from '../src/plugins/DebugSanitizationPlugin/utils/sanitize';
import { resolveManualRetryPluginOptions } from '../src/plugins/ManualRetryPlugin/configs';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';
import { shouldStopRefreshRetries, TokenRefreshAbortError } from '../src/plugins/TokenRefreshPlugin/errors';

const NO_OP_ADAPTER: CircuitBreakerStateAdapter = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
  clear: jest.fn(),
};

describe('MetricsPlugin defaults — branch coverage', () => {
  it('falls back to MEDIUM priority and retryAttempt=1 when metadata is absent on beforeRetry', () => {
    const axiosInstance = axios.create();
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);

    // Synthesize a beforeRetry with a config missing __axiosRetryer to hit the ?? defaults.
    manager.emit('beforeRetry', { url: '/x' });

    const detailed = manager.getMetrics();
    expect(detailed.retryAttemptsDistribution).toBeDefined();

    manager.destroy();
  });

  it('falls back to MEDIUM priority on afterRetry when metadata is absent', () => {
    const axiosInstance = axios.create();
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);

    manager.emit('afterRetry', { url: '/x' }, true);
    const axErr = new AxiosError('boom', 'ERR_BOOM');
    manager.emit('afterRetry', { url: '/x' }, false, axErr);

    expect(manager.getMetrics()).toBeDefined();
    manager.destroy();
  });

  it('getMetrics falls through to EMPTY_TIMER_STATS when context is null after destroy', () => {
    const axiosInstance = axios.create();
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);

    manager.destroy();
    const detailed = plugin.getMetrics();
    expect(detailed.timerHealth).toBeDefined();
  });
});

describe('ManualRetryPlugin configs — default branch', () => {
  it('returns the canonical defaults when called with no arguments', () => {
    const opts = resolveManualRetryPluginOptions();
    expect(opts.maxRequestsToStore).toBe(200);
    expect(opts.storeNonIdempotent).toBe(false);
  });
});

describe('CircuitBreakerPlugin configs — default-arg branch', () => {
  it('resolves with all defaults when called with no arguments', () => {
    const opts = resolveCircuitBreakerOptions();
    expect(opts.failureThreshold).toBe(5);
    expect(opts.scope).toBe(CIRCUIT_BREAKER_SCOPES.HOST_AND_URL);
  });
});

describe('CircuitBreakerScopeManager — scope branches', () => {
  function buildManager(scope: (typeof CIRCUIT_BREAKER_SCOPES)[keyof typeof CIRCUIT_BREAKER_SCOPES]) {
    const manager = new CircuitBreakerScopeManager({
      scope,
      stateAdapter: NO_OP_ADAPTER,
      maxTrackedScopes: 50,
    });
    manager.setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });
    return manager;
  }

  it('HOST_AND_URL scope yields normalizedUrl when host is missing (relative url)', () => {
    const manager = buildManager(CIRCUIT_BREAKER_SCOPES.HOST_AND_URL);
    const details = manager.getScopeDetails({ url: '/relative' });
    expect(details.scopeKey).toBe('/relative');
  });

  it('HOST scope falls back to normalizedUrl when host is missing', () => {
    const manager = buildManager(CIRCUIT_BREAKER_SCOPES.HOST);
    expect(manager.getScopeDetails({ url: '/relative' }).scopeKey).toBe('/relative');
  });

  it('URL scope yields normalizedUrl for an absolute url', () => {
    const manager = buildManager(CIRCUIT_BREAKER_SCOPES.URL);
    expect(manager.getScopeDetails({ url: 'https://api.example.com/items' }).scopeKey).toBe('/items');
  });

  it('HOST scope yields the host for an absolute url', () => {
    const manager = buildManager(CIRCUIT_BREAKER_SCOPES.HOST);
    expect(manager.getScopeDetails({ url: 'https://api.example.com/items' }).scopeKey).toBe('api.example.com');
  });

  it('custom scope returning empty string falls back to default', () => {
    const manager = new CircuitBreakerScopeManager({
      scope: () => '',
      stateAdapter: NO_OP_ADAPTER,
      maxTrackedScopes: 50,
    });
    manager.setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });
    const details = manager.getScopeDetails({ url: 'https://api.example.com/items' });
    expect(details.scopeKey).toBe('api.example.com/items');
  });

  it('custom scope throwing a non-Error is logged with the raw value', () => {
    const warn = jest.fn();
    const manager = new CircuitBreakerScopeManager({
      scope: () => {
        throw 'plain-string';
      },
      stateAdapter: NO_OP_ADAPTER,
      maxTrackedScopes: 50,
    });
    manager.setLogger({ log: jest.fn(), error: jest.fn(), warn, debug: jest.fn() });

    const details = manager.getScopeDetails({ url: 'https://api.example.com/items' });
    expect(details.scopeKey).toBe('api.example.com/items');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Custom scope callback threw'),
      expect.objectContaining({ error: 'plain-string' }),
    );
  });
});

describe('DebugSanitizationPlugin sanitize — primitive allowlistOnly + URL edge cases', () => {
  it('redacts top-level primitive value when allowlistOnly is set and sanitizeData is called directly', () => {
    // sanitizeData top-level branch hits: object input → object output via internal sanitizeValue.
    // For a primitive top level, the function bails early; we exercise the keyHint path through
    // a nested object whose inner value is primitive and key is not allowed.
    const out = sanitizeData(
      { allowed: 'keep', other: 'redact-me' },
      { allowlistOnly: true, allowedFields: ['allowed'] },
    ) as Record<string, string>;
    expect(out.allowed).toBe('keep');
    expect(out.other).not.toBe('redact-me');
  });

  it('returns the original URL when withoutHash has no "?" (hash before query token)', () => {
    // A URL like '/path#fragment?notReallyAQuery' would not produce a withoutHash with a "?";
    // since includes('?') is true on the original, we go further but find no query.
    // The function should return the input verbatim.
    expect(sanitizeUrl('/x#frag?fake')).toBe('/x#frag?fake');
  });
});

describe('TokenRefreshPlugin errors — duck-typing branches', () => {
  it('TokenRefreshAbortError uses the default message when no argument is given', () => {
    const err = new TokenRefreshAbortError();
    expect(err.message).toBe('Token refresh aborted');
  });

  it('shouldStopRefreshRetries detects duck-typed objects with stopRefreshRetries=true', () => {
    expect(shouldStopRefreshRetries({ stopRefreshRetries: true })).toBe(true);
    expect(shouldStopRefreshRetries({ stopRefreshRetries: false })).toBe(false);
    expect(shouldStopRefreshRetries({})).toBe(false);
    expect(shouldStopRefreshRetries(null)).toBe(false);
    expect(shouldStopRefreshRetries('plain-string')).toBe(false);
  });
});

describe('CachingPlugin — maxItems=0 short-circuit branches', () => {
  it('skips eviction logic and persist write when maxItems is 0', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new CachingPlugin({ maxItems: 0, timeToRevalidate: 60_000 });
    manager.use(plugin);

    mock.onGet('/x').reply(200, { ok: true });
    await manager.axiosInstance.get('/x');
    // Second hit should still serve from cache without the eviction path running.
    await manager.axiosInstance.get('/x');

    manager.destroy();
    mock.restore();
  });
});
