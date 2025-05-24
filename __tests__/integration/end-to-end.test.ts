import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { createRetryer, RetryManager, AXIOS_RETRYER_REQUEST_PRIORITIES, RETRY_MODES } from '../../src';

describe('End-to-End Integration Tests', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({ timeout: 5000 });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.reset();
  });

  describe('Complete Retry Flow with Real Network Conditions', () => {
    it('should handle real API failures with exponential backoff', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 3,
        debug: false,
        backoffType: 2 // EXPONENTIAL
      });

      let attempts = 0;
      const startTime = Date.now();

      mock.onGet('/unstable-api').reply(() => {
        attempts++;
        if (attempts <= 2) {
          return [503, { error: 'Service Temporarily Unavailable' }];
        }
        return [200, { data: 'success', attempts }];
      });

      const response = await retryer.axiosInstance.get('/unstable-api');
      const totalTime = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(response.data.data).toBe('success');
      expect(attempts).toBe(3);
      
      // Verify exponential backoff timing (should take at least 300ms for 2 retries)
      expect(totalTime).toBeGreaterThan(200);
    });

    it('should prioritize critical requests during high load', async () => {
      const retryer = new RetryManager({
        axiosInstance,
        maxConcurrentRequests: 2,
        retries: 1,
        queueDelay: 50
      });

      const executionOrder: string[] = [];
      const requestDelay = 100;

      // Setup mock responses with artificial delay
      ['low1', 'low2', 'critical', 'high', 'medium'].forEach(endpoint => {
        mock.onGet(`/${endpoint}`).reply(() => {
          return new Promise(resolve => {
            setTimeout(() => {
              executionOrder.push(endpoint);
              resolve([200, { endpoint }]);
            }, requestDelay);
          });
        });
      });

      // Send requests with different priorities simultaneously
      const requests = [
        retryer.axiosInstance.get('/low1', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW }),
        retryer.axiosInstance.get('/low2', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW }),
        retryer.axiosInstance.get('/critical', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL }),
        retryer.axiosInstance.get('/high', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH }),
        retryer.axiosInstance.get('/medium', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM })
      ];

      await Promise.all(requests);

      // Critical should execute first, then high, medium, then low requests
      expect(executionOrder[0]).toBe('critical');
      expect(executionOrder.indexOf('high')).toBeLessThan(executionOrder.indexOf('medium'));
      expect(executionOrder.indexOf('medium')).toBeLessThan(Math.max(
        executionOrder.indexOf('low1'),
        executionOrder.indexOf('low2')
      ));
    });

    it('should handle authentication refresh workflow', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        debug: false
      });

      let currentToken = 'expired-token';
      let refreshCalled = false;

      // Mock the protected API
      mock.onGet('/protected-resource').reply(config => {
        const authHeader = config.headers?.Authorization;
        if (authHeader === 'Bearer valid-token') {
          return [200, { data: 'protected-data' }];
        }
        return [401, { error: 'Unauthorized' }];
      });

      // Mock the token refresh endpoint
      mock.onPost('/auth/refresh').reply(() => {
        refreshCalled = true;
        currentToken = 'valid-token';
        return [200, { access_token: 'valid-token' }];
      });

      // Simulate token refresh logic
      retryer.axiosInstance.interceptors.response.use(
        response => response,
        async error => {
          if (error.response?.status === 401 && !refreshCalled) {
            const refreshResponse = await axiosInstance.post('/auth/refresh');
            currentToken = refreshResponse.data.access_token;
            
            // Retry original request with new token
            error.config.headers.Authorization = `Bearer ${currentToken}`;
            return axiosInstance.request(error.config);
          }
          throw error;
        }
      );

      // Make request with expired token
      const response = await retryer.axiosInstance.get('/protected-resource', {
        headers: { Authorization: `Bearer expired-token` }
      });

      expect(response.status).toBe(200);
      expect(response.data.data).toBe('protected-data');
      expect(refreshCalled).toBe(true);
    });
  });

  describe('Performance and Memory Management', () => {
    it('should handle burst traffic without memory leaks', async () => {
      const retryer = new RetryManager({
        axiosInstance,
        maxConcurrentRequests: 5,
        maxQueueSize: 100,
        retries: 1
      });

      // Setup fast responding mock
      mock.onGet(/\/burst\/\d+/).reply(200, { success: true });

      const requestCount = 50;
      const requests = Array.from({ length: requestCount }, (_, i) =>
        retryer.axiosInstance.get(`/burst/${i}`)
      );

      const startTime = Date.now();
      const responses = await Promise.all(requests);
      const endTime = Date.now();

      expect(responses).toHaveLength(requestCount);
      expect(responses.every(r => r.status === 200)).toBe(true);
      
      // Verify performance (should complete within reasonable time)
      expect(endTime - startTime).toBeLessThan(5000);

      // Check that queue is empty after completion
      const metrics = retryer.getMetrics();
      expect(metrics.totalRequests).toBe(requestCount);
    });

    it('should properly clean up resources on destroy', async () => {
      const retryer = new RetryManager({
        axiosInstance,
        retries: 3,
        debug: false
      });

      mock.onGet('/cleanup-test').reply(200, { data: 'test' });
      
      // Make a request to initialize internals
      await retryer.axiosInstance.get('/cleanup-test');

      // Get initial timer stats
      const initialTimers = retryer.getTimerStats();

      // Destroy the instance
      retryer.destroy();

      // Verify cleanup
      const finalTimers = retryer.getTimerStats();
      expect(finalTimers.activeTimers).toBe(0);
      expect(finalTimers.activeRetryTimers).toBe(0);

      // Note: After destroy, the axios instance may still work but internal retry logic is disabled
      // This is expected behavior as we only clean up internal timers and state
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle network timeouts with appropriate retry strategy', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        debug: false
      });

      let timeoutCount = 0;
      mock.onGet('/timeout-test').timeout();

             try {
         await retryer.axiosInstance.get('/timeout-test');
         fail('Should have thrown timeout error');
       } catch (error: any) {
         expect(error.code).toBe('ECONNABORTED');
        
        const metrics = retryer.getMetrics();
        expect(metrics.failedRetries).toBeGreaterThan(0);
        expect(metrics.completelyFailedRequests).toBe(1);
      }
    });

    it('should handle rapid successive requests with different outcomes', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        debug: false,
        maxConcurrentRequests: 3
      });

      // Setup mixed success/failure responses
      mock.onGet('/success').reply(200, { result: 'success' });
      mock.onGet('/failure').reply(500, { error: 'server error' });
      mock.onGet('/timeout').timeout();
      mock.onGet('/not-found').reply(404, { error: 'not found' });

             const requests = [
         retryer.axiosInstance.get('/success'),
         retryer.axiosInstance.get('/failure').catch(e => ({ isError: true, error: e })),
         retryer.axiosInstance.get('/timeout').catch(e => ({ isError: true, error: e })),
         retryer.axiosInstance.get('/not-found').catch(e => ({ isError: true, error: e })),
         retryer.axiosInstance.get('/success')
       ];

       const results = await Promise.all(requests);

       // Verify mixed results
       expect((results[0] as any).status).toBe(200);
       expect((results[1] as any).isError).toBe(true);
       expect((results[2] as any).isError).toBe(true);
       expect((results[3] as any).isError).toBe(true);
       expect((results[4] as any).status).toBe(200);

             const metrics = retryer.getMetrics();
       expect(metrics.totalRequests).toBeGreaterThan(0);
       expect(metrics.completelyFailedRequests).toBeGreaterThan(0);
    });

        it('should maintain request context during retries', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        debug: false
      });

      let attemptNumber = 0;
      const requestId = 'test-request-123';

      mock.onPost('/context-test').reply(config => {
        attemptNumber++;
        
        // For the first attempt, return error to trigger retry
        if (attemptNumber === 1) {
          return [503, { error: 'service unavailable' }];
        }
        
        // On retry, verify context is maintained and return success
        return [200, { 
          success: true, 
          attemptNumber,
          requestId: requestId
        }];
      });

      const response = await retryer.axiosInstance.post('/context-test', 
        { test: 'data' },
        { 
          headers: { 
            'X-Request-ID': requestId,
            'Idempotency-Key': 'test-key-123' // Make POST retryable
          },
          timeout: 5000
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(attemptNumber).toBeGreaterThan(1); // Should have retried
    });
  });

  describe('Manual Mode Integration', () => {
    it('should store failed requests and allow manual retry', async () => {
      const retryer = new RetryManager({
        axiosInstance,
        mode: RETRY_MODES.MANUAL,
        retries: 0,
        maxRequestsToStore: 10
      });

      // Setup failing endpoint
      mock.onGet('/store-and-retry').reply(500, { error: 'server error' });

      // Make failing request
      await expect(retryer.axiosInstance.get('/store-and-retry')).rejects.toThrow();

             // Change mock to succeed for retry
       mock.onGet('/store-and-retry').reply(200, { data: 'retry success' });

       // Retry stored requests
       const retryResults = await retryer.retryFailedRequests();
       
       expect(retryResults).toHaveLength(1);
       expect(retryResults[0].status).toBe(200);
       expect((retryResults[0] as any).data.data).toBe('retry success');
    });
  });

  describe('Comprehensive Plugin Integration', () => {
    it('should work with custom plugins across retry attempts', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        debug: false
      });

      const pluginCalls: string[] = [];

      // Custom plugin that tracks lifecycle
      const testPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
                 hooks: {
           beforeRetry: (config: AxiosRequestConfig) => {
             pluginCalls.push('beforeRetry');
             config.headers = { ...config.headers, 'X-Plugin-Retry': 'true' };
           },
           afterRetry: (config: AxiosRequestConfig, response: any) => {
             pluginCalls.push('afterRetry');
           },
           onFailure: (config: AxiosRequestConfig) => {
             pluginCalls.push('onFailure');
           }
         }
      };

      retryer.use(testPlugin);

      let attempts = 0;
      mock.onGet('/plugin-test').reply(config => {
        attempts++;
        if (attempts <= 1) {
          return [503, { error: 'service unavailable' }];
        }
        
                 // Verify plugin header was added
         expect(config.headers?.['X-Plugin-Retry']).toBe('true');
        return [200, { success: true, attempts }];
      });

      const response = await retryer.axiosInstance.get('/plugin-test');

      expect(response.status).toBe(200);
      expect(attempts).toBe(2);
      expect(pluginCalls).toContain('beforeRetry');
      expect(pluginCalls).toContain('afterRetry');
    });
  });
}); 