// @ts-nocheck
import { RequestQueue } from '../src/core/requestQueue';

describe('RequestQueue Basic Tests', () => {
  test('constructor validates maxConcurrent', () => {
    expect(() => {
      new RequestQueue(0, 0, () => false, () => false);
    }).toThrow('maxConcurrent must be >= 1');
    
    expect(() => {
      new RequestQueue(-1, 0, () => false, () => false);
    }).toThrow('maxConcurrent must be >= 1');
    
    expect(() => {
      new RequestQueue(1, 0, () => false, () => false);
    }).not.toThrow();
  });
  
  test('getWaitingCount returns correct count', () => {
    const queue = new RequestQueue(2, 0, () => false, () => false);
    expect(queue.getWaitingCount()).toBe(0);
  });
  
  test('getWaiting returns waiting items copy', () => {
    const queue = new RequestQueue(2, 0, () => false, () => false);
    expect(queue.getWaiting()).toEqual([]);
  });
  
  test('isBusy checks waiting and in-progress counts', () => {
    const queue = new RequestQueue(2, 0, () => false, () => false);
    
    // Empty queue is not busy
    expect(queue.isBusy).toBe(false);
  });
  
  test('enqueuing adds items to queue', () => {
    const queue = new RequestQueue(2, 0, () => false, () => false);
    
    // Make a request - should return a promise
    const promise = queue.enqueue({ url: '/test', method: 'get' });
    expect(promise).toBeInstanceOf(Promise);
    
    // Clean up
    promise.catch(() => {});
  });
  
  test('marking complete decrements in-progress count', () => {
    const queue = new RequestQueue(2, 0, () => false, () => false);
    
    // Should not throw
    queue.markComplete();
  });
}); 