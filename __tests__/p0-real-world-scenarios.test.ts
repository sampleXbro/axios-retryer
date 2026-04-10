import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import {
  AXIOS_RETRYER_BACKOFF_TYPES,
  AXIOS_RETRYER_REQUEST_PRIORITIES,
  QueueDestroyedError,
  RetryManager,
  type PluginContext,
  type RetryPlugin,
} from '../src';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
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

function getHeader(config: AxiosRequestConfig, headerName: string): string | undefined {
  const headers = config.headers as Record<string, unknown> | undefined;
  if (!headers) {
    return undefined;
  }

  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === headerName.toLowerCase());
  return typeof match?.[1] === 'string' ? match[1] : undefined;
}

describe('P0 Real-World Scenarios (22.x)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('22.1 API Rate Limiting', () => {
    it('22.1.1: 429 with Retry-After waits before succeeding on retry', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
      });
      const startedAt = Date.now();

      mock.onGet('/rate-once').replyOnce(429, {}, { 'Retry-After': '0.02' });
      mock.onGet('/rate-once').replyOnce(200, { ok: true });

      try {
        const response = await manager.axiosInstance.get('/rate-once');
        expect(response.status).toBe(200);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.1.2: repeated 429 responses eventually succeed after the configured retries', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 3,
        queueDelay: 0,
        // Exponential backoff + full jitter can exceed Jest's 5s default (e.g. ~7s worst case for 3 delays).
        backoffType: AXIOS_RETRYER_BACKOFF_TYPES.STATIC,
      });
      let attempts = 0;

      mock.onGet('/rate-many').reply(() => {
        attempts += 1;
        return attempts <= 3 ? [429] : [200, { ok: true }];
      });

      try {
        const response = await manager.axiosInstance.get('/rate-many');
        expect(response.status).toBe(200);
        expect(attempts).toBe(4);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.1.3: persistent 429 responses fail with the original 429 error', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        queueDelay: 0,
      });

      mock.onGet('/rate-fail').reply(429);

      try {
        await expect(manager.axiosInstance.get('/rate-fail')).rejects.toThrow('Request failed with status code 429');
        expect(mock.history.get).toHaveLength(3);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.1.4: burst traffic still honors maxConcurrentRequests under rate-limit responses', async () => {
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
              data: { error: 'rate limited' },
              headers: {},
              status: 429,
              statusText: 'Too Many Requests',
            });
          }, 5);
        });

      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
        maxConcurrentRequests: 3,
        throwErrorOnFailedRetries: false,
      });

      try {
        await Promise.all(Array.from({ length: 20 }, (_, index) => manager.axiosInstance.get(`/burst-${index}`)));
        expect(maxActive).toBe(3);
      } finally {
        manager.destroy();
      }
    });
  });

  describe('22.2 OAuth Token Expiration', () => {
    it('22.2.1: a batch of protected requests fans into a single refresh cycle', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => ({ token: 'fresh-token' }));
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(
        new TokenRefreshPlugin(refreshFn, {
          retryOnRefreshFail: false,
          maxRefreshAttempts: 1,
        }),
      );

      mock.onGet('/oauth-batch').reply((config) => {
        return getHeader(config, 'Authorization') === 'Bearer fresh-token' ? [200, { ok: true }] : [401];
      });

      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, () =>
            manager.axiosInstance.get('/oauth-batch', {
              headers: { Authorization: 'Bearer stale-token' },
            }),
          ),
        );

        expect(refreshFn).toHaveBeenCalledTimes(1);
        expect(responses).toHaveLength(10);
        expect(responses.every((response) => response.status === 200)).toBe(true);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.2.2: failed refresh rejects all pending protected requests', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => {
        throw new Error('refresh expired');
      });
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(
        new TokenRefreshPlugin(refreshFn, {
          retryOnRefreshFail: false,
          maxRefreshAttempts: 1,
        }),
      );
      mock.onGet('/oauth-fail').reply(401);

      try {
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            manager.axiosInstance.get('/oauth-fail', {
              headers: { Authorization: 'Bearer stale-token' },
            }),
          ),
        );

        expect(refreshFn).toHaveBeenCalledTimes(1);
        expect(results.every((result) => result.status === 'rejected')).toBe(true);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.2.3: a replayed request that still returns 401 does not enter an infinite refresh loop', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => ({ token: 'revoked-token' }));
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(
        new TokenRefreshPlugin(refreshFn, {
          retryOnRefreshFail: false,
          maxRefreshAttempts: 1,
        }),
      );

      mock.onGet('/oauth-loop').replyOnce(401);
      mock.onGet('/oauth-loop').replyOnce(401);

      try {
        await expect(
          manager.axiosInstance.get('/oauth-loop', {
            headers: { Authorization: 'Bearer stale-token' },
          }),
        ).rejects.toThrow();

        expect(refreshFn).toHaveBeenCalledTimes(1);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('22.3 Microservice Cascading Failures', () => {
    it('22.3.1: repeated 503s open the circuit and stop later calls', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 1,
        openTimeout: 50,
      });
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(plugin);
      mock.onGet('/service-b').reply(503);

      try {
        await manager.axiosInstance.get('/service-b').catch(() => undefined);
        await expect(manager.axiosInstance.get('/service-b')).rejects.toThrow();
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.3.2: recovered services close the circuit again after a successful half-open probe', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 1,
        openTimeout: 20,
      });
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(plugin);
      mock.onGet('/service-b').replyOnce(503);
      mock.onGet('/service-b').reply(200, { ok: true });

      try {
        await manager.axiosInstance.get('/service-b').catch(() => undefined);
        await wait(25);
        const response = await manager.axiosInstance.get('/service-b');

        expect(response.status).toBe(200);
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.3.3: flapping 503s do not prematurely trip a sliding-window circuit', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 3,
        useSlidingWindow: true,
        slidingWindowSize: 30,
      });
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(plugin);
      mock.onGet('/flapping').reply(503);

      try {
        await manager.axiosInstance.get('/flapping').catch(() => undefined);
        await wait(35);
        await manager.axiosInstance.get('/flapping').catch(() => undefined);
        await wait(35);
        await manager.axiosInstance.get('/flapping').catch(() => undefined);

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('22.4 Offline → Online Transition', () => {
    it('22.4.1: offline network failures are stored for manual replay', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manualRetry = new ManualRetryPlugin();
      const manager = new RetryManager({
        axiosInstance,
        mode: 'manual',
        retries: 0,
        queueDelay: 0,
      });

      manager.use(manualRetry);
      mock.onGet('/offline').networkError();

      try {
        await manager.axiosInstance.get('/offline').catch(() => undefined);
        expect(manualRetry.getStoredRequests()).toHaveLength(1);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.4.2: retryFailedRequests() replays stored requests once connectivity returns', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manualRetry = new ManualRetryPlugin();
      const manager = new RetryManager({
        axiosInstance,
        mode: 'manual',
        retries: 0,
        queueDelay: 0,
      });

      manager.use(manualRetry);
      mock.onGet('/offline-replay').networkErrorOnce();
      mock.onGet('/offline-replay').reply(200, { ok: true });

      try {
        await manager.axiosInstance.get('/offline-replay').catch(() => undefined);
        const results = await manualRetry.retryFailedRequests();

        expect(results).toHaveLength(1);
        expect(results[0].status).toBe(200);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.4.3: replayed requests that fail again are not re-stored', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manualRetry = new ManualRetryPlugin();
      const manager = new RetryManager({
        axiosInstance,
        mode: 'manual',
        retries: 0,
        queueDelay: 0,
      });

      manager.use(manualRetry);
      mock.onGet('/offline-fail-again').networkErrorOnce();
      mock.onGet('/offline-fail-again').reply(500, { error: 'still down' });

      try {
        await manager.axiosInstance.get('/offline-fail-again').catch(() => undefined);
        await manualRetry.retryFailedRequests().catch(() => undefined);

        expect(manualRetry.getStoredRequests()).toHaveLength(0);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('22.5 Priority-Based Request Ordering', () => {
    it('22.5.1: higher-priority auth work dispatches before queued lower-priority work', async () => {
      class GatePlugin implements RetryPlugin {
        public name = 'GatePlugin';
        public version = '1.0.0';
        private openGate!: () => void;

        public initialize(context: PluginContext): void {
          let allow = false;
          context.registerQueueGate('p0-real-world-gate', () => allow);
          this.openGate = () => {
            allow = true;
            context.refreshQueue();
          };
        }

        public release(): void {
          this.openGate();
        }
      }

      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const gatePlugin = new GatePlugin();
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
        maxConcurrentRequests: 3,
      });

      manager.use(gatePlugin);
      mock.onGet('/auth').reply(200, { ok: 'auth' });
      mock.onGet('/data').reply(200, { ok: 'data' });
      mock.onGet('/analytics').reply(200, { ok: 'analytics' });

      try {
        const analytics = manager.axiosInstance.get('/analytics', {
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
        });
        const data = manager.axiosInstance.get('/data', {
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
        });
        const auth = manager.axiosInstance.get('/auth', {
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        });

        await wait(0);
        gatePlugin.release();
        await Promise.all([analytics, data, auth]);

        expect(mock.history.get.map((request) => request.url)).toEqual(['/auth', '/data', '/analytics']);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.5.2: blocking auth requests keep dependent data fetches waiting until auth completes', async () => {
      const axiosInstance = axios.create();
      let authStarted = false;
      let dataStarted = false;
      let releaseAuth!: () => void;
      axiosInstance.defaults.adapter = async (config) =>
        new Promise((resolve) => {
          if (config.url === '/auth') {
            authStarted = true;
            releaseAuth = () =>
              resolve({
                config,
                data: { ok: true },
                headers: {},
                status: 200,
                statusText: 'OK',
              });
            return;
          }

          dataStarted = true;
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
        maxConcurrentRequests: 2,
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
      });

      try {
        const auth = manager.axiosInstance.get('/auth', {
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        });
        const data = manager.axiosInstance.get('/data', {
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
        });

        await wait(20);
        expect(authStarted).toBe(true);
        expect(dataStarted).toBe(false);

        releaseAuth();
        await Promise.all([auth, data]);
        expect(dataStarted).toBe(true);
      } finally {
        manager.destroy();
      }
    });

    it('22.5.3: failing blocking auth work cancels pending dependent requests', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
        cancelPendingOnDependencyFailure: true,
      });

      mock.onGet('/auth-fail').reply(500);
      mock.onGet('/data-waiting').reply(200, { shouldNotRun: true });

      try {
        const auth = manager.axiosInstance
          .get('/auth-fail', {
            __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
          })
          .catch(() => undefined);
        const data = manager.axiosInstance.get('/data-waiting', {
          __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
        });

        await auth;
        await expect(data).rejects.toMatchObject({
          code: 'REQUEST_CANCELED',
          name: 'QueuedRequestCanceledError',
        });
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('22.6 Graceful Shutdown', () => {
    it('22.6.1: cancelAllRequests() followed by destroy() leaves no hanging request promises', async () => {
      const axiosInstance = axios.create();
      axiosInstance.defaults.adapter = createAbortableAdapter();
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
        maxConcurrentRequests: 1,
      });

      try {
        const first = manager.axiosInstance.get('/shutdown-a').catch(() => undefined);
        const second = manager.axiosInstance.get('/shutdown-b').catch(() => undefined);
        await wait(0);

        manager.cancelAllRequests();
        manager.destroy();

        const results = await Promise.allSettled([first, second]);
        expect(results).toHaveLength(2);
      } finally {
        manager.destroy();
      }
    });

    it('22.6.2: destroying with an in-flight request aborts it with a clear error', async () => {
      const axiosInstance = axios.create();
      axiosInstance.defaults.adapter = createAbortableAdapter();
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      try {
        const request = manager.axiosInstance.get('/in-flight');
        await wait(0);
        manager.destroy();

        await expect(request).rejects.toThrow();
      } finally {
        manager.destroy();
      }
    });

    it('22.6.3: queued requests reject with QueueDestroyedError during destroy()', async () => {
      const axiosInstance = axios.create();
      let firstResolve!: () => void;
      axiosInstance.defaults.adapter = async (config) =>
        new Promise((resolve) => {
          if (config.url === '/slow') {
            firstResolve = () =>
              resolve({
                config,
                data: { ok: true },
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
      });

      try {
        const first = manager.axiosInstance.get('/slow').catch(() => undefined);
        await wait(0);
        const queued = manager.axiosInstance.get('/queued');

        manager.destroy();
        firstResolve();

        await expect(queued).rejects.toBeInstanceOf(QueueDestroyedError);
        await first;
      } finally {
        manager.destroy();
      }
    });
  });

  describe('22.7 File Upload with Retry', () => {
    it('22.7.1: large request bodies are preserved across retries', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
      });
      const body = {
        payload: 'x'.repeat(8_192),
      };

      mock.onPost('/upload-large').replyOnce(500);
      mock.onPost('/upload-large').replyOnce(200, { ok: true });

      try {
        await manager.axiosInstance.post('/upload-large', body, {
          headers: { 'Idempotency-Key': 'upload-large' },
        });

        expect(mock.history.post).toHaveLength(2);
        expect(mock.history.post[0]?.data).toBe(mock.history.post[1]?.data);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.7.2: POST uploads with Idempotency-Key are retried on server errors', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
      });

      mock.onPost('/upload-idempotent').replyOnce(500);
      mock.onPost('/upload-idempotent').replyOnce(200, { ok: true });

      try {
        const response = await manager.axiosInstance.post(
          '/upload-idempotent',
          { file: 'data' },
          {
            headers: { 'Idempotency-Key': 'file-1' },
          },
        );

        expect(response.status).toBe(200);
        expect(mock.history.post).toHaveLength(2);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.7.3: POST uploads without Idempotency-Key are not retried', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
      });

      mock.onPost('/upload-non-idempotent').reply(500);

      try {
        await expect(manager.axiosInstance.post('/upload-non-idempotent', { file: 'data' })).rejects.toThrow();
        expect(mock.history.post).toHaveLength(1);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('22.8 GraphQL Error Handling', () => {
    it('22.8.1: UNAUTHENTICATED GraphQL bodies trigger token refresh through customErrorDetector', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => ({ token: 'fresh-token' }));
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(
        new TokenRefreshPlugin(refreshFn, {
          retryOnRefreshFail: false,
          maxRefreshAttempts: 1,
          customErrorDetector: (response: unknown) =>
            (response as { errors?: Array<{ extensions?: { code?: string } }> }).errors?.[0]?.extensions?.code ===
            'UNAUTHENTICATED',
        }),
      );

      mock.onGet('/graphql-auth').replyOnce(200, {
        errors: [{ extensions: { code: 'UNAUTHENTICATED' } }],
      });
      mock.onGet('/graphql-auth').replyOnce(200, { data: { ok: true } });

      try {
        const response = await manager.axiosInstance.get('/graphql-auth', {
          headers: { Authorization: 'Bearer stale-token' },
        });

        expect(response.status).toBe(200);
        expect(refreshFn).toHaveBeenCalledTimes(1);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.8.2: partial GraphQL data with non-auth errors is returned as a normal response', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const refreshFn = jest.fn(async () => ({ token: 'fresh-token' }));
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        queueDelay: 0,
      });

      manager.use(
        new TokenRefreshPlugin(refreshFn, {
          retryOnRefreshFail: false,
          maxRefreshAttempts: 1,
          customErrorDetector: (response: unknown) =>
            (response as { errors?: Array<{ extensions?: { code?: string } }> }).errors?.[0]?.extensions?.code ===
            'UNAUTHENTICATED',
        }),
      );

      mock.onGet('/graphql-partial').reply(200, {
        data: { partial: true },
        errors: [{ extensions: { code: 'SOME_OTHER_ERROR' } }],
      });

      try {
        const response = await manager.axiosInstance.get('/graphql-partial');

        expect(response.data).toEqual({
          data: { partial: true },
          errors: [{ extensions: { code: 'SOME_OTHER_ERROR' } }],
        });
        expect(refreshFn).not.toHaveBeenCalled();
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('22.8.3: network-like GraphQL error bodies are not retried by default', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        queueDelay: 0,
      });

      mock.onGet('/graphql-network').reply(200, {
        errors: [{ extensions: { code: 'NETWORK_ERROR' } }],
      });

      try {
        const response = await manager.axiosInstance.get('/graphql-network');

        expect(response.status).toBe(200);
        expect(mock.history.get).toHaveLength(1);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });
});
