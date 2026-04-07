import AxiosMockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import { DebugSanitizationPlugin, createDebugSanitizationPlugin } from '../src/plugins/DebugSanitizationPlugin';

type SanitizedErrorLog = {
  data?: unknown;
  headers?: Record<string, unknown>;
  response?: {
    data?: unknown;
    headers?: Record<string, unknown>;
  };
  url?: string;
};

describe('DebugSanitizationPlugin', () => {
  let retryManager: RetryManager;
  let mock: AxiosMockAdapter;

  afterEach(() => {
    jest.restoreAllMocks();

    if (mock) {
      mock.restore();
    }

    if (retryManager) {
      retryManager.destroy();
    }
  });

  test('should sanitize request logs through the plugin', async () => {
    retryManager = new RetryManager({ debug: true });
    retryManager.use(
      new DebugSanitizationPlugin({
        sanitizeOptions: {
          sensitiveHeaders: ['x-custom-secret'],
        },
      }),
    );
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    const loggerSpy = jest.spyOn(retryManager.getLogger(), 'debug').mockImplementation();

    mock.onPost('/auth?token=secret-token&safe=value').reply(200, { ok: true });

    await retryManager.axiosInstance.post(
      '/auth?token=secret-token&safe=value',
      { username: 'testuser', password: 'secret123' },
      {
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
          'x-custom-secret': 'very-secret',
        },
      },
    );

    const logEntry = loggerSpy.mock.calls.find(
      ([message]) => message === '[DebugSanitizationPlugin] Sanitized request',
    );
    const logMeta = logEntry?.[1] as SanitizedErrorLog | undefined;

    expect(logEntry).toBeDefined();
    expect(logMeta?.url).toBe('/auth?token=********&safe=value');
    expect(logMeta?.headers).toMatchObject({
      Authorization: '********',
      'Content-Type': 'application/json',
      'x-custom-secret': '********',
    });
  });

  test('should sanitize response payloads when enabled', async () => {
    retryManager = new RetryManager({ debug: true, retries: 0 });
    retryManager.use(
      new DebugSanitizationPlugin({
        sanitizeOptions: {
          allowedFields: ['displayName'],
        },
      }),
    );
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    const loggerSpy = jest.spyOn(retryManager.getLogger(), 'debug').mockImplementation();

    mock.onGet('/profile?token=secret-token').reply(500, {
      displayName: 'Visible Name',
      token: 'server-secret',
    });

    await retryManager.axiosInstance.get('/profile?token=secret-token', {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    }).catch(() => undefined);

    const logEntry = loggerSpy.mock.calls.find(
      ([message]) => message === '[DebugSanitizationPlugin] Sanitized error',
    );
    const logMeta = logEntry?.[1] as SanitizedErrorLog | undefined;

    expect(logEntry).toBeDefined();
    expect(logMeta?.url).toBe('/profile?token=********');
    expect(logMeta?.response?.data).toEqual({
      displayName: 'Visible Name',
      token: '********',
    });
  });

  test('should honor request and response body sanitization toggles', async () => {
    retryManager = new RetryManager({ debug: true, retries: 0 });
    retryManager.use(
      new DebugSanitizationPlugin({
        sanitizeOptions: {
          sanitizeRequestData: false,
          sanitizeResponseData: false,
        },
      }),
    );
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    const loggerSpy = jest.spyOn(retryManager.getLogger(), 'debug').mockImplementation();

    mock.onPost('/auth?token=secret-token').reply(
      500,
      { password: 'server-secret' },
      { 'x-api-key': 'server-secret' },
    );

    await retryManager.axiosInstance.post(
      '/auth?token=secret-token',
      { password: 'client-secret' },
      {
        headers: {
          Authorization: 'Bearer secret-token',
        },
      },
    ).catch(() => undefined);

    const logEntry = loggerSpy.mock.calls.find(
      ([message]) => message === '[DebugSanitizationPlugin] Sanitized error',
    );
    const logMeta = logEntry?.[1] as SanitizedErrorLog | undefined;

    expect(logEntry).toBeDefined();
    expect(logMeta?.data).toBeUndefined();
    expect(logMeta?.response).toEqual({
      data: undefined,
      headers: {
        'x-api-key': '********',
      },
    });
  });

  test('should stop logging once the plugin is removed', async () => {
    retryManager = new RetryManager({ debug: true });
    const plugin = createDebugSanitizationPlugin();
    retryManager.use(plugin);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    const loggerSpy = jest.spyOn(retryManager.getLogger(), 'debug').mockImplementation();

    mock.onGet('/health?token=secret-token').reply(200, { ok: true });

    await retryManager.axiosInstance.get('/health?token=secret-token');
    expect(
      loggerSpy.mock.calls.some(([message]) => message === '[DebugSanitizationPlugin] Sanitized request'),
    ).toBe(true);

    loggerSpy.mockClear();

    expect(retryManager.unuse('DebugSanitizationPlugin')).toBe(true);
    expect(retryManager.listPlugins()).not.toContainEqual({
      name: 'DebugSanitizationPlugin',
      version: '1.0.0',
    });

    await retryManager.axiosInstance.get('/health?token=secret-token');
    expect(
      loggerSpy.mock.calls.some(([message]) => message === '[DebugSanitizationPlugin] Sanitized request'),
    ).toBe(false);
  });
});
