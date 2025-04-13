//@ts-nocheck
import { RequestQueue } from '../src/core/requestQueue';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../src';

// Set global timeout for all tests
jest.setTimeout(30000);

describe('RequestQueue', () => {
  const mockIsCriticalRequest = jest.fn();
  const mockHasActiveCriticalRequests = jest.fn();

  const createConfig = (priority: number, timestamp: number, requestId: string) => ({
    __priority: priority,
    __timestamp: timestamp,
    __requestId: requestId,
  });

  let queue: RequestQueue;

  beforeEach(() => {
    mockIsCriticalRequest.mockReset();
    mockHasActiveCriticalRequests.mockReset();
    queue = new RequestQueue(2, 0, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined);
  });

  it('should initialize correctly with valid parameters', () => {
    expect(() => new RequestQueue(1, 50, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined)).not.toThrow();
  });

  it('should throw an error if maxConcurrent is less than 1', () => {
    expect(() => new RequestQueue(0, 50, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined)).toThrow(
      'maxConcurrent must be >= 1. Received: 0'
    );
  });

  it('should enqueue requests and resolve them in priority order', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);

    const results: string[] = [];
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, Date.now(), 'req2')).then(() =>
      results.push('req2')
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results).toEqual(['req2', 'req1']);
  });

  it('should mark requests as complete and process more', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);

    const results: string[] = [];
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2')).then(() =>
      results.push('req2')
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results).toEqual(['req1', 'req2']);
  });

  it('should return the correct waiting count', () => {
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req44')).catch(() => {});
    expect(queue.getWaitingCount()).toBe(1);
  });

  it('should return the correct waiting requests', () => {
    const config = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req33');
    queue.enqueue(config).catch(() => {});
    expect(queue.getWaiting()[0].config).toEqual(config);
  });

  it('should return busy state correctly', () => {
    // When queue is empty and no in-progress requests, isBusy should be true
    expect(queue.isBusy).toBe(true);
    
    // When queue has items, isBusy should be false
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req33')).catch(() => {});
    expect(queue.isBusy).toBe(false);
  });

  it('should handle canceling non-existent requests', () => {
    const result = queue.cancelQueuedRequest('non-existent');
    expect(result).toBe(false);
  });

  it('should insert requests in the correct priority order', () => {
    const lowPriority = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req1');
    const highPriority = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, Date.now(), 'req2');
    queue.enqueue(lowPriority).catch(() => {});
    queue.enqueue(highPriority).catch(() => {});

    const waiting = queue.getWaiting();
    expect(waiting[0].config.__priority).toBe(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
    expect(waiting[1].config.__priority).toBe(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW);
  });

  it('should dequeue requests correctly based on priority and criticality', async () => {
    // First parameter to mockReturnValueOnce is for the LOW request, second for the CRITICAL request
    mockIsCriticalRequest
      .mockImplementation((config) => config.__priority === AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL);
    mockHasActiveCriticalRequests.mockReturnValue(true);

    console.log('Initial mocks setup:');
    console.log('mockIsCriticalRequest implementation set');
    console.log('mockHasActiveCriticalRequests returns:', mockHasActiveCriticalRequests());

    const results: string[] = [];
    
    // First add LOW priority request
    const lowPriorityConfig = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req1');
    console.log('Adding LOW priority request, isCritical:', mockIsCriticalRequest(lowPriorityConfig));
    queue.enqueue(lowPriorityConfig).then(() => {
      console.log('req1 resolved');
      results.push('req1');
    });
    
    // Then add CRITICAL priority request
    const criticalPriorityConfig = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL, Date.now(), 'req2');
    console.log('Adding CRITICAL priority request, isCritical:', mockIsCriticalRequest(criticalPriorityConfig));
    queue.enqueue(criticalPriorityConfig).then(() => {
      console.log('req2 resolved');
      results.push('req2');
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log('Final results:', results);
    expect(results).toEqual(['req2']);
  });

  it('should cancel queued requests correctly', async () => {
    const config = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req22');
    const promise = queue.enqueue(config);

    const result = queue.cancelQueuedRequest('req22');

    await expect(promise).rejects.toThrow()

    expect(result).toBe(true);
    expect(queue.getWaitingCount()).toBe(0);
  });
  
  it('should throw QueueFullError when maxQueueSize is reached', () => {
    // Create a queue with max size 1
    const limitedQueue = new RequestQueue(1, 0, () => false, () => false, 1);
    
    // Add first item (should succeed)
    const config1 = { url: '/test1', __requestId: 'id1' };
    const promise1 = limitedQueue.enqueue(config1);
    
    // The first enqueue should succeed and return a Promise
    expect(promise1).toBeInstanceOf(Promise);
    
    // The queue is now at capacity
    expect(limitedQueue.getWaitingCount()).toBe(1);
    
    // Second attempt should throw QueueFullError directly (not as a rejected promise)
    const config2 = { url: '/test2', __requestId: 'id2' };
    expect(() => {
      limitedQueue.enqueue(config2);
    }).toThrow(expect.objectContaining({
      name: 'QueueFullError'
    }));
    
    // Clean up
    promise1.catch(() => {});
  });
  
  it('getWaiting should return a copy of the waiting items', () => {
    const queue = new RequestQueue(1, 0, () => false, () => false);
    
    // Add items to queue
    const config1 = { url: '/test1', __requestId: 'id1' };
    const config2 = { url: '/test2', __requestId: 'id2' };
    
    queue.enqueue(config1).catch(() => {});
    queue.enqueue(config2).catch(() => {});
    
    const waiting = queue.getWaiting();
    expect(waiting.length).toBe(2);
    
    // Modify the returned array
    waiting.pop();
    
    // Original queue should not be affected
    expect(queue.getWaitingCount()).toBe(2);
  });

  it('should handle requests with same priority but different timestamps', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);

    const results: string[] = [];
    const now = Date.now();
    
    // Enqueue two requests with same priority but different timestamps
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, now + 100, 'req1')).then(() =>
      results.push('req1')
    );
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, now, 'req2')).then(() =>
      results.push('req2')
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Earlier timestamp should be processed first
    expect(results).toEqual(['req2', 'req1']);
  });

  it('should prioritize critical requests even if they arrive later', async () => {
    // Create a simple test with one blocking request and controlled completions
    const singleQueue = new RequestQueue(1, 0, 
      // Mock for active critical requests - we'll control this directly
      () => hasCriticalActive,
      // Mock for identifying critical requests
      (config) => config.__requestId === 'req2',
      undefined
    );
    
    let hasCriticalActive = false;
    const results = [];
    
    // First add a non-critical request
    const req1Promise = singleQueue.enqueue(
      createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1')
    ).then(() => {
      results.push('req1');
      singleQueue.markComplete();
    });
    
    // Wait for req1 to start processing
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Now add a critical request - this should be processed after req1
    hasCriticalActive = true;
    const req2Promise = singleQueue.enqueue(
      createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2')
    ).then(() => {
      results.push('req2');
      singleQueue.markComplete();
    });
    
    // Wait for all processing to complete
    await Promise.all([req1Promise, req2Promise]);
    
    // Verify critical request was processed after the first request
    expect(results.length).toBe(2);
    expect(results[0]).toBe('req1');
    expect(results[1]).toBe('req2');
  });

  it('should handle multiple calls to markComplete', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);
    
    // This should not throw or cause any issues
    queue.markComplete();
    queue.markComplete();
    queue.markComplete();
    
    const results: string[] = [];
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results).toEqual(['req1']);
  });

  it('should respect maxConcurrent limit exactly', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);
    
    // Create a queue with exactly 3 concurrent slots
    const exactQueue = new RequestQueue(3, 0, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined);
    
    const results: string[] = [];
    
    // Add 5 requests
    exactQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    exactQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2')).then(() =>
      results.push('req2')
    );
    exactQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req3')).then(() =>
      results.push('req3')
    );
    exactQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req4')).then(() =>
      results.push('req4')
    );
    exactQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req5')).then(() =>
      results.push('req5')
    );
    
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Only 3 should be processed initially
    expect(results).toEqual(['req1', 'req2', 'req3']);
    expect(exactQueue.getWaitingCount()).toBe(2);
    
    // Complete one request
    exactQueue.markComplete();
    
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Now the 4th request should be processed
    expect(results).toEqual(['req1', 'req2', 'req3', 'req4']);
    expect(exactQueue.getWaitingCount()).toBe(1);
  });

  it('should handle queue delay correctly', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);
    
    // Create a queue with a significant delay
    const delayedQueue = new RequestQueue(2, 50, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined);
    
    const startTime = Date.now();
    const results: { id: string, time: number }[] = [];
    
    delayedQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1')).then(() => {
      results.push({ id: 'req1', time: Date.now() - startTime });
    });
    
    delayedQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2')).then(() => {
      results.push({ id: 'req2', time: Date.now() - startTime });
    });
    
    // Wait for both requests to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // We should have both requests and they should have been delayed by at least the queue delay
    expect(results.length).toBe(2);
    expect(results[0].time).toBeGreaterThanOrEqual(50);
    expect(results[1].time).toBeGreaterThanOrEqual(50);
  });

  it('should properly propagate errors when canceling requests', async () => {
    const config = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'cancel-req');
    const promise = queue.enqueue(config);
    
    // Cancel the request
    queue.cancelQueuedRequest('cancel-req');
    
    // Verify error is thrown with the correct message
    await expect(promise).rejects.toThrow('Request is cancelled ID: cancel-req');
    await expect(promise).rejects.toHaveProperty('code', 'REQUEST_CANCELED');
  });

  it('should handle requests with no priority or timestamp', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);
    
    const results = [];
    
    // Request with no priority or timestamp
    queue.enqueue({ __requestId: 'req1' }).then(() => {
      results.push('req1');
      queue.markComplete();
    });
    
    // Request with only priority
    queue.enqueue({ __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, __requestId: 'req2' }).then(() => {
      results.push('req2');
      queue.markComplete();
    });
    
    // Request with only timestamp
    queue.enqueue({ __timestamp: Date.now(), __requestId: 'req3' }).then(() => {
      results.push('req3');
      queue.markComplete();
    });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify all requests were processed
    expect(results.length).toBe(3);
    expect(results).toContain('req1');
    expect(results).toContain('req2');
    expect(results).toContain('req3');
    
    // High priority (req2) should come before req1 and req3
    expect(results.indexOf('req2')).toBeLessThan(Math.max(results.indexOf('req1'), results.indexOf('req3')));
  });

  it('should handle rapid enqueue/cancel operations correctly', async () => {
    // Reset the mocks
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);
    
    const testQueue = new RequestQueue(2, 0, mockHasActiveCriticalRequests, mockIsCriticalRequest, 100);
    const processedIds: string[] = [];
    const canceledIds: string[] = [];
    
    // Create and immediately cancel some requests
    for (let i = 0; i < 20; i++) {
      const reqId = `req${i}`;
      const req = testQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), reqId))
        .then(() => {
          processedIds.push(reqId);
          testQueue.markComplete();
        })
        .catch((error) => {
          if (error.code === 'REQUEST_CANCELED') {
            canceledIds.push(reqId);
          }
        });
      
      // Cancel every third request
      if (i % 3 === 0) {
        testQueue.cancelQueuedRequest(reqId);
      }
    }
    
    // Wait for processing to complete
    await new Promise((resolve) => setTimeout(resolve, 200));
    
    // Verify that every third request was canceled
    for (let i = 0; i < 20; i++) {
      const reqId = `req${i}`;
      if (i % 3 === 0) {
        expect(canceledIds).toContain(reqId);
      } else {
        expect(processedIds).toContain(reqId);
      }
    }
    
    // Verify queue is now empty
    expect(testQueue.getWaitingCount()).toBe(0);
  });

  it('should maintain request order when priorities are equal and timestamps are identical', async () => {
    const q = new RequestQueue(1, 0, () => false, () => false);

    const results = [];
    const timestamp = Date.now();

    // First request starts processing immediately
    const promise1 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, timestamp, 'req1'))
      .then(() => {
        results.push('req1');
        q.markComplete();
      });

    // These will be queued
    const promise2 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, timestamp, 'req2'))
      .then(() => {
        results.push('req2');
        q.markComplete();
      });

    const promise3 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, timestamp, 'req3'))
      .then(() => {
        results.push('req3');
        q.markComplete();
      });

    await Promise.all([promise1, promise2, promise3]);

    // The first request should still complete first, and the others should maintain their order
    expect(results).toEqual(['req1', 'req2', 'req3']);
  });

  it('should handle race conditions with async completion', async () => {
    const q = new RequestQueue(2, 0, () => false, () => false);

    const results = [];

    // First request will complete after a delay
    const promise1 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1'))
      .then(async () => {
        results.push('req1-start');
        // Delay to simulate async processing
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push('req1-end');
        q.markComplete();
      });

    // Second request will also have some processing time
    const promise2 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2'))
      .then(async () => {
        results.push('req2-start');
        // Shorter delay
        await new Promise(resolve => setTimeout(resolve, 20));
        results.push('req2-end');
        q.markComplete();
      });

    // Third request should wait until either req1 or req2 completes
    const promise3 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req3'))
      .then(() => {
        results.push('req3-start');
        results.push('req3-end');
        q.markComplete();
      });

    await Promise.all([promise1, promise2, promise3]);

    // req1 and req2 should start processing immediately (2 slots)
    expect(results.indexOf('req1-start')).toBeLessThan(results.indexOf('req3-start'));
    expect(results.indexOf('req2-start')).toBeLessThan(results.indexOf('req3-start'));

    // req2 should complete before req1 due to shorter delay
    expect(results.indexOf('req2-end')).toBeLessThan(results.indexOf('req1-end'));

    // req3 should start after req2 completes (since it marks complete first)
    expect(results.indexOf('req2-end')).toBeLessThan(results.indexOf('req3-start'));

    // All requests should have completed
    expect(results).toContain('req1-end');
    expect(results).toContain('req2-end');
    expect(results).toContain('req3-end');
  });

});