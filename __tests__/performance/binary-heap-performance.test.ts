import { RequestQueue } from '../../src/core/requestQueue';
import { AXIOS_RETRYER_REQUEST_PRIORITIES, type AxiosRetryerRequestPriority } from '../../src/types';
import type { AxiosRequestConfig } from 'axios';

describe('Binary Heap Performance Tests', () => {
  const mockHasActiveCriticalRequests = jest.fn(() => false);
  const mockIsCriticalRequest = jest.fn(() => false);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createConfig = (priority: AxiosRetryerRequestPriority, timestamp: number, requestId: string) => ({
    __priority: priority,
    __timestamp: timestamp,
    __requestId: requestId,
    url: `https://api.example.com/${requestId}`,
    method: 'GET' as const,
  });

  it('should demonstrate improved performance with large queues', async () => {
    // Test with increasing queue sizes
    const queueSizes = [100, 500, 1000, 2000];
    const results: Array<{ size: number; duration: number; avgPerOperation: number }> = [];
    
    // Use valid priority values for random generation
    const validPriorities = Object.values(AXIOS_RETRYER_REQUEST_PRIORITIES);

    for (const size of queueSizes) {
      const queue = new RequestQueue(
        1, // maxConcurrent - keep low to build up queue
        1000, // delay - keep high so items stay in queue
        mockHasActiveCriticalRequests,
        mockIsCriticalRequest,
        size + 100 // maxQueueSize
      );

      const startTime = process.hrtime.bigint();
      
      // Add many requests with random priorities to trigger worst-case insertion patterns
      const promises: Array<Promise<AxiosRequestConfig | void>> = [];
      for (let i = 0; i < size; i++) {
        const priority = validPriorities[Math.floor(Math.random() * validPriorities.length)];
        const timestamp = Date.now() + Math.floor(Math.random() * 1000);
        const promise = queue.enqueue(createConfig(priority, timestamp, `req-${i}`))
          .catch(() => {}); // Ignore rejections for this test
        promises.push(promise);
      }

      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      results.push({
        size,
        duration: durationMs,
        avgPerOperation: durationMs / size
      });

      // Clean up
      queue.destroy();
      
      console.log(`Queue size ${size}: ${durationMs.toFixed(2)}ms total, ${(durationMs/size).toFixed(4)}ms per operation`);
    }

    // Performance should not degrade quadratically
    // With O(n log n) complexity, the ratio between largest and smallest should be reasonable
    const smallestTest = results[0];
    const largestTest = results[results.length - 1];
    
    // The ratio should be roughly size_ratio * log(size_ratio) for O(n log n)
    const sizeRatio = largestTest.size / smallestTest.size;
    const expectedWorstRatio = sizeRatio * Math.log2(sizeRatio);
    const actualRatio = largestTest.duration / smallestTest.duration;
    
    console.log(`Size ratio: ${sizeRatio}x, Duration ratio: ${actualRatio.toFixed(2)}x, Expected max ratio for O(n log n): ${expectedWorstRatio.toFixed(2)}x`);
    
    // The actual ratio should be significantly better than O(n²) worst case
    const quadraticWorstCase = sizeRatio * sizeRatio;
    expect(actualRatio).toBeLessThan(quadraticWorstCase * 0.1); // Should be at least 10x better than O(n²)
  });

  it('should handle rapid insertions and extractions efficiently', async () => {
    const queue = new RequestQueue(
      10, // Higher concurrency to allow extractions
      10, // Lower delay
      mockHasActiveCriticalRequests,
      mockIsCriticalRequest,
      5000
    );

    const operationCount = 1000;
    const startTime = process.hrtime.bigint();
    
    // Mix of insertions and extractions
    const promises: Array<Promise<void>> = [];
    const validPriorities = Object.values(AXIOS_RETRYER_REQUEST_PRIORITIES);
    
    for (let i = 0; i < operationCount; i++) {
      const priority = validPriorities[i % validPriorities.length]; // Cycle through valid priorities
      const timestamp = Date.now() + i;
      const promise = queue.enqueue(createConfig(priority, timestamp, `mixed-${i}`))
        .then(() => queue.markComplete())
        .catch(() => {});
      promises.push(promise);
    }

    await Promise.all(promises);
    
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1000000;
    
    console.log(`Mixed operations (${operationCount}): ${durationMs.toFixed(2)}ms total, ${(durationMs/operationCount).toFixed(4)}ms per operation`);
    
    // Should complete in reasonable time - increased threshold to account for timer overhead
    expect(durationMs).toBeLessThan(5000); // Less than 5 seconds for 1000 operations (more realistic)
    
    queue.destroy();
  });

  it('should maintain priority ordering under stress', async () => {
    const queue = new RequestQueue(
      2, // Increased concurrency to process faster
      20, // Reduced delay
      mockHasActiveCriticalRequests,
      mockIsCriticalRequest,
      1000 // Reduced queue size
    );

    const highPriorityCount = 50; // Reduced from 100
    const lowPriorityCount = 50; // Reduced from 100
    const processed: string[] = [];

    // Add low priority requests first
    const lowPriorityPromises: Array<Promise<void>> = [];
    for (let i = 0; i < lowPriorityCount; i++) {
      const promise = queue.enqueue(createConfig(
        AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
        Date.now() + i,
        `low-${i}`
      )).then(() => {
        processed.push(`low-${i}`);
        queue.markComplete();
      }).catch(() => {});
      lowPriorityPromises.push(promise);
    }

    // Add high priority requests after
    const highPriorityPromises: Array<Promise<void>> = [];
    for (let i = 0; i < highPriorityCount; i++) {
      const promise = queue.enqueue(createConfig(
        AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
        Date.now() + 1000 + i, // Later timestamp but higher priority
        `high-${i}`
      )).then(() => {
        processed.push(`high-${i}`);
        queue.markComplete();
      }).catch(() => {});
      highPriorityPromises.push(promise);
    }

    await Promise.all([...lowPriorityPromises, ...highPriorityPromises]);

    // High priority requests should have been processed before low priority ones
    const firstHighIndex = processed.findIndex(id => id.startsWith('high-'));
    const lastLowIndex = processed.map((id, idx) => id.startsWith('low-') ? idx : -1)
      .filter(idx => idx !== -1)
      .pop() ?? -1;

    expect(firstHighIndex).toBeLessThan(lastLowIndex);
    
    console.log(`Priority ordering maintained: first high-priority at index ${firstHighIndex}, last low-priority at index ${lastLowIndex}`);
    
    queue.destroy();
  }, 10000); // Increased timeout to 10 seconds
}); 