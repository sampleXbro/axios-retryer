/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §16 ManualRetryPlugin & §17 MetricsPlugin.
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RETRY_MODES, RetryManager } from '../src';
import { ManualRetryPlugin } from '../src/plugins/ManualRetryPlugin/ManualRetryPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin/MetricsPlugin';
import { InMemoryRequestStore } from '../src/store/InMemoryRequestStore';
import { assignRequestMetadata } from '../src/utils/requestMetadata';

describe('P1 ManualRetryPlugin (§16)', () => {
  it('16.1.1 MANUAL mode stores terminal failure for replay', async () => {
    const instance = axios.create();
    const manual = new ManualRetryPlugin();
    const manager = new RetryManager({
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
    }).use(manual);
    const mock = new MockAdapter(instance);
    mock.onGet('/f').reply(500);
    await instance.get('/f').catch(() => {});
    expect(manual.getStoredRequests().length).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('16.1.2 OBSERVED: plugin stores on onFailure in AUTOMATIC mode (gap doc assumed no store)', async () => {
    const instance = axios.create();
    const manual = new ManualRetryPlugin();
    const manager = new RetryManager({
      mode: RETRY_MODES.AUTOMATIC,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
    }).use(manual);
    const mock = new MockAdapter(instance);
    mock.onGet('/a').reply(500);
    await instance.get('/a').catch(() => {});
    expect(manual.getStoredRequests().length).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('16.1.4 failed POST without Idempotency-Key is not stored', async () => {
    const instance = axios.create();
    const manual = new ManualRetryPlugin({ storeNonIdempotent: false });
    const manager = new RetryManager({
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
    }).use(manual);
    const mock = new MockAdapter(instance);
    mock.onPost('/p').reply(500);
    await instance.post('/p').catch(() => {});
    expect(manual.getStoredRequests().length).toBe(0);
    mock.restore();
    manager.destroy();
  });

  it('16.1.5 failed POST with Idempotency-Key is stored', async () => {
    const instance = axios.create();
    const manual = new ManualRetryPlugin({ storeNonIdempotent: false });
    const manager = new RetryManager({
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
    }).use(manual);
    const mock = new MockAdapter(instance);
    mock.onPost('/p').reply(500);
    await instance.post('/p', {}, { headers: { 'Idempotency-Key': 'k1' } }).catch(() => {});
    expect(manual.getStoredRequests().length).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('16.2.4 retryFailedRequests with empty store returns []', async () => {
    const instance = axios.create();
    const manual = new ManualRetryPlugin();
    const manager = new RetryManager({ axiosInstance: instance }).use(manual);
    await expect(manual.retryFailedRequests()).resolves.toEqual([]);
    manager.destroy();
  });

  it('16.1.10 prepareRequestForStore returning null skips storage', async () => {
    const instance = axios.create();
    const manual = new ManualRetryPlugin({
      prepareRequestForStore: () => null,
    });
    const manager = new RetryManager({
      mode: RETRY_MODES.MANUAL,
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
    }).use(manual);
    const mock = new MockAdapter(instance);
    mock.onGet('/x').reply(500);
    await instance.get('/x').catch(() => {});
    expect(manual.getStoredRequests().length).toBe(0);
    mock.restore();
    manager.destroy();
  });

  it('16.1.13 InMemoryRequestStore.remove drops matching requestId', () => {
    const emit = jest.fn();
    const store = new InMemoryRequestStore(10, emit);
    const cfg = { url: '/z' };
    assignRequestMetadata(cfg, { requestId: 'rid-1' });
    store.add(cfg);
    expect(store.getAll()).toHaveLength(1);
    store.remove(cfg);
    expect(store.getAll()).toHaveLength(0);
  });
});

describe('P1 MetricsPlugin (§17)', () => {
  it('17.1.1 totalRequests is 1 for a single successful request without retry', async () => {
    const instance = axios.create();
    const metrics = new MetricsPlugin();
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(metrics);
    const mock = new MockAdapter(instance);
    mock.onGet('/once').reply(200);
    await instance.get('/once');
    expect(manager.getMetrics().totalRequests).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('17.x each retry re-queue increments totalRequests (implementation detail vs gap doc “per logical request”)', async () => {
    const instance = axios.create();
    const metrics = new MetricsPlugin();
    const manager = new RetryManager({ retries: 2, axiosInstance: instance }).use(metrics);
    const mock = new MockAdapter(instance);
    mock.onGet('/r').replyOnce(503).onGet('/r').replyOnce(503).onGet('/r').reply(200);
    await instance.get('/r');
    expect(manager.getMetrics().totalRequests).toBe(3);
    mock.restore();
    manager.destroy();
  });

  it('17.1.2 successfulRetries increments after retry success', async () => {
    const instance = axios.create();
    const metrics = new MetricsPlugin();
    const manager = new RetryManager({ retries: 1, axiosInstance: instance }).use(metrics);
    const mock = new MockAdapter(instance);
    mock.onGet('/s').replyOnce(500).onGet('/s').reply(200);
    await instance.get('/s');
    expect(manager.getMetrics().successfulRetries).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('17.3.3 averages with zero samples are 0', () => {
    const instance = axios.create();
    const metrics = new MetricsPlugin();
    const manager = new RetryManager({ axiosInstance: instance }).use(metrics);
    const m = manager.getMetrics();
    expect(Number.isNaN(m.avgQueueWait)).toBe(false);
    expect(m.avgQueueWait).toBe(0);
    expect(m.avgRetryDelay).toBe(0);
    manager.destroy();
  });

  it('17.4.1 timerHealth.healthScore baseline uses active timer counts', () => {
    const instance = axios.create();
    const metrics = new MetricsPlugin();
    const manager = new RetryManager({ axiosInstance: instance }).use(metrics);
    const m = manager.getMetrics();
    expect(m.timerHealth.activeTimers).toBe(0);
    expect(m.timerHealth.activeRetryTimers).toBe(0);
    expect(m.timerHealth.healthScore).toBe(0);
    manager.destroy();
  });

  it('17.5.1 resetMetrics zeros counters', async () => {
    const instance = axios.create();
    const metrics = new MetricsPlugin();
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(metrics);
    const mock = new MockAdapter(instance);
    mock.onGet('/o').reply(200);
    await instance.get('/o');
    expect(manager.getMetrics().totalRequests).toBeGreaterThan(0);
    manager.resetMetrics();
    expect(manager.getMetrics().totalRequests).toBe(0);
    mock.restore();
    manager.destroy();
  });
});
