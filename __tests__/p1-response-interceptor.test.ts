/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §6 Response Interceptor + §8.3 event ordering (integration).
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { AXIOS_RETRYER_BACKOFF_TYPES, RetryManager } from '../src';

describe('P1 Response interceptor & event ordering (§6, §8.3)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('6.1 successful response releases slot (follow-up request runs under maxConcurrentRequests: 1)', async () => {
    const manager = new RetryManager({ retries: 0, maxConcurrentRequests: 1, axiosInstance: axios.create() });
    const mock = new MockAdapter(manager.axiosInstance);
    mock.onGet('/one').reply(200, { n: 1 });
    mock.onGet('/two').reply(200, { n: 2 });
    await manager.axiosInstance.get('/one');
    await manager.axiosInstance.get('/two');
    mock.restore();
    manager.destroy();
  });

  it('6.3 silentlyCancelled success does not emit onRequestSucceeded', async () => {
    const controller = new AbortController();
    controller.abort();
    const manager = new RetryManager({
      retries: 0,
      throwErrorOnCancelRequest: false,
      axiosInstance: axios.create(),
    });
    const succeeded = jest.fn();
    manager.on('onRequestSucceeded', succeeded);
    await manager.axiosInstance.get('/x', { signal: controller.signal });
    expect(succeeded).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('6.4 then 6.5 retry success emits afterRetry before onRequestSucceeded; first-attempt success skips afterRetry', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 1, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const afterRetry = jest.fn();
    const succeeded = jest.fn();
    manager.on('afterRetry', afterRetry);
    manager.on('onRequestSucceeded', succeeded);

    mock.onGet('/retry').replyOnce(500).onGet('/retry').reply(200, { r: 1 });
    await manager.axiosInstance.get('/retry');
    expect(afterRetry).toHaveBeenCalledTimes(1);
    expect(succeeded).toHaveBeenCalledTimes(1);
    expect(afterRetry.mock.invocationCallOrder[0]).toBeLessThan(succeeded.mock.invocationCallOrder[0]);

    afterRetry.mockClear();
    succeeded.mockClear();
    mock.onGet('/once').reply(200, { r: 2 });
    await manager.axiosInstance.get('/once');
    expect(afterRetry).not.toHaveBeenCalled();
    expect(succeeded).toHaveBeenCalledTimes(1);

    mock.restore();
    manager.destroy();
  });

  it('6.6 onRequestSucceeded payload attempts matches retries + 1', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 2, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const succeeded = jest.fn();
    manager.on('onRequestSucceeded', succeeded);
    mock.onGet('/a').replyOnce(503).onGet('/a').replyOnce(503).onGet('/a').reply(200);
    await manager.axiosInstance.get('/a');
    expect(succeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 3,
      }),
    );
    mock.restore();
    manager.destroy();
  });

  it('8.3.1 happy path ordering: onRequestQueued → onRequestDispatched → onRequestSucceeded', async () => {
    const manager = new RetryManager({ retries: 0, axiosInstance: axios.create() });
    const mock = new MockAdapter(manager.axiosInstance);
    const order: string[] = [];
    manager.on('onRequestQueued', () => order.push('q'));
    manager.on('onRequestDispatched', () => order.push('d'));
    manager.on('onRequestSucceeded', () => order.push('s'));
    mock.onGet('/p').reply(200);
    await manager.axiosInstance.get('/p');
    expect(order).toEqual(['q', 'd', 's']);
    mock.restore();
    manager.destroy();
  });

  it('8.3.3 retry path includes onRetryScheduled and beforeRetry before final success', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 1,
      axiosInstance: instance,
      backoffType: AXIOS_RETRYER_BACKOFF_TYPES.STATIC,
    });
    const mock = new MockAdapter(instance);
    const seq: string[] = [];
    manager.on('onRequestQueued', () => seq.push('queued'));
    manager.on('onRequestDispatched', () => seq.push('dispatched'));
    manager.on('onRetryProcessStarted', () => seq.push('retryProcStart'));
    manager.on('onRetryScheduled', () => seq.push('scheduled'));
    manager.on('beforeRetry', () => seq.push('beforeRetry'));
    manager.on('afterRetry', () => seq.push('afterRetry'));
    manager.on('onRequestSucceeded', () => seq.push('succeeded'));

    mock.onGet('/z').replyOnce(503).onGet('/z').reply(200);
    await manager.axiosInstance.get('/z');

    expect(seq).toContain('scheduled');
    expect(seq).toContain('beforeRetry');
    expect(seq.indexOf('afterRetry')).toBeLessThan(seq.indexOf('succeeded'));

    mock.restore();
    manager.destroy();
  });

  it('8.3.5 onRetryProcessStarted fires once with two concurrent retrying requests', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 1, maxConcurrentRequests: 5, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const started = jest.fn();
    manager.on('onRetryProcessStarted', started);
    mock.onGet('/a').replyOnce(500).onGet('/a').reply(200);
    mock.onGet('/b').replyOnce(500).onGet('/b').reply(200);
    await Promise.all([manager.axiosInstance.get('/a'), manager.axiosInstance.get('/b')]);
    expect(started).toHaveBeenCalledTimes(1);
    mock.restore();
    manager.destroy();
  });

  it('8.3.6 onRetryProcessFinished fires once after all concurrent retries complete', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 1, maxConcurrentRequests: 5, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const finished = jest.fn();
    manager.on('onRetryProcessFinished', finished);
    mock.onGet('/c1').replyOnce(500).onGet('/c1').reply(200);
    mock.onGet('/c2').replyOnce(500).onGet('/c2').reply(200);
    await Promise.all([manager.axiosInstance.get('/c1'), manager.axiosInstance.get('/c2')]);
    expect(finished).toHaveBeenCalledTimes(1);
    mock.restore();
    manager.destroy();
  });

  it('§6.2 slow first request holds concurrency; fast second completes only after first (markComplete)', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 0, maxConcurrentRequests: 1, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    mock.onGet('/slow').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([200, { slow: true }]), 60);
        }),
    );
    mock.onGet('/fast').reply(200, { fast: true });

    const pSlow = manager.axiosInstance.get('/slow');
    await new Promise((r) => setTimeout(r, 10));
    const pFast = manager.axiosInstance.get('/fast');
    const [slowRes, fastRes] = await Promise.all([pSlow, pFast]);
    expect(slowRes.data).toEqual({ slow: true });
    expect(fastRes.data).toEqual({ fast: true });
    mock.restore();
    manager.destroy();
  }, 10_000);
});

describe('P1 §8.3 RetryManager.on chaining (§8.1.7 via public API)', () => {
  it('manager.on chains for two different events', () => {
    const manager = new RetryManager({ axiosInstance: axios.create() });
    const a = jest.fn();
    const b = jest.fn();
    const chained = manager.on('onRetryProcessFinished', a).on('onRequestCancelled', b);
    expect(chained).toBe(manager);
    manager.emit('onRetryProcessFinished');
    manager.emit('onRequestCancelled', 'id');
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith('id');
    manager.destroy();
  });
});
