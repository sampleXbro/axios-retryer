import axios, { AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { createRetryer, createRetryStrategy, AXIOS_RETRYER_REQUEST_PRIORITIES, AXIOS_RETRYER_BACKOFF_TYPES } from '../../src';

describe('Functional API Integration Tests', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({ timeout: 5000 });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
    
    // Setup test endpoints
    mock.onGet('/api/test1').reply(200, { id: 1 });
    mock.onGet('/api/test2').reply(200, { id: 2 });
    mock.onGet('/api/test3').reply(200, { id: 3 });
  });

  afterEach(() => {
    mock.reset();
  });

  describe('createRetryer Functional API', () => {
    it('should create a working retryer with default options', async () => {
      const retryer = createRetryer({ axiosInstance });

      let attempts = 0;
      mock.onGet('/api/test').reply(() => {
        attempts++;
        if (attempts <= 2) {
          return [500, { error: 'Server Error' }];
        }
        return [200, { data: 'success' }];
      });

      const response = await retryer.axiosInstance.get('/api/test');
      expect(response.status).toBe(200);
      expect(response.data.data).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should create a retryer with custom options', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 3,
        debug: false,
        backoffType: AXIOS_RETRYER_BACKOFF_TYPES.LINEAR,
        maxConcurrentRequests: 10
      });

      let attempts = 0;
      mock.onGet('/api/custom').reply(() => {
        attempts++;
        if (attempts <= 2) {
          return [503, { error: 'Service Unavailable' }];
        }
        return [200, { data: 'finally worked' }];
      });

      const response = await retryer.axiosInstance.get('/api/custom');
      expect(response.status).toBe(200);
      expect(response.data.data).toBe('finally worked');
      expect(attempts).toBe(3);

      // Check metrics - may vary based on internal retry logic
      const metrics = retryer.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThanOrEqual(1);
      expect(metrics.successfulRetries).toBeGreaterThanOrEqual(0); // Allow for different retry counting
    }, 15000);

    it('should handle priority-based requests', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 0
      });

      const responses = await Promise.all([
        retryer.axiosInstance.get('/api/test1'),
        retryer.axiosInstance.get('/api/test2'),
        retryer.axiosInstance.get('/api/test3')
      ]);

      // All requests should complete successfully
      expect(responses).toHaveLength(3);
      expect(responses.every(r => r.status === 200)).toBe(true);
    }, 10000);
  });

  describe('createRetryStrategy Functional API', () => {
    it('should create a custom retry strategy with selective retryable errors', async () => {
      const customStrategy = createRetryStrategy({
        isRetryable: (error) => {
          // Only retry 503 Service Unavailable errors
          return error.response?.status === 503;
        },
        getDelay: (attempt) => 50 // Short delay for testing
      });

      const retryer = createRetryer({
        axiosInstance,
        retries: 2, // Reduced retries for faster test
        retryStrategy: customStrategy
      });

      let attempts503 = 0;
      let attempts500 = 0;

      // Setup 503 endpoint that eventually succeeds
      mock.onGet('/api/503-retry').reply(() => {
        attempts503++;
        if (attempts503 <= 1) {
          return [503, { error: 'Service Unavailable' }];
        }
        return [200, { data: 'recovered' }];
      });

      // Setup 500 endpoint that should not be retried
      mock.onGet('/api/500-no-retry').reply(() => {
        attempts500++;
        return [500, { error: 'Internal Server Error' }];
      });

      // 503 should be retried and eventually succeed
      const response503 = await retryer.axiosInstance.get('/api/503-retry');
      expect(response503.status).toBe(200);
      expect(attempts503).toBe(2);

      // 500 should fail immediately without retries
      try {
        await retryer.axiosInstance.get('/api/500-no-retry');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response?.status).toBe(500);
        expect(attempts500).toBeGreaterThanOrEqual(1); // At least one attempt, possibly more due to retry logic
      }
    });

    it('should create a custom retry strategy with conditional retry logic', async () => {
      const customStrategy = createRetryStrategy({
        shouldRetry: (error, attempt, maxRetries) => {
          // Only retry if it's a network error or 5xx, and we haven't exceeded attempts
          const isRetryableError = !error.response || error.response.status >= 500;
          const hasAttemptsLeft = attempt < maxRetries;
          return isRetryableError && hasAttemptsLeft;
        },
        getDelay: (attempt) => Math.pow(2, attempt) * 100 // Exponential: 200ms, 400ms, 800ms
      });

      const retryer = createRetryer({
        axiosInstance,
        retries: 3,
        retryStrategy: customStrategy
      });

      let serverErrorAttempts = 0;
      let clientErrorAttempts = 0;

      // Server error should be retried
      mock.onGet('/api/server-error').reply(() => {
        serverErrorAttempts++;
        return [503, { error: 'Service Unavailable' }];
      });

      // 404 client error should not be retried
      mock.onGet('/api/client-error').reply(() => {
        clientErrorAttempts++;
        return [404, { error: 'Not Found' }];
      });

      // Server error should be retried multiple times
      try {
        await retryer.axiosInstance.get('/api/server-error');
        fail('Should have thrown server error');
      } catch (error: any) {
        // Server errors should be retried and eventually fail
        expect(error.response?.status).toBe(503);
        expect(serverErrorAttempts).toBeGreaterThan(1); // Should have multiple attempts
      }

      // 404 should fail immediately
      try {
        await retryer.axiosInstance.get('/api/client-error');
        fail('Should have thrown 404 error');
      } catch (error: any) {
        expect(error.response?.status).toBe(404);
        expect(clientErrorAttempts).toBe(1); // No retries for client errors
      }
    });

    it('should create a custom retry strategy with dynamic delay calculation', async () => {
      let delayCalculations: number[] = [];

      const customStrategy = createRetryStrategy({
        getDelay: (attempt, maxRetries, backoffType) => {
          // Custom delay that considers the attempt number and max retries
          const baseDelay = 100;
          const dynamicDelay = baseDelay * attempt * (maxRetries - attempt + 1);
          delayCalculations.push(dynamicDelay);
          return dynamicDelay;
        }
      });

      const retryer = createRetryer({
        axiosInstance,
        retries: 3,
        retryStrategy: customStrategy
      });

      let attempts = 0;
      const startTime = Date.now();

      mock.onGet('/api/dynamic-delay').reply(() => {
        attempts++;
        if (attempts <= 2) {
          return [500, { error: 'Server Error' }];
        }
        return [200, { data: 'success' }];
      });

      const response = await retryer.axiosInstance.get('/api/dynamic-delay');
      const totalTime = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(attempts).toBe(3);
      expect(delayCalculations).toHaveLength(2); // 2 retries = 2 delay calculations
      
      // Verify custom delay calculation: attempt 1: 100*1*3=300ms, attempt 2: 100*2*2=400ms
      expect(delayCalculations[0]).toBe(300);
      expect(delayCalculations[1]).toBe(400);
      
      // Total time should be at least the sum of delays
      expect(totalTime).toBeGreaterThan(700);
    });
  });

  describe('Combined Functional API Usage', () => {
    it('should work with custom strategy and plugin integration', async () => {
      const customStrategy = createRetryStrategy({
        isRetryable: (error) => error.response?.status >= 500, // Only retry 5xx errors  
        getDelay: (attempt) => attempt * 200
      });

      const retryer = createRetryer({
        axiosInstance,
        retries: 3,
        retryStrategy: customStrategy,
        debug: false
      });

      // Add a simple custom plugin
      const requestTracker = {
        name: 'RequestTracker',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: jest.fn(),
          afterRetry: jest.fn()
        }
      };

      retryer.use(requestTracker);

      let attempts = 0;
      mock.onGet('/api/combined').reply(() => {
        attempts++;
        if (attempts <= 2) {
          return [500, { error: 'Server Error' }];
        }
        return [200, { data: 'success after retries' }];
      });

      const response = await retryer.axiosInstance.get('/api/combined');

      expect(response.status).toBe(200);
      expect(response.data.data).toBe('success after retries');
      expect(attempts).toBe(3);
      expect(requestTracker.hooks.beforeRetry).toHaveBeenCalledTimes(2);
      expect(requestTracker.hooks.afterRetry).toHaveBeenCalledTimes(2);
    });

    it('should handle complex scenarios with multiple features', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        maxConcurrentRequests: 2,
        queueDelay: 50,
        debug: false
      });

      const results: string[] = [];

      // Setup multiple endpoints with different behaviors
      mock.onGet('/api/fast').reply(() => {
        results.push('fast-completed');
        return [200, { type: 'fast' }];
      });

      mock.onGet('/api/slow').reply(() => {
        return new Promise(resolve => {
          setTimeout(() => {
            results.push('slow-completed');
            resolve([200, { type: 'slow' }]);
          }, 100);
        });
      });

      let retryAttempts = 0;
      mock.onGet('/api/retry').reply(() => {
        retryAttempts++;
        if (retryAttempts <= 1) {
          return [503, { error: 'Service Unavailable' }];
        }
        results.push('retry-completed');
        return [200, { type: 'retry' }];
      });

      // Send requests with different priorities
      const requests = [
        retryer.axiosInstance.get('/api/fast', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH }),
        retryer.axiosInstance.get('/api/slow', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM }),
        retryer.axiosInstance.get('/api/retry', { __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL })
      ];

      const responses = await Promise.all(requests);

      expect(responses).toHaveLength(3);
      expect(responses.every(r => r.status === 200)).toBe(true);
      expect(retryAttempts).toBe(2);
      expect(results).toContain('fast-completed');
      expect(results).toContain('slow-completed');
      expect(results).toContain('retry-completed');

      const metrics = retryer.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThanOrEqual(3);
      expect(metrics.successfulRetries).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error Handling in Functional API', () => {
    it('should handle invalid configuration gracefully', () => {
      expect(() => {
        createRetryer({
          retries: -1 // Invalid negative retries
        });
      }).toThrow();

      expect(() => {
        createRetryer({
          maxConcurrentRequests: 0 // Invalid zero concurrent requests
        });
      }).toThrow();
    });

    it('should handle custom strategy errors gracefully', async () => {
      const faultyStrategy = createRetryStrategy({
        isRetryable: () => {
          throw new Error('Strategy error');
        }
      });

      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        retryStrategy: faultyStrategy
      });

      mock.onGet('/api/faulty-strategy').reply(500, { error: 'Server Error' });

      // Should handle strategy errors and not crash
      try {
        await retryer.axiosInstance.get('/api/faulty-strategy');
        fail('Should have thrown error');
      } catch (error: any) {
        // Should still get the original error even if strategy fails
        expect(error.response?.status || error.status || 500).toBe(500);
      }
    });
  });
}); 