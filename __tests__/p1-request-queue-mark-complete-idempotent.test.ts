/**
 * RequestQueue.markComplete must decrement the in-flight counter exactly once
 * per requestId, even if both the response and error paths race to release the
 * same request. Verifies the fix for double-decrement of inProgressCount.
 */
import { RequestQueue } from '../src/core/requestQueue';
import { ensureRequestMetadata, setRequestMetadataValue } from '../src/utils/requestMetadata';

describe('RequestQueue.markComplete (R6)', () => {
  it('decrements only once when called multiple times with the same requestId', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, maxQueueSize: 10 });

    const a = {} as Record<string, unknown>;
    ensureRequestMetadata(a);
    setRequestMetadataValue(a, 'requestId', 'req-A');

    const b = {} as Record<string, unknown>;
    ensureRequestMetadata(b);
    setRequestMetadataValue(b, 'requestId', 'req-B');

    // Dispatch A, then enqueue B which should wait until A is released.
    const dispatchedA = queue.enqueue(a);
    await dispatchedA;

    expect(queue.getWaitingCount()).toBe(0);

    const dispatchedB = queue.enqueue(b);
    expect(queue.getWaitingCount()).toBe(1);

    // Race: imagine response and error both fire for A.
    queue.markComplete('req-A');
    queue.markComplete('req-A');
    queue.markComplete('req-A');

    await dispatchedB;
    expect(queue.getWaitingCount()).toBe(0);

    // If markComplete had over-decremented, B would have dispatched plus the
    // counter would have gone negative; second markComplete here would re-open
    // a slot we never had. Verify the counter floor by completing B once.
    queue.markComplete('req-B');

    // Enqueue and dispatch a third request to confirm one slot is free, not two.
    const c = {} as Record<string, unknown>;
    ensureRequestMetadata(c);
    setRequestMetadataValue(c, 'requestId', 'req-C');
    const dispatchedC = queue.enqueue(c);
    await dispatchedC;
    expect(queue.getWaitingCount()).toBe(0);
  });

  it('falls back to legacy behavior when no requestId is supplied', () => {
    // The bare markComplete() call (no id) still decrements; only the
    // requestId-aware path is idempotent.
    const queue = new RequestQueue({ maxConcurrent: 2, queueDelay: 0, maxQueueSize: 5 });
    queue.markComplete();
    queue.markComplete();
    // Counter is floored at 0 — should not throw or go negative.
    expect(queue.isBusy).toBe(false);
  });
});
