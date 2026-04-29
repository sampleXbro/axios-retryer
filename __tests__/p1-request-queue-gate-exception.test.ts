//@ts-nocheck
import { jest } from '@jest/globals';

import { RequestQueue } from '../src/core/requestQueue';
import type { Logger } from '../src/types';

/**
 * Verifies that when a registered processing gate throws, the queue logs the failure
 * (at error level) instead of silently dropping the exception.
 */
describe('RequestQueue gate exception handling', () => {
  it('logs an error when a registered gate throws and treats the gate as not-ready', async () => {
    const errorLog = jest.fn();
    const logger: Logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: errorLog,
    };

    const queue = new RequestQueue({
      maxConcurrent: 1,
      queueDelay: 1,
      logger,
    });

    queue.registerProcessingGate('throwy', () => {
      throw new Error('gate boom');
    });

    let resolved = false;
    const enqueued = queue
      .enqueue({ url: '/x', __axiosRetryer: { requestId: 'req-1', priority: 0, timestamp: Date.now() } })
      .then(() => {
        resolved = true;
      });

    // Give the queue some time to attempt to dequeue.
    await new Promise((r) => setTimeout(r, 50));

    // The throwing gate should prevent the request from leaving the queue.
    expect(resolved).toBe(false);

    // The error must have been logged at least once.
    expect(errorLog).toHaveBeenCalledWith(
      'Queue gate threw; treating as not-ready',
      expect.objectContaining({
        requestId: 'req-1',
        error: 'gate boom',
      }),
    );

    // Cleanup so jest doesn't hang.
    queue.unregisterProcessingGate('throwy');
    await enqueued;
    queue.destroy();
  });

  it('continues to log on each evaluation attempt while the gate keeps throwing', async () => {
    const errorLog = jest.fn();
    const logger: Logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: errorLog,
    };

    const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 1, logger });
    queue.registerProcessingGate('always-throws', () => {
      throw new Error('still broken');
    });

    void queue
      .enqueue({ url: '/y', __axiosRetryer: { requestId: 'req-2', priority: 0, timestamp: Date.now() } })
      .catch(() => {});

    await new Promise((r) => setTimeout(r, 100));
    expect(errorLog.mock.calls.length).toBeGreaterThanOrEqual(1);
    queue.destroy();
  });
});
