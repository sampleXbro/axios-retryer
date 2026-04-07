// @ts-nocheck
import axios, { AxiosError } from 'axios';

import { RetryManager } from '../src';
import { EventBus } from '../src/core/EventBus';
import { RetryScheduler, parseRetryAfterMs } from '../src/core/RetryScheduler';
import { RetryLogger } from '../src/services/logger';
import { AXIOS_RETRYER_REQUEST_PRIORITIES, RETRY_MODES } from '../src/types';
import { CachingPlugin } from '../src/plugins/CachingPlugin';
import {
  CircuitBreakerPlugin,
  CIRCUIT_BREAKER_STATES,
  CircuitBreakerState,
} from '../src/plugins/CircuitBreakerPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import { InMemoryRequestStore } from '../src/store/InMemoryRequestStore';
import { assignRequestMetadata, getRequestMetadata } from '../src/utils/requestMetadata';
import { sanitizeData, sanitizeHeaders, sanitizeUrl } from '../src/plugins/DebugSanitizationPlugin/sanitize';

describe('Targeted Coverage Regressions', () => {
  const managers: RetryManager[] = [];

  afterEach(() => {
    managers.splice(0).forEach((manager) => manager.destroy());
    jest.restoreAllMocks();
  });

  const trackManager = (manager: RetryManager): RetryManager => {
    managers.push(manager);
    return manager;
  };

  describe('RetryScheduler', () => {
    test('parses numeric and date retry-after headers', () => {
      expect(parseRetryAfterMs('2')).toBe(2000);
      expect(parseRetryAfterMs('not-a-date')).toBe(0);

      // +2100ms ensures the raw ms delta is >= 1000ms after UTC-string second-truncation.
      const future = new Date(Date.now() + 2100).toUTCString();
      expect(parseRetryAfterMs(future)).toBeGreaterThanOrEqual(1000);
    });

    test('cancels retry delays and reports timer state', async () => {
      const scheduler = new RetryScheduler(
        new RetryLogger(true),
        {
          getDelay: () => 50,
          getIsRetryable: () => true,
          shouldRetry: () => true,
        },
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const debugSpy = jest.spyOn(console, 'debug').mockImplementation();

      const config = {};
      assignRequestMetadata(config, { requestId: 'retry-1', retryAfterMs: 120 });

      expect(scheduler.getRetryDelay(config, 1, 3)).toBe(120);
      expect(scheduler.getTimerStats().activeRetryTimers).toBe(0);

      const waitPromise = scheduler.waitForRetryDelay(config, 500);
      expect(scheduler.getTimerStats().activeRetryTimers).toBe(1);
      expect(scheduler.cancelRetryTimer('retry-1')).toBe(true);
      expect(await waitPromise).toBe(false);
      expect(scheduler.cancelRetryTimer('missing')).toBe(false);

      await scheduler.wait(1);
      expect(warnSpy).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Cancelled retry timer', { requestId: 'retry-1' });

      scheduler.destroy();
      expect(scheduler.getTimerStats()).toEqual({ activeRetryTimers: 0, activeTimers: 0 });
    });

    test('completes retry waits and cancels all active retry timers', async () => {
      const scheduler = new RetryScheduler(
        new RetryLogger(true),
        {
          getDelay: () => 5,
          getIsRetryable: () => true,
          shouldRetry: () => true,
        },
      );
      const debugSpy = jest.spyOn(console, 'debug').mockImplementation();

      const completedConfig = {};
      assignRequestMetadata(completedConfig, { requestId: 'completed-delay' });
      await expect(scheduler.waitForRetryDelay(completedConfig, 1)).resolves.toBe(true);

      const firstPending = {};
      const secondPending = {};
      assignRequestMetadata(firstPending, { requestId: 'pending-1' });
      assignRequestMetadata(secondPending, { requestId: 'pending-2' });
      const pendingOne = scheduler.waitForRetryDelay(firstPending, 1000);
      const pendingTwo = scheduler.waitForRetryDelay(secondPending, 1000);

      expect(scheduler.getTimerStats().activeRetryTimers).toBe(2);
      scheduler.cancelAllRetryTimers();

      await expect(pendingOne).resolves.toBe(false);
      await expect(pendingTwo).resolves.toBe(false);
      expect(debugSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Cancelled retry timer', { requestId: 'pending-1' });
      expect(debugSpy).toHaveBeenCalledWith('[AXIOS_RETRYER] Cancelled retry timer', { requestId: 'pending-2' });
      scheduler.destroy();
    });
  });

  describe('EventBus', () => {
    test('emits events to registered listeners', () => {
      const logger = new RetryLogger(true);
      const listener = jest.fn();

      const bus = new EventBus(logger);

      const config = {};
      assignRequestMetadata(config, { requestId: 'event-1' });

      bus.on('beforeRetry', listener);
      bus.emit('beforeRetry', config);

      expect(listener).toHaveBeenCalledWith(config);
    });

    test('handles listener failures without crashing other listeners', () => {
      const logger = new RetryLogger(true);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const bus = new EventBus(logger);

      const faultyListener = () => {
        throw new Error('listener-boom');
      };
      const survivingListener = jest.fn();

      expect(bus.off('beforeRetry', survivingListener)).toBe(false);
      bus.on('beforeRetry', faultyListener);
      bus.on('beforeRetry', survivingListener);
      bus.emit('beforeRetry', {});

      expect(survivingListener).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      expect(bus.off('beforeRetry', survivingListener)).toBe(true);
      bus.clear();
      bus.emit('beforeRetry', {});
    });
  });

  describe('Sanitize Utilities', () => {
    test('redacts unsupported values while cloning allowlisted dates', () => {
      const createdAt = new Date('2025-01-01T00:00:00.000Z');
      const sanitized = sanitizeData(
        {
          createdAt,
          passwordUpdatedAt: createdAt,
          secret: 'value',
        },
        {
          allowedFields: ['createdAt'],
        },
      );

      expect(sanitized.createdAt).toEqual(createdAt);
      expect(sanitized.createdAt).not.toBe(createdAt);
      expect(sanitized.passwordUpdatedAt).toBe('********');
      expect(sanitized.secret).toBe('********');
    });

    test('handles header substring matches and url fragments', () => {
      expect(
        sanitizeHeaders(
          {
            'X-Client-Secret-Id': 'abc123',
            'Content-Type': 'application/json',
          },
          { redactionChar: '#' },
        ),
      ).toEqual({
        'Content-Type': 'application/json',
        'X-Client-Secret-Id': '########',
      });

      expect(sanitizeUrl('/users?token=secret#details')).toBe('/users?token=********#details');
    });
  });

  describe('RetryManager', () => {
    test.each([
      [{ maxConcurrentRequests: 0 }, 'maxConcurrentRequests must be a positive integer'],
      [{ maxQueueSize: 0 }, 'maxQueueSize must be a positive integer'],
      [{ queueDelay: -1 }, 'queueDelay must be a non-negative integer'],
    ])('validates numeric options %p', (options, message) => {
      expect(() => new RetryManager(options)).toThrow(message);
    });



    test('returns null when a retry delay is cancelled and throwing is disabled', async () => {
      const manager = trackManager(new RetryManager({ throwErrorOnCancelRequest: false }));
      jest.spyOn(manager['retryScheduler'], 'waitForRetryDelay').mockResolvedValue(false);

      const config = {};
      assignRequestMetadata(config, {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
        requestId: 'retry-cancelled',
        timestamp: Date.now(),
      });

      await expect((manager as any).errorInterceptorHandler['scheduleRetry'](config, 1, 3)).resolves.toBeNull();
      expect(getRequestMetadata(config)?.isRetrying).toBe(false);
    });

    test('rejects queue-cancelled retries without relying on core replay state', async () => {
      const manager = trackManager(new RetryManager());
      jest.spyOn(manager['retryScheduler'], 'waitForRetryDelay').mockResolvedValue(true);

      const config = {};
      assignRequestMetadata(config, {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
        requestId: 'queue-cancelled',
        timestamp: Date.now(),
      });

      await expect((manager as any).errorInterceptorHandler['scheduleRetry'](config, 1, 3, true)).rejects.toThrow('Request aborted. ID: queue-cancelled');
    });

    test('auto-retries with retry-after headers through the scheduler path', async () => {
      const manager = trackManager(new RetryManager());
      const scheduleSpy = jest.spyOn((manager as any).errorInterceptorHandler, 'scheduleRetry' as never).mockResolvedValue({ status: 200 } as never);
      (manager as any).errorInterceptorHandler['options'].retryStrategy = {
        getDelay: () => 100,
        getIsRetryable: () => true,
        shouldRetry: () => true,
      };

      const config = {};
      assignRequestMetadata(config, {
        requestId: 'retry-after',
        requestMode: RETRY_MODES.AUTOMATIC,
      });

      const error = new AxiosError('retryable', 'ERR_BAD_RESPONSE', config, null, {
        config,
        data: {},
        headers: { 'retry-after': '2' },
        status: 503,
        statusText: 'Server Error',
      } as never);

      await (manager as any).errorInterceptorHandler['handleError'](error);

      expect(getRequestMetadata(config)?.retryAfterMs).toBe(2000);
      expect(scheduleSpy).toHaveBeenCalledWith(config, 1, manager['retries'], false);
    });

    test('handles terminal critical offline failures without throwing when configured', async () => {
      const manager = trackManager(new RetryManager({
        throwErrorOnFailedRetries: false,
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      }));
      const internetListener = jest.fn();
      const blockingListener = jest.fn();

      manager.on('onInternetConnectionError', internetListener);
      manager.on('onBlockingRequestFailed', blockingListener);

      const config = {};
      assignRequestMetadata(config, {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
        requestId: 'critical-offline',
        retryAttempt: 2,
      });

      const error = new AxiosError('offline', 'ERR_NETWORK', config);

      await expect((manager as any).errorInterceptorHandler['handleNoRetriesAction'](error, false)).resolves.toBeNull();
      expect(internetListener).toHaveBeenCalledWith(config);
      expect(blockingListener).toHaveBeenCalledWith(config);
    });

    test('cancels active requests', () => {
      const manager = trackManager(new RetryManager());

      const abortController = new AbortController();
      manager['requestLifecycle']['activeRequests'].set('cancel-me', abortController);
      const cancelQueuedSpy = jest.spyOn(manager['requestQueue'], 'cancelQueuedRequest').mockReturnValue(true);
      const retryTimerSpy = jest.spyOn(manager['retryScheduler'], 'cancelRetryTimer').mockReturnValue(true);
      const cancelListener = jest.fn();
      manager.on('onRequestCancelled', cancelListener);

      manager.cancelRequest('cancel-me');

      expect(abortController.signal.aborted).toBe(true);
      expect(cancelQueuedSpy).toHaveBeenCalledWith('cancel-me');
      expect(retryTimerSpy).toHaveBeenCalledWith('cancel-me');
      expect(cancelListener).toHaveBeenCalledWith('cancel-me');
    });

    test('builds safe request and error log metadata', () => {
      const manager = trackManager(new RetryManager());
      const config = {
        method: 'post',
        url: '/users?token=secret#details',
      };
      assignRequestMetadata(config, {
        requestId: 'loggable',
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
        isRetrying: true,
      });

      expect((manager as any).requestInterceptorHandler['buildRequestLogMeta'](config, 'loggable')).toEqual({
        method: 'POST',
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
        requestId: 'loggable',
        url: '/users',
      });

      expect(
        (manager as any).errorInterceptorHandler['buildErrorMeta'](
          config,
          new AxiosError('boom', 'ERR_TEST', config, null, {
            config,
            data: {},
            headers: {},
            status: 500,
            statusText: 'Server Error',
          } as never),
        ),
      ).toEqual({
        code: 'ERR_TEST',
        message: 'boom',
        method: 'POST',
        requestId: 'loggable',
        retrying: true,
        status: 500,
        statusText: 'Server Error',
        url: '/users',
      });

      expect((manager as any).requestInterceptorHandler['getLogUrl']('/users#details')).toBe('/users');
      expect((manager as any).requestInterceptorHandler['getLogUrl']('/users')).toBe('/users');
    });

    test('retries stored requests selectively through ManualRetryPlugin', async () => {
      const beforeManualRetry = jest.fn((config) => {
        return config.url === '/skip-me' ? null : config;
      });
      const requestStore = new InMemoryRequestStore();
      const manager = trackManager(new RetryManager());
      const manualRetry = new ManualRetryPlugin({
        beforeRetry: beforeManualRetry,
        requestStore,
      });
      manager.use(manualRetry);

      const replayable = { method: 'get', url: '/replay-me' };
      const skipped = { method: 'get', url: '/skip-me' };
      assignRequestMetadata(replayable, { requestId: 'replay-me', timestamp: Date.now() });
      assignRequestMetadata(skipped, { requestId: 'skip-me', timestamp: Date.now() });
      requestStore.add(replayable);
      requestStore.add(skipped);
      const requestSpy = jest.spyOn(manager.axiosInstance, 'request').mockResolvedValue({
        config: replayable as never,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      });

      const responses = await manualRetry.retryFailedRequests();

      expect(responses).toHaveLength(1);
      expect(beforeManualRetry).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenCalledWith(replayable);
    });

    test('clears active lifecycle state on cancelAllRequests', () => {
      const manager = trackManager(new RetryManager());
      const abortController = new AbortController();
      manager['requestLifecycle']['activeRequests'].set('active', abortController);
      const cancelAllRetryTimersSpy = jest.spyOn(manager['retryScheduler'], 'cancelAllRetryTimers').mockImplementation();

      manager.cancelAllRequests();

      expect(abortController.signal.aborted).toBe(true);
      expect(cancelAllRetryTimersSpy).toHaveBeenCalled();
    });
  });

  describe('CircuitBreakerPlugin', () => {
    test('validates options and clamps success threshold to half-open max', () => {
      expect(() => new CircuitBreakerPlugin({ failureThreshold: 0 })).toThrow('failureThreshold must be a positive integer');
      expect(() => new CircuitBreakerPlugin({ openTimeout: -1 })).toThrow('openTimeout must be a non-negative integer');
      expect(() => new CircuitBreakerPlugin({ halfOpenMax: 0 })).toThrow('halfOpenMax must be a positive integer');
      expect(() => new CircuitBreakerPlugin({ successThreshold: 0 })).toThrow('successThreshold must be a positive integer');

      const plugin = new CircuitBreakerPlugin({ halfOpenMax: 1, successThreshold: 3 });
      expect(plugin['_options'].successThreshold).toBe(1);
    });

    test('normalizes scoped urls, exclusions, adaptive timeouts, and reset state', async () => {
      const stateAdapter = {
        get: jest.fn().mockResolvedValue(undefined),
        set: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      };
      const plugin = new CircuitBreakerPlugin({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 2,
        excludeUrls: ['/health', /^\/metrics/],
        scope: 'host+url',
        stateAdapter,
      });
      const logger = {
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      };

      plugin['_context'] = {
        axiosInstance: axios.create({ baseURL: 'https://api.example.com' }),
        getLogger: () => logger,
      };

      expect(plugin['_normalizeUrl']('/users/123?x=1#test')).toBe('/users/:id');
      expect(plugin['_isUrlExcluded']({ url: '/health' })).toBe(true);
      expect(plugin['_isUrlExcluded']({ url: '/metrics/cpu' })).toBe(true);
      expect(plugin['_isUrlExcluded']({ url: '/users/123' })).toBe(false);

      const scope = plugin['_getScopeDetails']({ url: '/users/123?x=1', baseURL: 'https://api.example.com' });
      expect(scope).toEqual({
        host: 'api.example.com',
        normalizedUrl: '/users/:id',
        scopeKey: 'api.example.com/users/:id',
      });

      assignRequestMetadata(scope as never, {});
      plugin['_trackResponseTime']({
        config: { url: '/users/123', baseURL: 'https://api.example.com' },
        data: {},
        headers: { 'x-response-time': '150' },
        status: 200,
        statusText: 'OK',
      });
      plugin['_trackResponseTime']({
        config: { url: '/users/456', baseURL: 'https://api.example.com' },
        data: {},
        headers: {},
        status: 200,
        statusText: 'OK',
      });

      const metrics = plugin.getMetrics();
      expect(metrics.adaptiveTimeouts).toHaveLength(1);
      expect(metrics.adaptiveTimeouts[0].timeoutMs).toBeGreaterThanOrEqual(150);

      plugin['_knownScopes'].set('api.example.com/users/:id', scope);
      plugin['_reset']('api.example.com/users/:id');
      expect(stateAdapter.set).toHaveBeenCalled();
      expect(plugin.getState('api.example.com/users/:id')).toBe(CIRCUIT_BREAKER_STATES.CLOSED);
    });

    test('creates circuit errors with remembered failure details', () => {
      const plugin = new CircuitBreakerPlugin();
      const circuitError = plugin['_createCircuitStateError'](
        { url: '/users/1' },
        {
          failureCount: 1,
          halfOpenCount: 0,
          lastFailureCode: 'ECONNRESET',
          lastFailureStatus: 503,
          nextAttempt: Date.now(),
          recentFailures: [],
          state: CIRCUIT_BREAKER_STATES.OPEN,
          successCount: 0,
        },
        'Circuit is open',
      );

      expect(circuitError.code).toBe('ECONNRESET');
      expect(circuitError.response?.status).toBe(503);
      expect(getRequestMetadata(circuitError.config)?.requestRetries).toBe(0);
    });
  });

  describe('CachingPlugin', () => {
    test.each([
      [{ cleanupInterval: -1 }, 'cleanupInterval must be a non-negative integer'],
      [{ maxAge: -1 }, 'maxAge must be a non-negative integer'],
      [{ maxItems: -1 }, 'maxItems must be a non-negative integer'],
      [{ timeToRevalidate: -1 }, 'timeToRevalidate must be a non-negative integer'],
    ])('validates cache options %p', (options, message) => {
      expect(() => new CachingPlugin(options)).toThrow(message);
    });

    test('handles async storage failures and inflight followers', async () => {
      const logger = {
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      };
      const storage = {
        clear: jest.fn(),
        delete: jest.fn(),
        entries: jest.fn().mockResolvedValue([]),
        get: jest.fn()
          .mockRejectedValueOnce(new Error('storage-read-failed'))
          .mockResolvedValue(undefined),
        set: jest.fn(),
      };
      const plugin = new CachingPlugin({ storage });
      plugin['context'] = { getLogger: () => logger, triggerAndEmit: jest.fn() };

      const firstConfig = { url: '/users', method: 'get' };
      expect(await plugin['handleRequest'](firstConfig)).toBe(firstConfig);
      expect(logger.warn).toHaveBeenCalled();

      const inflightResponse = Promise.resolve({
        config: { url: '/users', method: 'get' },
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      });
      plugin['inflightRequests'].set('GET|/users|||', {
        promise: inflightResponse,
        reject: jest.fn(),
        resolve: jest.fn(),
      });

      const followerConfig = await plugin['handleRequest']({ url: '/users', method: 'get' });
      expect(typeof followerConfig.adapter).toBe('function');
      await expect(followerConfig.adapter()).resolves.toMatchObject({ data: { ok: true } });
    });

    test('supports promise-based cache clearing and invalidation helpers', async () => {
      const storageMap = new Map();
      const storage = {
        clear: jest.fn().mockImplementation(async () => {
          storageMap.clear();
        }),
        delete: jest.fn().mockImplementation(async (key) => {
          storageMap.delete(key);
        }),
        entries: jest.fn().mockImplementation(async () =>
          Array.from(storageMap, ([key, value]) => ({ key, value })),
        ),
        get: jest.fn().mockImplementation(async (key) => storageMap.get(key)),
        set: jest.fn().mockImplementation(async (key, value) => {
          storageMap.set(key, value);
        }),
      };
      const plugin = new CachingPlugin({
        dedupeConcurrentRequests: false,
        storage,
      });
      plugin['context'] = {
        getLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), log: jest.fn() }),
        triggerAndEmit: jest.fn(),
      };

      const passthroughConfig = { url: '/passthrough', method: 'get' };
      expect(await plugin['handleRequest'](passthroughConfig)).toBe(passthroughConfig);
      expect(() => plugin['generateCacheKey']({ method: 'get' })).toThrow('URL is required for cache key generation');

      const response = {
        config: { url: '/users/1', method: 'get' },
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      };
      storageMap.set('GET|/users/1|||', { response, timestamp: Date.now() });
      storageMap.set('GET|/users/2|||', { response, timestamp: Date.now() });

      await expect(plugin.clearCache()).resolves.toBeUndefined();
      storageMap.set('GET|/users/1|||', { response, timestamp: Date.now() });
      storageMap.set('GET|/users/2|||', { response, timestamp: Date.now() });
      await expect(plugin.invalidateCache({ prefix: 'GET|/users' })).resolves.toBe(2);
      expect(storage.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('TokenRefreshPlugin', () => {
    test('validates constructor options and short-circuits non-refreshable errors', async () => {
      expect(
        () => new TokenRefreshPlugin(async () => ({ token: 'fresh' }), { maxRefreshAttempts: 0 }),
      ).toThrow('maxRefreshAttempts must be a positive integer');

      const plugin = new TokenRefreshPlugin(async () => ({ token: 'fresh' }), {
        refreshStatusCodes: [401],
      });
      plugin['context'] = { releaseRequestTracking: jest.fn() };

      await expect(plugin['handleResponseError'](new AxiosError('missing-config'))).rejects.toMatchObject({
        message: 'missing-config',
      });

      const refreshRequest = {};
      assignRequestMetadata(refreshRequest, { isRetryRefreshRequest: true });
      await expect(plugin['handleResponseError'](new AxiosError('refresh', 'ERR', refreshRequest))).rejects.toMatchObject({
        message: 'refresh',
      });

      const nonRefreshable = new AxiosError('forbidden', 'ERR_BAD_RESPONSE', {}, null, {
        config: {},
        data: {},
        headers: {},
        status: 403,
        statusText: 'Forbidden',
      });
      await expect(plugin['handleResponseError'](nonRefreshable)).rejects.toMatchObject({
        message: 'forbidden',
      });
    });

    test('updates auth headers and clears queued requests on refresh failure', async () => {
      const plugin = new TokenRefreshPlugin(async () => ({ token: 'fresh' }));
      const triggerAndEmit = jest.fn();
      const defaults = { headers: { common: {} } };

      plugin['context'] = {
        axiosInstance: { defaults },
        triggerAndEmit,
        releaseRequestTracking: jest.fn(),
      };
      plugin['logger'] = {
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      };

      plugin['updateAuthHeader']('fresh');
      expect(defaults.headers.common.Authorization).toBe('Bearer fresh');

      const resolveConfig = jest.fn();
      const holdConfig = { headers: {} as Record<string, string> };
      plugin['refreshQueue'] = [
        {
          kind: 'hold-request',
          config: holdConfig,
          resolveConfig,
          reject: jest.fn(),
        },
      ];
      plugin['flushQueuedWithToken']('next-token');
      expect(resolveConfig).toHaveBeenCalledWith(holdConfig);
      expect(holdConfig.headers.Authorization).toBe('Bearer next-token');
      expect(plugin['refreshQueue']).toEqual([]);

      let rejectedError;
      await new Promise((resolve) => {
        plugin['refreshQueue'] = [
          {
            kind: 'hold-request',
            config: {},
            resolveConfig: jest.fn(),
            reject: (error) => {
              rejectedError = error;
              resolve(undefined);
            },
          },
        ];
        plugin['handleRefreshFailure']();
      });

      expect(rejectedError.message).toBe('Token refresh failed');
      expect(rejectedError).toMatchObject({
        code: 'TOKEN_REFRESH_FAILED',
        config: {},
      });
      expect(triggerAndEmit).toHaveBeenCalledWith('onTokenRefreshFailed');
      expect(plugin['logger'].error).toHaveBeenCalled();
      expect(plugin['refreshQueue']).toEqual([]);
    });
  });
});
