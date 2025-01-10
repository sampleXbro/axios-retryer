import type { AxiosRetryerRequestConfig } from '../types';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';

interface QueueItem {
  config: AxiosRetryerRequestConfig;
  priority: number;
  timestamp: number;
}

export class RequestQueue {
  private readonly maxConcurrent: number;
  private queue: QueueItem[] = [];
  private processing = new Set<string>();

  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
  }

  public enqueue(config: AxiosRetryerRequestConfig): void {
    const priority = config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    const timestamp = Date.now();

    const queueItem: QueueItem = {
      config,
      priority,
      timestamp,
    };

    this.queue.push(queueItem);
    this.sortQueue();
  }

  public dequeue(): AxiosRetryerRequestConfig | null {
    if (this.queue.length === 0 || this.processing.size >= this.maxConcurrent) {
      return null;
    }

    const item = this.queue.shift();
    if (item?.config.__requestId) {
      this.processing.add(item.config.__requestId);
    }

    return item?.config ?? null;
  }

  public complete(requestId: string): void {
    this.processing.delete(requestId);
  }

  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  public canProcess(): boolean {
    return this.processing.size < this.maxConcurrent;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getProcessingCount(): number {
    return this.processing.size;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      // Higher priority number means higher priority
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // If priorities are equal, use FIFO
      return a.timestamp - b.timestamp;
    });
  }

  public clear(): void {
    this.queue = [];
    this.processing.clear();
  }
}
