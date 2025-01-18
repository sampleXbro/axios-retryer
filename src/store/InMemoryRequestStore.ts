'use strict';

import type { AxiosRetryerRequestConfig, RequestStore } from '../types';

export class InMemoryRequestStore implements RequestStore {
  private requests: AxiosRetryerRequestConfig[] = [];

  constructor(
    private readonly maxStoreSize = 200,
    private readonly onRequestRemovedFromStore?: (request: AxiosRetryerRequestConfig) => void,
  ) {}

  add(request: AxiosRetryerRequestConfig): void {
    this.requests.push(request);

    // If the store exceeds the maximum size, remove the last (lowest priority and latest timestamp)
    if (this.requests.length > this.maxStoreSize) {
      const removedRequest = this.requests.pop();
      if (removedRequest) {
        this.onRequestRemovedFromStore?.(removedRequest);
      }
    }
  }

  remove(request: AxiosRetryerRequestConfig): void {
    this.requests = this.requests.filter((req) => req.__requestId !== request.__requestId);
  }

  getAll(): AxiosRetryerRequestConfig[] {
    return [...this.requests];
  }

  clear(): void {
    this.requests = [];
  }
}
