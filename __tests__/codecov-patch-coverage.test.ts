/**
 * Raises Codecov **patch** coverage for production files that often change together
 * (ErrorInterceptor, RequestQueue, plugins). Targets branches reported uncovered locally.
 */

import axios, { AxiosError, AxiosHeaders, type AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryerConfigError } from '../src/core/errors/RetryerConfigError';
import { ErrorInterceptorHandler } from '../src/core/interceptors/ErrorInterceptor';
import { RequestQueue } from '../src/core/requestQueue';
import { RetryManager } from '../src';
import { RETRY_MODES } from '../src/types';
import type { Logger, RetryStrategy } from '../src/types';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { CIRCUIT_BREAKER_STATES, CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';
import { TokenRefreshPlugin, type TokenRefreshPluginOptions } from '../src/plugins/TokenRefreshPlugin';

type ErrorInterceptorPrivates = {
  getRetryAfterHeader(headers: unknown): string | undefined;
  normalizeRetryAfterHeader(value: unknown): string | undefined;
  getLogUrl(url?: string): string | undefined;
};

function createErrorInterceptorPrivates(): ErrorInterceptorPrivates {
  const retryStrategy: RetryStrategy = {
    getIsRetryable: () => true,
    shouldRetry: () => true,
    getDelay: () => 0,
  };
  const handler = new ErrorInterceptorHandler({
    axiosInstance: { request: jest.fn() } as never,
    logger: {
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
    } as Logger,
    requestLifecycle: { removeById: jest.fn() } as never,
    dependencyGatekeeper: { finishBlockingRequest: jest.fn() } as never,
    requestQueue: { markComplete: jest.fn() } as never,
    retryScheduler: {
      getRetryDelay: jest.fn().mockReturnValue(0),
      waitForRetryDelay: jest.fn().mockResolvedValue(true),
    } as never,
    retryStrategy,
    emitEvent: jest.fn(),
    markRetryProcessStart: jest.fn(),
    handleRetryProcessFinish: jest.fn(),
    retries: 3,
    mode: RETRY_MODES.AUTOMATIC,
    throwErrorOnFailedRetries: true,
    throwErrorOnCancelRequest: true,
  });
  return handler as unknown as ErrorInterceptorPrivates;
}

describe('Codecov patch coverage helpers', () => {
  describe('ErrorInterceptorHandler — Retry-After and log URL branches', () => {
    it('parses Retry-After from plain object headers (no .get)', () => {
      const priv = createErrorInterceptorPrivates();
      expect(priv.getRetryAfterHeader(undefined)).toBeUndefined();
      expect(priv.getRetryAfterHeader({})).toBeUndefined();
      expect(priv.getRetryAfterHeader({ 'Retry-After': ['2'] })).toBe('2');
      expect(priv.getRetryAfterHeader({ 'retry-after': [] })).toBeUndefined();
      expect(priv.getRetryAfterHeader({ 'retry-after': 30 })).toBe('30');
    });

    it('normalizes Retry-After header value shapes', () => {
      const priv = createErrorInterceptorPrivates();
      expect(priv.normalizeRetryAfterHeader(['5'])).toBe('5');
      expect(priv.normalizeRetryAfterHeader([])).toBeUndefined();
      expect(priv.normalizeRetryAfterHeader(120)).toBe('120');
      expect(priv.normalizeRetryAfterHeader({})).toBeUndefined();
    });

    it('strips query and hash from log URLs', () => {
      const priv = createErrorInterceptorPrivates();
      expect(priv.getLogUrl(undefined)).toBeUndefined();
      expect(priv.getLogUrl('/path')).toBe('/path');
      expect(priv.getLogUrl('/path?q=1')).toBe('/path');
      expect(priv.getLogUrl('/path#frag')).toBe('/path');
      expect(priv.getLogUrl('/path?q=1#frag')).toBe('/path');
      expect(priv.getLogUrl('/path#frag?q=1')).toBe('/path');
    });
  });

  describe('RequestQueue — constructor validation', () => {
    it('rejects non-integer queueDelay', () => {
      expect(() => new RequestQueue({ queueDelay: 1.5 })).toThrow(RetryerConfigError);
    });

    it('rejects invalid maxQueueSize when provided', () => {
      expect(() => new RequestQueue({ maxQueueSize: 0 })).toThrow(RetryerConfigError);
    });
  });

  describe('ManualRetryPlugin — max age and clearStoredRequests', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('discards expired stored configs on retryFailedRequests', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manual = new ManualRetryPlugin({ manualRetryMaxAge: 1_000, maxRequestsToStore: 10 });
      const manager = new RetryManager({
        axiosInstance,
        mode: 'manual',
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });
      manager.use(manual);

      let wall = 10_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => wall);

      mock.onGet('/stale').reply(503);

      await axiosInstance.get('/stale').catch(() => undefined);
      expect(manual.getStoredRequests().length).toBe(1);

      wall = 10_000 + 2_000;
      await expect(manual.retryFailedRequests()).resolves.toEqual([]);
      nowSpy.mockRestore();

      mock.restore();
      manager.destroy();
    });

    it('clearStoredRequests empties the store', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manual = new ManualRetryPlugin({ maxRequestsToStore: 10 });
      const manager = new RetryManager({
        axiosInstance,
        mode: 'manual',
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });
      manager.use(manual);
      mock.onGet('/x').reply(503);
      await axiosInstance.get('/x').catch(() => undefined);
      expect(manual.getStoredRequests().length).toBe(1);
      manual.clearStoredRequests();
      expect(manual.getStoredRequests().length).toBe(0);
      mock.restore();
      manager.destroy();
    });

    it('neutralizeDefaultAuthHeaders sets config.auth undefined when defaults.auth is set', () => {
      const axiosInstance = axios.create();
      axiosInstance.defaults.auth = { username: 'u', password: 'p' };
      const manual = new ManualRetryPlugin({ maxRequestsToStore: 10 });
      const manager = new RetryManager({
        axiosInstance,
        mode: 'manual',
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });
      manager.use(manual);

      const cfg: AxiosRequestConfig = { url: '/r', headers: {} };
      (manual as unknown as { neutralizeDefaultAuthHeaders(c: AxiosRequestConfig): void }).neutralizeDefaultAuthHeaders(
        cfg,
      );
      expect(cfg.auth).toBeUndefined();

      manager.destroy();
    });
  });

  describe('CircuitBreakerPlugin — edge branches', () => {
    it('response error interceptor rejects when error has no config', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const plugin = new CircuitBreakerPlugin({ failureThreshold: 2, openTimeout: 60_000 });
      const manager = {
        axiosInstance,
        getLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }),
        triggerAndEmit: jest.fn(),
      } as never;
      plugin.initialize(manager as never);

      mock.onGet('/cb').reply(() => {
        const err = new AxiosError('no cfg');
        delete (err as { config?: unknown }).config;
        throw err;
      });

      await expect(axiosInstance.get('/cb')).rejects.toThrow('no cfg');
      mock.restore();
    });

    it('_emitStateChange is a no-op when from === to', () => {
      const axiosInstance = axios.create();
      const plugin = new CircuitBreakerPlugin({ failureThreshold: 2, openTimeout: 60_000 });
      const triggerAndEmit = jest.fn();
      const manager = {
        axiosInstance,
        getLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }),
        triggerAndEmit,
      } as never;
      plugin.initialize(manager as never);
      (plugin as unknown as { _emitStateChange: (...a: unknown[]) => void })._emitStateChange(
        'scope',
        CIRCUIT_BREAKER_STATES.CLOSED,
        CIRCUIT_BREAKER_STATES.CLOSED,
        'manual-reset',
      );
      expect(triggerAndEmit).not.toHaveBeenCalled();
    });

    it('_resolveScopeKey falls back when custom scope returns empty string', () => {
      const axiosInstance = axios.create();
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
        openTimeout: 60_000,
        scope: () => '',
      });
      const manager = {
        axiosInstance,
        getLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }),
        triggerAndEmit: jest.fn(),
      } as never;
      plugin.initialize(manager as never);
      const key = (
        plugin as unknown as { _resolveScopeKey: (c: unknown, u: string, h?: string) => string }
      )._resolveScopeKey({ url: 'https://example.com/api' }, '/api', 'example.com');
      expect(key).toBe('example.com/api');
    });

    it('_resolveScopeKey falls back when custom scope throws', () => {
      const axiosInstance = axios.create();
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 2,
        openTimeout: 60_000,
        scope: () => {
          throw new Error('scope-boom');
        },
      });
      const manager = {
        axiosInstance,
        getLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() }),
        triggerAndEmit: jest.fn(),
      } as never;
      plugin.initialize(manager as never);
      const key = (
        plugin as unknown as { _resolveScopeKey: (c: unknown, u: string, h?: string) => string }
      )._resolveScopeKey({ url: '/only-path' }, '/only-path', undefined);
      expect(key).toBe('/only-path');
    });
  });

  describe('TokenRefreshPlugin — header helpers via AxiosHeaders', () => {
    it('401 refresh flow with plain-object Authorization header (object.entries path)', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => ({ token: 'fresh-plain' }));
      const plugin = new TokenRefreshPlugin(refreshFn, { refreshTimeout: 5000 } as TokenRefreshPluginOptions);
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });
      manager.use(plugin);

      mock.onGet('/plain').replyOnce(401);
      mock.onGet('/plain').replyOnce(200, { ok: true });

      await axiosInstance.get('/plain', { headers: { authorization: 'Bearer stale-plain' } });

      expect(refreshFn).toHaveBeenCalled();
      expect(mock.history.get).toHaveLength(2);

      mock.restore();
      manager.destroy();
    });

    it('request path exercises AxiosHeaders.set Authorization merge before dispatch', async () => {
      const axiosInstance = axios.create();
      axiosInstance.defaults.headers.common.Authorization = 'Bearer default-token';
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => ({ token: 'refreshed' }));
      const plugin = new TokenRefreshPlugin(refreshFn, { refreshTimeout: 5000 } as TokenRefreshPluginOptions);
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });
      manager.use(plugin);

      const headers = new AxiosHeaders();
      headers.set('Authorization', 'Bearer default-token');

      mock.onGet('/hdr').reply(200, { ok: true });

      await axiosInstance.get('/hdr', { headers });

      expect(mock.history.get).toHaveLength(1);

      mock.restore();
      manager.destroy();
    });

    it('customErrorDetector path records warn when detector throws', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const warn = jest.fn();
      const refreshFn = jest.fn(async () => ({ token: 't' }));
      const plugin = new TokenRefreshPlugin(refreshFn, {
        refreshTimeout: 5000,
        customErrorDetector: () => {
          throw new Error('detector-fail');
        },
      } as TokenRefreshPluginOptions);
      const manager = {
        axiosInstance,
        getLogger: () => ({ debug: jest.fn(), warn, error: jest.fn(), log: jest.fn() }),
        releaseRequestTracking: jest.fn(),
        triggerAndEmit: jest.fn(),
      } as never;
      plugin.initialize(manager as never);

      mock.onGet('/body').reply(200, { auth: 'bad' });
      await axiosInstance.get('/body');

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('customErrorDetector threw'),
        expect.objectContaining({ error: 'detector-fail' }),
      );

      mock.restore();
    });
  });
});
