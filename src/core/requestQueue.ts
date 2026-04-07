'use strict';

import type { AxiosRequestConfig } from 'axios';

import { QueueClearedError } from './errors/QueueClearedError';
import { QueueDestroyedError } from './errors/QueueDestroyedError';
import { QueueFullError } from './errors/QueueFullError';
import { QueuedRequestCanceledError } from './errors/QueuedRequestCanceledError';
import { RetryerConfigError } from './errors/RetryerConfigError';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';
import { ensureRequestMetadata, getRequestMetadata } from '../utils/requestMetadata';

interface EnqueuedItem {
  config: AxiosRequestConfig;
  resolve: (cfg: AxiosRequestConfig) => void;
  reject: (err: unknown) => void;
  insertionOrder?: number;
}

/**
 * A binary heap-based priority queue for better performance with large numbers of requests.
 * Provides O(log n) insertions and extractions instead of O(n) array splice operations.
 */
class PriorityHeap {
  private heap: EnqueuedItem[] = [];
  private readonly compareFn: (a: EnqueuedItem, b: EnqueuedItem) => number;
  private insertionCounter = 0; // To ensure stable ordering
  private sortedCache: EnqueuedItem[] | null = null;

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
    item.insertionOrder = this.insertionCounter++;
    this.heap.push(item);
    this.heapifyUp(this.heap.length - 1);
    this.sortedCache = null;
  }

  /**
   * Remove and return the highest priority item in O(log n) time
   */
  shift(): EnqueuedItem | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) {
      this.sortedCache = null;
      return this.heap.pop();
    }

    const root = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.heapifyDown(0);
    this.sortedCache = null;
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
    const index = this.heap.findIndex((item) => getRequestMetadata(item.config)?.requestId === requestId);
    if (index === -1) return undefined;

    const item = this.heap[index];
    this.sortedCache = null;
    
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
    this.sortedCache = null;
    return items;
  }

  /**
   * Get a cached, sorted snapshot of all items for debugging/testing.
   */
  getAll(): EnqueuedItem[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.heap].sort(this.compareFn);
    }

    return [...this.sortedCache];
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

export interface RequestQueueOptions {
  maxConcurrent?: number;
  queueDelay?: number;
  maxQueueSize?: number;
  /**
   * Optional base gate: if provided, a request may only leave the queue when this returns true.
   * Applied before any plugin-registered processing gates.
   */
  canProcess?: (request: AxiosRequestConfig) => boolean;
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
  private readonly baseCanProcess: (request: AxiosRequestConfig) => boolean;
  private readonly processingGates = new Map<string, (request: AxiosRequestConfig) => boolean>();
  private readonly waiting: PriorityHeap;
  private inProgressCount = 0;
  private isDestroyed = false;
  private dequeueTimer: ReturnType<typeof setTimeout> | null = null;
  private microtaskScheduled = false;

  constructor(options: RequestQueueOptions = {}) {
    const { maxConcurrent = 5, queueDelay = 100, maxQueueSize, canProcess } = options;
    if (maxConcurrent < 1) {
      throw new RetryerConfigError(`maxConcurrent must be >= 1. Received: ${maxConcurrent}`, 'maxConcurrent', maxConcurrent);
    }
    if (!Number.isInteger(queueDelay) || queueDelay < 0) {
      throw new RetryerConfigError(`queueDelay must be >= 0. Received: ${queueDelay}`, 'queueDelay', queueDelay);
    }
    if (maxQueueSize !== undefined && (!Number.isInteger(maxQueueSize) || maxQueueSize < 1)) {
      throw new RetryerConfigError(
        `maxQueueSize must be >= 1 when provided. Received: ${maxQueueSize}`,
        'maxQueueSize',
        maxQueueSize,
      );
    }
    this.maxConcurrent = maxConcurrent;
    this.queueDelay = queueDelay;
    this.maxQueueSize = maxQueueSize;
    this.baseCanProcess = canProcess ?? (() => true);
    this.waiting = new PriorityHeap(this.comparePriority.bind(this));
  }

  /**
   * Enqueue a config and return a promise that resolves to that config
   * once concurrency is available.
   * @throws {QueueFullError} When the queue is at maximum capacity
   */
  public enqueue(config: AxiosRequestConfig): Promise<AxiosRequestConfig> {
    ensureRequestMetadata(config);

    // Check if the queue has been destroyed
    if (this.isDestroyed) {
      return Promise.reject(new QueueDestroyedError(config));
    }

    // Check if the queue is at its maximum capacity
    if (this.maxQueueSize !== undefined && this.waiting.length >= this.maxQueueSize) {
      return Promise.reject(new QueueFullError(config));
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

  public registerProcessingGate(name: string, canProcess: (request: AxiosRequestConfig) => boolean): void {
    this.processingGates.set(name, canProcess);
    this.refresh();
  }

  public unregisterProcessingGate(name: string): boolean {
    const removed = this.processingGates.delete(name);
    if (removed) {
      this.refresh();
    }

    return removed;
  }

  public refresh(): void {
    this.tryDequeue();
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

    request.reject(new QueuedRequestCanceledError(requestId, request.config));

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
      item.reject(new QueueClearedError(item.config));
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
    this.microtaskScheduled = false;

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
    if (this.isDestroyed || this.waiting.length === 0 || this.inProgressCount >= this.maxConcurrent) {
      return;
    }

    if (this.queueDelay <= 0) {
      if (this.microtaskScheduled) {
        return;
      }

      this.microtaskScheduled = true;
      queueMicrotask(() => {
        this.microtaskScheduled = false;
        if (!this.isDestroyed) {
          this.drainQueue();
        }
      });
      return;
    }

    if (this.dequeueTimer) {
      return;
    }

    this.dequeueTimer = setTimeout(() => {
      this.dequeueTimer = null;
      if (!this.isDestroyed) {
        this.drainQueue();
      }
    }, this.queueDelay);
  };

  /**
   * Dequeue and resolve items while concurrency allows.
   *
   * Head-of-line blocking is intentional: if the highest-priority item cannot be
   * processed (a gate returns false), the drain stops. This ensures gates work as
   * real barriers — no lower-priority request slips through while a gate is active.
   * Plugins that need ordered, gated dispatch (e.g. token refresh) rely on this.
   */
  private drainQueue(): void {
    while (this.inProgressCount < this.maxConcurrent && this.waiting.length > 0) {
      const topItem = this.waiting.peek();
      if (!topItem) {
        return;
      }

      if (!this.canProcess(topItem.config)) {
        return;
      }

      const item = this.waiting.shift()!;
      this.inProgressCount++;
      item.resolve(item.config);
      this.cleanupRequest(item);
    }
  }

  private canProcess(config: AxiosRequestConfig): boolean {
    if (!this.baseCanProcess(config)) {
      return false;
    }

    for (const gate of Array.from(this.processingGates.values())) {
      if (!gate(config)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compare by priority desc, then timestamp asc, then insertion order for stability.
   */
  private comparePriority(a: EnqueuedItem, b: EnqueuedItem): number {
    const priorityA = getRequestMetadata(a.config)?.priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    const priorityB = getRequestMetadata(b.config)?.priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    if (priorityA !== priorityB) {
      // higher priority first => return negative if a > b
      return priorityB - priorityA;
    }
    // tie-break by earliest timestamp first
    const tA = getRequestMetadata(a.config)?.timestamp ?? 0;
    const tB = getRequestMetadata(b.config)?.timestamp ?? 0;
    if (tA !== tB) {
      return tA - tB;
    }
    // final tie-break by insertion order for stability
    const iA = a.insertionOrder ?? 0;
    const iB = b.insertionOrder ?? 0;
    return iA - iB;
  }
  
  /**
   * Clear callback references once the queue item has been fully handled.
   */
  private cleanupRequest(item: EnqueuedItem): void {
    item.resolve = () => {};
    item.reject = () => {};
  }
}
