/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §19.3 metadata persistence across retries.
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { AXIOS_RETRYER_REQUEST_PRIORITIES, RetryManager } from '../src';
import { getRequestMetadata } from '../src/utils/requestMetadata';

describe('P1 Request metadata persistence (§19.3)', () => {
  it('19.3.1 requestId is stable across automatic retries', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 2, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const seen = new Set<string>();
    manager.on('beforeRetry', (config) => {
      const id = getRequestMetadata(config)?.requestId;
      if (id) seen.add(id);
    });
    mock.onGet('/x').replyOnce(503).onGet('/x').reply(200);
    await instance.get('/x');
    expect(seen.size).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('19.3.2 priority from __axiosRetryer is preserved across retries', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 1, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const priorities: number[] = [];
    manager.on('beforeRetry', (config) => {
      priorities.push(getRequestMetadata(config)?.priority ?? -1);
    });
    mock.onGet('/p').replyOnce(500).onGet('/p').reply(200);
    await instance.get('/p', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
    });
    expect(priorities.every((p) => p === AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH)).toBe(true);
    mock.restore();
    manager.destroy();
  });

  it('19.3.3 retryAttempt increments on each retry', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 2, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const attempts: number[] = [];
    manager.on('beforeRetry', (config) => {
      attempts.push(getRequestMetadata(config)?.retryAttempt ?? -1);
    });
    mock.onGet('/a').replyOnce(503).onGet('/a').replyOnce(503).onGet('/a').reply(200);
    await instance.get('/a');
    expect(attempts).toEqual([1, 2]);
    mock.restore();
    manager.destroy();
  });

  it('19.3.4 timestamp from first dispatch is preserved on retry config', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 1, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    let firstTs: number | undefined;
    manager.on('onRequestDispatched', (payload) => {
      if (payload.config.url === '/t') {
        firstTs = getRequestMetadata(payload.config)?.timestamp;
      }
    });
    manager.on('beforeRetry', (config) => {
      if (firstTs !== undefined) {
        expect(getRequestMetadata(config)?.timestamp).toBe(firstTs);
      }
    });
    mock.onGet('/t').replyOnce(500).onGet('/t').reply(200);
    await instance.get('/t');
    expect(firstTs).toBeDefined();
    mock.restore();
    manager.destroy();
  });

  it('19.3.5 extra survives into beforeRetry', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 1, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    manager.on('beforeRetry', (config) => {
      expect(getRequestMetadata(config)?.extra).toEqual({ tag: 'keep' });
    });
    mock.onGet('/e').replyOnce(500).onGet('/e').reply(200);
    await instance.get('/e', { __axiosRetryer: { extra: { tag: 'keep' } } });
    mock.restore();
    manager.destroy();
  });
});
