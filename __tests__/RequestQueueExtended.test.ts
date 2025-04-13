// @ts-nocheck
import { RequestQueue } from '../src/core/requestQueue';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../src';
import { QueueFullError } from '../src/core/errors/QueueFullError';

// Set global timeout for all tests
jest.setTimeout(60000); // Increase timeout to 60 seconds

describe('RequestQueue Extended Tests', () => {
  const createConfig = (priority: number, timestamp: number, requestId: string) => ({
    __priority: priority,
    __timestamp: timestamp,
    __requestId: requestId,
  });

  // Test for queue maxQueueSize functionality with debugging
  it('should handle maxQueueSize limits and throw appropriate errors', () => {
    // Create a queue with maxQueueSize=1 and maxConcurrent=1
    // This means 1 request will start processing immediately, and only 1 can be waiting
    const q = new RequestQueue(1, 0, () => false, () => false, 1);
    
    // First request - will be processed immediately
    const req1 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1'));
    expect(req1).toBeInstanceOf(Promise);
    
    // Check that processing count is correct
    expect(q.getWaitingCount()).toBe(1); // One in waiting
    
    // Second request - should throw QueueFullError
    try {
      q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2'));
      // Test should fail if we get here
      expect(true).toBe(false); // Will fail the test if we get here
    } catch (error) {
      // Check that it's the right type of error
      expect(error).toBeInstanceOf(QueueFullError);
      expect(error.name).toBe('QueueFullError');
      expect(error.message).toBe('Request queue is full. The maximum queue size has been reached.');
    }
    
    // Clean up
    req1.catch(() => {}); // Avoid unhandled promise rejection
  });

  // Add a test for queue capacity after a request is cancelled
  it('should have space in queue after cancelling a request', () => {
    // Create a queue with maxConcurrent=1 and maxQueueSize=1
    const q = new RequestQueue(1, 0, () => false, () => false, 1);
    
    // Add a request with an ID
    q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1'))
      .catch(() => {}); // Handle potential promise rejection
    
    // Cancel the request
    const result = q.cancelQueuedRequest('req1');
    expect(result).toBe(true);
    
    // Queue should be empty now
    expect(q.getWaitingCount()).toBe(0);
    
    // We should be able to add a new request
    const req2 = q.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2'));
    expect(req2).toBeInstanceOf(Promise);
    
    // Make sure it's in the queue
    expect(q.getWaitingCount()).toBe(1);
    
    // Clean up
    req2.catch(() => {}); // Handle potential promise rejection
  });

  it('should handle critical requests correctly', async () => {
    let criticalInProgress = false;
    
    // Create a queue with 1 concurrent request to test blocking behavior
    const criticalQueue = new RequestQueue(
      1, // maxConcurrent
      0, // queueDelay - set to 0 to speed up test
      // Mock function to check if there are active critical requests
      () => criticalInProgress,
      // Mock function to identify critical requests
      (config) => config.__requestId.startsWith('crit'),
      undefined // No maxQueueSize
    );

    const processed = [];

    // First add a non-critical request
    await criticalQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'normal1'))
      .then(() => {
        processed.push('normal1');
        criticalQueue.markComplete();
      })
      .catch(() => {}); // Handle any potential rejections

    // Now add a critical request and mark critical flag as true
    criticalInProgress = true;
    const critPromise = criticalQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'crit1'))
      .then(() => {
        processed.push('crit1');
        criticalQueue.markComplete();
        // Reset critical flag after critical request is done
        criticalInProgress = false;
      })
      .catch(() => {}); // Handle any potential rejections
    
    // Wait for critical request to complete
    await critPromise;

    // Add a high priority non-critical request after critical is finished
    const normalPromise = criticalQueue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, Date.now(), 'normal2'))
      .then(() => {
        processed.push('normal2');
        criticalQueue.markComplete();
      })
      .catch(() => {}); // Handle any potential rejections

    // Wait for non-critical request
    await normalPromise;

    // Check the processing order
    expect(processed).toEqual(['normal1', 'crit1', 'normal2']);
  });
});
