'use strict';

import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { AxiosError } from 'axios';

import { QueueFullError } from './errors/QueueFullError';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';

interface EnqueuedItem {
  config: AxiosRequestConfig;
  resolve: (cfg: AxiosRequestConfig) => void;
  reject: (err: unknown) => void;
}

/**
 * A queue that holds AxiosRequestConfig objects and resolves them
 * once concurrency is available, prioritizing higher priorities first.
 */
export class RequestQueue {
  private readonly maxConcurrent: number;
  private readonly queueDelay: number;
  private readonly maxQueueSize?: number;
  private readonly hasActiveCriticalRequests: () => boolean;
  private readonly isCriticalRequest: (request: AxiosRequestConfig) => boolean;
  private readonly waiting: EnqueuedItem[] = [];
  private inProgressCount = 0;
  private isDestroyed = false;
  private dequeueTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param maxConcurrent - maximum number of requests to process at once
   * @param queueDelay - delay of every enqueued request
   * @param hasActiveCriticalRequests - check if there are active critical requests
   * @param isCriticalRequest - check if a request is critical
   * @param maxQueueSize - optional maximum number of requests that can be queued
   */
  constructor(
    maxConcurrent = 5,
    queueDelay = 100,
    hasActiveCriticalRequests: typeof this.hasActiveCriticalRequests,
    isCriticalRequest: typeof this.isCriticalRequest,
    maxQueueSize?: number,
  ) {
    if (maxConcurrent < 1) {
      throw new Error(`maxConcurrent must be >= 1. Received: ${maxConcurrent}`);
    }
    this.maxConcurrent = maxConcurrent;
    this.queueDelay = queueDelay;
    this.maxQueueSize = maxQueueSize;
    this.hasActiveCriticalRequests = hasActiveCriticalRequests;
    this.isCriticalRequest = isCriticalRequest;
  }

  /**
   * Enqueue a config and return a promise that resolves to that config
   * once concurrency is available.
   * @throws {QueueFullError} When the queue is at maximum capacity
   */
  public enqueue(config: AxiosRequestConfig): Promise<AxiosRequestConfig> {
    // Check if the queue has been destroyed
    if (this.isDestroyed) {
      return Promise.reject(new AxiosError('Queue has been destroyed', 'QUEUE_DESTROYED'));
    }

    // Check if the queue is at its maximum capacity
    if (this.maxQueueSize !== undefined && this.waiting.length >= this.maxQueueSize) {
      throw new QueueFullError(config);
    }

    return new Promise<AxiosRequestConfig>((resolve, reject) => {
      const item: EnqueuedItem = { config, resolve, reject };
      this.insertByPriority(item);
      this.tryDequeue();
    });
  }

  /**
   * Call this after a request finishes, freeing a concurrency slot
   * so the next item can proceed.
   */
  public markComplete(): void {
    this.inProgressCount = Math.max(0, this.inProgressCount - 1);
    this.tryDequeue();
  }

  /**
   * Returns how many items are currently waiting (not yet resolved).
   */
  public getWaitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Returns a copy of the waiting items
   */
  public getWaiting(): EnqueuedItem[] {
    return [...this.waiting];
  }

  public get isBusy(): boolean {
    return this.waiting.length > 0 || this.inProgressCount > 0;
  }

  /**
   * Cancel a specific request in the queue before it starts.
   * @param requestId The request ID to cancel.
   * @returns true if successfully canceled, false if not found (or already dequeued).
   */
  public cancelQueuedRequest(requestId: string): boolean {
    // Find the index of the matching EnqueuedItem
    const index = this.waiting.findIndex((item) => item.config.__requestId === requestId);

    if (index === -1) {
      return false; // Not found, possibly already dequeued or wrong ID
    }

    // Remove the item from the queue
    const [request] = this.waiting.splice(index, 1);

    request.reject(
      new AxiosError(
        `Request is cancelled ID: ${requestId}`,
        'REQUEST_CANCELED',
        request.config as InternalAxiosRequestConfig,
      ),
    );

    // Cleanup large references
    this.cleanupRequest(request);

    return true;
  }

  /**
   * Clears all waiting requests from the queue and rejects them
   */
  public clear(): void {
    // Reject all pending requests
    for (const item of this.waiting) {
      item.reject(
        new AxiosError(
          'Queue cleared',
          'QUEUE_CLEARED',
          item.config as InternalAxiosRequestConfig,
        ),
      );
      // Cleanup large references
      this.cleanupRequest(item);
    }
    
    // Clear the array efficiently
    this.waiting.length = 0;
  }

  /**
   * Destroys the queue, canceling all waiting requests and cleanup resources
   * After calling this method, the queue is no longer usable
   */
  public destroy(): void {
    // Clear all timers
    if (this.dequeueTimer) {
      clearTimeout(this.dequeueTimer);
      this.dequeueTimer = null;
    }

    // Clear all waiting requests
    this.clear();
    
    // Mark as destroyed
    this.isDestroyed = true;
    this.inProgressCount = 0;
  }

  /**
   * Insert the request into `waiting` in the correct position based on priority,
   * then timestamp (FIFO for same priority).
   *
   * If performance is not an issue for your queue size, you can just do:
   *   this.waiting.push(item);
   *   this.waiting.sort((a, b) => comparePriority(a, b));
   */
  private insertByPriority(item: EnqueuedItem): void {
    // Optimized binary insertion for large arrays
    const length = this.waiting.length;
    
    // Fast path for empty array or append at end
    if (length === 0) {
      this.waiting.push(item);
      return;
    }
    
    // Check if we should append at the end (common case for many workloads)
    const lastItem = this.waiting[length - 1];
    if (this.comparePriority(item, lastItem) >= 0) {
      this.waiting.push(item);
      return;
    }
    
    // Standard binary insertion for other cases
    let low = 0;
    let high = length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1; // floor((low+high)/2)
      const c = this.comparePriority(item, this.waiting[mid]);
      if (c < 0) {
        // item should come before mid element
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    this.waiting.splice(low, 0, item);
  }

  /**
   * If there's capacity, shift items out of `waiting` and resolve them
   * so those requests can start.
   */
  private tryDequeue = (): void => {
    // Clear any existing timer to prevent multiple timers
    if (this.dequeueTimer) {
      clearTimeout(this.dequeueTimer);
      this.dequeueTimer = null;
    }
    
    // Don't schedule if queue is destroyed
    if (this.isDestroyed) {
      return;
    }

    // Schedule the actual dequeue after the delay
    this.dequeueTimer = setTimeout(() => {
      this.dequeueTimer = null;
      
      // Check if the queue has been destroyed during the timeout
      if (this.isDestroyed) {
        return;
      }
      
      // While there's capacity, shift from waiting and resolve the promise
      while (this.inProgressCount < this.maxConcurrent && this.waiting.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const { config, resolve } = this.waiting[0]!; // Peek at the first item

        if (this.isCriticalRequest(config) || !this.hasActiveCriticalRequests()) {
          // Remove from queue and resolve
          const item = this.waiting.shift()!;
          this.inProgressCount++;
          resolve(config);
          
          // Cleanup references after resolving
          this.cleanupRequest(item);
        } else {
          // Stop processing non-critical requests while critical ones exist
          break;
        }
      }
    }, this.queueDelay);
  };

  /**
   * Compare by priority desc, then timestamp asc.
   */
  private comparePriority(a: EnqueuedItem, b: EnqueuedItem): number {
    const pA = a.config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    const pB = b.config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    if (pA !== pB) {
      // higher priority first => return negative if a > b
      return pB - pA;
    }
    // tie-break by earliest timestamp first
    const tA = a.config.__timestamp ?? 0;
    const tB = b.config.__timestamp ?? 0;
    return tA - tB;
  }
  
  /**
   * Helper to clean up potentially large references in requests
   * to aid garbage collection
   */
  private cleanupRequest(item: EnqueuedItem): void {
    // Clear out large properties that might retain memory
    // Only clear data/body as we don't want to affect the actual request
    // if it's still in flight
    if (item.config.data) {
      // Keep the original reference but null out contents
      // since the reference might be needed elsewhere
      if (typeof item.config.data === 'object' && item.config.data !== null) {
        // Only clean if we're done with this request
        // @ts-ignore - intentionally clearing data properties
        item.config.__cleanedForGC = true;
      }
    }
  }
}
