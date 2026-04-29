//@ts-nocheck
import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';

import { RetryManager } from '../src';

/**
 * Verifies that a stable `correlationId` is assigned to each request and
 * propagated into log metadata at the request and error boundaries.
 */
describe('correlationId propagation', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let manager: RetryManager;
  let logs: Array<{ level: string; message: string; meta?: unknown }>;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
    logs = [];
    const collector = (level: string) => (message: string, meta?: unknown) => {
      logs.push({ level, message, meta });
    };
    manager = new RetryManager({
      axiosInstance,
      retries: 0,
      maxConcurrentRequests: 100,
      logger: {
        log: collector('log'),
        debug: collector('debug'),
        warn: collector('warn'),
        error: collector('error'),
      },
    });
  });

  afterEach(() => {
    mock.reset();
    mock.restore();
  });

  const findLog = (level: string, message: string): { meta?: unknown } | undefined =>
    logs.find((l) => l.level === level && l.message === message);

  it('defaults correlationId to requestId when none is supplied', async () => {
    mock.onGet('/x').reply(200, { ok: true });

    await manager.axiosInstance.get('/x');

    const debugLog = findLog('debug', 'New request created');
    expect(debugLog).toBeDefined();
    const meta = debugLog!.meta as { requestId?: string; correlationId?: string };
    expect(meta.requestId).toBeDefined();
    expect(meta.correlationId).toBe(meta.requestId);
  });

  it('reads correlationId from x-correlation-id header when provided', async () => {
    mock.onGet('/y').reply(200, { ok: true });

    await manager.axiosInstance.get('/y', { headers: { 'x-correlation-id': 'caller-trace-42' } });

    const debugLog = findLog('debug', 'New request created');
    expect(debugLog).toBeDefined();
    const meta = debugLog!.meta as { requestId?: string; correlationId?: string };
    expect(meta.correlationId).toBe('caller-trace-42');
    expect(meta.requestId).not.toBe('caller-trace-42');
  });

  it('reads correlationId from x-request-id header (alternate name)', async () => {
    mock.onGet('/y2').reply(200, { ok: true });

    await manager.axiosInstance.get('/y2', { headers: { 'x-request-id': 'alt-trace' } });

    const debugLog = findLog('debug', 'New request created');
    expect(debugLog).toBeDefined();
    const meta = debugLog!.meta as { correlationId?: string };
    expect(meta.correlationId).toBe('alt-trace');
  });

  it('includes correlationId in error-meta on failure', async () => {
    mock.onGet('/fail').reply(500);

    await manager.axiosInstance
      .get('/fail', { headers: { 'x-correlation-id': 'trace-fail-7' } })
      .catch(() => undefined);

    const errorLog = findLog('error', 'Request failed');
    expect(errorLog).toBeDefined();
    const meta = errorLog!.meta as { correlationId?: string };
    expect(meta.correlationId).toBe('trace-fail-7');
  });

  it('keeps the same correlationId across retries on the same logical request', async () => {
    let callCount = 0;
    mock.onGet('/retry').reply(() => {
      callCount += 1;
      return callCount === 1 ? [500, {}] : [200, { ok: true }];
    });

    // Build a manager that DOES retry once.
    const retryAxios = axios.create();
    const retryMock = new MockAdapter(retryAxios);
    retryMock.onGet('/retry').reply(() => {
      callCount += 1;
      return callCount === 1 ? [500, {}] : [200, { ok: true }];
    });
    const retryLogs: Array<{ level: string; message: string; meta?: unknown }> = [];
    const collector = (level: string) => (message: string, meta?: unknown) => {
      retryLogs.push({ level, message, meta });
    };
    const retryManager = new RetryManager({
      axiosInstance: retryAxios,
      retries: 1,
      backoffType: 'static',
      logger: {
        log: collector('log'),
        debug: collector('debug'),
        warn: collector('warn'),
        error: collector('error'),
      },
    });

    callCount = 0;
    await retryManager.axiosInstance.get('/retry', { headers: { 'x-correlation-id': 'persistent-trace' } });

    const errorLogs = retryLogs.filter((l) => l.level === 'error' && l.message === 'Request failed');
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
    const correlationsSeen = new Set(errorLogs.map((l) => (l.meta as { correlationId?: string }).correlationId));
    expect(correlationsSeen.has('persistent-trace')).toBe(true);
    expect(correlationsSeen.size).toBe(1);
  });
});
