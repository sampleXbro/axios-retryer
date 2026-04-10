import type { AxiosRequestConfig } from 'axios';

import { AXIOS_RETRYER_REQUEST_PRIORITIES, type AxiosRetryerRequestPriority } from '../src';
import { QueueClearedError, QueueDestroyedError, QueueFullError } from '../src/core/errors';
import { RequestQueue } from '../src/core/requestQueue';

type QueueDebugState = {
  dequeueTimer: ReturnType<typeof setTimeout> | null;
};

function createConfig(
  requestId: string,
  priority: AxiosRetryerRequestPriority = AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
  timestamp = Date.now(),
): AxiosRequestConfig {
  return {
    method: 'get',
    url: `/${requestId}`,
    __axiosRetryer: {
      priority,
      requestId,
      timestamp,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('P0 Request Queue (3.x)', () => {
  describe('3.1 Processing Gates', () => {
    it('3.1.1: gate returning false prevents queued requests from dispatching', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, canProcess: () => false });
      let resolved = false;
      const pending = queue.enqueue(createConfig('blocked')).then(() => {
        resolved = true;
      });

      await sleep(20);

      expect(resolved).toBe(false);
      expect(queue.getWaitingCount()).toBe(1);

      queue.destroy();
      await expect(pending).rejects.toBeInstanceOf(QueueDestroyedError);
    });

    it('3.1.2: removing a gate while requests wait triggers an immediate drain attempt', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
      queue.registerProcessingGate('blocked', () => false);

      const pending = queue.enqueue(createConfig('gate-release'));
      await sleep(20);
      expect(queue.getWaitingCount()).toBe(1);

      expect(queue.unregisterProcessingGate('blocked')).toBe(true);
      await expect(pending).resolves.toMatchObject({ url: '/gate-release' });
      queue.markComplete();
    });

    it('3.1.3: all registered gates must allow a request before it can proceed', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
      let secondGateOpen = false;

      queue.registerProcessingGate('first', () => true);
      queue.registerProcessingGate('second', () => secondGateOpen);

      let resolved = false;
      const pending = queue.enqueue(createConfig('all-gates')).then(() => {
        resolved = true;
      });

      await sleep(20);
      expect(resolved).toBe(false);

      secondGateOpen = true;
      queue.refresh();

      await expect(pending).resolves.toBeUndefined();
      queue.markComplete();
    });

    it('3.1.4: a gate that throws is caught instead of crashing the queue', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
      let shouldThrow = true;

      queue.registerProcessingGate('unstable', () => {
        if (shouldThrow) {
          throw new Error('gate boom');
        }

        return true;
      });

      let resolved = false;
      const pending = queue.enqueue(createConfig('gate-throws')).then(() => {
        resolved = true;
      });

      await sleep(20);
      expect(resolved).toBe(false);
      expect(queue.getWaitingCount()).toBe(1);

      shouldThrow = false;
      queue.refresh();

      await expect(pending).resolves.toBeUndefined();
      queue.markComplete();
    });

    it('3.1.5: registering a gate with an existing name replaces the previous gate', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
      const firstGate = jest.fn(() => false);
      const replacementGate = jest.fn(() => true);

      queue.registerProcessingGate('duplicate', firstGate);
      queue.registerProcessingGate('duplicate', replacementGate);

      await expect(queue.enqueue(createConfig('replacement-gate'))).resolves.toMatchObject({
        url: '/replacement-gate',
      });

      expect(firstGate).not.toHaveBeenCalled();
      expect(replacementGate).toHaveBeenCalled();
      queue.markComplete();
    });

    it('3.1.6: unregisterProcessingGate returns false for an unknown name', () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });

      expect(queue.unregisterProcessingGate('missing')).toBe(false);
    });
  });

  describe('3.2 Queue Delay Behavior', () => {
    it('3.2.1: queueDelay: 0 dispatches without artificial delay', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });

      const start = Date.now();
      await expect(queue.enqueue(createConfig('no-delay'))).resolves.toMatchObject({ url: '/no-delay' });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
      queue.markComplete();
    });

    it('3.2.2: queueDelay creates measurable spacing between dispatches', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 50 });
      const dispatchTimes: number[] = [];

      const first = queue.enqueue(createConfig('delayed-1')).then(() => {
        dispatchTimes.push(Date.now());
        queue.markComplete();
      });
      const second = queue.enqueue(createConfig('delayed-2')).then(() => {
        dispatchTimes.push(Date.now());
        queue.markComplete();
      });

      await Promise.all([first, second]);

      expect(dispatchTimes).toHaveLength(2);
      expect(dispatchTimes[1] - dispatchTimes[0]).toBeGreaterThanOrEqual(45);
    });

    it('3.2.3: queue delay timer is cancelled on destroy()', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 100 });
      const pending = queue.enqueue(createConfig('destroy-delay'));

      expect((queue as unknown as QueueDebugState).dequeueTimer).not.toBeNull();

      queue.destroy();

      expect((queue as unknown as QueueDebugState).dequeueTimer).toBeNull();
      await expect(pending).rejects.toBeInstanceOf(QueueDestroyedError);
    });
  });

  describe('3.3 Queue Size Enforcement', () => {
    it('3.3.1: maxQueueSize: 1 rejects once the single waiting slot is occupied', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, maxQueueSize: 1, canProcess: () => false });
      const first = queue.enqueue(createConfig('queued-1'));

      await sleep(20);
      await expect(queue.enqueue(createConfig('queued-2'))).rejects.toBeInstanceOf(QueueFullError);

      queue.destroy();
      await expect(first).rejects.toBeInstanceOf(QueueDestroyedError);
    });

    it('3.3.2: a request succeeds once a queue slot becomes available again', async () => {
      let gateOpen = false;
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, maxQueueSize: 1, canProcess: () => gateOpen });

      const first = queue.enqueue(createConfig('recover-1'));
      await sleep(20);
      await expect(queue.enqueue(createConfig('recover-overflow'))).rejects.toBeInstanceOf(QueueFullError);

      gateOpen = true;
      queue.refresh();
      await expect(first).resolves.toMatchObject({ url: '/recover-1' });
      queue.markComplete();

      await expect(queue.enqueue(createConfig('recover-2'))).resolves.toMatchObject({ url: '/recover-2' });
      queue.markComplete();
    });

    it('3.3.3: QueueFullError carries the rejected request config', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, maxQueueSize: 1, canProcess: () => false });
      const initial = queue.enqueue(createConfig('full-initial'));

      await sleep(20);
      await expect(queue.enqueue(createConfig('full-overflow'))).rejects.toMatchObject({
        config: expect.objectContaining({
          url: '/full-overflow',
          __axiosRetryer: expect.objectContaining({ requestId: 'full-overflow' }),
        }),
      });

      queue.destroy();
      await expect(initial).rejects.toBeInstanceOf(QueueDestroyedError);
    });

    it('3.3.4: concurrent enqueues at maxQueueSize do not allow an off-by-one overflow', async () => {
      let gateOpen = false;
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, maxQueueSize: 2, canProcess: () => gateOpen });

      const first = queue.enqueue(createConfig('cap-1'));
      const second = queue.enqueue(createConfig('cap-2'));
      const overflow = queue.enqueue(createConfig('cap-3'));

      await expect(overflow).rejects.toBeInstanceOf(QueueFullError);

      gateOpen = true;
      const order: string[] = [];
      void first.then(() => {
        order.push('cap-1');
        queue.markComplete();
      });
      void second.then(() => {
        order.push('cap-2');
        queue.markComplete();
      });
      queue.refresh();

      await Promise.all([first, second]);
      expect(order).toEqual(['cap-1', 'cap-2']);
    });
  });

  describe('3.4 Queue Clear and Destroy', () => {
    it('3.4.1: clear() rejects all waiting promises with QueueClearedError', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, canProcess: () => false });
      const first = queue.enqueue(createConfig('clear-1'));
      const second = queue.enqueue(createConfig('clear-2'));

      await sleep(20);
      queue.clear();

      await expect(first).rejects.toBeInstanceOf(QueueClearedError);
      await expect(second).rejects.toBeInstanceOf(QueueClearedError);
      expect(queue.getWaitingCount()).toBe(0);
    });

    it('3.4.2: destroy() rejects all waiting promises with QueueDestroyedError', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, canProcess: () => false });
      const first = queue.enqueue(createConfig('destroy-1'));
      const second = queue.enqueue(createConfig('destroy-2'));

      await sleep(20);
      queue.destroy();

      await expect(first).rejects.toBeInstanceOf(QueueDestroyedError);
      await expect(second).rejects.toBeInstanceOf(QueueDestroyedError);
      expect(queue.getWaitingCount()).toBe(0);
    });

    it('3.4.3: enqueue() after destroy() rejects with QueueDestroyedError immediately', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });

      queue.destroy();

      await expect(queue.enqueue(createConfig('after-destroy'))).rejects.toBeInstanceOf(QueueDestroyedError);
    });

    it('3.4.4: markComplete() after destroy() does not throw', () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });

      queue.destroy();

      expect(() => queue.markComplete()).not.toThrow();
    });
  });

  describe('3.5 Priority Ordering Edge Cases', () => {
    it('3.5.1: all five priority levels dispatch in strict descending order', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
      const timestamp = Date.now();
      const order: string[] = [];

      const requests = [
        queue.enqueue(createConfig('low', AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, timestamp)).then(() => {
          order.push('low');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('medium', AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, timestamp)).then(() => {
          order.push('medium');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('high', AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, timestamp)).then(() => {
          order.push('high');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('highest', AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST, timestamp)).then(() => {
          order.push('highest');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('critical', AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL, timestamp)).then(() => {
          order.push('critical');
          queue.markComplete();
        }),
      ];

      await Promise.all(requests);

      expect(order).toEqual(['critical', 'highest', 'high', 'medium', 'low']);
    });

    it('3.5.2: identical priorities stay FIFO when timestamps are identical', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0 });
      const timestamp = Date.now();
      const order: string[] = [];

      const requests = ['first', 'second', 'third'].map((requestId) =>
        queue.enqueue(createConfig(requestId, AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, timestamp)).then(() => {
          order.push(requestId);
          queue.markComplete();
        }),
      );

      await Promise.all(requests);

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('3.5.3: a critical request leapfrogs earlier low-priority requests', async () => {
      let gateOpen = false;
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, canProcess: () => gateOpen });
      const timestamp = Date.now();
      const order: string[] = [];

      const low1 = queue.enqueue(createConfig('low-1', AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, timestamp)).then(() => {
        order.push('low-1');
        queue.markComplete();
      });
      const low2 = queue.enqueue(createConfig('low-2', AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, timestamp)).then(() => {
        order.push('low-2');
        queue.markComplete();
      });
      const critical = queue
        .enqueue(createConfig('critical', AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL, timestamp))
        .then(() => {
          order.push('critical');
          queue.markComplete();
        });

      gateOpen = true;
      queue.refresh();
      await Promise.all([low1, low2, critical]);

      expect(order).toEqual(['critical', 'low-1', 'low-2']);
    });

    it('3.5.4: maxConcurrentRequests: 1 keeps mixed priorities strictly ordered', async () => {
      let gateOpen = false;
      const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, canProcess: () => gateOpen });
      const timestamp = Date.now();
      const order: string[] = [];

      const requests = [
        queue.enqueue(createConfig('medium', AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, timestamp)).then(() => {
          order.push('medium');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('highest', AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST, timestamp)).then(() => {
          order.push('highest');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('low', AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, timestamp)).then(() => {
          order.push('low');
          queue.markComplete();
        }),
        queue.enqueue(createConfig('critical', AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL, timestamp)).then(() => {
          order.push('critical');
          queue.markComplete();
        }),
      ];

      gateOpen = true;
      queue.refresh();
      await Promise.all(requests);

      expect(order).toEqual(['critical', 'highest', 'medium', 'low']);
    });
  });
});
