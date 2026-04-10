/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §9 DependencyGatekeeper (integration via RetryManager).
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { AXIOS_RETRYER_REQUEST_PRIORITIES, RetryManager } from '../src';

describe('P1 DependencyGatekeeper (§9)', () => {
  it('9.1.10 no blockingPriorityThreshold: requests are not held by blocking gate', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 2,
      axiosInstance: instance,
    });
    const mock = new MockAdapter(instance);
    const resolved = jest.fn();
    manager.on('onAllBlockingRequestsResolved', resolved);
    mock.onGet('/x').reply(200);
    mock.onGet('/y').reply(200);
    await Promise.all([instance.get('/x'), instance.get('/y')]);
    expect(resolved).not.toHaveBeenCalled();
    mock.restore();
    manager.destroy();
  });

  it('9.1.1 HIGH blocker delays LOW until HIGH completes', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 1,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    const order: string[] = [];
    mock.onGet('/high').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push('high-done');
            resolve([200, { h: 1 }]);
          }, 50);
        }),
    );
    mock.onGet('/low').reply(() => {
      order.push('low-reply');
      return [200, { l: 1 }];
    });

    const pHigh = instance.get('/high', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
    });
    await new Promise((r) => setTimeout(r, 5));
    const pLow = instance.get('/low', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
    });
    await Promise.all([pHigh, pLow]);
    expect(order).toEqual(['high-done', 'low-reply']);
    mock.restore();
    manager.destroy();
  });

  it('9.1.2 MEDIUM is not a blocker (does not hold the gate for same-priority peers)', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 2,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    mock.onGet('/m1').reply(200);
    mock.onGet('/m2').reply(200);
    await Promise.all([
      instance.get('/m1', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM } }),
      instance.get('/m2', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM } }),
    ]);
    mock.restore();
    manager.destroy();
  });

  it('9.1.3 CRITICAL is treated as blocking relative to LOW under threshold HIGH', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 1,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    const order: string[] = [];
    mock.onGet('/crit').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push('c');
            resolve([200]);
          }, 40);
        }),
    );
    mock.onGet('/low').reply(() => {
      order.push('l');
      return [200];
    });
    const pc = instance.get('/crit', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
    });
    await new Promise((r) => setTimeout(r, 5));
    const pl = instance.get('/low', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW } });
    await Promise.all([pc, pl]);
    expect(order).toEqual(['c', 'l']);
    mock.restore();
    manager.destroy();
  });

  it('9.1.4 two HIGH blockers: LOW waits until both complete', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 2,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    let h1Done = false;
    let h2Done = false;
    mock.onGet('/h1').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            h1Done = true;
            resolve([200]);
          }, 30);
        }),
    );
    mock.onGet('/h2').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            h2Done = true;
            resolve([200]);
          }, 30);
        }),
    );
    mock.onGet('/low').reply(() => {
      expect(h1Done && h2Done).toBe(true);
      return [200];
    });

    const p1 = instance.get('/h1', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH } });
    const p2 = instance.get('/h2', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH } });
    await new Promise((r) => setTimeout(r, 5));
    const pLow = instance.get('/low', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW } });
    await Promise.all([p1, p2, pLow]);
    mock.restore();
    manager.destroy();
  });

  it('9.1.5 blocking HIGH fails terminally → onBlockingRequestFailed', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    const failed = jest.fn();
    manager.on('onBlockingRequestFailed', failed);
    mock.onGet('/bh').reply(500);
    await instance.get('/bh', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH } });
    expect(failed).toHaveBeenCalledTimes(1);
    mock.restore();
    manager.destroy();
  });

  it('9.1.6 cancelPendingOnDependencyFailure true cancels queued after blocking failure', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 1,
      cancelPendingOnDependencyFailure: true,
      throwErrorOnCancelRequest: true,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    mock.onGet('/failHigh').reply(500);
    mock.onGet('/queuedLow').reply(200);

    const pFail = instance.get('/failHigh', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH } });
    await new Promise((r) => setTimeout(r, 5));
    const pQueued = instance.get('/queuedLow', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW } });
    await pFail.catch(() => {});
    await expect(pQueued).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    mock.restore();
    manager.destroy();
  });

  it('9.1.7 cancelPendingOnDependencyFailure false leaves queued work alive after blocking failure', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 1,
      cancelPendingOnDependencyFailure: false,
      throwErrorOnFailedRetries: false,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    const cancelled = jest.fn();
    manager.on('onRequestCancelled', cancelled);
    mock.onGet('/failHigh').reply(500);
    mock.onGet('/laterLow').reply(200, { ok: 1 });
    await instance.get('/failHigh', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH } });
    await new Promise((r) => setTimeout(r, 15));
    const res = await instance.get('/laterLow', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW } });
    expect(res.data).toEqual({ ok: 1 });
    expect(cancelled).not.toHaveBeenCalled();
    mock.restore();
    manager.destroy();
  });

  it('9.1.8 all blocking HIGH succeed → onAllBlockingRequestsResolved', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 1,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    const resolved = jest.fn();
    manager.on('onAllBlockingRequestsResolved', resolved);
    mock.onGet('/okh').reply(200);
    await instance.get('/okh', { __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH } });
    expect(resolved).toHaveBeenCalledTimes(1);
    mock.restore();
    manager.destroy();
  });

  it('9.1.9 blocking request cancelled does not emit onAllBlockingRequestsResolved', async () => {
    const instance = axios.create();
    const manager = new RetryManager({
      retries: 0,
      maxConcurrentRequests: 1,
      axiosInstance: instance,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    });
    const mock = new MockAdapter(instance);
    const resolved = jest.fn();
    manager.on('onAllBlockingRequestsResolved', resolved);
    let rid = '';
    manager.on('onRequestQueued', (p) => {
      if (p.priority === AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH) {
        rid = p.requestId;
      }
    });
    mock
      .onGet('/slowHigh')
      .reply(() => new Promise<[number, { s: number }]>((resolve) => setTimeout(() => resolve([200, { s: 1 }]), 300)));
    const p = instance.get('/slowHigh', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(rid).not.toBe('');
    manager.cancelRequest(rid);
    await p.catch(() => {});
    expect(resolved).not.toHaveBeenCalled();
    mock.restore();
    manager.destroy();
  }, 10_000);
});
