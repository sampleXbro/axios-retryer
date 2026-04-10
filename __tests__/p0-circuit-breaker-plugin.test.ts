import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import {
  CircuitBreakerPlugin,
  type CircuitBreakerScopeState,
  type CircuitBreakerStateAdapter,
} from '../src/plugins/CircuitBreakerPlugin';
import { CircuitBreakerStateError } from '../src/plugins/CircuitBreakerPlugin/CircuitBreakerStateError';

type TestLogger = {
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
  info: jest.Mock;
};

type Harness = {
  axiosInstance: AxiosInstance;
  manager: RetryManager;
  mock: MockAdapter;
  plugin: CircuitBreakerPlugin;
  logger: TestLogger;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLogger(): TestLogger {
  return {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    info: jest.fn(),
  };
}

function createHarness(
  pluginOptions: ConstructorParameters<typeof CircuitBreakerPlugin>[0] = {},
  managerOptions: ConstructorParameters<typeof RetryManager>[0] = {},
): Harness {
  const axiosInstance = axios.create({
    baseURL: 'https://api.example.com',
  });
  const mock = new MockAdapter(axiosInstance);
  const logger = createLogger();
  const plugin = new CircuitBreakerPlugin(pluginOptions);
  const manager = new RetryManager({
    axiosInstance,
    retries: 0,
    queueDelay: 0,
    logger,
    throwErrorOnFailedRetries: true,
    ...managerOptions,
  });

  manager.use(plugin);

  return {
    axiosInstance,
    manager,
    mock,
    plugin,
    logger,
  };
}

async function failRequest(manager: RetryManager, url: string, config?: AxiosRequestConfig): Promise<void> {
  await manager.axiosInstance.get(url, config).catch(() => undefined);
}

describe('P0 CircuitBreakerPlugin (14.x)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('14.1 State Machine', () => {
    it('14.1.1: initial state is CLOSED for all scope keys', () => {
      const { manager, plugin, mock } = createHarness();

      try {
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
        expect(plugin.getState('missing-scope')).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.2: CLOSED transitions to OPEN after exactly failureThreshold failures', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 2,
      });
      mock.onGet('/trip').reply(500);

      try {
        await failRequest(manager, '/trip');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);

        await failRequest(manager, '/trip');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.3: OPEN state fails fast without making a network call', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 1_000,
      });
      mock.onGet('/fast-fail').reply(500);

      try {
        await failRequest(manager, '/fast-fail');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);

        await expect(manager.axiosInstance.get('/fast-fail')).rejects.toBeInstanceOf(CircuitBreakerStateError);
        expect(mock.history.get).toHaveLength(1);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.4: OPEN transitions to HALF_OPEN after openTimeout elapses', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 20,
      });

      let releaseProbe!: () => void;
      mock.onGet('/service').replyOnce(500);
      mock.onGet('/service').reply(() => {
        return new Promise<[number, object]>((resolve) => {
          releaseProbe = () => resolve([200, { ok: true }]);
        });
      });

      try {
        await failRequest(manager, '/service');
        await wait(25);

        const probePromise = manager.axiosInstance.get('/service');
        await wait(0);

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.HALF_OPEN);

        releaseProbe();
        await probePromise;
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.5: HALF_OPEN allows exactly halfOpenMax probe requests through', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 20,
        halfOpenMax: 2,
        successThreshold: 2,
      });

      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let probeCount = 0;

      mock.onGet('/service').replyOnce(500);
      mock.onGet('/service').reply(() => {
        probeCount += 1;
        return new Promise<[number, object]>((resolve) => {
          if (probeCount === 1) {
            releaseFirst = () => resolve([200, { ok: 'first' }]);
            return;
          }

          releaseSecond = () => resolve([200, { ok: 'second' }]);
        });
      });

      try {
        await failRequest(manager, '/service');
        await wait(25);

        const first = manager.axiosInstance.get('/service');
        const second = manager.axiosInstance.get('/service');
        await wait(0);

        await expect(manager.axiosInstance.get('/service')).rejects.toBeInstanceOf(CircuitBreakerStateError);

        releaseFirst();
        releaseSecond();
        await Promise.all([first, second]);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.6: HALF_OPEN transitions to CLOSED after successThreshold successes', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 20,
        halfOpenMax: 2,
        successThreshold: 2,
      });

      mock.onGet('/service').replyOnce(500);
      mock.onGet('/service').reply(200, { ok: true });

      try {
        await failRequest(manager, '/service');
        await wait(25);

        await manager.axiosInstance.get('/service');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.HALF_OPEN);

        await manager.axiosInstance.get('/service');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.7: HALF_OPEN transitions back to OPEN after any failure', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 20,
      });

      mock.onGet('/service').replyOnce(500);
      mock.onGet('/service').reply(500);

      try {
        await failRequest(manager, '/service');
        await wait(25);

        await expect(manager.axiosInstance.get('/service')).rejects.toThrow();
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.8: onCircuitStateChanged emits the correct transition sequence', async () => {
      const { manager, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 20,
      });
      const events: Array<Record<string, unknown>> = [];

      manager.on(
        'onCircuitStateChanged' as never,
        ((payload: Record<string, unknown>) => {
          events.push(payload);
        }) as never,
      );

      mock.onGet('/service').replyOnce(500);
      mock.onGet('/service').reply(200, { ok: true });

      try {
        await failRequest(manager, '/service');
        await wait(25);
        await manager.axiosInstance.get('/service');

        expect(events).toEqual([
          expect.objectContaining({ from: 'CLOSED', to: 'OPEN', reason: 'failure-threshold' }),
          expect.objectContaining({ from: 'OPEN', to: 'HALF_OPEN', reason: 'open-timeout-elapsed' }),
          expect.objectContaining({ from: 'HALF_OPEN', to: 'CLOSED', reason: 'success-threshold-reached' }),
        ]);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.1.9: OPEN transition events include nextAttemptIn', async () => {
      const { manager, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 50,
      });
      let openEvent: Record<string, unknown> | undefined;

      manager.on(
        'onCircuitStateChanged' as never,
        ((payload: Record<string, unknown>) => {
          if (payload.to === 'OPEN') {
            openEvent = payload;
          }
        }) as never,
      );

      mock.onGet('/trip').reply(500);

      try {
        await failRequest(manager, '/trip');

        expect(openEvent).toEqual(
          expect.objectContaining({
            to: 'OPEN',
            nextAttemptIn: expect.any(Number),
          }),
        );
        expect((openEvent?.nextAttemptIn as number) > 0).toBe(true);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.2 Scoping', () => {
    it('14.2.1: HOST scope shares circuit state across endpoints on the same host', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 2,
        scope: 'host',
      });

      mock.onGet('/users').reply(500);
      mock.onGet('/posts').reply(500);

      try {
        await failRequest(manager, '/users');
        await failRequest(manager, '/posts');

        await expect(manager.axiosInstance.get('/comments')).rejects.toBeInstanceOf(CircuitBreakerStateError);
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.2.2: URL scope keeps separate circuits per normalized path', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        scope: 'url',
      });

      mock.onGet('/users/1').reply(500);
      mock.onGet('/posts/1').reply(200, { ok: true });

      try {
        await failRequest(manager, '/users/1');
        const response = await manager.axiosInstance.get('/posts/1');

        expect(response.status).toBe(200);
        expect(plugin.getMetrics().scopeMetrics.map((scope) => scope.url)).toEqual(
          expect.arrayContaining(['/users/:id', '/posts/:id']),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.2.3: HOST_AND_URL scope separates circuits per host and path combination', async () => {
      const axiosInstance = axios.create();
      const mock = new MockAdapter(axiosInstance);
      const logger = createLogger();
      const plugin = new CircuitBreakerPlugin({
        failureThreshold: 1,
        scope: 'host+url',
      });
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        logger,
        throwErrorOnFailedRetries: true,
      });

      manager.use(plugin);
      mock.onGet('https://a.example.com/users/1').reply(500);
      mock.onGet('https://b.example.com/users/1').reply(200, { ok: true });

      try {
        await failRequest(manager, 'https://a.example.com/users/1');

        const response = await manager.axiosInstance.get('https://b.example.com/users/1');
        expect(response.status).toBe(200);
        expect(plugin.getMetrics().scopeMetrics.map((scope) => scope.scopeKey)).toEqual(
          expect.arrayContaining(['a.example.com/users/:id', 'b.example.com/users/:id']),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.2.4: custom scope functions group requests by the returned key', async () => {
      const { manager, mock } = createHarness({
        failureThreshold: 2,
        scope: (config: AxiosRequestConfig) => String((config.headers as Record<string, string>)['X-Service']),
      });

      mock.onGet('/users').reply(500);
      mock.onGet('/posts').reply(500);
      mock.onGet('/other').reply(200, { ok: true });

      try {
        await failRequest(manager, '/users', { headers: { 'X-Service': 'users' } });
        await failRequest(manager, '/posts', { headers: { 'X-Service': 'users' } });

        await expect(
          manager.axiosInstance.get('/users', {
            headers: { 'X-Service': 'users' },
          }),
        ).rejects.toBeInstanceOf(CircuitBreakerStateError);

        const response = await manager.axiosInstance.get('/other', {
          headers: { 'X-Service': 'other' },
        });
        expect(response.status).toBe(200);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.2.5: custom scope function failures fall back to the default scope safely', async () => {
      const { manager, logger, mock } = createHarness({
        failureThreshold: 1,
        scope: () => {
          throw new Error('scope exploded');
        },
      });

      mock.onGet('/fallback').reply(500);

      try {
        await failRequest(manager, '/fallback');

        await expect(manager.axiosInstance.get('/fallback')).rejects.toBeInstanceOf(CircuitBreakerStateError);
        expect(logger.warn).toHaveBeenCalledWith(
          'CircuitBreakerPlugin: Custom scope callback threw; using default scope',
          expect.objectContaining({
            error: 'scope exploded',
            url: '/fallback',
          }),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.2.6: maxTrackedScopes evicts the oldest tracked scope', async () => {
      const { manager, plugin, mock } = createHarness({
        maxTrackedScopes: 3,
      });

      mock.onGet('/svc-a').reply(200, { ok: 'a' });
      mock.onGet('/svc-b').reply(200, { ok: 'b' });
      mock.onGet('/svc-c').reply(200, { ok: 'c' });
      mock.onGet('/svc-d').reply(200, { ok: 'd' });

      try {
        await manager.axiosInstance.get('/svc-a');
        await manager.axiosInstance.get('/svc-b');
        await manager.axiosInstance.get('/svc-c');
        await manager.axiosInstance.get('/svc-d');

        expect(plugin.getMetrics().scopeMetrics.map((scope) => scope.url)).toEqual(['/svc-b', '/svc-c', '/svc-d']);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.2.7: scope resolution with an undefined URL falls back to "unknown"', () => {
      const { manager, plugin, mock } = createHarness();

      try {
        const scopeDetails = (
          plugin as unknown as {
            _getScopeDetails(config: AxiosRequestConfig): { scopeKey: string; normalizedUrl: string };
          }
        )._getScopeDetails({});

        expect(scopeDetails.scopeKey).toBe('/');
        expect(scopeDetails.normalizedUrl).toBe('/');
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.3 Sliding Window', () => {
    it('14.3.1: failures outside the slidingWindowSize do not count toward tripping the circuit', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 2,
        useSlidingWindow: true,
        slidingWindowSize: 20,
      });

      mock.onGet('/window').reply(500);

      try {
        await failRequest(manager, '/window');
        await wait(25);
        await failRequest(manager, '/window');

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.3.2: only failures inside the active sliding window remain counted', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 5,
        useSlidingWindow: true,
        slidingWindowSize: 50,
      });

      mock.onGet('/window').reply(500);

      try {
        await failRequest(manager, '/window');
        await failRequest(manager, '/window');
        await failRequest(manager, '/window');
        await wait(60);
        await failRequest(manager, '/window');
        await failRequest(manager, '/window');

        expect(plugin.getMetrics().failuresInWindow).toBe(2);
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.3.3: successes do not reset sliding-window failure history', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 5,
        useSlidingWindow: true,
        slidingWindowSize: 100,
      });

      let callCount = 0;
      mock.onGet('/flap').reply(() => {
        callCount += 1;
        return callCount === 5 ? [200, { ok: true }] : [500, { error: 'flap' }];
      });

      try {
        await failRequest(manager, '/flap');
        await failRequest(manager, '/flap');
        await failRequest(manager, '/flap');
        await failRequest(manager, '/flap');
        await manager.axiosInstance.get('/flap');
        await failRequest(manager, '/flap');

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.4 Adaptive Timeout', () => {
    it('14.4.1: adaptiveTimeout tracks response times and adjusts timeout threshold', async () => {
      const { manager, plugin, mock } = createHarness({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 3,
        adaptiveTimeoutMultiplier: 1.5,
      });

      try {
        for (const value of [100, 150, 200]) {
          (plugin as unknown as { _trackResponseTime(response: AxiosResponse): void })._trackResponseTime({
            config: { url: '/slow' } as AxiosResponse['config'],
            data: {},
            headers: { 'x-response-time': String(value) },
            status: 200,
            statusText: 'OK',
          } as AxiosResponse);
        }

        mock.onGet('/slow').reply((config) => [200, { timeout: config.timeout }]);

        const response = await manager.axiosInstance.get('/slow');
        expect(response.data.timeout).toBe(300);
        expect(plugin.getAdaptiveTimeoutMetrics()).toEqual([
          expect.objectContaining({
            url: '/slow',
            timeoutMs: 300,
            p95ResponseTimeMs: 200,
            samplesCount: 3,
          }),
        ]);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.4.2: requests beyond the adaptive timeout threshold trigger the circuit', async () => {
      const { manager, plugin, mock } = createHarness({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 3,
        adaptiveTimeoutMultiplier: 1.5,
        failureThreshold: 1,
      });

      for (const value of [100, 150, 200]) {
        (plugin as unknown as { _trackResponseTime(response: AxiosResponse): void })._trackResponseTime({
          config: { url: '/slow-threshold' } as AxiosResponse['config'],
          data: {},
          headers: { 'x-response-time': String(value) },
          status: 200,
          statusText: 'OK',
        } as AxiosResponse);
      }

      mock.onGet('/slow-threshold').reply((config) => {
        if ((config.timeout ?? 0) < 400) {
          throw new AxiosError('timeout', 'ECONNABORTED', config as never);
        }

        return [200, { ok: true }];
      });

      try {
        await expect(manager.axiosInstance.get('/slow-threshold')).rejects.toThrow('timeout');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.4.3: adaptiveTimeoutSampleSize is the minimum sample count before adaptive timeout activates', async () => {
      const { manager, plugin, mock } = createHarness({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 3,
      });

      try {
        for (const value of [100, 200]) {
          (plugin as unknown as { _trackResponseTime(response: AxiosResponse): void })._trackResponseTime({
            config: { url: '/warming-up' } as AxiosResponse['config'],
            data: {},
            headers: { 'x-response-time': String(value) },
            status: 200,
            statusText: 'OK',
          } as AxiosResponse);
        }

        mock.onGet('/warming-up').reply((config) => [200, { timeout: config.timeout ?? null }]);

        expect(plugin.getAdaptiveTimeoutMetrics()).toEqual([
          expect.objectContaining({
            url: '/warming-up',
            p95ResponseTimeMs: 0,
            samplesCount: 2,
          }),
        ]);

        const response = await manager.axiosInstance.get('/warming-up');
        expect(response.data.timeout).toBe(0);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.4.4: bounded sample windows let outlier response times age out cleanly', () => {
      const { manager, plugin, mock } = createHarness({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 3,
      });

      try {
        for (const value of [100, 100, 1000, 100, 100, 100]) {
          (plugin as unknown as { _trackResponseTime(response: AxiosResponse): void })._trackResponseTime({
            config: { url: '/outlier' } as AxiosResponse['config'],
            data: {},
            headers: { 'x-response-time': String(value) },
            status: 200,
            statusText: 'OK',
          } as AxiosResponse);
        }

        const timeoutMetric = plugin.getAdaptiveTimeoutMetrics().find((metric) => metric.url === '/outlier');
        expect(timeoutMetric?.p95ResponseTimeMs).toBe(100);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.5 URL Exclusion', () => {
    it('14.5.1: excluded string URLs bypass the circuit breaker', async () => {
      const { manager, mock } = createHarness({
        failureThreshold: 1,
        excludeUrls: ['/health'],
      });

      mock.onGet('/trip').reply(500);
      mock.onGet('/health').reply(200, { status: 'ok' });

      try {
        await failRequest(manager, '/trip');

        const response = await manager.axiosInstance.get('/health');
        expect(response.data.status).toBe('ok');
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.5.2: excluded RegExp URLs bypass the circuit breaker', async () => {
      const { manager, mock } = createHarness({
        failureThreshold: 1,
        excludeUrls: [/^\/api\/v\d+\/health$/],
      });

      mock.onGet('/trip').reply(500);
      mock.onGet('/api/v2/health').reply(200, { status: 'ok' });

      try {
        await failRequest(manager, '/trip');

        const response = await manager.axiosInstance.get('/api/v2/health');
        expect(response.status).toBe(200);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.5.3: failures on excluded URLs do not count toward the failure threshold', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        excludeUrls: ['/health'],
      });

      mock.onGet('/health').reply(500);

      try {
        await failRequest(manager, '/health');

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
        expect(plugin.getMetrics().failureCount).toBe(0);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.5.4: excluded URLs still succeed even while the main scope is OPEN', async () => {
      const { manager, mock } = createHarness({
        failureThreshold: 1,
        excludeUrls: ['/metrics'],
      });

      mock.onGet('/trip').reply(500);
      mock.onGet('/metrics').reply(200, { ok: true });

      try {
        await failRequest(manager, '/trip');

        const response = await manager.axiosInstance.get('/metrics');
        expect(response.data.ok).toBe(true);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.6 State Adapter (Distributed)', () => {
    it('14.6.1: custom state adapters receive get, set, and delete calls for state operations', async () => {
      const store = new Map<string, CircuitBreakerScopeState>();
      const adapter: CircuitBreakerStateAdapter = {
        get: jest.fn((key: string) => store.get(key) as never),
        set: jest.fn((key: string, state: CircuitBreakerScopeState) => {
          store.set(key, state);
        }),
        delete: jest.fn((key: string) => {
          store.delete(key);
        }),
        clear: jest.fn(),
      };
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        stateAdapter: adapter,
      });

      mock.onGet('/adapter').reply(500);

      try {
        await failRequest(manager, '/adapter');
        const scopeKey = plugin.getMetrics().scopeMetrics[0]?.scopeKey;

        plugin.manualReset(scopeKey);

        expect(adapter.get).toHaveBeenCalled();
        expect(adapter.set).toHaveBeenCalled();
        expect(adapter.delete).toHaveBeenCalledWith(scopeKey);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.6.2: async state adapters work correctly', async () => {
      const store = new Map<string, CircuitBreakerScopeState>();
      const adapter: CircuitBreakerStateAdapter = {
        get: async (key: string) => store.get(key) as never,
        set: async (key: string, state: CircuitBreakerScopeState) => {
          store.set(key, state);
        },
        delete: async () => undefined,
        clear: async () => undefined,
      };
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        stateAdapter: adapter,
      });

      mock.onGet('/async-adapter').reply(500);

      try {
        await failRequest(manager, '/async-adapter');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.6.3: adapter get returning undefined initializes a fresh CLOSED state', async () => {
      const adapter: CircuitBreakerStateAdapter = {
        get: jest.fn(async () => undefined),
        set: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      };
      const { manager, plugin, mock } = createHarness({
        stateAdapter: adapter,
      });

      mock.onGet('/fresh').reply(200, { ok: true });

      try {
        await manager.axiosInstance.get('/fresh');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
        expect(adapter.get).toHaveBeenCalled();
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.6.4: adapter set failures fall back to local state and still block later requests', async () => {
      const adapter: CircuitBreakerStateAdapter = {
        get: jest.fn(async () => undefined),
        set: jest.fn(async () => {
          throw new Error('adapter set failed');
        }),
        delete: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      };
      const { manager, logger, mock } = createHarness({
        failureThreshold: 2,
        stateAdapter: adapter,
      });

      mock.onGet('/fallback').reply(500);

      try {
        await failRequest(manager, '/fallback');
        await failRequest(manager, '/fallback');

        await expect(manager.axiosInstance.get('/fallback')).rejects.toBeInstanceOf(CircuitBreakerStateError);
        expect(logger.warn).toHaveBeenCalledWith(
          'CircuitBreakerPlugin: State adapter set failed; continuing with local circuit state',
          expect.objectContaining({
            error: 'adapter set failed',
          }),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.6.5: clear() on adapter clears all distributed state', async () => {
      const adapter: CircuitBreakerStateAdapter = {
        get: jest.fn(async () => undefined),
        set: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      };
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        scope: 'url',
        stateAdapter: adapter,
      });

      mock.onGet('/a').reply(500);
      mock.onGet('/b').reply(500);

      try {
        await failRequest(manager, '/a');
        await failRequest(manager, '/b');

        plugin.manualReset();

        expect(adapter.clear).toHaveBeenCalledTimes(1);
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.7 Manual Reset', () => {
    it('14.7.1: manualReset() without a scope key resets ALL scopes to CLOSED', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        scope: 'url',
      });

      mock.onGet('/a').reply(500);
      mock.onGet('/b').reply(500);
      mock.onGet('/a').reply(200, { ok: 'a' });
      mock.onGet('/b').reply(200, { ok: 'b' });

      try {
        await failRequest(manager, '/a');
        await failRequest(manager, '/b');

        plugin.manualReset();

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.7.2: manualReset(scopeKey) resets only the targeted scope to CLOSED', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        scope: 'url',
      });

      mock.onGet('/a').reply(500);
      mock.onGet('/b').reply(500);

      try {
        await failRequest(manager, '/a');
        await failRequest(manager, '/b');

        const scopeKeyA = plugin.getMetrics().scopeMetrics.find((scope) => scope.url === '/a')?.scopeKey;
        plugin.manualReset(scopeKeyA);

        mock.reset();
        mock.onGet('/a').reply(200, { ok: true });

        const response = await manager.axiosInstance.get('/a');
        expect(response.status).toBe(200);
        await expect(manager.axiosInstance.get('/b')).rejects.toBeInstanceOf(CircuitBreakerStateError);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.7.3: manual reset emits onCircuitStateChanged with reason "manual-reset"', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
      });
      const events: Array<Record<string, unknown>> = [];

      manager.on(
        'onCircuitStateChanged' as never,
        ((payload: Record<string, unknown>) => {
          events.push(payload);
        }) as never,
      );

      mock.onGet('/trip').reply(500);

      try {
        await failRequest(manager, '/trip');
        plugin.manualReset();

        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              reason: 'manual-reset',
              to: 'CLOSED',
            }),
          ]),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.7.4: manualReset cancels the OPEN to HALF_OPEN timer and clears the OPEN state immediately', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        openTimeout: 1_000,
      });

      mock.onGet('/trip').reply(500);

      try {
        await failRequest(manager, '/trip');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);

        plugin.manualReset();

        mock.reset();
        mock.onGet('/trip').reply(200, { ok: true });
        const response = await manager.axiosInstance.get('/trip');
        expect(response.status).toBe(200);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.8 Metrics', () => {
    it('14.8.1: getMetrics() returns per-scope state and failure counts', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        scope: 'url',
      });

      mock.onGet('/first').reply(500);
      mock.onGet('/second').reply(500);

      try {
        await failRequest(manager, '/first');
        await failRequest(manager, '/second');

        expect(plugin.getMetrics().scopeMetrics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ url: '/first', state: 'OPEN', failureCount: 1 }),
            expect.objectContaining({ url: '/second', state: 'OPEN', failureCount: 1 }),
          ]),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.8.2: resetMetrics() zeros all counters but preserves circuit state', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        scope: 'url',
      });

      mock.onGet('/first').reply(500);
      mock.onGet('/second').reply(500);

      try {
        await failRequest(manager, '/first');
        await failRequest(manager, '/second');

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);

        plugin.resetMetrics();

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
        expect(plugin.getMetrics()).toEqual(
          expect.objectContaining({
            failureCount: 0,
            halfOpenCount: 0,
            successCount: 0,
            failuresInWindow: 0,
          }),
        );
        expect(plugin.getMetrics().scopeMetrics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ url: '/first', state: 'OPEN', failureCount: 0 }),
            expect.objectContaining({ url: '/second', state: 'OPEN', failureCount: 0 }),
          ]),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.8.3: getAdaptiveTimeoutMetrics() returns per-scope p95 and sample counts', () => {
      const { manager, plugin, mock } = createHarness({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 2,
      });

      try {
        for (const [url, value] of [
          ['/one', 100],
          ['/one', 150],
          ['/two', 250],
          ['/two', 300],
        ] as const) {
          (plugin as unknown as { _trackResponseTime(response: AxiosResponse): void })._trackResponseTime({
            config: { url } as AxiosResponse['config'],
            data: {},
            headers: { 'x-response-time': String(value) },
            status: 200,
            statusText: 'OK',
          } as AxiosResponse);
        }

        expect(plugin.getAdaptiveTimeoutMetrics()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ url: '/one', p95ResponseTimeMs: 150, samplesCount: 2 }),
            expect.objectContaining({ url: '/two', p95ResponseTimeMs: 300, samplesCount: 2 }),
          ]),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });

  describe('14.9 shouldCountError Filter', () => {
    it('14.9.1: shouldCountError can exclude 404 errors from circuit counting', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        shouldCountError: (error) => error.response?.status !== 404,
      });

      mock.onGet('/not-found').reply(404);

      try {
        await failRequest(manager, '/not-found');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.CLOSED);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.9.2: shouldCountError returning true for 503 errors allows them to trip the circuit', async () => {
      const { manager, plugin, mock } = createHarness({
        failureThreshold: 1,
        shouldCountError: (error) => error.response?.status === 503,
      });

      mock.onGet('/unavailable').reply(503);

      try {
        await failRequest(manager, '/unavailable');
        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
      } finally {
        manager.destroy();
        mock.restore();
      }
    });

    it('14.9.3: shouldCountError callback failures default to counting the error', async () => {
      const { manager, plugin, logger, mock } = createHarness({
        failureThreshold: 1,
        shouldCountError: () => {
          throw new Error('count exploded');
        },
      });

      mock.onGet('/count').reply(503);

      try {
        await failRequest(manager, '/count');

        expect(plugin.getState()).toBe(CircuitBreakerPlugin.STATES.OPEN);
        expect(logger.warn).toHaveBeenCalledWith(
          'CircuitBreakerPlugin: shouldCountError callback threw; counting error by default',
          expect.objectContaining({
            error: 'count exploded',
          }),
        );
      } finally {
        manager.destroy();
        mock.restore();
      }
    });
  });
});
