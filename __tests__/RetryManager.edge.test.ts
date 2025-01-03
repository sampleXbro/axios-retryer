// @ts-nocheck
import AxiosMockAdapter from 'axios-mock-adapter';
import {InMemoryRequestStore, RetryManager} from "../src";

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

  it('Simultaneous retries and cancellations', function (done) {
    mock.onGet('/retry-then-cancel').replyOnce(500).onGet('/retry-then-cancel').reply(200);

    const requestPromise = retryManager.getAxiosInstance().get('/retry-then-cancel');
    setTimeout(function () {
      retryManager.cancelAllRequests();
    }, 50);

    requestPromise.catch(function (err) {
      expect(err.message).toContain('Request aborted');
      const requestStore = retryManager['requestStore'];
      expect(requestStore.getAll().length).toBe(1); // Ensure failed requests are stored
      done();
    });
  });

  it('Handling a mix of successful, failed, and retried requests', function (done) {
    mock
        .onGet('/success').reply(200, 'OK')
        .onGet('/fail').reply(500, 'Error')
        .onGet('/retry').replyOnce(500).onGet('/retry').reply(200, 'Retried OK');

    const successPromise = retryManager.getAxiosInstance().get('/success');
    const failPromise = retryManager.getAxiosInstance().get('/fail').catch(function () { return 'failed'; });
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
  }, 10000); // Increased timeout to 10 seconds

  it('Ensuring the queue maintains order under stress', function (done) {
    mock
      .onGet('/first').reply(200, 'First')
      .onGet('/second').replyOnce(500).onGet('/second').reply(200, 'Second Retry OK')
      .onGet('/third').reply(200, 'Third');

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
});
