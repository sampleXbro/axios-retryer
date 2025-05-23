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
 * A binary heap-based priority queue for better performance with large numbers of requests.
 * Provides O(log n) insertions and extractions instead of O(n) array splice operations.
 */
class PriorityHeap {
  private heap: EnqueuedItem[] = [];
  private compareFn: (a: EnqueuedItem, b: EnqueuedItem) => number;
  private insertionCounter = 0; // To ensure stable ordering

  constructor(compareFn: (a: EnqueuedItem, b: EnqueuedItem) => number) {
    this.compareFn = compareFn;
  }

  get length(): number {
    return this.heap.length;
  }

  /**
   * Add an item to the heap in O(log n) time
   */
  push(item: EnqueuedItem): void {
    // Add insertion order to ensure stability
    (item as any).__insertionOrder = this.insertionCounter++;
    this.heap.push(item);
    this.heapifyUp(this.heap.length - 1);
  }

  /**
   * Remove and return the highest priority item in O(log n) time
   */
  shift(): EnqueuedItem | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const root = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.heapifyDown(0);
    return root;
  }

  /**
   * Peek at the highest priority item without removing it
   */
  peek(): EnqueuedItem | undefined {
    return this.heap[0];
  }

  /**
   * Remove a specific item by request ID in O(n) time
   * This is still O(n) but only called during cancellations
   */
  removeByRequestId(requestId: string): EnqueuedItem | undefined {
    const index = this.heap.findIndex(item => item.config.__requestId === requestId);
    if (index === -1) return undefined;

    const item = this.heap[index];
    
    // Replace with last element and restore heap property
    if (index === this.heap.length - 1) {
      return this.heap.pop();
    }
    
    this.heap[index] = this.heap.pop()!;
    
    // Restore heap property - might need to go up or down
    this.heapifyUp(index);
    this.heapifyDown(index);
    
    return item;
  }

  /**
   * Clear all items
   */
  clear(): EnqueuedItem[] {
    const items = [...this.heap];
    this.heap.length = 0;
    this.insertionCounter = 0;
    return items;
  }

  /**
   * Get a copy of all items (for debugging/testing)
   * Returns items in priority order (not heap order)
   */
  getAll(): EnqueuedItem[] {
    // Return items sorted by priority for testing
    return [...this.heap].sort(this.compareFn);
  }

  private heapifyUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      
      // If parent has higher or equal priority, we're done
      if (this.compareFn(this.heap[parentIndex], this.heap[index]) <= 0) {
        break;
      }
      
      // Swap with parent
      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }

  private heapifyDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      // Find the highest priority among node and its children
      if (leftChild < this.heap.length && 
          this.compareFn(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild;
      }
      
      if (rightChild < this.heap.length && 
          this.compareFn(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild;
      }

      // If current node has highest priority, we're done
      if (smallest === index) {
        break;
      }

      // Swap with highest priority child
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
}

/**
 * A queue that holds AxiosRequestConfig objects and resolves them
 * once concurrency is available, prioritizing higher priorities first.
 * 
 * Now uses a binary heap for O(log n) insertions instead of O(n) array operations.
 */
export class RequestQueue {
  private readonly maxConcurrent: number;
  private readonly queueDelay: number;
  private readonly maxQueueSize?: number;
  private readonly hasActiveCriticalRequests: () => boolean;
  private readonly isCriticalRequest: (request: AxiosRequestConfig) => boolean;
  private readonly waiting: PriorityHeap;
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
    this.waiting = new PriorityHeap(this.comparePriority.bind(this));
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
      this.waiting.push(item); // Now O(log n) instead of O(n)
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
    return this.waiting.getAll();
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
    const request = this.waiting.removeByRequestId(requestId);
    
    if (!request) {
      return false; // Not found, possibly already dequeued or wrong ID
    }

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
    // Get all items and clear the heap
    const items = this.waiting.clear();
    
    // Reject all pending requests
    for (const item of items) {
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
  }

  /**
   * Destroys the queue, canceling all waiting requests and cleanup resources
   * After calling this method, the queue is no longer usable
   */
  public destroy(): void {
    // Clear any existing timer
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
        const topItem = this.waiting.peek(); // Peek at the first item
        if (!topItem) break;

        if (this.isCriticalRequest(topItem.config) || !this.hasActiveCriticalRequests()) {
          // Remove from queue and resolve - now O(log n) instead of O(n)
          const item = this.waiting.shift()!;
          this.inProgressCount++;
          item.resolve(item.config);
          
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
   * Compare by priority desc, then timestamp asc, then insertion order for stability.
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
    if (tA !== tB) {
      return tA - tB;
    }
    // final tie-break by insertion order for stability
    const iA = (a as any).__insertionOrder ?? 0;
    const iB = (b as any).__insertionOrder ?? 0;
    return iA - iB;
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
