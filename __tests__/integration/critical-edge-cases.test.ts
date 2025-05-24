import axios, { AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { createRetryer, RetryManager, QueueFullError, RETRY_MODES } from '../../src';

describe('Critical Edge Cases & Error Scenarios', () => {
  let axiosInstance: AxiosInstance;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({ timeout: 5000 });
    mock = new AxiosMockAdapter(axiosInstance, { delayResponse: 0 });
  });

  afterEach(() => {
    mock.reset();
  });

  describe('Queue Overflow Edge Cases', () => {
    it('should handle QueueFullError properly', async () => {
      const retryer = createRetryer({
        axiosInstance,
        maxConcurrentRequests: 1,
        maxQueueSize: 1,
        retries: 0
      });

      // First request will be processed immediately
      mock.onGet('/test1').reply(() => 
        new Promise(resolve => setTimeout(() => resolve([200, 'OK']), 100))
      );
      mock.onGet('/test2').reply(200, 'OK');
      mock.onGet('/test3').reply(200, 'OK');

      // Start first request (will be processing)
      const promise1 = retryer.axiosInstance.get('/test1');

      // Wait for first request to start processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second request (will be queued)
      const promise2 = retryer.axiosInstance.get('/test2').catch(e => e);

      // Third request should throw QueueFullError
      try {
        await retryer.axiosInstance.get('/test3');
        fail('Should have thrown QueueFullError');
      } catch (error: any) {
        expect(error.name).toBe('QueueFullError');
        expect(error.message).toContain('queue is full');
      }

      // Clean up
      await promise1;
      await promise2;
    });
  });

  describe('Network Error Scenarios', () => {
    it('should handle network errors gracefully', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2,
        throwErrorOnFailedRetries: false
      });

      mock.onGet('/network-error').networkError();

      const response = await retryer.axiosInstance.get('/network-error');
      expect(response).toBeNull();

      const metrics = retryer.getMetrics();
      expect(metrics.errorTypesDistribution.network).toBeGreaterThan(0);
    });

    it('should handle timeout errors', async () => {
      const shortTimeoutAxios = axios.create({ timeout: 50 });
      const retryer = createRetryer({
        axiosInstance: shortTimeoutAxios,
        retries: 1,
        throwErrorOnFailedRetries: false
      });

      const timeoutMock = new AxiosMockAdapter(shortTimeoutAxios);
      timeoutMock.onGet('/timeout').timeout();

      const response = await retryer.axiosInstance.get('/timeout');
      expect(response).toBeNull();

      timeoutMock.restore();
    });
  });

  describe('HTTP Error Code Coverage', () => {
    it('should handle 4xx client errors correctly', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 1,
        throwErrorOnFailedRetries: false
      });

      const clientErrors = [400, 401, 403, 404, 429];
      
      for (const status of clientErrors) {
        mock.onGet(`/client-${status}`).reply(status, { error: `Error ${status}` });
        
        const response = await retryer.axiosInstance.get(`/client-${status}`);
        expect(response).toBeNull();
      }

      const metrics = retryer.getMetrics();
      expect(metrics.errorTypesDistribution.client4xx).toBeGreaterThan(0);
    });

    it('should handle 5xx server errors correctly', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 1,
        throwErrorOnFailedRetries: false
      });

      const serverErrors = [500, 502, 503, 504];
      
      for (const status of serverErrors) {
        mock.onGet(`/server-${status}`).reply(status, { error: `Error ${status}` });
        
        const response = await retryer.axiosInstance.get(`/server-${status}`);
        expect(response).toBeNull();
      }

      const metrics = retryer.getMetrics();
      expect(metrics.errorTypesDistribution.server5xx).toBeGreaterThan(0);
    });
  });

  describe('Plugin Error Handling', () => {
    it('should handle plugin version validation errors', () => {
      const retryer = createRetryer({ axiosInstance });

      const invalidPlugin = {
        name: 'InvalidPlugin',
        version: 'invalid-version-format',
        initialize: jest.fn()
      };

      expect(() => {
        retryer.use(invalidPlugin);
      }).toThrow('Invalid plugin version format');
    });

    it('should handle plugin hook errors gracefully', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 1
      });

      const errorPlugin = {
        name: 'ErrorPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        hooks: {
          beforeRetry: () => {
            throw new Error('Plugin error');
          }
        }
      };

      retryer.use(errorPlugin);

      mock.onGet('/plugin-error').replyOnce(500, 'Error').onGet('/plugin-error').reply(200, 'Success');

      // Should complete despite plugin errors
      const response = await retryer.axiosInstance.get('/plugin-error');
      expect(response.status).toBe(200);
    });

    it('should prevent duplicate plugin registration', () => {
      const retryer = createRetryer({ axiosInstance });

      const plugin = {
        name: 'DuplicatePlugin',
        version: '1.0.0',
        initialize: jest.fn()
      };

      retryer.use(plugin);

      expect(() => {
        retryer.use(plugin);
      }).toThrow('Plugin "DuplicatePlugin" is already registered');
    });
  });

  describe('Configuration Validation', () => {
    it('should validate negative retry counts', () => {
      expect(() => {
        createRetryer({ retries: -1 });
      }).toThrow();
    });

    it('should validate zero concurrent requests', () => {
      expect(() => {
        createRetryer({ maxConcurrentRequests: 0 });
      }).toThrow();
    });

    it('should handle invalid priority values', async () => {
      const retryer = createRetryer({ axiosInstance });

      mock.onGet('/invalid-priority').reply(200, { success: true });

      // Should handle null/undefined priorities gracefully
      const response = await retryer.axiosInstance.get('/invalid-priority', {
        __priority: null as any
      });
      expect(response.status).toBe(200);
    });
  });

  describe('Resource Management', () => {
    it('should handle destroy cleanup properly', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2
      });

      mock.onGet('/cleanup-test').reply(200, { success: true });

      await retryer.axiosInstance.get('/cleanup-test');

      // Should not throw on destroy
      expect(() => {
        retryer.destroy();
      }).not.toThrow();

      const finalStats = retryer.getTimerStats();
      expect(finalStats.activeTimers).toBe(0);
      expect(finalStats.activeRetryTimers).toBe(0);
    });

    it('should handle plugin cleanup during destroy', () => {
      const retryer = createRetryer({ axiosInstance });

      const cleanupSpy = jest.fn();
      const plugin = {
        name: 'CleanupPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        onBeforeDestroyed: cleanupSpy
      };

      retryer.use(plugin);
      retryer.destroy();

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('Manual Mode Edge Cases', () => {
    it('should handle manual mode with no failures', async () => {
      const retryer = createRetryer({
        axiosInstance,
        mode: RETRY_MODES.MANUAL,
        retries: 2
      });

      mock.onGet('/success').reply(200, { success: true });

      await retryer.axiosInstance.get('/success');

      const results = await retryer.retryFailedRequests();
      expect(results).toHaveLength(0);
    });

    it('should handle manual retry of failed requests', async () => {
      const retryer = createRetryer({
        axiosInstance,
        mode: RETRY_MODES.MANUAL,
        retries: 1,
        throwErrorOnFailedRetries: false
      });

      let callCount = 0;
      mock.onGet('/manual-retry').reply(() => {
        callCount++;
        if (callCount === 1) {
          return [500, 'Error'];
        }
        return [200, { success: true }];
      });

      // First request fails
      await retryer.axiosInstance.get('/manual-retry');

      // Manual retry should succeed
      const results = await retryer.retryFailedRequests();
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(200);
    });
  });

  describe('Extreme Configurations', () => {
    it('should handle zero retries', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 0,
        throwErrorOnFailedRetries: false
      });

      mock.onGet('/no-retries').reply(500, 'Error');

      const response = await retryer.axiosInstance.get('/no-retries');
      expect(response).toBeNull();
    });

    it('should handle single concurrent request', async () => {
      const retryer = createRetryer({
        axiosInstance,
        maxConcurrentRequests: 1,
        queueDelay: 10
      });

      const results: string[] = [];

      mock.onGet('/sequential').reply(() => {
        results.push('completed');
        return [200, { success: true }];
      });

      // Multiple requests should be processed sequentially
      const promises = [
        retryer.axiosInstance.get('/sequential'),
        retryer.axiosInstance.get('/sequential'),
        retryer.axiosInstance.get('/sequential')
      ];

      await Promise.all(promises);
      expect(results).toHaveLength(3);
    });
  });

  describe('Interceptor Conflicts', () => {
    it('should handle existing request interceptors', async () => {
      const retryer = createRetryer({ axiosInstance });

      // Add external interceptor
      const interceptorId = axiosInstance.interceptors.request.use(config => {
        config.headers = config.headers || {};
        (config.headers as any)['X-Test-Header'] = 'test-value';
        return config;
      });

      mock.onGet('/interceptor-test').reply(config => {
        expect((config.headers as any)['X-Test-Header']).toBe('test-value');
        return [200, { success: true }];
      });

      const response = await retryer.axiosInstance.get('/interceptor-test');
      expect(response.status).toBe(200);

      // Cleanup
      axiosInstance.interceptors.request.eject(interceptorId);
    });

    it('should handle existing response interceptors', async () => {
      const retryer = createRetryer({ axiosInstance });

      // Add external response interceptor
      const interceptorId = axiosInstance.interceptors.response.use(response => {
        response.data.modified = true;
        return response;
      });

      mock.onGet('/response-interceptor').reply(200, { original: true });

      const response = await retryer.axiosInstance.get('/response-interceptor');
      expect(response.data.modified).toBe(true);
      expect(response.data.original).toBe(true);

      // Cleanup
      axiosInstance.interceptors.response.eject(interceptorId);
    });
  });

  describe('Metrics Edge Cases', () => {
    it('should track timer health correctly', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 1
      });

      mock.onGet('/timer-health').reply(200, { success: true });

      const initialMetrics = retryer.getMetrics();
      expect(initialMetrics.timerHealth.healthScore).toBe(0);

      await retryer.axiosInstance.get('/timer-health');

      const finalMetrics = retryer.getMetrics();
      expect(finalMetrics.timerHealth.healthScore).toBe(0);
      expect(finalMetrics.totalRequests).toBe(1);
    });

    it('should calculate priority metrics', async () => {
      const retryer = createRetryer({ axiosInstance });

      mock.onGet('/high-priority').reply(200, { success: true });
      mock.onGet('/low-priority').reply(200, { success: true });

      await retryer.axiosInstance.get('/high-priority', { __priority: 0 });
      await retryer.axiosInstance.get('/low-priority', { __priority: 10 as any });

      const metrics = retryer.getMetrics();
      expect(metrics.requestCountsByPriority[0]).toBe(1);
      expect(metrics.requestCountsByPriority[10]).toBe(1);
    });
  });

  describe('Data Handling Edge Cases', () => {
    it('should handle large response data', async () => {
      const retryer = createRetryer({ axiosInstance });

      const largeData = 'x'.repeat(100000); // 100KB
      mock.onGet('/large-data').reply(200, { data: largeData });

      const response = await retryer.axiosInstance.get('/large-data');
      expect(response.status).toBe(200);
      expect(response.data.data.length).toBe(100000);
    });

    it('should handle empty responses', async () => {
      const retryer = createRetryer({ axiosInstance });

      mock.onGet('/empty').reply(200);

      const response = await retryer.axiosInstance.get('/empty');
      expect(response.status).toBe(200);
    });

    it('should handle malformed JSON gracefully', async () => {
      const retryer = createRetryer({ axiosInstance });

      // Return malformed JSON as string
      mock.onGet('/malformed').reply(200, 'invalid json {[');

      const response = await retryer.axiosInstance.get('/malformed');
      expect(response.status).toBe(200);
      expect(typeof response.data).toBe('string');
    });
  });

  describe('Cancellation Edge Cases', () => {
    it('should handle request cancellation properly', async () => {
      const retryer = createRetryer({
        axiosInstance,
        retries: 2
      });

      mock.onGet('/cancel-test').reply(() => 
        new Promise(resolve => setTimeout(() => resolve([200, 'OK']), 200))
      );

      const requestPromise = retryer.axiosInstance.get('/cancel-test').catch(() => ({ cancelled: true }));

      // Cancel after a short delay
      setTimeout(() => retryer.cancelAllRequests(), 50);

      const result = await requestPromise;
      expect((result as any).cancelled).toBe(true);

      const finalStats = retryer.getTimerStats();
      expect(finalStats.activeRetryTimers).toBe(0);
    });
  });
}); 