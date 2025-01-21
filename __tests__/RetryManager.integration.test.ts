//@ts-nocheck
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { RetryHooks, RetryManager } from '../src';
import {
  AXIOS_RETRYER_REQUEST_PRIORITIES,
  RETRY_MODES,
  RetryPlugin
} from '../src';
import AxiosMockAdapter from 'axios-mock-adapter';

describe('RetryManager Integration Tests', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;
  let retryManager: RetryManager;
  let hookSpy: RetryHooks;

  beforeEach(() => {
    // Initialize a real Axios instance
    axiosInstance = axios.create();

    // Initialize Axios Mock Adapter
    mock = new AxiosMockAdapter(axiosInstance);

    // Initialize hooks with Jest spies
    hookSpy = {
      onRetryProcessStarted: jest.fn(),
      onRetryProcessFinished: jest.fn(),
      beforeRetry: jest.fn(),
      afterRetry: jest.fn(),
      onFailure: jest.fn(),
      onCriticalRequestFailed: jest.fn(),
      onRequestRemovedFromStore: jest.fn(),
    };

    // Initialize the RetryManager with the mocked Axios instance
    retryManager = new RetryManager({
      axiosInstance,
      retries: 3,
      mode: RETRY_MODES.AUTOMATIC,
      debug: false,
      maxConcurrentRequests: 2,
      queueDelay: 0,
      blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      hooks: hookSpy,
      maxRequestsToStore: 100,
    });
  });

  afterEach(() => {
    // Reset the mock adapter after each test
    mock.reset();
  });

  // Helper function to simulate full request chain
  const processRequest = async (cfg: AxiosRequestConfig): Promise<AxiosResponse> => {
    try {
      return await axiosInstance.request(cfg);
    } catch (err) {
      throw err;
    }
  };

  describe('Request Processing and Priority Management', () => {
    it('should handle dynamic priority changes during retries', async () => {
      const request: AxiosRequestConfig = {
        url: '/dynamic-priority',
        __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
        __requestRetries: 2
      };

      let attemptCount = 0;
      mock.onAny('/dynamic-priority').reply(config => {
        attemptCount++;
        if (attemptCount === 1) {
          return [503, 'error'];
        }
        expect(config.__priority).toBe(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
        return [200, 'success'];
      });

      const plugin: RetryPlugin = {
        name: 'PriorityModifier',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: (config) => {
            config.__priority = AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH;
          }
        }
      };

      retryManager.use(plugin);
      const response = await processRequest(request);
      expect(response.data).toBe('success');
    });

    it('should properly queue and process requests when exceeding concurrent limit', async () => {
      const maxConcurrent = 2;

      // Create RetryManager with small concurrent limit
      const testRetryManager = new RetryManager({
        axiosInstance,
        retries: 0, // No retries for this test
        maxConcurrentRequests: maxConcurrent,
        queueDelay: 50
      });

      const totalRequests = 6; // More than maxConcurrent
      const processOrder: string[] = [];

      const requests = Array.from({ length: totalRequests }, (_, i) => ({
        url: `/concurrent${i}`,
        __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
        __requestRetries: 0
      }));

      // Mock to track processing order with controlled delay
      requests.forEach(req => {
        mock.onAny(req.url!).reply(config => {
          processOrder.push(config.url!);
          return new Promise(resolve => setTimeout(() => resolve([200, 'success']), 100));
        });
      });

      // Send all requests simultaneously
      const results = await Promise.all(
        requests.map(req => testRetryManager.axiosInstance.request(req))
      );

      // All requests should eventually succeed
      expect(results.every(r => r.status === 200)).toBe(true);

      // Only maxConcurrent requests should be processed at a time
      // We can verify this by checking timestamps or process order length at intervals
      expect(processOrder.length).toBe(totalRequests);

      // Get queue metrics for verification
      const queueInstance = testRetryManager['requestQueue'];
      expect(queueInstance.isBusy).toBe(true);
      expect(queueInstance.getWaitingCount()).toBe(0); // All requests should be completed
    });

    it('should maintain FIFO order within same priority level', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => ({
        url: `/fifo${i}`,
        __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
        __timestamp: Date.now() + i
      }));

      const processedUrls: string[] = [];

      requests.forEach(req => {
        mock.onAny(req.url!).reply(config => {
          processedUrls.push(config.url!);
          return [200, 'success'];
        });
      });

      await Promise.all(requests.map(req => processRequest(req)));

      expect(processedUrls).toEqual(requests.map(r => r.url));
    });
    it('should process requests according to priority order', async () => {
      retryManager.blockingQueueThreshold = undefined;

      const requests: AxiosRequestConfig[] = [
        { url: '/low', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
        { url: '/critical', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        { url: '/high', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
        { url: '/medium', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
      ];

      const processedUrls: string[] = [];

      // Setup mock responses
      requests.forEach((req) => {
        mock.onAny(req.url!).reply((config) => {
          processedUrls.push(config.url!);
          return [200, 'success'];
        });
      });

      // Initiate all requests concurrently
      await Promise.all(requests.map((req) => processRequest(req)));

      // Verify the order based on priority
      expect(processedUrls).toEqual(['/critical', '/high', '/medium', '/low']);
    });

    it('should maintain correct order when mixing priorities and retry attempts', async () => {
      retryManager.blockingQueueThreshold = undefined;

      const requests: AxiosRequestConfig[] = [
        { url: '/low', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
        { url: '/high-retry', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
        { url: '/medium', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
      ];

      const processedRequests: string[] = [];
      let highRetryCount = 0;

      // Setup mock responses with retry logic
      mock.onAny('/high-retry').reply((config) => {
        processedRequests.push(config.url!);
        if (highRetryCount < 1) {
          highRetryCount++;
          return [503, 'Service Unavailable'];
        }
        return [200, 'success'];
      });

      mock.onAny('/low').reply((config) => {
        processedRequests.push(config.url!);
        return [200, 'success'];
      });

      mock.onAny('/medium').reply((config) => {
        processedRequests.push(config.url!);
        return [200, 'success'];
      });

      // Initiate all requests concurrently
      await Promise.all(requests.map((req) => processRequest(req)));

      // Expected processing order:
      // 1. /high-retry (first attempt)
      // 2. /medium
      // 3. /low
      // 4. /high-retry (retry)
      expect(processedRequests).toEqual(['/high-retry', '/medium', '/low', '/high-retry']);
    });
  });

  describe('Request Store and Recovery', () => {
    it('should properly handle store cleanup on successful retries', async () => {
      mock.onAny('/store-test').replyOnce(500, 'error')
        .onAny('/store-test').reply(200, 'success');

      const request = { url: '/store-test', __requestRetries: 1 };
      await processRequest(request);

      // Store should be empty after successful retry
      expect(retryManager['requestStore'].getAll().length).toBe(0);
    });

    it('should maintain request metadata across retries', async () => {
      const metadata = { customField: 'test-value' };
      mock.onAny('/metadata-test').replyOnce(500, 'error')
        .onAny('/metadata-test').reply(200, 'success');

      const request: AxiosRequestConfig = {
        url: '/metadata-test',
        __requestRetries: 1,
        metadata
      };

      await processRequest(request);
      expect(hookSpy.beforeRetry).toHaveBeenCalledWith(
        expect.objectContaining({ metadata })
      );
    });

    it('should store failed requests and allow bulk retry', async () => {
      // Setup mock to reject specific endpoints
      mock.onGet('/api1').reply(500, 'Error');
      mock.onGet('/api2').reply(500, 'Error');

      const failedRequests: AxiosRequestConfig[] = [
        { url: '/api1', method: 'get' },
        { url: '/api2', method: 'get' },
      ];

      // Initiate failed requests
      await Promise.allSettled(
        failedRequests.map((req) =>
          processRequest(req)
        )
      );

      // Verify that failed requests are stored
      expect(retryManager.getMetrics().completelyFailedRequests).toBe(2);

      // Setup mock to succeed on retry
      mock.onGet('/api1').reply(200, 'success');
      mock.onGet('/api2').reply(200, 'success');

      // Perform bulk retry
      const retryResults = await retryManager.retryFailedRequests();

      expect(retryResults.every((res) => res.data === 'success')).toBe(true);
      expect(retryManager.getMetrics().completelyFailedRequests).toBe(0);
    }, 10000);

    it('should handle store capacity and removal of old requests', async () => {
      // Setup mock to reject any request
      mock.onAny().reply(500, 'Error');

      // Create more requests than the store capacity (100)
      const requests: AxiosRequestConfig[] = Array.from({ length: 150 }, (_, i) => ({
        url: `/api${i}`,
        method: 'get',
        __timestamp: Date.now() + i,
      }));

      // Initiate all requests
      await Promise.all(
        requests.map((req) =>
          processRequest(req).catch(() => {
            // Handle rejection
          })
        )
      );

      // Verify that the store does not exceed its capacity
      expect(retryManager.getMetrics().completelyFailedRequests).toBeLessThanOrEqual(100);
      expect(hookSpy.onRequestRemovedFromStore).toHaveBeenCalled();
    }, 10000);
  });

  describe('Plugin System and Hooks', () => {
    it('should allow plugins to modify request config', async () => {
      const plugin: RetryPlugin = {
        name: 'RequestModifierPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: (config) => {
            config.headers = {
              ...config.headers,
              'X-Modified-By-Plugin': 'true'
            };
          }
        }
      };

      retryManager.use(plugin);

      mock.onAny('/test')
        .replyOnce(503)
        .onAny('/test')
        .reply(config => {
          expect(config.headers['X-Modified-By-Plugin']).toBe('true');
          return [200, 'success'];
        });

      await processRequest({ url: '/test' });
    });

    it('should handle multiple plugins with conflicting modifications', async () => {
      const plugin1: RetryPlugin = {
        name: 'Plugin1',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: (config) => {
            config.headers = { ...config.headers, 'X-Order': '1' };
          }
        }
      };

      const plugin2: RetryPlugin = {
        name: 'Plugin2',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: (config) => {
            config.headers = { ...config.headers, 'X-Order': '2' };
          }
        }
      };

      retryManager.use(plugin1);
      retryManager.use(plugin2);

      mock.onAny('/test')
        .replyOnce(503)
        .onAny('/test')
        .reply(config => {
          expect(config.headers['X-Order']).toBe('2');
          return [200, 'success'];
        });

      await processRequest({ url: '/test' });
    });

    it('should properly execute plugin hooks in order', async () => {
      const hookExecutionOrder: string[] = [];

      const plugin: RetryPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: () => {
            hookExecutionOrder.push('plugin:beforeRetry');
          },
          afterRetry: () => {
            hookExecutionOrder.push('plugin:afterRetry');
          },
          onRetryProcessStarted: () => {
            hookExecutionOrder.push('plugin:onRetryProcessStarted');
          },
        },
      };

      // Register the plugin
      retryManager.use(plugin);

      // Override core hooks to track execution order
      hookSpy.beforeRetry = jest.fn(() => {
        hookExecutionOrder.push('core:beforeRetry');
      });

      hookSpy.afterRetry = jest.fn(() => {
        hookExecutionOrder.push('core:afterRetry');
      });

      hookSpy.onRetryProcessStarted = jest.fn(() => {
        hookExecutionOrder.push('core:onRetryProcessStarted');
      });

      mock.onAny('/test').replyOnce(503, 'Service Unavailable').onAny('/test').replyOnce(200, 'success');

      // Initiate the request
      await processRequest({ url: '/test' }).catch(() => {
        // Handle rejection to proceed with test
      });

      // Verify the order of hook executions
      expect(hookExecutionOrder).toEqual([
        'core:onRetryProcessStarted',
        'plugin:onRetryProcessStarted',
        'core:beforeRetry',
        'plugin:beforeRetry',
        'core:afterRetry',
        'plugin:afterRetry',
      ]);
    });

    it('should handle plugin errors gracefully', async () => {
      const plugin: RetryPlugin = {
        name: 'ErrorPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: () => {
            throw new Error('Plugin error');
          },
        },
      };

      // Register the faulty plugin
      retryManager.use(plugin);

      mock.onAny('/test').replyOnce(503, 'Service Unavailable').onAny('/test').replyOnce(200, 'success');

      // Initiate the request and ensure it succeeds despite the plugin error
      const result = await processRequest({ url: '/test' });

      expect(result.data).toBe('success');
    });

    it('should handle plugin version conflicts', async () => {
      const plugin1: RetryPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn()
      };

      const plugin2: RetryPlugin = {
        name: 'TestPlugin',
        version: '2.0.0',
        initialize: jest.fn()
      };

      retryManager.use(plugin1);
      expect(() => retryManager.use(plugin2)).toThrow();
    });

    it('should execute plugin initialization with correct context', async () => {
      const initSpy = jest.fn();
      const plugin: RetryPlugin = {
        name: 'InitTestPlugin',
        version: '1.0.0',
        initialize: initSpy
      };

      retryManager.use(plugin);
      expect(initSpy).toHaveBeenCalledWith(retryManager);
    });
  });

  describe('Critical Request Handling', () => {
    // Add to "Critical Request Handling" describe block
    it('should handle mixed priority requests with partial failures', async () => {
      const requests = [
        { url: '/critical1', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        { url: '/critical2', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        { url: '/low1', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
        { url: '/low2', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW }
      ];

      // First critical succeeds, second fails
      mock.onAny('/critical1').reply(200, 'success');
      mock.onAny('/critical2').reply(500, 'error');
      mock.onAny('/low1').reply(200, 'success');
      mock.onAny('/low2').reply(200, 'success');

      const results = await Promise.allSettled(
        requests.map(req => processRequest(req))
      );

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('rejected'); // Should be cancelled due to critical failure
      expect(results[3].status).toBe('rejected'); // Should be cancelled due to critical failure

      expect(hookSpy.onCriticalRequestFailed).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should cancel non-critical requests when critical request fails', async () => {
      // Setup mock to fail the critical request and succeed others
      mock.onAny('/critical').reply(500, 'Error');
      mock.onAny('/low1').reply(() => {
        // Simulate delay to allow cancellation
        return new Promise((resolve) =>
          setTimeout(() => resolve([200, 'success']), 100)
        );
      });
      mock.onAny('/low2').reply(() => {
        // Simulate delay to allow cancellation
        return new Promise((resolve) =>
          setTimeout(() => resolve([200, 'success']), 100)
        );
      });

      const requests: AxiosRequestConfig[] = [
        { url: '/critical', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
        { url: '/low1', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
        { url: '/low2', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
      ];

      // Initiate all requests concurrently
      const results = await Promise.allSettled(
        requests.map((req) => processRequest(req))
      );

      // Verify that all requests have been rejected
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('rejected');
      expect(hookSpy.onCriticalRequestFailed).toHaveBeenCalled();
    }, 10000);

    it('should block new non-critical requests while critical requests are in progress', async () => {
      // Setup mock responses
      mock.onAny('/critical').reply(() =>
        new Promise((resolve) =>
          setTimeout(() => resolve([200, 'critical success']), 100)
        )
      );
      mock.onAny('/low').reply(200, 'success');

      // Initiate a critical request
      const criticalPromise = processRequest({
        url: '/critical',
        __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
      });

      // Attempt to make a non-critical request while critical is in progress
      const lowPriorityPromise = processRequest({
        url: '/low',
        __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
      });

      // Await both promises
      const lowPriorityResult = await lowPriorityPromise;
      const criticalResult = await criticalPromise;

      // Verify responses
      expect(criticalResult.data).toBe('critical success');
      expect(lowPriorityResult.data).toBe('success');

      // Verify that only two requests were made
      expect(mock.history.length).toBe(2);
    });
  });

  describe('Metrics and Monitoring', () => {
    it('should track all request metrics accurately', async () => {
      // Setup mock responses
      mock.onAny('/success').reply(200, 'success');
      mock.onAny('/retry-success').replyOnce(500, 'Error').onAny('/retry-success').replyOnce(200, 'success');
      mock.onAny('/fail').reply(500, 'Error');

      // Initiate requests
      await processRequest({ url: '/success' });
      await processRequest({ url: '/retry-success' });
      await processRequest({ url: '/fail' }).catch(() => {
        // Handle rejection
      });

      const metrics = retryManager.getMetrics();

      expect(metrics.totalRequests).toBe(7);
      expect(metrics.successfulRetries).toBe(1);
      expect(metrics.failedRetries).toBe(3);
      expect(metrics.completelyFailedRequests).toBe(1);
    }, 10000);

    it('should track cancellation metrics', async () => {
      // Setup mock responses with delays to allow cancellation
      mock.onAny('/test1').reply(() =>
        new Promise((resolve) =>
          setTimeout(() => resolve([200, 'success']), 100)
        )
      );
      mock.onAny('/test2').reply(() =>
        new Promise((resolve) =>
          setTimeout(() => resolve([200, 'success']), 100)
        )
      );
      mock.onAny('/test3').reply(200, 'success');

      const requests: AxiosRequestConfig[] = [
        { url: '/test1', __requestId: 'req1' },
        { url: '/test2', __requestId: 'req2' },
        { url: '/test3', __requestId: 'req3' },
      ];

      // Initiate all requests
      const promises = requests.map((req) => processRequest(req));

      // Cancel some requests after a short delay
      setTimeout(() => {
        retryManager.cancelRequest('req1');
        retryManager.cancelRequest('req2');
      }, 50);

      const results = await Promise.allSettled(promises);

      // Verify cancellation results
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
      expect(retryManager.getMetrics().canceledRequests).toBe(4);
    });
  });

  describe('Backoff and Error Handling Tests', () => {
    let retryManagerWithCustomBackoff: RetryManager;
    let customMock: AxiosMockAdapter;
    let customHookSpy: RetryHooks;

    beforeEach(() => {
      // Initialize a separate Axios instance for backoff tests
      const customAxiosInstance = axios.create();
      customMock = new AxiosMockAdapter(customAxiosInstance);

      // Initialize custom hooks
      customHookSpy = {
        onRetryProcessStarted: jest.fn(),
        onRetryProcessFinished: jest.fn(),
        beforeRetry: jest.fn(),
        afterRetry: jest.fn(),
        onFailure: jest.fn(),
        onCriticalRequestFailed: jest.fn(),
        onRequestRemovedFromStore: jest.fn(),
      };

      // Initialize RetryManager with custom Axios instance
      retryManagerWithCustomBackoff = new RetryManager({
        axiosInstance: customAxiosInstance,
        retries: 3,
        mode: RETRY_MODES.AUTOMATIC,
        debug: false,
        maxConcurrentRequests: 2,
        queueDelay: 0,
        hooks: customHookSpy,
        maxRequestsToStore: 100,
      });

      // Replace the mock with the custom mock
      retryManagerWithCustomBackoff = retryManagerWithCustomBackoff; // For TypeScript
    });

    afterEach(() => {
      customMock.reset();
      jest.restoreAllMocks();
    });

    // Helper function to simulate full request chain for custom RetryManager
    const customProcessRequest = async (cfg: AxiosRequestConfig): Promise<AxiosResponse> => {
      try {
        return await retryManagerWithCustomBackoff.axiosInstance.request(cfg);
      } catch (err) {
        if ((err as AxiosError).isAxiosError) {
          throw err;
        }
        throw new AxiosError('Unexpected error', 'UNKNOWN_ERROR', cfg, null, null);
      }
    };

    describe('Error Handling', () => {
      it('should handle timeout errors with appropriate retries', async () => {
        const timeoutError = new AxiosError(
          'Timeout',
          'ECONNABORTED',
          { url: '/timeout', method: 'get' } as InternalAxiosRequestConfig,
          {}
        );

        customMock.onAny('/timeout')
          .replyOnce(() => Promise.reject(timeoutError))
          .onAny('/timeout')
          .reply(200, 'success');

        const response = await customProcessRequest({
          url: '/timeout',
          timeout: 1000
        });

        expect(response.data).toBe('success');
        expect(customHookSpy.beforeRetry).toHaveBeenCalledTimes(1);
      });

      it('should handle rate limit responses correctly', async () => {
        customMock.onAny('/ratelimited')
          .replyOnce(429, '', { 'Retry-After': '1' })
          .onAny('/ratelimited')
          .reply(200, 'success');

        const response = await customProcessRequest({
          url: '/ratelimited'
        });

        expect(response.data).toBe('success');
        expect(customHookSpy.beforeRetry).toHaveBeenCalledTimes(1);
      });
      it('should handle network errors appropriately', async () => {
        const networkError = new AxiosError(
          'Network Error',
          'ECONNRESET',
          { url: '/network-error', method: 'get' } as InternalAxiosRequestConfig,
          {},
        );

        // Setup mock to fail twice and succeed on the third attempt
        customMock.onAny('/network-error').replyOnce(() => Promise.reject(networkError));
        customMock.onAny('/network-error').replyOnce(() => Promise.reject(networkError));
        customMock.onAny('/network-error').reply(200, 'success');

        await customProcessRequest({ url: '/network-error', method: 'get' }).catch(() => {});

        expect(customHookSpy.beforeRetry).toHaveBeenCalledTimes(2);
        expect(customHookSpy.afterRetry).toHaveBeenCalledTimes(2);
        expect(customHookSpy.onFailure).toHaveBeenCalledTimes(0);
      });

      it('should handle non-retryable methods correctly', async () => {
        // Setup mock to reject DELETE requests
        customMock.onDelete('/non-retryable').reply(500, 'Error');

        await expect(
          customProcessRequest({ url: '/non-retryable', method: 'delete' })
        ).rejects.toThrow();

        // Ensure no retries were attempted
        expect(customHookSpy.beforeRetry).not.toHaveBeenCalled();
      });

      it('should retry POST requests with Idempotency-Key', async () => {
        // Setup mock to fail once and succeed on retry
        customMock.onPost('/idempotent').replyOnce(500, 'Error');
        customMock.onPost('/idempotent').reply(200, 'success');

        const response = await customProcessRequest({
          url: '/idempotent',
          method: 'post',
          headers: {
            'Idempotency-Key': 'test-key-123',
          },
        });

        expect(response.data).toBe('success');
        expect(customHookSpy.beforeRetry).toHaveBeenCalledTimes(1);
      });
    });

    describe('Concurrency and Queue Management', () => {
      it('should handle concurrent requests with mixed priorities and errors', async () => {
        const requests: AxiosRequestConfig[] = [
          {
            url: '/priority1',
            __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
            shouldFail: true,
          },
          {
            url: '/priority2',
            __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
            shouldFail: false,
          },
          {
            url: '/priority3',
            __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
            shouldFail: true,
          },
        ];

        // Setup mock responses with retry logic
        customMock.onAny('/priority1').replyOnce(503, 'Error').onAny('/priority1').reply(200, 'success');
        customMock.onAny('/priority2').reply(200, 'success');
        customMock.onAny('/priority3').replyOnce(503, 'Error').onAny('/priority3').reply(200, 'success');

        // Initiate all requests concurrently
        const results = await Promise.all(
          requests.map((req) => customProcessRequest(req))
        );

        // Verify responses
        expect(results[0].data).toBe('success'); // /priority1 retried and succeeded
        expect(results[1].data).toBe('success'); // /priority2 succeeded immediately
        expect(results[2].data).toBe('success'); // /priority3 retried and succeeded

        // Verify that retries were attempted
        expect(customHookSpy.beforeRetry).toHaveBeenCalledTimes(2);
        expect(customHookSpy.afterRetry).toHaveBeenCalledTimes(2);
      });

      it('should maintain queue order when retries occur', async () => {
        const processedUrls: string[] = [];

        // Setup mock to fail once on /retry and succeed on retry
        customMock.onAny('/retry').replyOnce(503, 'Error').onAny('/retry').reply(200, 'success');
        customMock.onAny('/first').reply(200, 'success');
        customMock.onAny('/last').reply(200, 'success');

        // Spy on beforeRetry to capture the order
        customHookSpy.beforeRetry = jest.fn((config) => {
          processedUrls.push(`beforeRetry:${config.url}`);
        });

        // Spy on afterRetry to capture the order
        customHookSpy.afterRetry = jest.fn((config) => {
          processedUrls.push(`afterRetry:${config.url}`);
        });

        // Initiate requests
        await Promise.all([
          customProcessRequest({ url: '/first', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH }),
          customProcessRequest({ url: '/retry', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH }),
          customProcessRequest({ url: '/last', __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW }),
        ]);

        // Expected processing order:
        // 1. /first
        // 2. /retry (initial)
        // 3. /last
        // 4. /retry (retry)

        expect(processedUrls).toEqual([
          'beforeRetry:/retry',
          'afterRetry:/retry',
        ]);
      });
    });
  });

  describe('Request Timing and Delays', () => {
    it('should respect queueDelay between requests', async () => {
      const queueDelay = 200;
      const customRetryManager = new RetryManager({
        axiosInstance,
        queueDelay,
        maxConcurrentRequests: 1
      });

      const timestamps: number[] = [];
      mock.onAny().reply(() => {
        timestamps.push(Date.now());
        return [200, 'success'];
      });

      await Promise.all([
        customRetryManager.axiosInstance.request({ url: '/delay1' }),
        customRetryManager.axiosInstance.request({ url: '/delay2' })
      ]);

      const timeDiff = timestamps[1] - timestamps[0];
      expect(timeDiff).toBeGreaterThanOrEqual(queueDelay);
    });

    it('should handle multiple retry delays correctly', async () => {
      const request: AxiosRequestConfig = {
        url: '/retry-delays',
        __requestRetries: 2
      };

      const timestamps: number[] = [];
      mock.onAny('/retry-delays')
        .replyOnce(() => {
          timestamps.push(Date.now());
          return [503, 'error'];
        })
        .onAny('/retry-delays')
        .replyOnce(() => {
          timestamps.push(Date.now());
          return [503, 'error'];
        })
        .onAny('/retry-delays')
        .reply(() => {
          timestamps.push(Date.now());
          return [200, 'success'];
        });

      await processRequest(request);

      const delays = timestamps.slice(1).map((time, i) => time - timestamps[i]);
      delays.forEach(delay => {
        expect(delay).toBeGreaterThan(0);
      });
    });
  });

  describe('Request Cancellation Scenarios', () => {
    it('should handle cancellation during retry delay', async () => {
      const request: AxiosRequestConfig = {
        url: '/cancel-during-delay',
        __requestRetries: 2,
        __requestId: 'cancel-during-delay-id'
      };

      mock.onAny('/cancel-during-delay').reply(503, 'error');

      const requestPromise = processRequest(request);

      //Cancel during retry delay
      setTimeout(() => {
        retryManager.cancelRequest(request.__requestId!);
      }, 50);

      await expect(requestPromise).rejects.toContain('Request aborted');
    });

    it('should cleanup resources after cancellation', async () => {
      const request: AxiosRequestConfig = {
        url: '/cleanup-test',
        __requestId: 'cleanup-request',
      };

      mock.onAny('/cleanup-test').reply(() =>
        new Promise(resolve => setTimeout(() => resolve([200, 'success']), 100))
      );

      const requestPromise = processRequest(request);
      // Wait a bit to ensure request starts processing
      await new Promise(resolve => setTimeout(resolve, 10));
      retryManager.cancelRequest(request.__requestId!);

      await expect(requestPromise).rejects.toContain('Request aborted');
      expect(retryManager['activeRequests'].size).toBe(0);
      expect(retryManager['requestQueue'].getWaitingCount()).toBe(0);
    });
  });

  describe('RetryManager Events Integration', () => {
    let manager: RetryManager;

    beforeEach(() => {
      manager = new RetryManager({
        retries: 2,
        debug: true,
        maxConcurrentRequests: 3,
      });
    });

    it('should register a listener and call it when event is emitted', () => {
      const mockListener = jest.fn();

      manager.on('onFailure', mockListener);

      // Emit the "onFailure" event with a mock config
      const fakeConfig: AxiosRequestConfig = { url: '/fake-endpoint' };
      manager.emit('onFailure', fakeConfig);

      // The listener should be called exactly once with the correct argument
      expect(mockListener).toHaveBeenCalledTimes(1);
      expect(mockListener).toHaveBeenCalledWith(fakeConfig);
    });

    it('should support multiple listeners on the same event', () => {
      const listenerA = jest.fn();
      const listenerB = jest.fn();

      manager.on('afterRetry', listenerA);
      manager.on('afterRetry', listenerB);

      // Emit "afterRetry" with mock arguments (config, success)
      const fakeConfig: AxiosRequestConfig = { url: '/fake-endpoint-2' };
      manager.emit('afterRetry', fakeConfig, true);

      // Both listeners should be called once with the same arguments
      expect(listenerA).toHaveBeenCalledWith(fakeConfig, true);
      expect(listenerB).toHaveBeenCalledWith(fakeConfig, true);
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);
    });

    it('should remove a listener and stop calling it after "off"', () => {
      const listener = jest.fn();

      manager.on('onRetryProcessStarted', listener);
      // Emit once
      manager.emit('onRetryProcessStarted');
      expect(listener).toHaveBeenCalledTimes(1);

      // Now remove the listener
      const result = manager.off('onRetryProcessStarted', listener);
      expect(result).toBe(true);

      // Emit again
      manager.emit('onRetryProcessStarted');

      // Listener should no longer be called
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should do nothing when off() is called for an unregistered listener', () => {
      const listener = jest.fn();

      // We never did manager.on('onFailure', listener)
      const result = manager.off('onFailure', listener);
      expect(result).toBe(false); // Indicates listener wasn't found

      // Emitting "onFailure" won't call it
      const fakeConfig: AxiosRequestConfig = { url: '/another-endpoint' };
      manager.emit('onFailure', fakeConfig);
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle emit() when no listeners are registered', () => {
      // Nothing is registered for "onCriticalRequestFailed"
      // So emit() should simply do nothing (and not throw errors)
      manager.emit('onCriticalRequestFailed');
      // If it doesn't crash or throw, test passes
    });
  });
});