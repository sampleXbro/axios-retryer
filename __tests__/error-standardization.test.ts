import axios, { AxiosError } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import {
  createRetryer,
  PluginRegistrationError,
  QueueClearedError,
  QueueDestroyedError,
  QueuedRequestCanceledError,
  RequestAbortedError,
  RetryerConfigError,
} from '../src';
import { RequestQueue } from '../src/core/requestQueue';
import { CachingPlugin, InvalidCacheKeyError } from '../src/plugins/CachingPlugin';
import {
  CircuitBreakerPlugin,
  CIRCUIT_BREAKER_STATES,
  CircuitBreakerState,
  CircuitBreakerStateError,
} from '../src/plugins/CircuitBreakerPlugin';
import {
  MissingTokenRefreshHandlerError,
  TokenRefreshAbortError,
  TokenRefreshPlugin,
} from '../src/plugins/TokenRefreshPlugin';

describe('Error standardization', () => {
  test('uses RetryerConfigError for core and plugin validation failures', () => {
    expect(() => createRetryer({ retries: -1 })).toThrow(RetryerConfigError);
    expect(() => new CachingPlugin({ maxAge: -1 })).toThrow(RetryerConfigError);
    expect(() => new CircuitBreakerPlugin({ failureThreshold: 0 })).toThrow(RetryerConfigError);
    expect(() => new TokenRefreshPlugin(async () => ({ token: 'x' }), { refreshTimeout: 0 })).toThrow(
      RetryerConfigError,
    );

    try {
      createRetryer({ retries: -1 });
    } catch (error) {
      expect(error).toBeInstanceOf(RetryerConfigError);
      expect(error).toMatchObject({
        code: 'EINVALID_CONFIG',
        optionName: 'retries',
        optionValue: -1,
      });
    }
  });

  test('uses PluginRegistrationError for duplicate plugins and invalid versions', () => {
    const retryer = createRetryer();
    const duplicatePlugin = {
      name: 'DuplicatePlugin',
      version: '1.0.0',
      initialize: jest.fn(),
    };

    retryer.use(duplicatePlugin);

    expect(() => retryer.use(duplicatePlugin)).toThrow(PluginRegistrationError);
    expect(() =>
      retryer.use({
        name: 'BadVersionPlugin',
        version: 'bad-version',
        initialize: jest.fn(),
      }),
    ).toThrow(PluginRegistrationError);

    try {
      retryer.use(duplicatePlugin);
    } catch (error) {
      expect(error).toBeInstanceOf(PluginRegistrationError);
      expect(error).toMatchObject({
        code: 'EPLUGIN_ALREADY_REGISTERED',
        pluginName: 'DuplicatePlugin',
      });
    }

    retryer.destroy();
  });

  test('uses named queue errors for destroyed, canceled, and cleared requests', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 1000, canProcess: () => true });

    const canceledPromise = queue.enqueue({ __axiosRetryer: { requestId: 'cancel-me' } });
    expect(queue.cancelQueuedRequest('cancel-me')).toBe(true);
    await expect(canceledPromise).rejects.toBeInstanceOf(QueuedRequestCanceledError);

    const clearedPromise = queue.enqueue({ __axiosRetryer: { requestId: 'clear-me' } });
    queue.clear();
    await expect(clearedPromise).rejects.toBeInstanceOf(QueueClearedError);

    queue.destroy();
    await expect(queue.enqueue({})).rejects.toBeInstanceOf(QueueDestroyedError);
  });

  test('uses RequestAbortedError when retries are cancelled and throwing is enabled', async () => {
    const retryer = createRetryer();

    await expect(
      (retryer as any).errorInterceptorHandler['handleCancelAction']({ __axiosRetryer: { requestId: 'abort-me' } }),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    retryer.destroy();
  });

  test('uses InvalidCacheKeyError for invalid cache key generation', () => {
    const plugin = new CachingPlugin();

    expect(() => plugin['buildCacheKey']({ method: 'get' })).toThrow(InvalidCacheKeyError);
  });

  test('uses CircuitBreakerStateError for fail-fast circuit responses', () => {
    const plugin = new CircuitBreakerPlugin();
    const error = plugin['_createCircuitStateError'](
      { url: '/payments' },
      {
        state: CIRCUIT_BREAKER_STATES.OPEN,
        failureCount: 3,
        halfOpenCount: 0,
        successCount: 0,
        nextAttempt: Date.now() + 5000,
        recentFailures: [],
        lastFailureStatus: 503,
        lastFailureCode: 'ECONNRESET',
      },
      'Circuit is open: failing fast.',
    );

    expect(error).toBeInstanceOf(CircuitBreakerStateError);
    expect(error).toMatchObject({
      code: 'ECONNRESET',
      circuitState: CIRCUIT_BREAKER_STATES.OPEN,
    });
    expect(error.response?.status).toBe(503);
  });

  test('uses standardized token refresh errors across failure modes', async () => {
    expect(new TokenRefreshAbortError('stop')).toMatchObject({
      code: 'ETOKEN_REFRESH_ABORTED',
      stopRefreshRetries: true,
    });

    const faultyAxios = axios.create();
    const faultyMock = new AxiosMockAdapter(faultyAxios);
    const faultyRetryer = createRetryer({ axiosInstance: faultyAxios });
    faultyRetryer.use(new TokenRefreshPlugin(undefined as never, { refreshStatusCodes: [401] }));
    faultyMock.onGet('/protected').reply(401);

    const missingHandlerErr = await faultyRetryer.axiosInstance.get('/protected').catch((e) => e);
    expect(missingHandlerErr).toBeInstanceOf(AxiosError);
    expect(missingHandlerErr.code).toBe('TOKEN_REFRESH_FAILED');
    expect(missingHandlerErr.cause).toBeInstanceOf(MissingTokenRefreshHandlerError);
    faultyRetryer.destroy();
    faultyMock.restore();

    const timeoutAxios = axios.create();
    const timeoutMock = new AxiosMockAdapter(timeoutAxios);
    const timeoutRetryer = createRetryer({ axiosInstance: timeoutAxios });
    timeoutRetryer.use(
      new TokenRefreshPlugin(async () => await new Promise(() => {}), {
        refreshStatusCodes: [401],
        refreshTimeout: 1,
        maxRefreshAttempts: 1,
        retryOnRefreshFail: false,
      }),
    );
    timeoutMock.onGet('/timeout-protected').reply(401);

    const timeoutErr = await timeoutRetryer.axiosInstance.get('/timeout-protected').catch((e) => e);
    expect(timeoutErr).toBeInstanceOf(AxiosError);
    expect(timeoutErr.code).toBe('TOKEN_REFRESH_FAILED');
    expect(timeoutErr.message).toBe('Token refresh timeout');
    timeoutRetryer.destroy();
    timeoutMock.restore();

    const plugin = new TokenRefreshPlugin(async () => ({ token: 'fresh-token' }));
    const reject = jest.fn();
    plugin['refreshQueue'] = [
      {
        kind: 'hold-request',
        config: {},
        resolveConfig: jest.fn(),
        reject,
      },
    ];
    plugin['context'] = { triggerAndEmit: jest.fn(), releaseRequestTracking: jest.fn() } as any;
    plugin['logger'] = { error: jest.fn() } as any;
    const networkErr = new AxiosError('network', 'ERR_NETWORK');
    plugin['handleRefreshFailure'](networkErr);

    expect(reject).toHaveBeenCalledTimes(1);
    const rejected = reject.mock.calls[0][0] as AxiosError;
    expect(rejected).toBeInstanceOf(AxiosError);
    expect(rejected.code).toBe('TOKEN_REFRESH_FAILED');
    expect(rejected.config).toEqual({});
    expect((rejected as Error & { cause?: unknown }).cause).toBe(networkErr);
  });
});
