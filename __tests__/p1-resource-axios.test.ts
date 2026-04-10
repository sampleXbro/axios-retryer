/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §25 Resource management & §26 Axios compatibility.
 */
import axios, { type InternalAxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';

describe('P1 Resource management (§25)', () => {
  it('25.1.1 after retry cycles and destroy, timer stats are zeroed', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 2, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    mock.onGet('/c').replyOnce(503).onGet('/c').replyOnce(503).onGet('/c').reply(200);
    await instance.get('/c');
    const mid = manager.getMetrics().timerHealth;
    expect(mid.activeRetryTimers).toBe(0);
    manager.destroy();
    const post = manager.getMetrics().timerHealth;
    expect(post.activeTimers).toBe(0);
    expect(post.activeRetryTimers).toBe(0);
    mock.restore();
  });
});

describe('P1 Axios compatibility (§26)', () => {
  it('26.7 baseURL + relative url succeeds through RetryManager', async () => {
    const instance = axios.create({ baseURL: 'https://api.example.com' });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    mock.onGet('/v1/me').reply(200, { me: true });
    const res = await instance.get('/v1/me');
    expect(res.data).toEqual({ me: true });
    mock.restore();
    manager.destroy();
  });

  it('26.1 user request interceptor runs before retryer wiring (header visible to adapter)', async () => {
    const instance = axios.create();
    let seenHeader: string | undefined;
    instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>)['X-User'] = 'pre-retryer';
      return config;
    });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    mock.onGet('/h').reply((config) => {
      seenHeader = (config.headers as Record<string, string>)?.['X-User'];
      return [200, { ok: true }];
    });
    await instance.get('/h');
    expect(seenHeader).toBe('pre-retryer');
    mock.restore();
    manager.destroy();
  });

  it('26.12 using axiosInstance directly still passes through retryer interceptors', async () => {
    const instance = axios.create();
    const manager = new RetryManager({ retries: 0, axiosInstance: instance });
    const mock = new MockAdapter(instance);
    const queued = jest.fn();
    manager.on('onRequestQueued', queued);
    mock.onGet('/direct').reply(200);
    await instance.get('/direct');
    expect(queued).toHaveBeenCalled();
    mock.restore();
    manager.destroy();
  });
});
