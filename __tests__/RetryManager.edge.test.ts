// @ts-nocheck
import AxiosMockAdapter from 'axios-mock-adapter';
import { InMemoryRequestStore, RetryManager, RetryManagerOptions } from '../src';
import axios from 'axios';

describe('RetryManager Edge Scenarios', function () {
  let retryManager: RetryManager;
  let mock: AxiosMockAdapter;

  beforeEach(function () {
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 3,
      requestStore: new InMemoryRequestStore(),
    });
    mock = new AxiosMockAdapter(retryManager.getAxiosInstance());
  });

  afterEach(function () {
    mock.reset();
  });

  it('Simultaneous retries and cancellations', (done) => {
    mock.onGet('/retry-then-cancel').replyOnce(500).onGet('/retry-then-cancel').reply(200);

    const requestPromise = retryManager.getAxiosInstance().get('/retry-then-cancel');
    setTimeout(() => {
      retryManager.cancelAllRequests();
    }, 50);

    requestPromise.catch((err) => {
      expect(err).toContain('Request aborted. ID: /retry-then-cancel-1');
      const requestStore = retryManager['requestStore'];
      expect(requestStore.getAll().length).toBe(0); // Ensure failed requests are not stored
      done();
    });
  });

  it('Handling a mix of successful, failed, and retried requests', function (done) {
    mock
      .onGet('/success')
      .reply(200, 'OK')
      .onGet('/fail')
      .reply(500, 'Error')
      .onGet('/retry')
      .replyOnce(500)
      .onGet('/retry')
      .reply(200, 'Retried OK');

    const successPromise = retryManager.getAxiosInstance().get('/success');
    const failPromise = retryManager
      .getAxiosInstance()
      .get('/fail')
      .catch(function () {
        return 'failed';
      });
    const retryPromise = retryManager.getAxiosInstance().get('/retry');

    Promise.all([successPromise, failPromise, retryPromise])
      .then(function (results) {
        const [successResult, failResult, retryResult] = results;
        expect(successResult.data).toBe('OK');
        expect(failResult).toBe('failed');
        expect(retryResult.data).toBe('Retried OK');
        done();
      })
      .catch(done.fail);
  }, 15000); // Increased timeout to 10 seconds

  it('Ensuring the queue maintains order under stress', function (done) {
    mock
      .onGet('/first')
      .reply(200, 'First')
      .onGet('/second')
      .replyOnce(500)
      .onGet('/second')
      .reply(200, 'Second Retry OK')
      .onGet('/third')
      .reply(200, 'Third');

    Promise.all([
      retryManager.getAxiosInstance().get('/first'),
      retryManager.getAxiosInstance().get('/second'),
      retryManager.getAxiosInstance().get('/third'),
    ])
      .then(function (results) {
        const [firstResult, secondResult, thirdResult] = results;
        expect(firstResult.data).toBe('First');
        expect(secondResult.data).toBe('Second Retry OK');
        expect(thirdResult.data).toBe('Third');
        done();
      })
      .catch(done.fail);
  });

  it('should not retry on non-retryable errors', async () => {
    mock.onGet('/non-retryable').reply(400, 'Bad Request');

    await expect(retryManager.getAxiosInstance().get('/non-retryable')).rejects.toThrow();
    const requestStore = (retryManager as any).requestStore;
    expect(requestStore.getAll()).toHaveLength(0); // Non-retryable errors should not be stored
  });

  test('should clear request store', () => {
    const requestStore = (retryManager as any).requestStore;
    requestStore.add({ url: '/stored-request' });
    expect(requestStore.getAll()).toHaveLength(1);

    requestStore.clear();
    expect(requestStore.getAll()).toHaveLength(0);
  });

  test('should cancel a specific request without affecting others', async () => {
    const options = {
      mode: 'automatic',
      retries: 1,
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

    // Mock the endpoint
    mock.onGet('/specific-cancel').reply(() => {
      return new Promise((resolve) => setTimeout(() => resolve([200, { data: 'ok' }]), 100));
    });

    // Set up the AbortController and request ID
    const controller = new AbortController();
    const requestId = 'cancel-specific';
    retryManager['activeRequests'].set(requestId, controller);

    // Start the request and immediately cancel it
    const mockPromise = retryManager.getAxiosInstance().get('/specific-cancel', { signal: controller.signal });
    retryManager.cancelRequest(requestId);

    // Verify the cancellation behavior
    await mockPromise.catch((err) => {
      expect(err.message).toContain('Request aborted');
    });

    // Ensure the request was removed from activeRequests
    expect(retryManager['activeRequests'].has(requestId)).toBe(false);
  });
});
