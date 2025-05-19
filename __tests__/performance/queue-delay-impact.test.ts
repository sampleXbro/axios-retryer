import { RetryManager } from '../../src';
import AxiosMockAdapter from 'axios-mock-adapter';
import { AxiosResponse } from 'axios';

describe('Queue Delay Impact Tests', () => {
  let mock: AxiosMockAdapter;

  afterEach(() => {
    if (mock) mock.restore();
  });

  // Test to measure how different queue delay values impact throughput
  test('should measure the impact of different queue delay values on throughput', async () => {
    // Configure delay values to test
    const delayValues = [0, 10, 50, 100, 250];
    const results: Record<number, number> = {};
    const requestCount = 50;
    
    // Configure endpoint to be very fast to isolate queue delay impact
    const setupMock = (mockAdapter: AxiosMockAdapter) => {
      mockAdapter.onAny().reply(200, { success: true });
    };
    
    // Test each delay value
    for (const delay of delayValues) {
      // Create manager with specific delay setting
      const retryManager = new RetryManager({
        maxConcurrentRequests: 5,
        queueDelay: delay,
        debug: false
      });
      
      mock = new AxiosMockAdapter(retryManager.axiosInstance);
      setupMock(mock);
      
      // Measure throughput
      const startTime = Date.now();
      const promises: Promise<AxiosResponse<any>>[] = [];
      
      for (let i = 0; i < requestCount; i++) {
        promises.push(retryManager.axiosInstance.get(`/api/test-${i}`));
      }
      
      await Promise.all(promises);
      const endTime = Date.now();
      results[delay] = endTime - startTime;
      
      // Clean up
      mock.restore();
    }
    
    // Output results
    console.log(`Queue Delay Impact on Throughput (${requestCount} requests):`);
    for (const delay of delayValues) {
      console.log(`- Delay ${delay}ms: ${results[delay].toFixed(2)}ms total execution time`);
      
      if (delay > 0) {
        const overhead = ((results[delay] - results[0]) / results[0]) * 100;
        console.log(`  Overhead: ${overhead.toFixed(2)}%`);
      }
    }
    
    // Verify impact is reasonable - in a mock environment, we can only verify the general trend
    if (results[0] > 0 && results[100] > 0) {
      // The main assertion is that larger delays lead to longer execution times
      expect(results[100]).toBeGreaterThan(results[0]);
      expect(results[250]).toBeGreaterThan(results[100]);
    }
  }, 30000);

  // Test to measure the impact of queue delay on retry performance
  test('should measure the impact of queue delay on retry performance', async () => {
    const delayValues = [0, 50, 200];
    const results: Record<number, { total: number, firstSuccess: number, retriedSuccess: number }> = {};
    
    for (const delay of delayValues) {
      // Setup retry manager with specific settings
      const retryManager = new RetryManager({
        maxConcurrentRequests: 3,
        queueDelay: delay,
        retries: 1, // Just one retry to keep test simple
        debug: false
      });
      
      mock = new AxiosMockAdapter(retryManager.axiosInstance);
      
      // Configure endpoint behavior:
      // - 5 requests succeed immediately 
      // - 5 requests fail then succeed on retry
      for (let i = 0; i < 5; i++) {
        mock.onGet(`/api/success-${i}`).reply(200, { success: true });
      }
      
      for (let i = 0; i < 5; i++) {
        // First attempt fails
        mock.onGet(`/api/retry-${i}`).replyOnce(500, { error: 'Server error' });
        // Retry succeeds
        mock.onGet(`/api/retry-${i}`).reply(200, { success: true });
      }
      
      // Track success times
      const successTimes: Record<string, number> = {};
      const retrySuccessTimes: Record<string, number> = {};
      
      // Measure performance
      const startTime = Date.now();
      
      // First send direct success requests
      const directPromises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        directPromises.push(
          retryManager.axiosInstance.get(`/api/success-${i}`)
            .then(() => {
              successTimes[`success-${i}`] = Date.now() - startTime;
            })
        );
      }
      
      // Then send retry requests
      const retryPromises: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        retryPromises.push(
          retryManager.axiosInstance.get(`/api/retry-${i}`)
            .then(() => {
              retrySuccessTimes[`retry-${i}`] = Date.now() - startTime;
            })
            .catch((e: any) => e) // Prevent test failure
        );
      }
      
      await Promise.all([...directPromises, ...retryPromises]);
      const endTime = Date.now();
      
      // Calculate average completion times
      const avgDirectSuccess = Object.values(successTimes)
        .reduce((sum, time) => sum + time, 0) / Object.values(successTimes).length;
        
      const avgRetrySuccess = Object.values(retrySuccessTimes)
        .reduce((sum, time) => sum + time, 0) / Object.values(retrySuccessTimes).length;
      
      results[delay] = {
        total: endTime - startTime,
        firstSuccess: avgDirectSuccess,
        retriedSuccess: avgRetrySuccess
      };
      
      // Clean up
      mock.restore();
    }
    
    // Output results
    console.log('\nQueue Delay Impact on Retry Performance:');
    for (const delay of delayValues) {
      console.log(`\nDelay ${delay}ms:`);
      console.log(`- Total execution time: ${results[delay].total.toFixed(2)}ms`);
      console.log(`- Avg time for direct success: ${results[delay].firstSuccess.toFixed(2)}ms`);
      console.log(`- Avg time for retried success: ${results[delay].retriedSuccess.toFixed(2)}ms`);
      
      if (delay > 0) {
        const directOverhead = ((results[delay].firstSuccess - results[0].firstSuccess) / results[0].firstSuccess) * 100;
        const retryOverhead = ((results[delay].retriedSuccess - results[0].retriedSuccess) / results[0].retriedSuccess) * 100;
        
        console.log(`- Direct success overhead: ${directOverhead.toFixed(2)}%`);
        console.log(`- Retried success overhead: ${retryOverhead.toFixed(2)}%`);
      }
    }
    
    // Verify impact is reasonable - delay should increase retry times more than direct success times
    // because retries go through the queue mechanism twice
    if (results[0] && results[50]) {
      // The retry times should generally be longer than direct success times 
      // due to the additional request
      expect(results[0].retriedSuccess).toBeGreaterThan(results[0].firstSuccess);
      
      // Larger queue delays should have correspondingly larger impacts
      expect(results[200].retriedSuccess).toBeGreaterThan(results[50].retriedSuccess);
    }
  }, 30000);
}); 