// @ts-nocheck
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src';
import type { RetryManagerOptions } from '../src';
import axios, { type AxiosError } from 'axios';

describe('RetryManager Additional Tests', () => {
  let mock: AxiosMockAdapter;
  let retryManager: RetryManager;

  beforeEach(() => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 2,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('Request ID Generation', () => {
    it('All IDs should be unique', async () => {
      const idsSet = new Set();
      // Disable retries to isolate the test behavior
      retryManager = new RetryManager({
        mode: 'automatic',
        retries: 0, // No retries
        axiosInstance: axios.create({ baseURL: 'http://localhost' }),
      });
      mock = new AxiosMockAdapter(retryManager.axiosInstance);

      // Mock the responses to always fail
      mock.onGet('/fail1').reply(500, 'Error 1');
      mock.onGet('/fail2').reply(500, 'Error 2');
      mock.onGet('/fail3').reply(500, 'Error 3');

      // Make concurrent requests
      await Promise.all([
        retryManager
          .axiosInstance
          .get('/fail1')
          .catch(() => {}),
        retryManager
          .axiosInstance
          .get('/fail2')
          .catch(() => {}),
        retryManager
          .axiosInstance
          .get('/fail3')
          .catch(() => {}),
      ]);

      // Check the request store
      const requestStore = (retryManager as any).requestStore;
      const storedRequests = requestStore.getAll();
      storedRequests.forEach((request) => {
        idsSet.add(request.__requestId);
      });

      // Assertions
      expect(storedRequests).toHaveLength(3);
      expect(idsSet.size).toBe(3);
      expect(storedRequests[0].url).toBe('/fail1');
      expect(storedRequests[1].url).toBe('/fail2');
      expect(storedRequests[2].url).toBe('/fail3');
    }, 10000);
  });

  describe('Custom Retry Strategy Behavior', () => {
    it('should respect custom retry delay strategy', async () => {
      const customStrategy = {
        shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
          return attempt <= maxRetries;
        },
        getDelay: (attempt) => attempt * 100,
        getIsRetryable: () => true,
      };

      retryManager = new RetryManager({
        mode: 'automatic',
        retries: 2, // No retries
        axiosInstance: axios.create({ baseURL: 'http://localhost' }),
        retryStrategy: customStrategy,
      });
      mock = new AxiosMockAdapter(retryManager.axiosInstance);

      const startTime = Date.now();
      mock.onGet('/custom-delay').reply(500, 'Error 1');

      await retryManager
        .axiosInstance
        .get('/custom-delay')
        .catch(() => {});
      const elapsedTime = Date.now() - startTime;

      // Should have waited approximately 100ms for first retry and 200ms for second retry
      expect(elapsedTime).toBeGreaterThanOrEqual(300);
    });
  });

  describe('Request Configuration Override', () => {
    test('should allow per-request retry configuration override', async () => {
      let attemptCount = 0;
      mock.onGet('/override-config').reply(() => {
        attemptCount++;
        return [500];
      });

      await retryManager
        .axiosInstance
        .get('/override-config', {
          __requestRetries: 1, // Override default of 2 retries
        })
        .catch(() => {});

      expect(attemptCount).toBe(2); // Initial attempt + 1 retry
    });

    test('should allow per-request mode override', async () => {
      mock.onGet('/override-mode').reply(500);

      await retryManager
        .axiosInstance
        .get('/override-mode', {
          __requestMode: 'manual',
        })
        .catch(() => {});

      const requestStore = retryManager['requestStore'];
      expect(requestStore.getAll()).toHaveLength(1); // Should be stored for manual retry
    });
  });

  describe('Error Handling Edge Cases', () => {
    test('should handle network errors differently from HTTP errors', async () => {
      mock.onGet('/network-error').networkError();

      await retryManager
        .axiosInstance
        .get('/network-error')
        .catch((error) => {
          expect(error.message).toContain('Network Error');
        });
    });

    test('should handle timeout errors appropriately', async () => {
      const timeoutConfig = {
        timeout: 100,
      };

      mock.onGet('/timeout').timeout();

      await retryManager
        .axiosInstance
        .get('/timeout', timeoutConfig)
        .catch((error) => {
          expect(error.code).toBe('ECONNABORTED');
        });
    });

    describe('HTTP Status Codes', () => {
      const retryableStatuses = [408, 429, 500, 502, 503, 504];

      test.each(retryableStatuses)('should retry on %i status code', async (status) => {
        mock.onGet('/status').reply(status);

        await expect(retryManager.axiosInstance.get('/status')).rejects.toThrow();

        expect(mock.history.get.length).toBe(3);
      });

      test('should not retry on 400 Bad Request', async () => {
        mock.onGet('/bad-request').reply(400);

        await expect(retryManager.axiosInstance.get('/bad-request')).rejects.toThrow();

        expect(mock.history.get.length).toBe(1); // No retries
      });
    });

    describe('HTTP Methods', () => {
      test.each(['get', 'head', 'options', 'put'])('should retry failed %s requests', async (method) => {
        mock.onAny('/method').reply(500);

        await expect(retryManager.axiosInstance[method]('/method')).rejects.toThrow();

        expect(mock.history[method].length).toBe(3);
      });

      test('should retry POST only with Idempotency-Key', async () => {
        mock.onPost('/idempotent').reply(500);

        // Without Idempotency-Key
        await expect(retryManager.axiosInstance.post('/idempotent')).rejects.toThrow();
        expect(mock.history.post.length).toBe(1); // No retry

        mock.resetHistory();

        // With Idempotency-Key
        await expect(
          retryManager.axiosInstance.post('/idempotent', null, {
            headers: { 'Idempotency-Key': 'abc123' },
          }),
        ).rejects.toThrow();
        expect(mock.history.post.length).toBe(3); // Should retry
      });

      test('should not retry PATCH requests', async () => {
        mock.onPatch('/no-retry').reply(500);

        await expect(retryManager.axiosInstance.patch('/no-retry')).rejects.toThrow();

        expect(mock.history.patch.length).toBe(1); // No retries
      });
    });
  });

  describe('Plugin System', () => {
    test('should handle plugin initialization failures gracefully', () => {
      const failingPlugin = {
        name: 'FailingPlugin',
        version: '1.0.0',
        initialize: () => {
          throw new Error('Plugin initialization failed');
        },
      };

      expect(() => retryManager.use(failingPlugin)).toThrow('Plugin initialization failed');
    });

    test('should allow plugins to modify request config', async () => {
      retryManager = new RetryManager({
        mode: 'automatic',
        retries: 1, // No retries
        axiosInstance: axios.create({ baseURL: 'http://localhost' }),
      });
      mock = new AxiosMockAdapter(retryManager.axiosInstance);

      let retryHeader = null;

      const headerPlugin = {
        name: 'HeaderPlugin',
        version: '1.0.0',
        initialize: () => {},
        hooks: {
          beforeRetry: (config) => {
            config.headers = config.headers || {};
            config.headers['X-Retry-Count'] = config.__retryAttempt;
          },
          afterRetry: (config) => {
            retryHeader = config.headers['X-Retry-Count'];
          },
        },
      };

      retryManager.use(headerPlugin);
      mock.onGet('/plugin-headers').reply(500, 'Error');

      await expect(retryManager.axiosInstance.get('/plugin-headers')).rejects.toThrow();

      expect(retryHeader).toEqual('1');
    });
  });

  describe('Memory Management', () => {
    test('should clean up resources after request completion', async () => {
      mock.onGet('/cleanup').reply(200);

      await retryManager.axiosInstance.get('/cleanup');

      expect(retryManager['activeRequests'].size).toBe(0);
      const requestStore = retryManager['requestStore'];
      expect(requestStore.getAll()).toHaveLength(0);
    });

    test('should handle multiple request cleanups correctly', async () => {
      mock.onGet('/cleanup1').reply(200);
      mock.onGet('/cleanup2').reply(500);

      await Promise.all([
        retryManager.axiosInstance.get('/cleanup1'),
        retryManager
          .axiosInstance
          .get('/cleanup2')
          .catch(() => {}),
      ]);

      expect(retryManager['activeRequests'].size).toBe(0);
    });
  });
});
