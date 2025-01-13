import type { AxiosRetryerRequestConfig } from '../types';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';

/**
 * A queue that manages AxiosRetryerRequestConfigs with concurrency limits
 * and priority-based ordering. Higher priority requests are dequeued first;
 * if priorities are equal, requests are handled in FIFO order.
 */
export class RequestQueue {
  private readonly maxConcurrent: number;
  // The main queue holding waiting requests
  private readonly queue: AxiosRetryerRequestConfig[] = [];
  // A Set tracking actively processing requests
  private readonly inProgress = new Set<string>();

  /**
   * @param maxConcurrent - maximum number of requests to process at once
   */
  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Insert a new request into the queue.
   *
   * @param config - request configuration object
   */
  public enqueue(config: AxiosRetryerRequestConfig): void {
    // Instead of pushing and sorting the entire array,
    // you could do a binary insertion if performance is critical.
    this.queue.push(config);
    this.sortQueue();
  }

  /**
   * Retrieve the next request from the queue if below concurrency limits.
   * Marks that request as "in progress" until you call `markComplete`.
   *
   * @returns the highest-priority request or null if none is available
   */
  public dequeue(): AxiosRetryerRequestConfig | null {
    // No work if empty or we’ve hit concurrency limit
    if (this.queue.length === 0 || this.inProgress.size >= this.maxConcurrent) {
      return null;
    }

    const item = this.queue.shift();
    if (item?.__requestId) {
      this.inProgress.add(item.__requestId);
    }

    return item ?? null;
  }

  /**
   * Mark a request as complete (finished processing).
   * This frees a concurrency slot for the next request.
   *
   * @param requestId - the request ID to complete
   */
  public markComplete(requestId: string): void {
    if (!this.inProgress.has(requestId)) {
      // Optionally throw an Error or log a warning if not found
      // throw new Error(`RequestID ${requestId} not found in progress.`);
      return;
    }
    this.inProgress.delete(requestId);
  }

  /**
   * Returns true if the queue has no more waiting requests.
   */
  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Returns true if we're under the concurrency limit
   * and can dequeue another request.
   */
  public hasCapacity(): boolean {
    return this.inProgress.size < this.maxConcurrent;
  }

  /**
   * Total number of queued items.
   */
  public getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Number of active requests in progress.
   */
  public getInProgressCount(): number {
    return this.inProgress.size;
  }

  /**
   * Clears all waiting requests and active in-progress tracking.
   * (Use carefully; it can abruptly remove your queue state.)
   */
  public clearAll(): void {
    this.queue.length = 0;
    this.inProgress.clear();
  }

  /**
   * Sorts the underlying array so the highest priority is at the front.
   * If priorities match, earlier timestamp is served first (FIFO).
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      // Higher priority number => handled first
      const priorityA = a.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
      const priorityB = b.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
      if (priorityA !== priorityB) {
        return priorityB - priorityA;
      }
      // If same priority, FIFO by timestamp
      const tsA = a.__timestamp ?? 0;
      const tsB = b.__timestamp ?? 0;
      return tsA - tsB;
    });
  }
}
