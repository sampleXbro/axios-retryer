import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import MockAdapter from 'axios-mock-adapter';

import {
  AXIOS_RETRYER_BACKOFF_TYPES,
  RETRY_MODES,
  RetryManager,
  type Logger,
  type PluginContext,
  type RetryPlugin,
} from '../src';
import { setRequestMetadataValue } from '../src/utils/requestMetadata';

type TestLogger = Logger & {
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
  info: jest.Mock;
};

function createLogger(): TestLogger {
  return {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    info: jest.fn(),
  };
}

function getRequestInterceptorCount(instance: AxiosInstance): number {
  const handlers = (instance.interceptors.request as { handlers?: Array<unknown> }).handlers ?? [];
  return handlers.filter(Boolean).length;
}

function getResponseInterceptorCount(instance: AxiosInstance): number {
  const handlers = (instance.interceptors.response as { handlers?: Array<unknown> }).handlers ?? [];
  return handlers.filter(Boolean).length;
}

function createAbortableAdapter(): {
  adapter: AxiosAdapter;
  waitUntilStarted: Promise<void>;
  wasAborted: () => boolean;
} {
  let aborted = false;
  let resolveStarted!: () => void;
  const waitUntilStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const adapter: AxiosAdapter = async (config) =>
    new Promise((resolve, reject) => {
      resolveStarted();
      const timeoutRef: { id?: ReturnType<typeof setTimeout> } = {};
      const onAbort = (): void => {
        aborted = true;
        if (timeoutRef.id) {
          clearTimeout(timeoutRef.id);
        }
        reject(new AxiosError('destroyed', AxiosError.ERR_CANCELED, config));
      };

      if (config.signal?.aborted) {
        onAbort();
        return;
      }

      if (typeof config.signal?.addEventListener === 'function') {
        config.signal.addEventListener('abort', onAbort, { once: true });
      }
      timeoutRef.id = setTimeout(() => {
        if (typeof config.signal?.removeEventListener === 'function') {
          config.signal.removeEventListener('abort', onAbort);
        }
        resolve({
          config,
          data: { ok: true },
          headers: {},
          status: 200,
          statusText: 'OK',
        });
      }, 5_000);
    });

  return {
    adapter,
    waitUntilStarted,
    wasAborted: () => aborted,
  };
}

describe('P0 RetryManager Core (1.x)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('1.1.1: RetryManager with zero options uses documented defaults', () => {
    const manager = new RetryManager();

    try {
      const managerInternals = manager as unknown as {
        mode: string;
        retries: number;
        requestQueue: { maxConcurrent: number; maxQueueSize?: number };
        retryStrategy: { backoffType: number };
      };

      expect(managerInternals.mode).toBe(RETRY_MODES.AUTOMATIC);
      expect(managerInternals.retries).toBe(3);
      expect(managerInternals.requestQueue.maxConcurrent).toBe(5);
      expect(managerInternals.requestQueue.maxQueueSize).toBe(1000);
      expect(managerInternals.retryStrategy.backoffType).toBe(AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL);
    } finally {
      manager.destroy();
    }
  });

  it('1.1.2: retries: 0 still executes the initial request once', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
    });

    mock.onGet('/once').reply(500, { error: 'no retry' });

    try {
      await expect(manager.axiosInstance.get('/once')).rejects.toThrow('Request failed with status code 500');
      expect(mock.history.get).toHaveLength(1);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('1.1.3: creates a fresh axios instance with sane defaults when none is provided', () => {
    const manager = new RetryManager();

    try {
      expect(manager.axiosInstance.defaults.timeout).toBe(30_000);
      expect(manager.axiosInstance.defaults.validateStatus?.(200)).toBe(true);
      expect(manager.axiosInstance.defaults.validateStatus?.(299)).toBe(true);
      expect(manager.axiosInstance.defaults.validateStatus?.(300)).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  it('1.1.4: user-provided axios interceptors remain additive only', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const existingRequest = jest.fn((config: InternalAxiosRequestConfig) => {
      const headers = config.headers as unknown as Record<string, string>;
      headers['X-Existing'] = '1';
      return config;
    });
    const existingResponse = jest.fn((response) => response);

    axiosInstance.interceptors.request.use(existingRequest);
    axiosInstance.interceptors.response.use(existingResponse);

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
    });

    mock.onGet('/additive').reply(200, { ok: true });

    try {
      expect(getRequestInterceptorCount(axiosInstance)).toBe(2);
      expect(getResponseInterceptorCount(axiosInstance)).toBe(2);

      await manager.axiosInstance.get('/additive');

      expect(existingRequest).toHaveBeenCalledTimes(1);
      expect(existingResponse).toHaveBeenCalledTimes(1);
      expect(mock.history.get[0]?.headers?.['X-Existing']).toBe('1');
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('1.1.5: constructing two RetryManager instances on the same axiosInstance produces predictable additive behavior', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const managerA = new RetryManager({
      axiosInstance,
      retries: 0,
    });
    const managerB = new RetryManager({
      axiosInstance,
      retries: 0,
    });

    mock.onGet('/shared').reply(200, { ok: true });

    try {
      expect(getRequestInterceptorCount(axiosInstance)).toBe(2);
      expect(getResponseInterceptorCount(axiosInstance)).toBe(2);

      await expect(managerA.axiosInstance.get('/shared')).resolves.toMatchObject({ status: 200 });

      managerA.destroy();

      expect(getRequestInterceptorCount(axiosInstance)).toBe(1);
      expect(getResponseInterceptorCount(axiosInstance)).toBe(1);

      await expect(managerB.axiosInstance.get('/shared')).resolves.toMatchObject({ status: 200 });
      expect(mock.history.get).toHaveLength(2);
    } finally {
      managerB.destroy();
      mock.restore();
    }
  });

  it('1.1.6: debug mode logs initialization details through the provided logger', () => {
    const logger = createLogger();
    const manager = new RetryManager({
      debug: true,
      logger,
    });

    try {
      expect(logger.debug).toHaveBeenCalledWith(
        'Initializing RetryManager',
        expect.objectContaining({
          options: expect.objectContaining({
            mode: undefined,
            retries: undefined,
          }),
        }),
      );
    } finally {
      manager.destroy();
    }
  });

  it('1.2.1: destroy() ejects request and response interceptors from the axios instance', () => {
    const axiosInstance = axios.create();
    const requestEjectSpy = jest.spyOn(axiosInstance.interceptors.request, 'eject');
    const responseEjectSpy = jest.spyOn(axiosInstance.interceptors.response, 'eject');
    const manager = new RetryManager({ axiosInstance });

    manager.destroy();

    expect(requestEjectSpy).toHaveBeenCalled();
    expect(responseEjectSpy).toHaveBeenCalled();
  });

  it('1.2.2: destroy() cancels all in-flight requests', async () => {
    const axiosInstance = axios.create();
    const { adapter, waitUntilStarted, wasAborted } = createAbortableAdapter();
    axiosInstance.defaults.adapter = adapter;

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    const requestPromise = manager.axiosInstance.get('/slow');
    await waitUntilStarted;

    manager.destroy();

    await expect(requestPromise).rejects.toBeInstanceOf(AxiosError);
    expect(wasAborted()).toBe(true);
    expect(
      (manager as unknown as { requestLifecycle: { getActiveCount(): number } }).requestLifecycle.getActiveCount(),
    ).toBe(0);
  });

  it('1.2.3: destroy() clears all pending queue and retry timers', async () => {
    jest.useFakeTimers();

    const manager = new RetryManager({
      queueDelay: 1_000,
    });

    try {
      const requestQueue = (
        manager as unknown as {
          requestQueue: { enqueue(config: AxiosRequestConfig): Promise<AxiosRequestConfig> };
        }
      ).requestQueue;
      const retryScheduler = (
        manager as unknown as {
          retryScheduler: { waitForRetryDelay(config: AxiosRequestConfig, delay: number): Promise<boolean> };
        }
      ).retryScheduler;

      const queuedPromise = requestQueue.enqueue({ url: '/queued-timer' });
      const retryConfig: AxiosRequestConfig = { url: '/retry-timer' };
      setRequestMetadataValue(retryConfig, 'requestId', 'req_destroy_timers');
      const retryPromise = retryScheduler.waitForRetryDelay(retryConfig, 5_000);

      expect(jest.getTimerCount()).toBeGreaterThan(0);

      manager.destroy();

      expect(jest.getTimerCount()).toBe(0);
      await expect(queuedPromise).rejects.toThrow();
      await expect(retryPromise).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('1.2.4: destroy() calls onBeforeDestroyed on every registered plugin', () => {
    const onBeforeDestroyed = jest.fn();
    const plugin: RetryPlugin = {
      name: 'DestroyHookPlugin',
      version: '1.0.0',
      initialize: (_context: PluginContext) => undefined,
      onBeforeDestroyed,
    };

    const manager = new RetryManager();
    manager.use(plugin);

    manager.destroy();

    expect(onBeforeDestroyed).toHaveBeenCalledTimes(1);
  });

  it('1.2.5: destroy() clears the EventBus so listeners no longer fire', () => {
    const manager = new RetryManager();
    const onFailure = jest.fn();

    manager.on('onFailure', onFailure);
    manager.destroy();
    manager.emit('onFailure', { url: '/after-destroy' } as AxiosRequestConfig);

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('1.2.6: calling destroy() twice does not throw', () => {
    const manager = new RetryManager();

    manager.destroy();

    expect(() => manager.destroy()).not.toThrow();
  });

  it('1.2.7: using axiosInstance after destroy() works normally without retry behavior', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 3,
    });

    manager.destroy();
    mock.onGet('/after-destroy').reply(500, { error: 'plain axios' });

    try {
      await expect(axiosInstance.get('/after-destroy')).rejects.toThrow('Request failed with status code 500');
      expect(mock.history.get).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('1.2.8: cancelAllRequests() followed by destroy() does not double-abort', async () => {
    const axiosInstance = axios.create();
    let abortCount = 0;
    let resolveStarted!: () => void;
    const waitUntilStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    axiosInstance.defaults.adapter = async (config) =>
      new Promise((resolve, reject) => {
        const timeoutRef: { id?: ReturnType<typeof setTimeout> } = {};
        const onAbort = (): void => {
          abortCount += 1;
          if (timeoutRef.id) {
            clearTimeout(timeoutRef.id);
          }
          reject(new AxiosError('aborted once', AxiosError.ERR_CANCELED, config));
        };

        resolveStarted();

        if (config.signal?.aborted) {
          onAbort();
          return;
        }

        config.signal?.addEventListener?.('abort', onAbort, { once: true });
        timeoutRef.id = setTimeout(() => {
          config.signal?.removeEventListener?.('abort', onAbort);
          resolve({
            config,
            data: { ok: true },
            headers: {},
            status: 200,
            statusText: 'OK',
          });
        }, 5_000);
      });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    const requestPromise = manager.axiosInstance.get('/double-abort');
    await waitUntilStarted;

    manager.cancelAllRequests();
    manager.destroy();

    await expect(requestPromise).rejects.toBeInstanceOf(AxiosError);
    expect(abortCount).toBe(1);
  });

  it('1.3.1: getMetrics() returns zero-valued metrics without MetricsPlugin', () => {
    const manager = new RetryManager();

    try {
      expect(manager.getMetrics()).toEqual(
        expect.objectContaining({
          totalRequests: 0,
          successfulRetries: 0,
          failedRetries: 0,
          completelyFailedRequests: 0,
          canceledRequests: 0,
          completelyFailedCriticalRequests: 0,
          avgQueueWait: 0,
          avgRetryDelay: 0,
          timerHealth: expect.objectContaining({
            activeTimers: 0,
            activeRetryTimers: 0,
          }),
        }),
      );
    } finally {
      manager.destroy();
    }
  });

  it('1.3.2: getMetrics() still exposes live timer health without MetricsPlugin', async () => {
    jest.useFakeTimers();

    const manager = new RetryManager();
    const config: AxiosRequestConfig = { url: '/retrying' };
    setRequestMetadataValue(config, 'requestId', 'req_timer_health');

    const waitPromise = (
      manager as unknown as {
        retryScheduler: {
          waitForRetryDelay(config: AxiosRequestConfig, delay: number): Promise<boolean>;
          cancelRetryTimer(id: string): boolean;
        };
      }
    ).retryScheduler.waitForRetryDelay(config, 1_000);

    expect(manager.getMetrics().timerHealth.activeRetryTimers).toBe(1);

    (
      manager as unknown as {
        retryScheduler: { cancelRetryTimer(id: string): boolean };
      }
    ).retryScheduler.cancelRetryTimer('req_timer_health');
    await expect(waitPromise).resolves.toBe(false);
    expect(manager.getMetrics().timerHealth.activeRetryTimers).toBe(0);

    manager.destroy();
    jest.useRealTimers();
  });

  it('1.3.3: resetMetrics() is a no-op without MetricsPlugin', () => {
    const manager = new RetryManager();

    try {
      expect(() => manager.resetMetrics()).not.toThrow();
      expect(manager.getMetrics().totalRequests).toBe(0);
    } finally {
      manager.destroy();
    }
  });
});
