import axios, { type AxiosHeaders, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { EventBus } from '../src/core/EventBus';
import { RequestQueue } from '../src/core/requestQueue';
import { parseRetryAfterMs } from '../src/core/RetryScheduler';
import { RetryManager } from '../src';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';
import { TokenRefreshPlugin } from '../src/plugins/TokenRefreshPlugin';
import {
  assignRequestMetadata,
  ensureRequestMetadata,
  getRequestMetadata,
  setRequestMetadataValue,
} from '../src/utils/requestMetadata';

function getHeader(config: AxiosRequestConfig, headerName: string): string | undefined {
  const headers = config.headers;
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as AxiosHeaders).get === 'function') {
    const value = (headers as AxiosHeaders).get(headerName);
    return typeof value === 'string' ? value : undefined;
  }

  const match = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === headerName.toLowerCase(),
  );
  return typeof match?.[1] === 'string' ? match[1] : undefined;
}

describe('P0 Security (24.x)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('24.1.1: assignRequestMetadata with __proto__ does not pollute Object.prototype', () => {
    const config: AxiosRequestConfig = { url: '/security/proto' };

    ensureRequestMetadata(config);
    assignRequestMetadata(config, {
      ['__proto__' as keyof object]: { polluted: true } as unknown,
    } as never);

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('24.1.2: assignRequestMetadata with constructor does not modify the object constructor', () => {
    const config: AxiosRequestConfig = { url: '/security/constructor' };

    ensureRequestMetadata(config);
    assignRequestMetadata(config, {
      ['constructor' as keyof object]: { prototype: { polluted: true } } as unknown,
    } as never);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('24.1.3: request config body with __proto__ does not affect metadata processing', () => {
    const config: AxiosRequestConfig = {
      url: '/security/body',
      data: JSON.parse('{"__proto__":{"polluted":true}}'),
    };

    const metadata = ensureRequestMetadata(config);

    expect(metadata).toBeDefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('24.2.1: onTokenRefreshed emits the raw token string', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnFailedRetries: false,
    });
    const plugin = new TokenRefreshPlugin(async () => ({ token: 'raw-token-value' }), {
      retryOnRefreshFail: false,
      maxRefreshAttempts: 1,
    });
    let emittedToken: string | undefined;

    manager.use(plugin);
    manager.on(
      'onTokenRefreshed' as never,
      ((token: string) => {
        emittedToken = token;
      }) as never,
    );

    mock.onGet('/secure').replyOnce(401);
    mock.onGet('/secure').replyOnce(200, { ok: true });

    try {
      await manager.axiosInstance.get('/secure', {
        headers: { Authorization: 'Bearer stale-token' },
      });

      expect(emittedToken).toBe('raw-token-value');
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.2.2: onRequestError payload does not expose a top-level body field', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnFailedRetries: true,
    });
    let payload: Record<string, unknown> | undefined;

    manager.on('onRequestError', ((eventPayload: Record<string, unknown>) => {
      payload = eventPayload;
    }) as never);

    mock.onPost('/submit').reply(500, { error: 'boom' });

    try {
      await expect(
        manager.axiosInstance.post('/submit', {
          secret: 'should-not-be-promoted',
        }),
      ).rejects.toThrow();

      expect(payload).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(payload ?? {}, 'body')).toBe(false);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.2.3: debug logging for request failures does not add request body to log metadata', async () => {
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      info: jest.fn(),
    };
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      debug: true,
      logger,
      throwErrorOnFailedRetries: true,
    });

    mock.onPost('/loggable').reply(500, { error: 'boom' });

    try {
      await expect(
        manager.axiosInstance.post('/loggable', {
          password: 'super-secret',
        }),
      ).rejects.toThrow();

      const requestFailedCall = logger.error.mock.calls.find(([message]) => message === 'Request failed');
      expect(requestFailedCall).toBeDefined();
      expect(requestFailedCall?.[1]).toEqual(
        expect.not.objectContaining({
          data: expect.anything(),
        }),
      );
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.2.4: JSON.stringify(config) after retry metadata assignment does not include internal metadata', () => {
    const config: AxiosRequestConfig = { url: '/serialize' };

    setRequestMetadataValue(config, 'requestId', 'req_test');
    setRequestMetadataValue(config, 'retryAttempt', 2);

    const serialized = JSON.stringify(config);

    expect(serialized).not.toContain('requestId');
    expect(serialized).not.toContain('retryAttempt');
    expect(JSON.parse(serialized).__axiosRetryer).toBeUndefined();
  });

  it('24.2.5: stored manual-retry requests strip Set-Cookie headers', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manualRetry = new ManualRetryPlugin({
      storeAuthRequests: true,
    });
    const manager = new RetryManager({
      axiosInstance,
      mode: 'manual',
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    manager.use(manualRetry);
    mock.onGet('/store').reply(500, { error: 'down' });

    try {
      await expect(
        manager.axiosInstance.get('/store', {
          headers: {
            'Set-Cookie': 'session=abc',
          },
        }),
      ).rejects.toThrow();

      const stored = manualRetry.getStoredRequests();
      expect(stored).toHaveLength(1);
      expect(getHeader(stored[0], 'Set-Cookie')).toBeUndefined();
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.3.1: stale-token fast-fail only matches the exact stale auth header value', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const refreshFn = jest.fn(async () => {
      throw new Error('refresh failed');
    });
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    manager.use(
      new TokenRefreshPlugin(refreshFn, {
        retryOnRefreshFail: false,
        maxRefreshAttempts: 1,
      }),
    );

    mock.onGet('/exact-match').reply(401);

    try {
      await expect(
        manager.axiosInstance.get('/exact-match', {
          headers: { Authorization: 'Bearer stale-token' },
        }),
      ).rejects.toThrow('refresh failed');

      mock.resetHistory();
      mock.onGet('/exact-match').reply(200, { ok: true });

      const response = await manager.axiosInstance.get('/exact-match', {
        headers: { Authorization: 'Bearer fresh-token' },
      });

      expect(response.status).toBe(200);
      expect(mock.history.get).toHaveLength(1);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.4.1: Retry-After values are capped at five minutes', () => {
    expect(parseRetryAfterMs('99999999')).toBe(300_000);
  });

  it('24.4.2: EventBus rejects the 51st listener with a warning', () => {
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      info: jest.fn(),
    };
    const eventBus = new EventBus(logger);
    const listeners = Array.from({ length: 51 }, () => jest.fn());

    for (const listener of listeners) {
      eventBus.on('onFailure', listener as never);
    }

    eventBus.emit('onFailure', { url: '/listener-cap' } as AxiosRequestConfig);

    expect(logger.warn).toHaveBeenCalled();
    expect(listeners.slice(0, 50).every((listener) => listener.mock.calls.length === 1)).toBe(true);
    expect(listeners[50]).not.toHaveBeenCalled();
  });

  it('24.4.3: circuit-breaker tracked scopes stay bounded and evict the oldest scope', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const plugin = new CircuitBreakerPlugin({
      maxTrackedScopes: 3,
    });
    const manager = new RetryManager({
      axiosInstance,
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    manager.use(plugin);

    mock.onGet('/scope-a').reply(200, { ok: 'a' });
    mock.onGet('/scope-b').reply(200, { ok: 'b' });
    mock.onGet('/scope-c').reply(200, { ok: 'c' });
    mock.onGet('/scope-d').reply(200, { ok: 'd' });

    try {
      await manager.axiosInstance.get('/scope-a');
      await manager.axiosInstance.get('/scope-b');
      await manager.axiosInstance.get('/scope-c');
      await manager.axiosInstance.get('/scope-d');

      expect(plugin.getMetrics().scopeMetrics.map((scope) => scope.url)).toEqual(['/scope-b', '/scope-c', '/scope-d']);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.4.4: ManualRetryPlugin evicts the oldest stored request when maxRequestsToStore is exceeded', async () => {
    const axiosInstance = axios.create();
    const mock = new MockAdapter(axiosInstance);
    const manualRetry = new ManualRetryPlugin({
      maxRequestsToStore: 2,
    });
    const manager = new RetryManager({
      axiosInstance,
      mode: 'manual',
      retries: 0,
      throwErrorOnFailedRetries: true,
    });

    manager.use(manualRetry);
    mock.onGet('/one').reply(500);
    mock.onGet('/two').reply(500);
    mock.onGet('/three').reply(500);

    try {
      await manager.axiosInstance.get('/one').catch(() => undefined);
      await manager.axiosInstance.get('/two').catch(() => undefined);
      await manager.axiosInstance.get('/three').catch(() => undefined);

      expect(manualRetry.getStoredRequests().map((config) => config.url)).toEqual(['/two', '/three']);
    } finally {
      manager.destroy();
      mock.restore();
    }
  });

  it('24.4.5: queue overflow protection rejects requests once maxQueueSize is reached', async () => {
    const queue = new RequestQueue({
      maxConcurrent: 1,
      maxQueueSize: 1,
      queueDelay: 0,
      canProcess: () => false,
    });

    const first = queue.enqueue({ url: '/first' });
    await expect(queue.enqueue({ url: '/second' })).rejects.toMatchObject({
      code: 'EQUEUE_FULL',
      name: 'QueueFullError',
    });

    queue.destroy();
    await expect(first).rejects.toMatchObject({
      code: 'QUEUE_DESTROYED',
      name: 'QueueDestroyedError',
    });
  });

  it('24.4.6: getRequestMetadata remains available in memory even when metadata is hidden from JSON', () => {
    const config: AxiosRequestConfig = { url: '/memory' };

    setRequestMetadataValue(config, 'requestId', 'req_memory');

    expect(getRequestMetadata(config)?.requestId).toBe('req_memory');
    expect(JSON.stringify(config)).not.toContain('req_memory');
  });
});
