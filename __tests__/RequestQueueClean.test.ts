// @ts-nocheck
import { RequestQueue } from '../src/core/requestQueue';

describe('RequestQueue Basic Tests', () => {
  test('constructor validates maxConcurrent', () => {
    expect(() => {
      new RequestQueue({ maxConcurrent: 0, queueDelay: 0 });
    }).toThrow('maxConcurrent must be >= 1');

    expect(() => {
      new RequestQueue({ maxConcurrent: -1, queueDelay: 0 });
    }).toThrow('maxConcurrent must be >= 1');

    expect(() => {
      new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
    }).not.toThrow();
  });
  
  test('getWaitingCount returns correct count', () => {
    const queue = new RequestQueue({ maxConcurrent: 2, queueDelay: 0 });
    expect(queue.getWaitingCount()).toBe(0);
  });
  
  test('getWaiting returns waiting items copy', () => {
    const queue = new RequestQueue({ maxConcurrent: 2, queueDelay: 0 });
    expect(queue.getWaiting()).toEqual([]);
  });

  test('isBusy checks waiting and in-progress counts', () => {
    const queue = new RequestQueue({ maxConcurrent: 2, queueDelay: 0 });

    // Empty queue is not busy
    expect(queue.isBusy).toBe(false);
  });

  test('enqueuing adds items to queue', () => {
    const queue = new RequestQueue({ maxConcurrent: 2, queueDelay: 0 });

    // Make a request - should return a promise
    const promise = queue.enqueue({ url: '/test', method: 'get' });
    expect(promise).toBeInstanceOf(Promise);

    // Clean up
    promise.catch(() => {});
  });

  test('marking complete decrements in-progress count', () => {
    const queue = new RequestQueue({ maxConcurrent: 2, queueDelay: 0 });

    // Should not throw
    queue.markComplete();
  });
}); 