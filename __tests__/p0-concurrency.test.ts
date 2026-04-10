import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager, type PluginContext, type RetryPlugin } from '../src';
import { RequestQueue } from '../src/core/requestQueue';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortableAdapter(onStart?: (config: AxiosRequestConfig) => void): AxiosAdapter {
  return async (config) =>
    new Promise((resolve, reject) => {
      const timeoutRef: { id?: ReturnType<typeof setTimeout> } = {};
      onStart?.(config);

      const onAbort = (): void => {
        if (timeoutRef.id) {
          clearTimeout(timeoutRef.id);
        }
        reject(new AxiosError('aborted', AxiosError.ERR_CANCELED, config));
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
}

describe('P0 Concurrency & Race Conditions (23.x)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('23.1: 100 concurrent requests with maxConcurrentRequests: 5 never exceed 5 in flight', async () => {
    const axiosInstance = axios.create();
    let active = 0;
    let maxActive = 0;
    axiosInstance.defaults.adapter = async (config) =>
      new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active -= 1;
          resolve({
            config,
            data: { ok: true },
            headers: {},
            status: 200,
            statusText: 'OK',
          });
        }, 5);
      });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      queueDelay: 0,
      maxConcurrentRequests: 5,
    });

    try {
      await Promise.all(Array.from({ length: 100 }, (_, index) => manager.axiosInstance.get(`/bulk-${index}`)));
      expect(maxActive).toBe(5);
    } finally {
      manager.destroy();
    }
  });

  it('23.2: a request completing during cancelAllRequests() does not block later work', async () => {
    const axiosInstance = axios.create();
    let firstResolve!: () => void;
    let started = 0;
    axiosInstance.defaults.adapter = async (config) =>
      new Promise((resolve) => {
        started += 1;
        if (started === 1) {
          firstResolve = () =>
            resolve({
              config,
              data: { first: true },
              headers: {},
              status: 200,
              statusText: 'OK',
            });
          return;
        }

        resolve({
          config,
          data: { ok: true },
          headers: {},
          status: 200,
          statusText: 'OK',
        });
      });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      queueDelay: 0,
      maxConcurrentRequests: 1,
      throwErrorOnCancelRequest: true,
    });

    const first = manager.axiosInstance.get('/first').catch(() => undefined);
    const second = manager.axiosInstance.get('/second').catch(() => undefined);
    await wait(0);
    manager.cancelAllRequests();
    firstResolve();

    try {
      await Promise.allSettled([first, second]);
      const third = await manager.axiosInstance.get('/third');
      expect(third.status).toBe(200);
    } finally {
      manager.destroy();
    }
  });

  it('23.3: retry scheduling does not duplicate a retry attempt', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      queueDelay: 0,
      retries: 1,
      retryStrategy: {
        getDelay: () => 0,
        getIsRetryable: () => true,
        shouldRetry: (_error, attempt, maxRetries) => attempt <= maxRetries,
      },
    });

    mock.onGet('/retry').replyOnce(500);
    mock.onGet('/retry').replyOnce(200, { ok: true });

    try {
      const response = await manager.axiosInstance.get('/retry');
      expect(response.status).toBe(200);
      expect(mock.history.get).toHaveLength(2);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('23.4: plugin event listeners on the same request fire in registration order', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const order: string[] = [];

    const createPlugin = (name: string): RetryPlugin => ({
      name,
      version: '1.0.0',
      initialize(context: PluginContext): void {
        context.on('onRequestSucceeded', (() => {
          order.push(name);
        }) as never);
      },
    });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      queueDelay: 0,
    });

    manager.use(createPlugin('A'));
    manager.use(createPlugin('B'));
    mock.onGet('/ordered').reply(200, { ok: true });

    try {
      await manager.axiosInstance.get('/ordered');
      expect(order).toEqual(['A', 'B']);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('23.5: destroy() during retry delay cancels the sleep and prevents dispatching the retry', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 1,
      queueDelay: 0,
      retryStrategy: {
        getDelay: () => 50,
        getIsRetryable: () => true,
        shouldRetry: (_error, attempt, maxRetries) => attempt <= maxRetries,
      },
    });

    mock.onGet('/destroy-during-retry').replyOnce(500);
    mock.onGet('/destroy-during-retry').replyOnce(200, { shouldNotRun: true });

    try {
      const request = manager.axiosInstance.get('/destroy-during-retry');
      await wait(10);
      manager.destroy();

      await expect(request).rejects.toThrow();
      expect(mock.history.get).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('23.6: cancelRequest(id) called twice for the same request is a no-op the second time', async () => {
    const axiosInstance = axios.create();
    let requestId: string | undefined;
    axiosInstance.defaults.adapter = createAbortableAdapter((config) => {
      requestId = (config as AxiosRequestConfig & { __axiosRetryer?: { requestId?: string } }).__axiosRetryer
        ?.requestId;
    });

    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      queueDelay: 0,
    });

    try {
      const request = manager.axiosInstance.get('/cancel-twice');
      await wait(0);

      expect(() => manager.cancelRequest(String(requestId))).not.toThrow();
      expect(() => manager.cancelRequest(String(requestId))).not.toThrow();
      await expect(request).rejects.toThrow();
    } finally {
      manager.destroy();
    }
  });

  it('23.7: token refresh timeout and refresh success race settles with only one outcome', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      queueDelay: 0,
      throwErrorOnFailedRetries: false,
    });

    let before = 0;
    let refreshed = 0;
    let failed = 0;
    const plugin = new TokenRefreshPlugin(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ token: 'race-token' }), 20);
        }),
      {
        refreshTimeout: 20,
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
      },
    );

    manager.use(plugin);
    manager.on(
      'onBeforeTokenRefresh' as never,
      (() => {
        before += 1;
      }) as never,
    );
    manager.on(
      'onTokenRefreshed' as never,
      (() => {
        refreshed += 1;
      }) as never,
    );
    manager.on(
      'onTokenRefreshFailed' as never,
      (() => {
        failed += 1;
      }) as never,
    );

    mock.onGet('/race').replyOnce(401);
    mock.onGet('/race').reply(200, { ok: true });

    try {
      await manager.axiosInstance
        .get('/race', {
          headers: { Authorization: 'Bearer stale-token' },
        })
        .catch(() => undefined);
      await wait(30);

      expect(before).toBe(1);
      expect(refreshed + failed).toBe(1);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('23.8: unregistering a queue gate while drain is in progress lets waiting requests continue', async () => {
    const queue = new RequestQueue({
      maxConcurrent: 2,
      queueDelay: 0,
    });
    queue.registerProcessingGate('block', () => false);

    const first = queue.enqueue({ url: '/one' });
    const second = queue.enqueue({ url: '/two' });
    await wait(0);

    queue.unregisterProcessingGate('block');

    await expect(first).resolves.toMatchObject({ url: '/one' });
    await expect(second).resolves.toMatchObject({ url: '/two' });
  });

  it('23.9: markComplete() when nothing is in flight does not underflow concurrency tracking', async () => {
    const queue = new RequestQueue({
      maxConcurrent: 1,
      queueDelay: 0,
    });

    queue.markComplete();
    queue.markComplete();

    expect((queue as unknown as { inProgressCount: number }).inProgressCount).toBe(0);
    await expect(queue.enqueue({ url: '/safe' })).resolves.toMatchObject({ url: '/safe' });
  });

  it('23.10: rapid create-cancel-destroy churn does not leave timer leaks behind', async () => {
    let lastManager: RetryManager | undefined;

    try {
      for (let index = 0; index < 10; index++) {
        const axiosInstance = axios.create();
        axiosInstance.defaults.adapter = createAbortableAdapter();
        const manager = new RetryManager({
          axiosInstance,
          retries: 0,
          queueDelay: 0,
        });

        const request = manager.axiosInstance.get(`/churn-${index}`).catch(() => undefined);
        await wait(0);
        manager.cancelAllRequests();
        await request;
        expect(manager.getMetrics().timerHealth.activeRetryTimers).toBe(0);
        expect(manager.getMetrics().timerHealth.activeTimers).toBe(0);
        manager.destroy();
        lastManager = manager;
      }
    } finally {
      lastManager?.destroy();
    }
  });

  it('23.11: unuse during active event emission prevents removed plugin listeners from firing later in the same emit', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const pluginBFired = jest.fn();
    // eslint-disable-next-line prefer-const
    let manager!: RetryManager;

    const pluginA: RetryPlugin = {
      name: 'PluginA',
      version: '1.0.0',
      initialize(context: PluginContext): void {
        context.on('onRequestSucceeded', (() => {
          manager.unuse('PluginB');
        }) as never);
      },
    };

    const pluginB: RetryPlugin = {
      name: 'PluginB',
      version: '1.0.0',
      initialize(context: PluginContext): void {
        context.on('onRequestSucceeded', pluginBFired as unknown as never);
      },
      onBeforeDestroyed(context: PluginContext): void {
        context.off('onRequestSucceeded', pluginBFired as unknown as never);
      },
    };

    manager = new RetryManager({
      axiosInstance,
      retries: 0,
      queueDelay: 0,
    });

    manager.use(pluginA);
    manager.use(pluginB);
    mock.onGet('/unuse-during-emit').reply(200, { ok: true });

    try {
      await manager.axiosInstance.get('/unuse-during-emit');
      expect(pluginBFired).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
      mock.restore();
    }
  });
});
