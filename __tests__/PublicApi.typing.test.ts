import type { AxiosError } from 'axios';

import {
  AXIOS_RETRYER_BACKOFF_TYPES,
  AXIOS_RETRYER_HTTP_METHODS,
  RETRY_MODES,
  type RetryHooks,
  createRetryStrategy,
  createRetryer,
} from '../src';
import {
  createCachePlugin,
  CIRCUIT_BREAKER_SCOPES,
  CircuitBreakerPlugin,
  type CircuitBreakerMetrics,
  createCircuitBreaker,
  type TokenRefreshPluginEvents,
  type TokenRefreshResult,
  createTokenRefreshPlugin,
} from '../src/plugins';

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
    beforeManualRetry: (config) => config,
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
  createRetryer({ hooks: coreHooks });
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
};

describe('Public API typing', () => {
  it('keeps core and plugin typings precise for end users', () => {
    expect(typeof verifyPublicApiTyping).toBe('function');
  });
});
