'use strict';

import type { RequestStore } from '../types';
import type { AxiosRequestConfig } from 'axios';

export class InMemoryRequestStore implements RequestStore {
  private requests: AxiosRequestConfig[] = [];

  constructor(
    private readonly maxStoreSize = 200,
    private readonly onRequestRemovedFromStore?: (request: AxiosRequestConfig) => void,
  ) {}

  add(request: AxiosRequestConfig): void {
    this.requests.push(request);

    // If the store exceeds the maximum size, remove the last (lowest priority and latest timestamp)
    if (this.requests.length > this.maxStoreSize) {
      const removedRequest = this.requests.pop();
      if (removedRequest) {
        this.onRequestRemovedFromStore?.(removedRequest);
      }
    }
  }

  remove(request: AxiosRequestConfig): void {
    this.requests = this.requests.filter((req) => req.__requestId !== request.__requestId);
  }

  getAll(): AxiosRequestConfig[] {
    return [...this.requests];
  }

  clear(): void {
    this.requests = [];
  }
}
