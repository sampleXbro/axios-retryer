'use strict';

/**
 * Generic binary heap-based priority queue.
 *
 * Provides O(log n) push and shift; O(n) `removeByRequestId` (only invoked
 * during request cancellations, so the cost is acceptable).
 *
 * Items must extend `HeapItem` so the heap can attach a stable insertion
 * counter that breaks ties between items of equal priority. The caller
 * supplies the comparator and (optionally) the request-id extractor used by
 * `removeByRequestId`.
 */

export interface HeapItem {
  /** Stable monotonic insertion order; assigned by the heap on push(). */
  insertionOrder?: number;
}

export type PriorityHeapCompareFn<T extends HeapItem> = (a: T, b: T) => number;
export type PriorityHeapIdExtractor<T extends HeapItem> = (item: T) => string | undefined;

export class PriorityHeap<T extends HeapItem> {
  private heap: T[] = [];
  private readonly compareFn: PriorityHeapCompareFn<T>;
  private readonly idExtractor: PriorityHeapIdExtractor<T> | null;
  private insertionCounter = 0;
  private sortedCache: T[] | null = null;

  constructor(compareFn: PriorityHeapCompareFn<T>, idExtractor?: PriorityHeapIdExtractor<T>) {
    this.compareFn = compareFn;
    this.idExtractor = idExtractor ?? null;
  }

  get length(): number {
    return this.heap.length;
  }

  /** Add an item to the heap in O(log n). */
  push(item: T): void {
    item.insertionOrder = this.insertionCounter++;
    this.heap.push(item);
    this.heapifyUp(this.heap.length - 1);
    this.sortedCache = null;
  }

  /** Remove and return the highest priority item in O(log n). */
  shift(): T | undefined {
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

  /** Peek at the highest priority item without removing it. */
  peek(): T | undefined {
    return this.heap[0];
  }

  /**
   * Remove a specific item by request ID in O(n).
   * Returns undefined when no extractor was provided or no match was found.
   */
  removeByRequestId(requestId: string): T | undefined {
    if (!this.idExtractor) return undefined;
    const extractor = this.idExtractor;
    const index = this.heap.findIndex((item) => extractor(item) === requestId);
    if (index === -1) return undefined;

    const item = this.heap[index];
    this.sortedCache = null;

    if (index === this.heap.length - 1) {
      return this.heap.pop();
    }

    this.heap[index] = this.heap.pop()!;
    this.heapifyUp(index);
    this.heapifyDown(index);

    return item;
  }

  /** Remove all items and return them. */
  clear(): T[] {
    const items = [...this.heap];
    this.heap.length = 0;
    this.insertionCounter = 0;
    this.sortedCache = null;
    return items;
  }

  /** Returns a sorted snapshot of all items (cached until the heap is mutated). */
  getAll(): T[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.heap].sort(this.compareFn);
    }

    return [...this.sortedCache];
  }

  private heapifyUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);

      if (this.compareFn(this.heap[parentIndex], this.heap[index]) <= 0) {
        break;
      }

      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }

  private heapifyDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.heap.length && this.compareFn(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild;
      }

      if (rightChild < this.heap.length && this.compareFn(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild;
      }

      if (smallest === index) {
        break;
      }

      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
}
