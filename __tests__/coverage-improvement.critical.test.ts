// @ts-nocheck
import { RetryManager } from '../src/core/RetryManager';
import { QueueFullError } from '../src/core/errors/QueueFullError';
import { DefaultRetryStrategy } from '../src/core/strategies/DefaultRetryStrategy';
import { RETRY_MODES, AXIOS_RETRYER_BACKOFF_TYPES } from '../src/types';
import { AxiosError } from 'axios';
import MockAdapter from 'axios-mock-adapter';

describe('Coverage Improvement - Critical Edge Cases', () => {
  describe('QueueFullError Edge Cases', () => {
    test('should handle QueueFullError with null config', () => {
      const error = new QueueFullError(null);
      expect(error.message).toContain('Request queue is full');
      expect(error.code).toBe('EQUEUE_FULL');
      expect(error.name).toBe('QueueFullError');
    });

    test('should handle QueueFullError with undefined config', () => {
      const error = new QueueFullError(undefined);
      expect(error.message).toContain('Request queue is full');
      expect(error.code).toBe('EQUEUE_FULL');
      expect(error.name).toBe('QueueFullError');
    });

    test('should handle QueueFullError inheritance properly', () => {
      const config = { url: '/test', method: 'get' };
      const error = new QueueFullError(config);
      
      expect(error instanceof QueueFullError).toBe(true);
      expect(error instanceof AxiosError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('DefaultRetryStrategy Uncovered Branches', () => {
    test('should handle network errors without response', () => {
      const strategy = new DefaultRetryStrategy();
      const networkError = new AxiosError('Network Error', 'ECONNREFUSED', { url: '/test' });
      // No response property
      
      expect(strategy.getIsRetryable(networkError)).toBe(true);
    });

    test('should handle POST with idempotency headers', () => {
      const strategy = new DefaultRetryStrategy(
        undefined, // default statuses
        undefined, // default methods
        AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
        ['Idempotency-Key'] // custom idempotency headers
      );

      const config = {
        method: 'post',
        url: '/test',
        headers: { 'Idempotency-Key': 'unique-123' }
      };

      const error = new AxiosError('Bad Request', '400', config, null, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: config,
        data: {}
      });

      expect(strategy.getIsRetryable(error)).toBe(true);
    });

    test('should handle PUT with idempotency headers', () => {
      const strategy = new DefaultRetryStrategy();
      const config = {
        method: 'put',
        url: '/test',
        headers: { 'Idempotency-Key': 'unique-456' }
      };

      const error = new AxiosError('Conflict', '409', config, null, {
        status: 409,
        statusText: 'Conflict',
        headers: {},
        config: config,
        data: {}
      });

      expect(strategy.getIsRetryable(error)).toBe(true);
    });

    test('should handle PATCH with idempotency headers', () => {
      const strategy = new DefaultRetryStrategy();
      const config = {
        method: 'patch',
        url: '/test',
        headers: { 'Idempotency-Key': 'unique-789' }
      };

      const error = new AxiosError('Server Error', '500', config, null, {
        status: 500,
        statusText: 'Server Error',
        headers: {},
        config: config,
        data: {}
      });

      expect(strategy.getIsRetryable(error)).toBe(true);
    });

    test('should handle custom retryable statuses via config override', () => {
      const strategy = new DefaultRetryStrategy();
      const config = {
        method: 'get',
        url: '/test',
        __retryableStatuses: [400, [420, 430]]
      };

      // Test individual status
      const error400 = new AxiosError('Bad Request', '400', config, null, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: config,
        data: {}
      });

      expect(strategy.getIsRetryable(error400)).toBe(true);

      // Test status in range
      const error425 = new AxiosError('Too Early', '425', config, null, {
        status: 425,
        statusText: 'Too Early',
        headers: {},
        config: config,
        data: {}
      });

      expect(strategy.getIsRetryable(error425)).toBe(true);
    });

    test('should respect maxRetries in shouldRetry', () => {
      const strategy = new DefaultRetryStrategy();
      const config = { method: 'get', url: '/test' };
      const error = new AxiosError('Server Error', '500', config, null, {
        status: 500,
        statusText: 'Server Error',
        headers: {},
        config: config,
        data: {}
      });

      // Should retry when within limit
      expect(strategy.shouldRetry(error, 2, 3)).toBe(true);
      
      // Should not retry when exceeding limit
      expect(strategy.shouldRetry(error, 4, 3)).toBe(false);
    });

    test('should use backoff type override in getDelay', () => {
      const strategy = new DefaultRetryStrategy();
      
      const delay = strategy.getDelay(2, 5, AXIOS_RETRYER_BACKOFF_TYPES.STATIC);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
    });
  });

  describe('RetryManager Uncovered Lines', () => {
    let retryManager: RetryManager;
    let mockAdapter: MockAdapter;

    beforeEach(() => {
      retryManager = new RetryManager({
        retries: 3,
        mode: RETRY_MODES.AUTOMATIC,
        debug: false
      });
      mockAdapter = new MockAdapter(retryManager.axiosInstance);
    });

    afterEach(() => {
      mockAdapter.restore();
      retryManager.destroy();
    });

    test('should handle timer stats access', () => {
      const stats = retryManager.getTimerStats();
      expect(stats).toHaveProperty('activeTimers');
      expect(stats).toHaveProperty('activeRetryTimers');
      expect(typeof stats.activeTimers).toBe('number');
      expect(typeof stats.activeRetryTimers).toBe('number');
    });

    test('should handle getLogger method', () => {
      const logger = retryManager.getLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe('function');
    });

    test('should handle triggerAndEmit method', () => {
      const events = [];
      retryManager.on('onMetricsUpdated', (metrics) => {
        events.push('metrics-updated');
      });

      // Trigger event manually
      retryManager.triggerAndEmit('onMetricsUpdated', retryManager.getMetrics());
      expect(events).toContain('metrics-updated');
    });

    test('should handle destroy method multiple times', () => {
      expect(() => {
        retryManager.destroy();
        retryManager.destroy(); // Should not throw on second call
      }).not.toThrow();
    });

    test('should handle cancelRequest for non-existent request', () => {
      expect(() => {
        retryManager.cancelRequest('non-existent-id');
      }).not.toThrow();
    });

    test('should handle manual retry process in manual mode', async () => {
      const manualManager = new RetryManager({
        retries: 2,
        mode: RETRY_MODES.MANUAL,
        debug: false
      });
      const manualMockAdapter = new MockAdapter(manualManager.axiosInstance);

      try {
        // Setup failing request
        manualMockAdapter.onGet('/api/data').reply(500, { error: 'Server Error' });

        // First request should fail and be stored
        try {
          await manualManager.axiosInstance.get('/api/data');
        } catch (error) {
          // Expected to fail
        }

        // Setup success for retry
        manualMockAdapter.onGet('/api/data').reply(200, { data: 'success' });

        // Manual retry should work
        const results = await manualManager.retryFailedRequests();
        expect(Array.isArray(results)).toBe(true);
      } finally {
        manualMockAdapter.restore();
        manualManager.destroy();
      }
    });

    test('should handle metrics with timer health', () => {
      const metrics = retryManager.getMetrics();
      expect(metrics).toHaveProperty('timerHealth');
      expect(metrics.timerHealth).toHaveProperty('activeTimers');
      expect(metrics.timerHealth).toHaveProperty('activeRetryTimers');
      expect(metrics.timerHealth).toHaveProperty('healthScore');
    });
  });

  describe('RequestQueue Edge Cases', () => {
    test('should handle queue delay correctly', (done) => {
      const retryManager = new RetryManager({
        maxConcurrentRequests: 1,
        queueDelay: 50, // 50ms delay
        retries: 1
      });
      const mockAdapter = new MockAdapter(retryManager.axiosInstance);
      
      mockAdapter.onGet('/api/fast').reply(200, { data: 'fast' });
      mockAdapter.onGet('/api/slow').reply(200, { data: 'slow' });

      const startTime = Date.now();
      
      Promise.all([
        retryManager.axiosInstance.get('/api/fast'),
        retryManager.axiosInstance.get('/api/slow') // Should be delayed
      ]).then(() => {
        const duration = Date.now() - startTime;
        expect(duration).toBeGreaterThanOrEqual(50); // Should have some delay
        mockAdapter.restore();
        retryManager.destroy();
        done();
      }).catch(done);
    });
  });

  describe('Plugin Lifecycle Edge Cases', () => {
    test('should handle plugin listing', () => {
      const testManager = new RetryManager({ retries: 1 });
      const plugins = testManager.listPlugins();
      expect(Array.isArray(plugins)).toBe(true);
      testManager.destroy();
    });

    test('should handle plugin unregistration of non-existent plugin', () => {
      const testManager = new RetryManager({ retries: 1 });
      expect(() => {
        testManager.unuse('NonExistentPlugin');
      }).not.toThrow();
      testManager.destroy();
    });
  });

  describe('Error Type Distribution', () => {
    test('should track error types in metrics', async () => {
      const testManager = new RetryManager({ retries: 1 });
      const testMockAdapter = new MockAdapter(testManager.axiosInstance);
      
      testMockAdapter.onGet('/api/network-error').networkError();
      testMockAdapter.onGet('/api/timeout').timeout();
      testMockAdapter.onGet('/api/server-error').reply(500, { error: 'Server Error' });

      try {
        await testManager.axiosInstance.get('/api/network-error');
      } catch (error) {
        // Expected to fail
      }

      try {
        await testManager.axiosInstance.get('/api/timeout');
      } catch (error) {
        // Expected to fail
      }

      try {
        await testManager.axiosInstance.get('/api/server-error');
      } catch (error) {
        // Expected to fail
      }

      const metrics = testManager.getMetrics();
      expect(metrics.errorTypesDistribution).toBeDefined();
      
      testMockAdapter.restore();
      testManager.destroy();
    });
  });

  describe('Priority Queue Edge Cases', () => {
    test('should handle requests with same priority and timestamp', async () => {
      const testManager = new RetryManager({ retries: 1 });
      const testMockAdapter = new MockAdapter(testManager.axiosInstance);
      
      const timestamp = Date.now();
      
      // Create requests with identical priority and timestamp
      const config1 = {
        url: '/api/test1',
        __priority: 2, // HIGH priority
        __timestamp: timestamp
      };
      
      const config2 = {
        url: '/api/test2', 
        __priority: 2, // Same HIGH priority
        __timestamp: timestamp // Same timestamp
      };

      testMockAdapter.onGet('/api/test1').reply(200, { id: 1 });
      testMockAdapter.onGet('/api/test2').reply(200, { id: 2 });

      // Both should execute successfully despite identical priorities
      const [response1, response2] = await Promise.all([
        testManager.axiosInstance.get('/api/test1', config1),
        testManager.axiosInstance.get('/api/test2', config2)
      ]);

      expect(response1.data.id).toBe(1);
      expect(response2.data.id).toBe(2);
      
      testMockAdapter.restore();
      testManager.destroy();
    });
  });
}); 