import type { AxiosRequestConfig } from 'axios';

import { DependencyGatekeeper } from '../src/core/DependencyGatekeeper';
import { EventBus } from '../src/core/EventBus';
import { PluginRegistry } from '../src/core/PluginRegistry';
import { RequestLifecycleManager } from '../src/core/RequestLifecycleManager';
import type { RequestQueue } from '../src/core/requestQueue';
import { RetryLogger } from '../src/services/logger';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../src/types';
import type { Logger, PluginContext, RetryPlugin } from '../src/types';
import { assignRequestMetadata } from '../src/utils/requestMetadata';

describe('PR patch coverage — core components', () => {
  describe('RequestLifecycleManager', () => {
    function createManager(): {
      lifecycle: RequestLifecycleManager;
      requestQueue: {
        cancelQueuedRequest: jest.Mock<boolean, [string]>;
        getWaitingCount: jest.Mock<number, []>;
      };
      retryScheduler: {
        cancelRetryTimer: jest.Mock;
        cancelAllRetryTimers: jest.Mock;
        getTimerStats: jest.Mock;
      };
      onRequestCancelled: jest.Mock<void, [string]>;
    } {
      const requestQueue = {
        cancelQueuedRequest: jest.fn().mockReturnValue(false),
        getWaitingCount: jest.fn().mockReturnValue(3),
      };
      const retryScheduler = {
        cancelRetryTimer: jest.fn(),
        cancelAllRetryTimers: jest.fn(),
        getTimerStats: jest.fn().mockReturnValue({ activeRetryTimers: 2, activeTimers: 1 }),
      };
      const onRequestCancelled = jest.fn();
      const lifecycle = new RequestLifecycleManager({
        logger: new RetryLogger(false),
        requestQueue: requestQueue as unknown as RequestQueue,
        retryScheduler: retryScheduler as never,
        onRequestCancelled,
      });
      return { lifecycle, requestQueue, retryScheduler, onRequestCancelled };
    }

    test('beginRequest assigns generated id when metadata has no requestId', () => {
      const { lifecycle } = createManager();
      const config: AxiosRequestConfig = { url: '/x' };
      const { requestId } = lifecycle.beginRequest(config);
      expect(requestId).toMatch(/^req_/);
      expect(config.signal).toBeDefined();
    });

    test('beginRequest links already-aborted caller signal without addEventListener', () => {
      const { lifecycle } = createManager();
      const config: AxiosRequestConfig = {
        url: '/x',
        signal: AbortSignal.abort('reason'),
      };
      const result = lifecycle.beginRequest(config);
      expect(result.callerAborted).toBe(true);
    });

    test('beginRequest ignores caller signal that lacks event listener APIs', () => {
      const { lifecycle } = createManager();
      const pseudoSignal = { aborted: false } as AbortSignal;
      const config: AxiosRequestConfig = { url: '/x', signal: pseudoSignal };
      expect(() => lifecycle.beginRequest(config)).not.toThrow();
    });

    test('release returns released false when config has no requestId', () => {
      const { lifecycle } = createManager();
      expect(lifecycle.release({ url: '/noid' })).toEqual({ released: false });
    });

    test('cancelAllRequests logs timer stats and clears active tracking', () => {
      const warn = jest.fn();
      const requestQueue = {
        cancelQueuedRequest: jest.fn().mockReturnValue(false),
        getWaitingCount: jest.fn().mockReturnValue(3),
      };
      const retryScheduler = {
        cancelRetryTimer: jest.fn(),
        cancelAllRetryTimers: jest.fn(),
        getTimerStats: jest.fn().mockReturnValue({ activeRetryTimers: 2, activeTimers: 1 }),
      };
      const onRequestCancelled = jest.fn();
      const lifecycle = new RequestLifecycleManager({
        logger: { debug: jest.fn(), error: jest.fn(), log: jest.fn(), warn } as Logger,
        requestQueue: requestQueue as unknown as RequestQueue,
        retryScheduler: retryScheduler as never,
        onRequestCancelled,
      });
      const ac = new AbortController();
      lifecycle['activeRequests'].set('a1', ac as never);
      lifecycle['activeConfigs'].set('a1', {});

      lifecycle.cancelAllRequests();

      expect(warn).toHaveBeenCalledWith(
        'Cancelling all requests',
        expect.objectContaining({
          activeCount: 1,
          queuedCount: 3,
          activeRetryTimers: 2,
        }),
      );
      expect(requestQueue.cancelQueuedRequest).toHaveBeenCalledWith('a1');
      expect(onRequestCancelled).toHaveBeenCalledWith('a1');
      expect(retryScheduler.cancelAllRetryTimers).toHaveBeenCalled();
      expect(lifecycle.getActiveCount()).toBe(0);
    });

    test('cancelQueuedRequests notifies when queue cancels a matching id', () => {
      const { lifecycle, requestQueue, onRequestCancelled } = createManager();
      requestQueue.cancelQueuedRequest.mockReturnValueOnce(true);
      lifecycle['activeRequests'].set('q1', new AbortController() as never);

      lifecycle.cancelQueuedRequests();

      expect(onRequestCancelled).toHaveBeenCalledWith('q1');
    });

    test('generateRequestId falls back when crypto has no randomUUID or getRandomValues', () => {
      const { lifecycle } = createManager();
      const origCrypto = globalThis.crypto;
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: {},
      });
      try {
        const id = lifecycle['generateRequestId']();
        expect(id).toMatch(/^req_/);
      } finally {
        Object.defineProperty(globalThis, 'crypto', {
          configurable: true,
          value: origCrypto,
        });
      }
    });

    test('generateRequestId uses getRandomValues when randomUUID is missing', () => {
      const { lifecycle } = createManager();
      const origCrypto = globalThis.crypto;
      const getRandomValues = jest.fn((arr: Uint32Array) => {
        arr[0] = 100;
        arr[1] = 200;
        return arr;
      });
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: { getRandomValues },
      });
      try {
        const id = lifecycle['generateRequestId']();
        expect(getRandomValues).toHaveBeenCalled();
        expect(id.startsWith('req_2s5k_')).toBe(true);
      } finally {
        Object.defineProperty(globalThis, 'crypto', {
          configurable: true,
          value: origCrypto,
        });
      }
    });
  });

  describe('EventBus', () => {
    test('off removes last listener and hasListeners reflects registration', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const bus = new EventBus(logger);
      const listener = jest.fn();

      expect(bus.hasListeners('beforeRetry')).toBe(false);
      bus.on('beforeRetry', listener);
      expect(bus.hasListeners('beforeRetry')).toBe(true);
      expect(bus.off('beforeRetry', listener)).toBe(true);
      expect(bus.hasListeners('beforeRetry')).toBe(false);
    });

    test('off with multiple listeners deletes event bucket only when the last is removed', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const bus = new EventBus(logger);
      const a = jest.fn();
      const b = jest.fn();
      bus.on('beforeRetry', a);
      bus.on('beforeRetry', b);
      expect(bus.off('beforeRetry', a)).toBe(true);
      expect(bus.hasListeners('beforeRetry')).toBe(true);
      expect(bus.off('beforeRetry', b)).toBe(true);
      expect(bus.hasListeners('beforeRetry')).toBe(false);
    });

    test('triggerAndEmit delegates to emit', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const bus = new EventBus(logger);
      const listener = jest.fn();
      const emitSpy = jest.spyOn(bus, 'emit');
      bus.on('beforeRetry', listener);
      const cfg = {};
      bus.triggerAndEmit('beforeRetry', cfg);
      expect(emitSpy).toHaveBeenCalledWith('beforeRetry', cfg);
      expect(listener).toHaveBeenCalledWith(cfg);
      emitSpy.mockRestore();
    });
  });

  describe('DependencyGatekeeper', () => {
    test('registers processing gate and trackIfBlocking respects priority threshold', () => {
      let gate: ((cfg: AxiosRequestConfig) => boolean) | undefined;
      const requestQueue = {
        registerProcessingGate: jest.fn((_name: string, fn: (c: AxiosRequestConfig) => boolean) => {
          gate = fn;
        }),
        refresh: jest.fn(),
      };
      const requestLifecycle = {
        cancelQueuedRequests: jest.fn(),
      };
      const emitEvent = jest.fn();

      const gk = new DependencyGatekeeper({
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
        cancelPendingOnDependencyFailure: false,
        requestQueue: requestQueue as unknown as RequestQueue,
        requestLifecycle: requestLifecycle as never,
        emitEvent,
      });

      expect(requestQueue.registerProcessingGate).toHaveBeenCalledWith('__blocking', expect.any(Function));
      expect(gate).toBeDefined();

      const high: AxiosRequestConfig = { url: '/h' };
      assignRequestMetadata(high, {
        requestId: 'high-1',
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      });
      const low: AxiosRequestConfig = { url: '/l' };
      assignRequestMetadata(low, {
        requestId: 'low-1',
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
      });

      expect(gate!(high)).toBe(true);
      expect(gate!(low)).toBe(true);

      gk.trackIfBlocking(high);
      expect(gate!(low)).toBe(false);

      gk.trackIfBlocking(low);

      const blockingNoId: AxiosRequestConfig = { url: '/no-id' };
      assignRequestMetadata(blockingNoId, { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH });
      gk.trackIfBlocking(blockingNoId);
    });

    test('handleRequestCancelled refreshes queue when last blocking id is removed', () => {
      const requestQueue = {
        registerProcessingGate: jest.fn(),
        refresh: jest.fn(),
      };
      const requestLifecycle = { cancelQueuedRequests: jest.fn() };
      const gk = new DependencyGatekeeper({
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
        cancelPendingOnDependencyFailure: false,
        requestQueue: requestQueue as unknown as RequestQueue,
        requestLifecycle: requestLifecycle as never,
        emitEvent: jest.fn(),
      });

      const cfg: AxiosRequestConfig = { url: '/blk' };
      assignRequestMetadata(cfg, {
        requestId: 'blk-x',
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      });
      gk.trackIfBlocking(cfg);
      gk.handleRequestCancelled('blk-x');

      expect(requestQueue.refresh).toHaveBeenCalled();
    });

    test('finishBlockingRequest emits when last blocking request succeeds', () => {
      const requestQueue = {
        registerProcessingGate: jest.fn(),
        refresh: jest.fn(),
      };
      const requestLifecycle = { cancelQueuedRequests: jest.fn() };
      const emitEvent = jest.fn();
      const gk = new DependencyGatekeeper({
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
        cancelPendingOnDependencyFailure: false,
        requestQueue: requestQueue as unknown as RequestQueue,
        requestLifecycle: requestLifecycle as never,
        emitEvent,
      });

      const cfg: AxiosRequestConfig = { url: '/b' };
      assignRequestMetadata(cfg, {
        requestId: 'blk-1',
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      });
      gk.trackIfBlocking(cfg);
      gk.finishBlockingRequest(cfg, 'success');

      expect(emitEvent).toHaveBeenCalledWith('onAllBlockingRequestsResolved');
      expect(requestQueue.refresh).toHaveBeenCalled();
    });
  });

  describe('PluginRegistry', () => {
    test('list, iterator, and unuse missing plugin', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const registry = new PluginRegistry(logger);
      const context = {} as PluginContext;
      const controls = {
        ejectRetryerInterceptors: jest.fn(),
        installRetryerInterceptors: jest.fn(),
      };
      const plugin = {
        name: 'CovPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
      } as RetryPlugin;

      registry.use(plugin, context, controls);
      expect(registry.list()).toEqual([{ name: 'CovPlugin', version: '1.0.0' }]);
      expect(Array.from(registry.getPlugins())).toHaveLength(1);
      expect(registry.unuse('nope', context)).toBe(false);
    });

    test('use skips interceptor eject/install when beforeRetryerInterceptors is false', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const registry = new PluginRegistry(logger);
      const context = {} as PluginContext;
      const controls = {
        ejectRetryerInterceptors: jest.fn(),
        installRetryerInterceptors: jest.fn(),
      };
      const plugin = {
        name: 'LateHook',
        version: '2.0.0',
        initialize: jest.fn(),
      } as RetryPlugin;

      registry.use(plugin, context, controls, false);

      expect(controls.ejectRetryerInterceptors).not.toHaveBeenCalled();
      expect(controls.installRetryerInterceptors).not.toHaveBeenCalled();
      expect(plugin.initialize).toHaveBeenCalledWith(context);
    });

    test('use reinstalls interceptors when initialize throws', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const registry = new PluginRegistry(logger);
      const context = {} as PluginContext;
      const controls = {
        ejectRetryerInterceptors: jest.fn(),
        installRetryerInterceptors: jest.fn(),
      };
      const boom = new Error('init-fail');
      const plugin = {
        name: 'Broken',
        version: '1.0.0',
        initialize: jest.fn(() => {
          throw boom;
        }),
      } as RetryPlugin;

      expect(() => registry.use(plugin, context, controls, true)).toThrow(boom);
      expect(controls.ejectRetryerInterceptors).toHaveBeenCalledTimes(1);
      expect(controls.installRetryerInterceptors).toHaveBeenCalledTimes(1);
      expect(registry.list()).toEqual([]);
    });

    test('use does not reinstall interceptors on failure when beforeRetryerInterceptors is false', () => {
      const logger: Logger = {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      const registry = new PluginRegistry(logger);
      const context = {} as PluginContext;
      const controls = {
        ejectRetryerInterceptors: jest.fn(),
        installRetryerInterceptors: jest.fn(),
      };
      const plugin = {
        name: 'BrokenLate',
        version: '1.0.0',
        initialize: jest.fn(() => {
          throw new Error('late-fail');
        }),
      } as RetryPlugin;

      expect(() => registry.use(plugin, context, controls, false)).toThrow('late-fail');
      expect(controls.ejectRetryerInterceptors).not.toHaveBeenCalled();
      expect(controls.installRetryerInterceptors).not.toHaveBeenCalled();
    });
  });
});
