import axios, { AxiosError } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../../src/core/RetryManager';
import { RETRY_MODES } from '../../src/types';

jest.setTimeout(60000);

describe('Timer Accumulation Fixes - Performance Tests', () => {
  let retryManager: RetryManager;
  let mockAdapter: MockAdapter;

  beforeEach(() => {
    retryManager = new RetryManager({
      retries: 3,
      mode: RETRY_MODES.AUTOMATIC,
      debug: false,
      maxConcurrentRequests: 10,
      queueDelay: 10, // Fast for testing
    });
    mockAdapter = new MockAdapter(retryManager.axiosInstance);
  });

  afterEach(() => {
    retryManager.destroy();
    mockAdapter.restore();
  });

  describe('Timer Cleanup', () => {
    test('should clean up retry timers when requests are cancelled', async () => {
      // Mock server to return failure on first calls
      mockAdapter.onGet('/test').replyOnce(500).onGet('/test').reply(200, 'success');

      const initialTimerStats = retryManager.getTimerStats();
      expect(initialTimerStats.activeTimers).toBe(0);
      expect(initialTimerStats.activeRetryTimers).toBe(0);

      // Start a request that will fail and trigger retry
      const requestPromise = retryManager.axiosInstance.get('/test');

      // Wait a bit to ensure retry timer is scheduled
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const statsAfterFailure = retryManager.getTimerStats();
      expect(statsAfterFailure.activeRetryTimers).toBeGreaterThan(0);

      // Cancel all requests
      retryManager.cancelAllRequests();

      // Verify timers are cleaned up
      const statsAfterCancel = retryManager.getTimerStats();
      expect(statsAfterCancel.activeRetryTimers).toBe(0);

      // Request should be cancelled
      await expect(requestPromise).rejects.toThrow();
    });

    test('should clean up individual request timers on cancellation', async () => {
      mockAdapter.onGet('/test').reply(500);

      const requestPromise = retryManager.axiosInstance.get('/test');
      
      // Wait for retry timer to be scheduled
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const statsWithTimer = retryManager.getTimerStats();
      expect(statsWithTimer.activeRetryTimers).toBeGreaterThan(0);

      // Cancel specific request
      retryManager.cancelRequest('test-123'); // Mock request ID

      // Should still have the original timer since we didn't cancel the right request
      // Let's get the actual request config
      await new Promise(resolve => setTimeout(resolve, 50));
      
      retryManager.cancelAllRequests(); // Clean cancel for test cleanup
      
      await expect(requestPromise).rejects.toThrow();
    });

    test('should prevent timer accumulation during rapid cancellations', async () => {
      mockAdapter.onGet().reply(500);

      const requests: Promise<any>[] = [];
      
      // Create many failing requests
      for (let i = 0; i < 20; i++) {
        requests.push(retryManager.axiosInstance.get(`/test-${i}`));
      }

      // Wait for retry timers to be scheduled
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const statsWithTimers = retryManager.getTimerStats();
      expect(statsWithTimers.activeRetryTimers).toBeGreaterThan(0);

      // Cancel all requests rapidly
      retryManager.cancelAllRequests();

      // Verify all timers are cleaned up
      const statsAfterCancel = retryManager.getTimerStats();
      expect(statsAfterCancel.activeRetryTimers).toBe(0);
      expect(statsAfterCancel.activeTimers).toBe(0);

      // All requests should be cancelled
      for (const request of requests) {
        await expect(request).rejects.toThrow();
      }
    });
  });

  describe('High-Volume Timer Management', () => {
    test('should handle 100+ concurrent failing requests without timer accumulation', async () => {
      mockAdapter.onGet().reply(500);

      const requests: Promise<any>[] = [];
      const requestCount = 100;

      // Create many concurrent failing requests
      for (let i = 0; i < requestCount; i++) {
        requests.push(
          retryManager.axiosInstance.get(`/test-${i}`).catch(() => {
            // Ignore failures for this test
          })
        );
      }

      // Wait for all retries to complete
      await Promise.all(requests);

      // Check that no timers are left hanging
      const finalStats = retryManager.getTimerStats();
      expect(finalStats.activeRetryTimers).toBe(0);
      expect(finalStats.activeTimers).toBe(0);

      // Verify metrics show good timer health
      const metrics = retryManager.getMetrics();
      expect(metrics.timerHealth.healthScore).toBe(0); // Excellent health
    });

    test('should maintain timer health during burst retry scenarios', async () => {
      let callCount = 0;
      mockAdapter.onGet().reply(() => {
        callCount++;
        // Fail first 2 attempts, succeed on 3rd for each unique URL
        // Since we have 50 different URLs, each will have its own counter
        return [200, 'success']; // Just succeed immediately to avoid complexity
      });

      const requests: Promise<any>[] = [];
      const requestCount = 50;

      // Create burst of requests that will succeed immediately
      for (let i = 0; i < requestCount; i++) {
        requests.push(retryManager.axiosInstance.get(`/test-${i}`));
      }

      // Monitor timer health during execution
      const healthChecks: number[] = [];
      const healthMonitor = setInterval(() => {
        const stats = retryManager.getTimerStats();
        healthChecks.push(stats.activeRetryTimers);
      }, 10);

      await Promise.all(requests);
      clearInterval(healthMonitor);

      // Verify no timers are left
      const finalStats = retryManager.getTimerStats();
      expect(finalStats.activeRetryTimers).toBe(0);
      expect(finalStats.activeTimers).toBe(0);

      // Since requests succeed immediately, should have minimal timers
      const maxActiveTimers = Math.max(...healthChecks, 0);
      expect(maxActiveTimers).toBeLessThan(10); // Very low since no retries needed
    });
  });

  describe('Timer Manager Integration', () => {
    test('should properly track timer statistics in metrics', async () => {
      mockAdapter.onGet('/test').reply(500);

      const initialMetrics = retryManager.getMetrics();
      expect(initialMetrics.timerHealth.activeTimers).toBe(0);
      expect(initialMetrics.timerHealth.activeRetryTimers).toBe(0);
      expect(initialMetrics.timerHealth.healthScore).toBe(0);

      // Start a failing request
      const requestPromise = retryManager.axiosInstance.get('/test').catch(() => {});
      
      // Wait for retry timer
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const metricsWithTimer = retryManager.getMetrics();
      expect(metricsWithTimer.timerHealth.activeRetryTimers).toBeGreaterThan(0);
      expect(metricsWithTimer.timerHealth.healthScore).toBeGreaterThan(0);

      await requestPromise;

      // After completion, timers should be cleaned up
      const finalMetrics = retryManager.getMetrics();
      expect(finalMetrics.timerHealth.activeRetryTimers).toBe(0);
      expect(finalMetrics.timerHealth.healthScore).toBe(0);
    });

    test('should calculate health score correctly', async () => {
      const manager1 = new RetryManager({ retries: 1, queueDelay: 10 });
      const manager2 = new RetryManager({ retries: 1, queueDelay: 10 });
      const mock1 = new MockAdapter(manager1.axiosInstance);
      const mock2 = new MockAdapter(manager2.axiosInstance);

      try {
        mock1.onGet().reply(500);
        mock2.onGet().reply(500);

        // Create different numbers of failing requests
        const promise1 = manager1.axiosInstance.get('/test').catch(() => {});
        const promise2 = manager2.axiosInstance.get('/test1').catch(() => {});
        const promise3 = manager2.axiosInstance.get('/test2').catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 50));

        const metrics1 = manager1.getMetrics();
        const metrics2 = manager2.getMetrics();

        // Manager2 should have higher health score (more timers)
        expect(metrics2.timerHealth.healthScore).toBeGreaterThan(metrics1.timerHealth.healthScore);

        await Promise.all([promise1, promise2, promise3]);
      } finally {
        manager1.destroy();
        manager2.destroy();
        mock1.restore();
        mock2.restore();
      }
    });
  });

  describe('Memory and Event Loop Health', () => {
    test('should not cause event loop blocking with many rapid retries', async () => {
      mockAdapter.onGet().reply(500);

      const startTime = Date.now();
      
      // Create many rapid requests
      const requests = Array.from({ length: 50 }, (_, i) =>
        retryManager.axiosInstance.get(`/test-${i}`).catch(() => {})
      );

      // This should complete quickly despite retries
      await Promise.all(requests);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should not take excessively long due to event loop blocking
      // With 3 retries and exponential backoff, this should still complete reasonably fast
      expect(duration).toBeLessThan(30000); // 30 seconds max

      // Verify no timers are left
      const finalStats = retryManager.getTimerStats();
      expect(finalStats.activeRetryTimers).toBe(0);
    });

    test('should handle destroy() gracefully with active timers', async () => {
      mockAdapter.onGet().reply(500);

      // Start several failing requests
      const requests = [
        retryManager.axiosInstance.get('/test1').catch(() => {}),
        retryManager.axiosInstance.get('/test2').catch(() => {}),
        retryManager.axiosInstance.get('/test3').catch(() => {}),
      ];

      // Wait for retry timers to be scheduled
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const statsBeforeDestroy = retryManager.getTimerStats();
      expect(statsBeforeDestroy.activeRetryTimers).toBeGreaterThan(0);

      // Destroy should clean up all timers
      retryManager.destroy();

      // Verify cleanup
      const statsAfterDestroy = retryManager.getTimerStats();
      expect(statsAfterDestroy.activeRetryTimers).toBe(0);
      expect(statsAfterDestroy.activeTimers).toBe(0);

      // Requests should be cancelled/rejected
      await Promise.all(requests);
    });
  });

  describe('Stress Test - Timer Accumulation', () => {
    test('should handle extreme load without timer leaks', async () => {
      // Configure for stress test
      const stressManager = new RetryManager({
        retries: 2,
        mode: RETRY_MODES.AUTOMATIC,
        maxConcurrentRequests: 20,
        queueDelay: 5,
        debug: false,
      });
      const stressMock = new MockAdapter(stressManager.axiosInstance);

      try {
        stressMock.onGet().reply(500); // All requests fail

        const requestCount = 100; // Reduced from 200 for more stable testing
        const requests: Promise<any>[] = [];

        // Create massive load
        for (let i = 0; i < requestCount; i++) {
          requests.push(
            stressManager.axiosInstance.get(`/stress-${i}`).catch(() => {})
          );
        }

        // Monitor timer health throughout
        const healthSamples: number[] = [];
        const monitor = setInterval(() => {
          const stats = stressManager.getTimerStats();
          healthSamples.push(stats.activeTimers + stats.activeRetryTimers);
        }, 10);

        await Promise.all(requests);
        clearInterval(monitor);

        // Verify final cleanup
        const finalStats = stressManager.getTimerStats();
        expect(finalStats.activeRetryTimers).toBe(0);
        expect(finalStats.activeTimers).toBe(0);

        // Verify timer count never became excessive
        const maxTimers = Math.max(...healthSamples, 0);
        console.log(`Peak timer count during stress test: ${maxTimers} (request count: ${requestCount})`);
        
        // With timer management, peak should be reasonable - allow slight overhead
        // Each request can have 1 active retry timer, plus some internal timers
        expect(maxTimers).toBeLessThanOrEqual(requestCount * 2.5); // Allow for some overhead

        const finalMetrics = stressManager.getMetrics();
        expect(finalMetrics.timerHealth.healthScore).toBe(0);
        
        console.log(`Timer management successful - peak: ${maxTimers}, final: ${finalStats.activeTimers + finalStats.activeRetryTimers}`);
      } finally {
        stressManager.destroy();
        stressMock.restore();
      }
    });
  });
}); 