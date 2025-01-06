'use strict';

import type {AxiosRetryerRequestConfig, RequestStore} from '../types';

export class InMemoryRequestStore implements RequestStore {
  private requests: AxiosRetryerRequestConfig[] = [];

  add(request: AxiosRetryerRequestConfig): void {
    this.requests.push(request);
  }

  remove(request: AxiosRetryerRequestConfig): void {
    this.requests = this.requests.filter((r) => r !== request);
  }

  getAll(): AxiosRetryerRequestConfig[] {
    return this.requests;
  }

  clear(): void {
    this.requests = [];
  }
}
