// @ts-nocheck
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src';
import type { RetryManagerOptions } from '../src';
import axios from 'axios';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';

describe('RetryManager', () => {
  let mock: AxiosMockAdapter;
  let retryManager: RetryManager;

  const hooks = {
    beforeRetry: jest.fn(),
    afterRetry: jest.fn(),
    onFailure: jest.fn(),
    onRequestError: jest.fn(),
    onRequestQueued: jest.fn(),
    onRequestDispatched: jest.fn(),
    onRequestSucceeded: jest.fn(),
    onRetryProcessFinished: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 2,
      throwErrorOnFailedRetries: true,
      throwErrorOnCancelRequest: true,
    };

    retryManager = new RetryManager(options);
    retryManager.use(new MetricsPlugin());
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
  });

  afterEach(() => {
    if (retryManager) {
      retryManager.destroy();
    }
    mock.restore();
  });

  test('should succeed on first try with no retries needed', async () => {
    mock.onGet('/success').reply(200, { data: 'ok' });

    const response = await retryManager.axiosInstance.get('/success');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: 'ok' });
  });

  test('should throw a clear validation error for negative retries', () => {
    expect(() => new RetryManager({ retries: -1 })).toThrow('Retries must be a non-negative number');
  });

  test('should return zero averages for a fresh manager metrics snapshot', () => {
    const metrics = retryManager.getMetrics();

    expect(metrics.avgQueueWait).toBe(0);
    expect(metrics.avgRetryDelay).toBe(0);
  });

  test('should avoid lifecycle metrics snapshot work when metrics are not installed and nothing observes them', async () => {
    const managerWithoutMetrics = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
    });
    const managerMock = new AxiosMockAdapter(managerWithoutMetrics.axiosInstance);
    const getMetricsSpy = jest.spyOn(managerWithoutMetrics, 'getMetrics');

    try {
      managerMock.onGet('/no-metrics-fast-path').reply(200, { ok: true });

      await managerWithoutMetrics.axiosInstance.get('/no-metrics-fast-path');

      expect(getMetricsSpy).not.toHaveBeenCalled();
    } finally {
      managerWithoutMetrics.destroy();
      managerMock.restore();
    }
  });

  test('should emit metrics snapshots when MetricsPlugin is installed', async () => {
    const onMetricsUpdated = jest.fn();

    retryManager.on('onMetricsUpdated', onMetricsUpdated);
    mock.onGet('/metrics-listener').reply(200, { ok: true });

    await retryManager.axiosInstance.get('/metrics-listener');

    expect(onMetricsUpdated).toHaveBeenCalled();
    const lastSnapshot = onMetricsUpdated.mock.calls[onMetricsUpdated.mock.calls.length - 1][0];
    expect(lastSnapshot.totalRequests).toBe(1);
    expect(lastSnapshot.successfulRetries).toBe(0);
  });

  test('should isolate metrics state between retry manager instances', async () => {
    const firstManager = new RetryManager({
      retries: 0,
      throwErrorOnFailedRetries: true,
    });
    const secondManager = new RetryManager({
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    firstManager.use(new MetricsPlugin());
    secondManager.use(new MetricsPlugin());

    const firstMock = new AxiosMockAdapter(firstManager.axiosInstance);
    const secondMock = new AxiosMockAdapter(secondManager.axiosInstance);

    try {
      firstMock.onGet('/fails').reply(500, 'Server Error');

      await expect(firstManager.axiosInstance.get('/fails')).rejects.toThrow(
        'Request failed with status code 500',
      );

      expect(firstManager.getMetrics().completelyFailedRequests).toBe(1);
      expect(firstManager.getMetrics().requestCountsByPriority).toEqual({ 1: 1 });
      expect(secondManager.getMetrics().completelyFailedRequests).toBe(0);
      expect(secondManager.getMetrics().requestCountsByPriority).toEqual({});
    } finally {
      firstManager.destroy();
      secondManager.destroy();
      firstMock.restore();
      secondMock.restore();
    }
  });

  test('should retry on failure and succeed on second attempt', async () => {
    let attempt = 0;
    mock.onGet('/retry-success').reply(() => {
      attempt++;
      if (attempt === 1) {
        return [500, 'Error'];
      }
      return [200, { data: 'recovered' }];
    });

    const response = await retryManager.axiosInstance.get('/retry-success');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: 'recovered' });
  });

  test('should exhaust retries and throw error', async () => {
    mock.onGet('/retry-fail').reply(500, 'Server Error');

    await expect(retryManager.axiosInstance.get('/retry-fail')).rejects.toThrow(
      'Request failed with status code 500',
    );
  });

  test('should count a terminal failure when retries are disabled', async () => {
    retryManager = new RetryManager({
      retries: 0,
      throwErrorOnFailedRetries: true,
    });
    retryManager.use(new MetricsPlugin());
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
    mock.onGet('/no-retries-terminal-failure').reply(500, 'Server Error');

    await expect(retryManager.axiosInstance.get('/no-retries-terminal-failure')).rejects.toThrow(
      'Request failed with status code 500',
    );

    expect(retryManager.getMetrics().completelyFailedRequests).toBe(1);
  });

  test('should track queue wait time in metrics when requests are queued', async () => {
    retryManager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
      maxConcurrentRequests: 1,
      queueDelay: 10,
    });
    retryManager.use(new MetricsPlugin());
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/slow').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([200, { ok: true }]), 50);
        }),
    );
    mock.onGet('/queued').reply(200, { ok: true });

    await Promise.all([
      retryManager.axiosInstance.get('/slow'),
      retryManager.axiosInstance.get('/queued'),
    ]);

    expect(retryManager.getMetrics().avgQueueWait).toBeGreaterThan(0);
  });

  test('should abort and not retry if request is cancelled before retry', async () => {
    // Make first call fail
    mock.onGet('/cancel-before-retry').replyOnce(500, 'Error');
    // On second try, if it would ever happen, it would succeed
    mock.onGet('/cancel-before-retry').replyOnce(200, { data: 'should-not-reach' });

    const axiosInstance = retryManager.axiosInstance;
    const requestPromise = axiosInstance.get('/cancel-before-retry').catch((err) => {
      // We expect a cancellation error here
      expect(err.message).toMatch(/Request aborted/);
    });

    // Wait for the first attempt, then cancel all requests
    setTimeout(() => {
      // Extract active requests
      const activeRequests = (retryManager as any).requestLifecycle.activeRequests;
      // @ts-ignore
      const keys = Array.from(activeRequests.keys());
      if (keys.length > 0) {
        retryManager.cancelAllRequests();
      }
    }, 50);

    await requestPromise;
  });

  test('should store failed requests in manual mode for later retry', async () => {
    // Reinitialize in manual mode
    const manualRetry = new ManualRetryPlugin();
    const options = {
      mode: 'manual' as const,
      retries: 1,
    };
    retryManager = new RetryManager(options);
    retryManager.use(manualRetry);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/store-fail').reply(500, 'Error');

    await expect(retryManager.axiosInstance.get('/store-fail')).rejects.toThrow();
    // The request should have been stored for manual retry
    const storedRequests = manualRetry.getStoredRequests();
    expect(storedRequests).toHaveLength(1);
    expect(storedRequests[0].url).toBe('/store-fail');
  });

  test('should manually retry failed requests', async () => {
    // With manual mode and failed request stored
    const manualRetry = new ManualRetryPlugin();
    const options = {
      mode: 'manual' as const,
      retries: 1,
    };
    retryManager = new RetryManager(options);
    retryManager.use(manualRetry);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/manual-retry').reply(500, 'Error');
    await expect(retryManager.axiosInstance.get('/manual-retry')).rejects.toThrow();

    const storedRequestsBefore = manualRetry.getStoredRequests();
    expect(storedRequestsBefore).toHaveLength(1);

    // Now change mock for a successful retry
    mock.onGet('/manual-retry').reply(200, { data: 'second-chance' });

    const responses = await manualRetry.retryFailedRequests();
    expect(responses).toHaveLength(1);
    expect(responses[0].data).toEqual({ data: 'second-chance' });

    const storedRequestsAfter = manualRetry.getStoredRequests();
    expect(storedRequestsAfter).toHaveLength(0);
  });

  test('should throw an error after manual retry if requests are still failed', async () => {
    // Initialize RetryManager in manual mode with 1 retry
    const manualRetry = new ManualRetryPlugin();
    const options = {
      mode: 'manual' as const,
      retries: 1,
    };
    const retryManager = new RetryManager(options);
    retryManager.use(manualRetry);
    const mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // First request fails
    mock.onGet('/manual-retry').reply(500, 'Error');
    await expect(retryManager.axiosInstance.get('/manual-retry')).rejects.toThrow();

    // Verify that the failed request is stored
    const storedRequestsBefore = manualRetry.getStoredRequests();
    expect(storedRequestsBefore).toHaveLength(1);

    // Mock another failure for retry
    mock.onGet('/manual-retry').reply(500, 'Error again');

    // Attempt manual retry and expect it to throw
    await expect(manualRetry.retryFailedRequests()).rejects.toThrow(/Request failed with status code 500/);

    // Verify that the failed request remains in the store
    const storedRequestsAfter = manualRetry.getStoredRequests();
    expect(storedRequestsAfter).toHaveLength(1);
  });

  test('should throw error on cancel if throwErrorOnCancelRequest is true', async () => {
    const options = {
      mode: 'automatic' as const,
      retries: 1,
      throwErrorOnCancelRequest: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/cancel-silent').replyOnce(500, 'Error'); // triggers a retry

    const requestPromise = retryManager.axiosInstance.get('/cancel-silent');

    setTimeout(() => {
      retryManager.cancelAllRequests();
    }, 50);

    await requestPromise.catch((err) => {
      expect(err.message).toMatch(/Request aborted/);
    });
  });

  test('should resolve null for pre-aborted requests when throwErrorOnCancelRequest is false', async () => {
    retryManager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
      throwErrorOnCancelRequest: false,
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    const controller = new AbortController();
    controller.abort();

    await expect(
      retryManager.axiosInstance.get('/pre-aborted', {
        signal: controller.signal,
      }),
    ).resolves.toBeNull();

    expect(mock.history.get).toHaveLength(0);
  });

  test('should resolve null for queued caller aborts when throwErrorOnCancelRequest is false', async () => {
    retryManager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 0,
      maxConcurrentRequests: 1,
      queueDelay: 0,
      throwErrorOnCancelRequest: false,
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    let releaseSlowRequest;
    mock.onGet('/slow').reply(
      () =>
        new Promise((resolve) => {
          releaseSlowRequest = () => resolve([200, { ok: true }]);
        }),
    );
    mock.onGet('/queued').reply(200, { shouldNotRun: true });

    const slowRequest = retryManager.axiosInstance.get('/slow');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const controller = new AbortController();
    const queuedRequest = retryManager.axiosInstance.get('/queued', {
      signal: controller.signal,
    });

    controller.abort();

    await expect(queuedRequest).resolves.toBeNull();
    expect(mock.history.get).toHaveLength(1);

    releaseSlowRequest();
    await expect(slowRequest).resolves.toMatchObject({ status: 200 });
  });

  test('should resolve null when a retry is cancelled and throwErrorOnCancelRequest is false', async () => {
    retryManager = new RetryManager({
      axiosInstance: axios.create(),
      retries: 1,
      throwErrorOnCancelRequest: false,
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/cancel-during-retry').replyOnce(500, 'Error');

    const requestPromise = retryManager.axiosInstance.get('/cancel-during-retry');

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    retryManager.cancelAllRequests();

    await expect(requestPromise).resolves.toBeNull();
  });

  test('onFailure is called when all retries are exhausted', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
      throwErrorOnCancelRequest: true,
    };
    retryManager = new RetryManager(options);
    retryManager.on('onFailure', hooks.onFailure);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Ensure the mock matches exactly the request you are making
    mock.onGet('/exhaust-retries').reply(500, 'Still failing');

    // Use .rejects to ensure we handle the failure
    await expect(retryManager.axiosInstance.get('/exhaust-retries')).rejects.toThrow(
      'Request failed with status code 500',
    );

    expect(hooks.onFailure).toHaveBeenCalledTimes(1);
  });

  test('onRequestError is called once for terminal failure with status payload', async () => {
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
    });
    retryManager.on('onRequestError', hooks.onRequestError);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/terminal-request-error').reply(500, 'Still failing');

    await expect(retryManager.axiosInstance.get('/terminal-request-error')).rejects.toThrow(
      'Request failed with status code 500',
    );

    expect(hooks.onRequestError).toHaveBeenCalledTimes(1);
    expect(hooks.onRequestError).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 500,
        attempts: 2,
        retryable: true,
        config: expect.objectContaining({ url: '/terminal-request-error' }),
      }),
    );
  });

  test('onRequestError is not called when request succeeds after retry', async () => {
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 2,
      throwErrorOnFailedRetries: true,
    });
    retryManager.on('onRequestError', hooks.onRequestError);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    let attempt = 0;
    mock.onGet('/recovers-before-terminal').reply(() => {
      attempt++;
      if (attempt === 1) {
        return [500, 'Error'];
      }
      return [200, { ok: true }];
    });

    await expect(retryManager.axiosInstance.get('/recovers-before-terminal')).resolves.toMatchObject({
      status: 200,
    });

    expect(hooks.onRequestError).not.toHaveBeenCalled();
  });

  test('onRequestQueued and onRequestDispatched fire with queue metadata', async () => {
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 0,
      maxConcurrentRequests: 1,
      queueDelay: 0,
    });
    retryManager.on('onRequestQueued', hooks.onRequestQueued);
    retryManager.on('onRequestDispatched', hooks.onRequestDispatched);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    let releaseSlowRequest: (() => void) | undefined;
    mock.onGet('/queue-slow').reply(
      () =>
        new Promise((resolve) => {
          releaseSlowRequest = () => resolve([200, { ok: 'slow' }]);
        }),
    );
    mock.onGet('/queue-fast').reply(200, { ok: 'fast' });

    const slowPromise = retryManager.axiosInstance.get('/queue-slow');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fastPromise = retryManager.axiosInstance.get('/queue-fast');

    releaseSlowRequest?.();
    await Promise.all([slowPromise, fastPromise]);

    expect(hooks.onRequestQueued).toHaveBeenCalledTimes(2);
    expect(hooks.onRequestDispatched).toHaveBeenCalledTimes(2);

    const queuedPayload = hooks.onRequestQueued.mock.calls[1][0];
    expect(queuedPayload).toMatchObject({
      config: expect.objectContaining({ url: '/queue-fast' }),
      priority: 1,
    });
    expect(queuedPayload.queueSize).toBeGreaterThanOrEqual(1);

    const dispatchedPayload = hooks.onRequestDispatched.mock.calls[1][0];
    expect(dispatchedPayload).toMatchObject({
      config: expect.objectContaining({ url: '/queue-fast' }),
      priority: 1,
    });
    expect(dispatchedPayload.queuedForMs).toBeGreaterThanOrEqual(0);
  });

  test('onRequestSucceeded fires for successful requests with attempt count', async () => {
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
    });
    retryManager.on('onRequestSucceeded', hooks.onRequestSucceeded);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock
      .onGet('/succeeds-after-retry')
      .replyOnce(500, 'Fail first')
      .onGet('/succeeds-after-retry')
      .replyOnce(200, { ok: true });

    await expect(retryManager.axiosInstance.get('/succeeds-after-retry')).resolves.toMatchObject({
      status: 200,
    });

    expect(hooks.onRequestSucceeded).toHaveBeenCalledTimes(1);
    expect(hooks.onRequestSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        attempts: 2,
        config: expect.objectContaining({ url: '/succeeds-after-retry' }),
      }),
    );
  });

  test('onRetryProcessFinished is called after no more retries are pending', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    retryManager.on('onRetryProcessFinished', hooks.onRetryProcessFinished);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/complete-all').reply(500, 'Fail');

    await retryManager
      .axiosInstance
      .get('/complete-all')
      .catch(() => {});

    expect(hooks.onRetryProcessFinished).toHaveBeenCalledTimes(1);
  });

  test('manual mode: no automatic retries, failures go straight to store', async () => {
    const manualRetry = new ManualRetryPlugin();
    const options: RetryManagerOptions = {
      mode: 'manual',
      retries: 2,
    };
    retryManager = new RetryManager(options);
    retryManager.on('onFailure', hooks.onFailure);
    retryManager.on('beforeRetry', hooks.beforeRetry);
    retryManager.on('afterRetry', hooks.afterRetry);
    retryManager.use(manualRetry);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/manual-mode').reply(500, 'Fail Immediately');

    await retryManager
      .axiosInstance
      .get('/manual-mode')
      .catch(() => {});

    const stored = manualRetry.getStoredRequests();
    expect(stored).toHaveLength(1);

    // onFailure should always be called
    expect(hooks.onFailure).toHaveBeenCalledTimes(1);

    // No beforeRetry or afterRetry calls expected since no retries occurred
    expect(hooks.beforeRetry).toHaveBeenCalledTimes(0);
    expect(hooks.afterRetry).toHaveBeenCalledTimes(0);
  });

  test('throwErrorOnFailedRetries = true: returns a rejected promise without forcing error', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
    mock.onGet('/no-throw-fail').reply(500, 'Error');

    let err;
    try {
      await retryManager.axiosInstance.get('/no-throw-fail');
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect((err as any).message).toMatch(/Request failed/);

  });

  test('cancelling after the first retry is scheduled but before it fires', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 2,
      throwErrorOnFailedRetries: true,
      throwErrorOnCancelRequest: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
    const waitForRetryDelaySpy = jest.spyOn(retryManager['retryScheduler'], 'waitForRetryDelay');

    // Always fail to trigger retries
    mock.onGet('/cancel-late').reply(500, 'Error');

    const requestPromise = retryManager
      .axiosInstance
      .get('/cancel-late')
      .catch((err) => {
        expect(err.message).toMatch(/Request aborted/);
      });

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();

      const poll = () => {
        if (waitForRetryDelaySpy.mock.calls.length > 0) {
          resolve();
          return;
        }

        if (Date.now() - startedAt > 1000) {
          reject(new Error('Retry was not scheduled in time'));
          return;
        }

        setTimeout(poll, 10);
      };

      poll();
    });

    retryManager.cancelAllRequests();

    await requestPromise;

  });

  test('Ensure afterRetry is called on a retry failure', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    retryManager.on('afterRetry', hooks.afterRetry);
    retryManager.on('onFailure', hooks.onFailure);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    let callCount = 0;
    mock.onGet('/after-retry-fail').reply(() => {
      callCount++;
      // Always fail
      return [500, 'Fail'];
    });

    await retryManager
      .axiosInstance
      .get('/after-retry-fail')
      .catch(() => {});

    // afterRetry is called after a retry fails
    expect(hooks.afterRetry).toHaveBeenCalledTimes(1);
    // onFailure is always called now that retries are done
    expect(hooks.onFailure).toHaveBeenCalledTimes(1);

  });

  test('should register a new plugin', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin = { name: 'TestPlugin', version: '1.0.0', initialize: jest.fn() };

    manager.use(plugin);

    expect(manager.listPlugins()).toEqual([{ name: 'TestPlugin', version: '1.0.0' }]);
    expect(plugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ axiosInstance: manager.axiosInstance }),
    );
  });

  test('should throw an error when registering a duplicate plugin', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin = { name: 'DuplicatePlugin', version: '1.0.0', initialize: jest.fn() };

    manager.use(plugin);
    expect(() => manager.use(plugin)).toThrowError('Plugin "DuplicatePlugin" is already registered.');
  });

  test('should list all registered plugins', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin1 = { name: 'PluginOne', version: '1.0.0', initialize: jest.fn() };
    const plugin2 = { name: 'PluginTwo', version: '1.0.0', initialize: jest.fn() };

    manager.use(plugin1);
    manager.use(plugin2);

    const plugins = manager.listPlugins();
    expect(plugins).toEqual([
      { name: 'PluginOne', version: '1.0.0' },
      { name: 'PluginTwo', version: '1.0.0' },
    ]);
  });

  test('should trigger events for all registered plugins', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const pluginOneBeforeRetry = jest.fn();
    const pluginTwoBeforeRetry = jest.fn();
    const plugin1 = {
      name: 'PluginOne',
      version: '1.0.0',
      initialize: (retryer: RetryManager) => {
        retryer.on('beforeRetry', pluginOneBeforeRetry);
      },
    };
    const plugin2 = {
      name: 'PluginTwo',
      version: '1.0.0',
      initialize: (retryer: RetryManager) => {
        retryer.on('beforeRetry', pluginTwoBeforeRetry);
      },
    };

    manager.use(plugin1);
    manager.use(plugin2);

    const config = { url: 'http://example.com' };
    manager.triggerAndEmit('beforeRetry', config);

    expect(pluginOneBeforeRetry).toHaveBeenCalledWith(config);
    expect(pluginTwoBeforeRetry).toHaveBeenCalledWith(config);
  });

  test('should handle errors in plugin event listeners gracefully', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const faultyListener = jest.fn(() => {
      throw new Error('Test error');
    });
    const faultyPlugin = {
      name: 'FaultyPlugin',
      version: '1.0.0',
      initialize: (retryer: RetryManager) => {
        retryer.on('beforeRetry', faultyListener);
      },
    };

    manager.use(faultyPlugin);

    const config = { url: 'http://example.com' };
    expect(() => manager.triggerAndEmit('beforeRetry', config)).not.toThrow();
  });

  test('should execute plugins in registration order', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const executionOrder: string[] = [];

    const plugin1 = {
      name: 'PluginOne',
      version: '1.0.0',
      initialize: (retryer: RetryManager) => {
        retryer.on('beforeRetry', () => executionOrder.push('PluginOne'));
      },
    };

    const plugin2 = {
      name: 'PluginTwo',
      version: '1.0.0',
      initialize: (retryer: RetryManager) => {
        retryer.on('beforeRetry', () => executionOrder.push('PluginTwo'));
      },
    };

    manager.use(plugin1);
    manager.use(plugin2);

    const config = { url: 'http://example.com' };
    manager.triggerAndEmit('beforeRetry', config);

    expect(executionOrder).toEqual(['PluginOne', 'PluginTwo']);
  });

  test('should cancel a specific request by ID', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const controller = new AbortController();
    const requestId = 'test-request-1';

    manager['requestLifecycle']['activeRequests'].set(requestId, controller);
    manager.cancelRequest(requestId);

    expect(manager['requestLifecycle']['activeRequests'].has(requestId)).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  test('should cancel all active requests', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    manager['requestLifecycle']['activeRequests'].set('request-1', controller1);
    manager['requestLifecycle']['activeRequests'].set('request-2', controller2);

    manager.cancelAllRequests();

    expect(manager['requestLifecycle']['activeRequests'].size).toBe(0);
    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(true);
  });

  test('should trigger events in correct order', async () => {
    const eventsOrder: string[] = [];

    retryManager = new RetryManager({
      retries: 1,
      mode: 'automatic',
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    retryManager.on('beforeRetry', () => eventsOrder.push('beforeRetry'));
    retryManager.on('afterRetry', () => eventsOrder.push('afterRetry'));
    retryManager.on('onFailure', () => eventsOrder.push('onFailure'));
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/events-order').reply(500, 'Error');

    await expect(retryManager.axiosInstance.get('/events-order')).rejects.toThrow();
    expect(eventsOrder).toEqual(['beforeRetry', 'afterRetry', 'onFailure']);
  });

  test('single request', async () => {
    const options: RetryManagerOptions = { retries: 1, mode: 'automatic' };
    retryManager = new RetryManager({
      ...options,
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/fail1').reply(500, 'Error');
    await retryManager
      .axiosInstance
      .get('/fail1')
      .catch(() => {});
  });

  test('sequential requests', async () => {
    const options: RetryManagerOptions = { retries: 1, mode: 'automatic' };
    retryManager = new RetryManager({
      ...options,
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/fail1').reply(500, 'Error');
    mock.onGet('/fail2').reply(500, 'Error');

    await retryManager
      .axiosInstance
      .get('/fail1')
      .catch(() => {});
    await retryManager
      .axiosInstance
      .get('/fail2')
      .catch(() => {});
  });

  test('should store multiple concurrent failed requests', async () => {
    const manualRetry = new ManualRetryPlugin();
    // Disable retries to isolate the test behavior
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 0, // No retries
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    retryManager.use(manualRetry);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Mock the responses to always fail
    mock.onGet('/fail1').reply(500, 'Error 1');
    mock.onGet('/fail2').reply(500, 'Error 2');

    // Make concurrent requests
    await Promise.all([
      retryManager
        .axiosInstance
        .get('/fail1')
        .catch(() => {}),
      retryManager
        .axiosInstance
        .get('/fail2')
        .catch(() => {}),
    ]);

    // Check the request store
    const storedRequests = manualRetry.getStoredRequests();

    // Assertions
    expect(storedRequests).toHaveLength(2);
    expect(storedRequests[0].url).toBe('/fail1');
    expect(storedRequests[1].url).toBe('/fail2');
  }, 10000);

  test('should reject requests with QueueFullError when queue size limit is reached', async () => {
    // Create spies to monitor what's happening
    const consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    
    // Reinitialize with a max queue size of 2
    const options = {
      mode: 'automatic' as const,
      retries: 0, // No retries to keep test simple
      maxConcurrentRequests: 1,
      maxQueueSize: 2,
      queueDelay: 50, // Add delay to ensure requests are properly queued
      debug: true, // Enable debug mode to see what's happening
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Set up mock to use our manually controlled promise - ensuring requests stay pending
    mock.onGet(/\/test-queue-limit\/.*/).reply(() => {
      return new Promise(() => {});
    });

    // Make our requests and track them
    console.log('Making first request - should be in process');
    retryManager.axiosInstance.get('/test-queue-limit/1').catch(e => e);
    
    // Wait long enough for first request to start processing
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('Making second request - should be queued (position 1)');
    retryManager.axiosInstance.get('/test-queue-limit/2').catch(e => e);
    
    // Wait to ensure second request is properly queued
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('Making third request - should be queued (position 2)');
    retryManager.axiosInstance.get('/test-queue-limit/3').catch(e => e);
    
    // Wait to ensure third request is properly queued
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check queue size using RequestQueue's internal method via the private field
    // Note: In a real application you should avoid accessing private fields
    const queueSize = retryManager['requestQueue'].getWaitingCount();
    console.log(`Current queue size: ${queueSize}`);
    expect(queueSize).toBe(2); // Verify queue actually has 2 items
    
    console.log('Making fourth request - should be rejected');
    // The 4th request should now be rejected with QueueFullError
    await expect(retryManager.axiosInstance.get('/test-queue-limit/4'))
      .rejects.toThrow('Request queue is full');
    
    // Clean up
    consoleDebugSpy.mockRestore();
    retryManager.cancelAllRequests();
  }, 5000); // Increase timeout for this test

  test('should keep core request debug logs minimal without the sanitization plugin', async () => {
    const debugManager = new RetryManager({ debug: true });
    const debugMock = new AxiosMockAdapter(debugManager.axiosInstance);
    const loggerSpy = jest.spyOn(debugManager.getLogger(), 'debug').mockImplementation();

    debugMock.onPost('/api/login?token=secret-token').reply(200, { success: true });

    await debugManager.axiosInstance.post(
      '/api/login?token=secret-token',
      { username: 'testuser', password: 'secret123' },
      {
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
      },
    );

    const logEntry = loggerSpy.mock.calls.find(([message]) => message === 'New request created');

    expect(logEntry).toBeDefined();
    expect(logEntry?.[1]).toMatchObject({
      method: 'POST',
      url: '/api/login',
    });
    expect(logEntry?.[1]).not.toHaveProperty('headers');

    debugMock.restore();
    debugManager.destroy();
  });

  test('should keep core error logs minimal without the sanitization plugin', async () => {
    const debugManager = new RetryManager({ debug: true, retries: 0 });
    const debugMock = new AxiosMockAdapter(debugManager.axiosInstance);
    const loggerSpy = jest.spyOn(debugManager.getLogger(), 'error').mockImplementation();

    debugMock.onPost('/auth?token=secret-token').reply(
      500,
      { password: 'server-secret' },
      { 'x-api-key': 'server-secret' },
    );

    await debugManager.axiosInstance.post(
      '/auth?token=secret-token',
      { password: 'secret123' },
      {
        headers: {
          Authorization: 'Bearer secret-token',
        },
      },
    ).catch(() => undefined);

    const logEntry = loggerSpy.mock.calls.find(([message]) => message === 'Request failed');

    expect(logEntry).toBeDefined();
    expect(logEntry?.[1]).toMatchObject({
      method: 'POST',
      status: 500,
      url: '/auth',
    });
    expect(logEntry?.[1]).not.toHaveProperty('headers');
    expect(logEntry?.[1]).not.toHaveProperty('data');
    expect(logEntry?.[1]).not.toHaveProperty('response');

    debugMock.restore();
    debugManager.destroy();
  });
});
