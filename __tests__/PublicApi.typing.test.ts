import type { AxiosError } from 'axios';

import {
  AXIOS_RETRYER_BACKOFF_TYPES,
  AXIOS_RETRYER_HTTP_METHODS,
  RETRY_MODES,
  type PluginContext,
  type RetryHooks,
  createRetryStrategy,
  createRetryer,
} from '../src';
import {
  CIRCUIT_BREAKER_SCOPES,
  CircuitBreakerPlugin,
  type CircuitBreakerMetrics,
  type ManualRetryPluginEvents,
  createCircuitBreaker,
  type TokenRefreshPluginEvents,
  type TokenRefreshResult,
  createTokenRefreshPlugin,
} from '../src/plugins';
import { createCachePlugin } from '../src/plugins/CachingPlugin';
import type { RequestStore } from '../src/plugins/ManualRetryPlugin';
import type { MetricsRecorder } from '../src/plugins/MetricsPlugin';

const verifyPublicApiTyping = (): void => {
  const retryer = createRetryer({
    mode: RETRY_MODES.AUTOMATIC,
    backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
    retryableStatuses: [408, 429, [500, 599] as const],
    retryableMethods: [
      AXIOS_RETRYER_HTTP_METHODS.GET,
      AXIOS_RETRYER_HTTP_METHODS.HEAD,
      AXIOS_RETRYER_HTTP_METHODS.PUT,
    ] as const,
  });
  const coreHooks: RetryHooks = {
    beforeRetry: (config) => {
      expect(config.url).toBeDefined();
    },
  };
  const manualRetryHooks: RetryHooks<ManualRetryPluginEvents> = {
    onManualRetryProcessStarted: () => {
      expect(true).toBe(true);
    },
  };
  const tokenRefreshHooks: RetryHooks<TokenRefreshPluginEvents> = {
    onTokenRefreshed: (token) => {
      expect(token).toBe('fresh-token');
    },
  };

  const cachePlugin = createCachePlugin({
    cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET] as const,
  });

  const circuitBreaker = createCircuitBreaker({
    scope: CIRCUIT_BREAKER_SCOPES.HOST_AND_URL,
  });

  const tokenPlugin = createTokenRefreshPlugin(
    async (axiosInstance) => {
      expect(axiosInstance).toBeDefined();

      const result: TokenRefreshResult = { token: 'fresh-token' };
      return result;
    },
    {
      customErrorDetector: (response) => {
        if (typeof response !== 'object' || response === null) {
          return false;
        }

        return 'errors' in response;
      },
    },
  );

  const circuitBreakerMetrics: CircuitBreakerMetrics = new CircuitBreakerPlugin().getMetrics();

  createRetryStrategy({
    isRetryable: (error) => {
      const typedError: AxiosError = error;
      return Boolean(typedError.response);
    },
    shouldRetry: (error, attempt, maxRetries) => {
      const typedError: AxiosError = error;
      return Boolean(typedError.code) && attempt <= maxRetries;
    },
  });

  retryer.use(cachePlugin);
  retryer.use(circuitBreaker);
  retryer.use(tokenPlugin);
  retryer.axiosInstance.get('/cached', {
    __cachingOptions: {
      cache: true,
      ttr: 1000,
    },
  });
  createRetryer({ hooks: coreHooks });
  createRetryer<ManualRetryPluginEvents>({ hooks: manualRetryHooks });
  createRetryer<TokenRefreshPluginEvents>({ hooks: tokenRefreshHooks });
  expect(circuitBreakerMetrics.state).toBeDefined();

  // @ts-expect-error retryableMethods only accepts supported HTTP methods.
  createRetryer({ retryableMethods: ['TRACE'] });

  createRetryer({
    hooks: {
      // @ts-expect-error Plugin-specific hooks are not available on the untyped root manager.
      onTokenRefreshed: () => undefined,
    },
  });

  // @ts-expect-error cacheMethods only accepts supported HTTP methods.
  createCachePlugin({ cacheMethods: ['TRACE'] });

  // @ts-expect-error scope only accepts declared circuit breaker scope constants/values.
  createCircuitBreaker({ scope: 'service' });

  // PluginContext is part of the root surface (needed for plugin authors)
  const _ctx: PluginContext = undefined as unknown as PluginContext;
  void _ctx;

  // RequestStore is available from the ManualRetryPlugin entry
  const _store: RequestStore = undefined as unknown as RequestStore;
  void _store;

  // MetricsRecorder is available from the MetricsPlugin entry
  const _recorder: MetricsRecorder = undefined as unknown as MetricsRecorder;
  void _recorder;

  // @ts-expect-error Plugin option types are not exported from the root entry.
  type RootTokenRefreshPluginOptions = import('../src').TokenRefreshPluginOptions;

  // @ts-expect-error RequestStore is not part of the root surface.
  type RootRequestStore = import('../src').RequestStore;

  // @ts-expect-error MetricsRecorder is not part of the root surface.
  type RootMetricsRecorder = import('../src').MetricsRecorder;

  // @ts-expect-error Plugin-private metadata is not part of the root metadata surface.
  const metadata: import('../src').AxiosRetryerRequestMetadata = { isRetryRefreshRequest: true };
  void metadata;
};

describe('Public API typing', () => {
  it('keeps core and plugin typings precise for end users', () => {
    expect(typeof verifyPublicApiTyping).toBe('function');
  });
});
