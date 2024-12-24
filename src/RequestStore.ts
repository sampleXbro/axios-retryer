'use strict';

import type { AxiosRetryerRequestConfig } from './types';

export interface RequestStore {
  /**
   * Add a request config to the store
   * */
  add(request: AxiosRetryerRequestConfig): void;
  /**
   * Remove a request config to the store
   * */
  remove(request: AxiosRetryerRequestConfig): void;
  /**
   * Get all request configs from the store
   * */
  getAll(): AxiosRetryerRequestConfig[];
  /**
   * Clear request store
   * */
  clear(): void;
}

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
