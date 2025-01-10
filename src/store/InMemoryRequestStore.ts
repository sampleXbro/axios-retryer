'use strict';

import type { AxiosRetryerRequestConfig, RequestStore } from '../types';

export class InMemoryRequestStore implements RequestStore {
  private requests = new Set<AxiosRetryerRequestConfig>();

  add(request: AxiosRetryerRequestConfig): void {
    this.requests.add(request);
  }

  remove(request: AxiosRetryerRequestConfig): void {
    this.requests.delete(request);
  }

  getAll(): AxiosRetryerRequestConfig[] {
    const requests: AxiosRetryerRequestConfig[] = [];

    this.requests.forEach((req) => {
      requests.push(req);
    });

    return requests;
  }

  clear(): void {
    this.requests.clear();
  }
}
