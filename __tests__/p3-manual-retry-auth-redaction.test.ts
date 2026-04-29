//@ts-nocheck
import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';

import { RetryManager } from '../src';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin';

/**
 * Verifies the default security contract of ManualRetryPlugin:
 *
 *  1. With `storeAuthRequests: false` (default), requests carrying any sensitive
 *     auth material are not stored at all.
 *  2. With `storeAuthRequests: true`, requests are stored but sensitive headers
 *     (Authorization, Cookie, X-Api-Key, etc.) are stripped from the stored copy.
 *  3. The original request config is never mutated.
 */
describe('ManualRetryPlugin default auth-header redaction', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let manager: RetryManager;
  let plugin: ManualRetryPlugin;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.reset();
    mock.restore();
  });

  it('with default (storeAuthRequests: false) skips storing requests bearing Authorization', async () => {
    plugin = new ManualRetryPlugin({ maxRequestsToStore: 50 });
    manager = new RetryManager({ axiosInstance, mode: 'manual', retries: 0, throwErrorOnFailedRetries: false });
    manager.use(plugin);

    mock.onGet('/secure').reply(500);
    await manager.axiosInstance.get('/secure', { headers: { Authorization: 'Bearer SECRET' } });

    const stored = plugin.getStoredRequests();
    expect(stored).toHaveLength(0);
  });

  it('with storeAuthRequests=true the stored request has no Authorization, Cookie, or X-Api-Key', async () => {
    plugin = new ManualRetryPlugin({ maxRequestsToStore: 50, storeAuthRequests: true });
    manager = new RetryManager({ axiosInstance, mode: 'manual', retries: 0, throwErrorOnFailedRetries: false });
    manager.use(plugin);

    mock.onPost('/transactions').reply(500);

    const callerConfig = {
      headers: {
        Authorization: 'Bearer SECRET',
        Cookie: 'session=abc',
        'X-Api-Key': 'k-123',
        'Idempotency-Key': 'idem-1',
        'Content-Type': 'application/json',
      },
    };
    await manager.axiosInstance.post('/transactions', { amount: 100 }, callerConfig);

    const stored = plugin.getStoredRequests();
    expect(stored).toHaveLength(1);
    const storedHeaders = (stored[0].headers ?? {}) as Record<string, unknown>;

    // Sensitive headers stripped.
    expect(storedHeaders.Authorization).toBeUndefined();
    expect(storedHeaders.authorization).toBeUndefined();
    expect(storedHeaders.Cookie).toBeUndefined();
    expect(storedHeaders.cookie).toBeUndefined();
    expect(storedHeaders['X-Api-Key']).toBeUndefined();
    expect(storedHeaders['x-api-key']).toBeUndefined();

    // Non-sensitive headers preserved (idempotency key + content-type).
    const lowerKeys = Object.keys(storedHeaders).map((k) => k.toLowerCase());
    expect(lowerKeys).toContain('idempotency-key');
    expect(lowerKeys).toContain('content-type');

    // Original caller config is NOT mutated.
    expect(callerConfig.headers.Authorization).toBe('Bearer SECRET');
    expect(callerConfig.headers.Cookie).toBe('session=abc');
  });
});
