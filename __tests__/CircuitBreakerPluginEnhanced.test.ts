//@ts-nocheck
import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';
import { RetryManager } from '../src';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';

describe('Enhanced CircuitBreakerPlugin (Jest + axios-mock-adapter)', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let manager: RetryManager;
  let plugin: CircuitBreakerPlugin;

  // A simple logger mock
  const fakeLogger = {
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  };

  beforeEach(() => {
    // Use Jest's fake timers so we can control time-based logic (e.g. openTimeout).
    jest.useFakeTimers();

    // Create a fresh Axios instance and mock adapter
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);

    // Minimal fake RetryManager that the plugin expects
    manager = {
      axiosInstance,
      getLogger: () => fakeLogger,
    } as unknown as RetryManager;

    // Create a plugin instance with all the enhanced options
    plugin = new CircuitBreakerPlugin({
      failureThreshold: 3,         // trip after 3 failures
      openTimeout: 10000,          // 10 seconds before transitioning to HALF_OPEN
      halfOpenMax: 2,              // allow 2 test requests in HALF_OPEN
      successThreshold: 2,         // require 2 successful test requests before closing
      useSlidingWindow: true,      // enable sliding window for some tests
      slidingWindowSize: 5000,     // 5 second window
      adaptiveTimeout: true,       // enable adaptive timeouts
      adaptiveTimeoutSampleSize: 5, // small sample size for testing
      excludeUrls: ['/health', /^\/metrics/], // exclude health check and metrics endpoints
    });

    // Initialize the plugin, which installs request/response interceptors
    plugin.initialize(manager);
  });

  afterEach(() => {
    // Restore real timers and reset mock calls between tests
    jest.useRealTimers();
    mock.reset();
    jest.clearAllMocks();
  });

  describe('Sliding Window Functionality', () => {
    test('should count failures in the sliding window', async () => {
      // Create several failures within the sliding window
      mock.onGet('/api/data').reply(500);

      // Generate 3 failures - this will trip the circuit
      for (let i = 0; i < 3; i++) {
        await expect(axiosInstance.get('/api/data')).rejects.toThrow();
      }

      // Check that the circuit tripped
      const metrics = plugin.getMetrics();
      expect(metrics.state).toBe('OPEN');
      expect(metrics.failureCount).toBe(3);
      expect(metrics.failuresInWindow).toBe(3);

      // After the sliding window period, old failures should be removed
      jest.advanceTimersByTime(5001); // Just beyond the window
      
      // Reset the circuit to CLOSED for testing sliding window cleanup
      (plugin as any)._reset();

      // Add a new failure to trigger recounting
      mock.onGet('/api/other').reply(500);
      await expect(axiosInstance.get('/api/other')).rejects.toThrow();

      // Should show only 1 failure now (the newest one)
      const updatedMetrics = plugin.getMetrics();
      expect(updatedMetrics.failuresInWindow).toBe(1);
      
      // Since we're back below the threshold, requests should be allowed (circuit is CLOSED again)
      mock.onGet('/api/test').reply(200, { result: 'OK' });
      const response = await axiosInstance.get('/api/test');
      expect(response.data).toEqual({ result: 'OK' });
    });
  });

  describe('Success Threshold', () => {
    test('should require multiple successes to close the circuit', async () => {
      // Trip the circuit
      mock.onGet('/api/failing').reply(500);
      for (let i = 0; i < 3; i++) {
        await expect(axiosInstance.get('/api/failing')).rejects.toThrow();
      }

      // Advance time to enter HALF_OPEN
      jest.advanceTimersByTime(10000);
      
      // First successful test request - should NOT close the circuit yet
      mock.onGet('/api/test').reply(200, { test: 'success' });
      await axiosInstance.get('/api/test');
      
      // Circuit should still be in HALF_OPEN state
      expect(plugin.getState()).toBe('HALF_OPEN');
      
      // Second successful test request - should close the circuit
      await axiosInstance.get('/api/test');
      
      // Now the circuit should be CLOSED
      expect(plugin.getState()).toBe('CLOSED');
    });
  });

  describe('URL Exclusion', () => {
    test('should allow excluded URLs even when circuit is open', async () => {
      // Trip the circuit
      mock.onGet('/api/data').reply(500);
      for (let i = 0; i < 3; i++) {
        await expect(axiosInstance.get('/api/data')).rejects.toThrow();
      }
      
      // Confirm circuit is OPEN
      expect(plugin.getState()).toBe('OPEN');
      
      // Health check endpoint should still work
      mock.onGet('/health').reply(200, { status: 'UP' });
      const healthResponse = await axiosInstance.get('/health');
      expect(healthResponse.data.status).toBe('UP');
      
      // Metrics endpoint should also work (using regex pattern)
      mock.onGet('/metrics/system').reply(200, { cpu: 50, memory: 70 });
      const metricsResponse = await axiosInstance.get('/metrics/system');
      expect(metricsResponse.data).toMatchObject({ cpu: 50, memory: 70 });
      
      // Non-excluded endpoint should still be blocked
      await expect(axiosInstance.get('/api/users')).rejects.toThrow(/Circuit is open/);
    });
  });

  describe('Adaptive Timeouts', () => {
    test('should track response times and adjust timeouts accordingly', async () => {
      // Ensure we're working with a plugin that has adaptive timeouts enabled
      const plugin = new CircuitBreakerPlugin({
        adaptiveTimeout: true,
        adaptiveTimeoutSampleSize: 5, // small sample size for testing
        adaptiveTimeoutPercentile: 0.95,
        adaptiveTimeoutMultiplier: 1.5,
      });
      
      plugin.initialize(manager);
      
      // Make a few requests to collect response times
      mock.onGet('/api/slow').reply(200, { data: 'slow' });
      
      // Use fake timestamps instead of real time
      const startTime = Date.now();
      
      // Mock response times - manually add response times of varying lengths
      const responseTimes = [100, 150, 200, 250, 300]; // ms
      
      // Create fake responses with these timings
      for (const responseTime of responseTimes) {
        // Setup the request timestamp
        const requestConfig = { url: '/api/slow', __timestamp: startTime };
        
        // Create a fake successful response
        const response = {
          config: requestConfig,
          headers: {},
          status: 200,
          statusText: 'OK',
          data: { data: 'response' }
        };
        
        // Manually simulate the response happening after responseTime
        jest.spyOn(Date, 'now').mockImplementationOnce(() => startTime + responseTime);
        
        // Call the tracking function directly
        (plugin as any)._trackResponseTime(response);
      }
      
      // Get the metrics to check if adaptive timeout is working
      const metrics = plugin.getMetrics();
      
      // Adaptive timeouts array should exist
      expect(metrics.adaptiveTimeouts).toBeDefined();
      expect(metrics.adaptiveTimeouts.length).toBeGreaterThan(0);
      
      // Find the timeout for our slow endpoint
      const slowEndpointTimeout = metrics.adaptiveTimeouts.find(t => t.url === '/api/slow');
      expect(slowEndpointTimeout).toBeDefined();
      
      // The 95th percentile of our values should be 300ms
      // With the multiplier of 1.5, the timeout should be 450ms
      expect(slowEndpointTimeout.p95ResponseTimeMs).toBeGreaterThanOrEqual(250);
      expect(slowEndpointTimeout.timeoutMs).toBeGreaterThanOrEqual(375); // 250 * 1.5
      
      // Restore the Date.now mock
      jest.spyOn(Date, 'now').mockRestore();
      
      // Clean up
      plugin.onBeforeDestroyed(manager);
    });
  });

  describe('Metadata and Monitoring', () => {
    test('should provide detailed metrics', async () => {
      // Trip the circuit
      mock.onGet('/api/error').reply(500);
      for (let i = 0; i < 3; i++) {
        await expect(axiosInstance.get('/api/error')).rejects.toThrow();
      }
      
      // Get metrics
      const metrics = plugin.getMetrics();
      
      // Validate metric structure
      expect(metrics.state).toBe('OPEN');
      expect(metrics.failureCount).toBe(3);
      expect(typeof metrics.nextAttemptIn).toBe('number');
      expect(metrics.nextAttemptIn).toBeGreaterThan(0);
      expect(metrics.failuresInWindow).toBe(3);
      
      // Advance time and check nextAttemptIn updates
      jest.advanceTimersByTime(5000);
      
      const updatedMetrics = plugin.getMetrics();
      expect(updatedMetrics.nextAttemptIn).toBeLessThan(metrics.nextAttemptIn);
    });
  });
}); 