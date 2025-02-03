'use strict';

import type { AxiosRequestConfig } from 'axios';

import type { RequestStore, RetryHooks } from '../types';

/**
 * A simple in-memory store for Axios request configurations.
 * Used for storing failed requests for later retry.
 */
export class InMemoryRequestStore implements RequestStore {
  private requests: AxiosRequestConfig[] = [];

  /**
   * @param maxStoreSize - Maximum number of requests to store.
   * @param emit - Function to emit events (e.g., when a request is removed).
   */
  constructor(
    private readonly maxStoreSize = 200,
    private readonly emit: <K extends keyof RetryHooks>(
      event: K,
      ...args: Parameters<NonNullable<RetryHooks[K]>>
    ) => void,
  ) {}

  /**
   * Adds a request configuration to the store.
   * If the store exceeds the maximum size, the most recent request is removed.
   *
   * @param request - The Axios request configuration to store.
   */
  add(request: AxiosRequestConfig): void {
    this.requests.push(request);

    // If the store exceeds maxStoreSize, remove the last request.
    // (This assumes that newer requests are less critical than older ones.
    //  If you prefer to remove the oldest, use shift() instead.)
    if (this.requests.length > this.maxStoreSize) {
      const removedRequest = this.requests.pop();
      if (removedRequest) {
        this.emit('onRequestRemovedFromStore', removedRequest);
      }
    }
  }

  /**
   * Removes a specific request from the store.
   *
   * @param request - The request configuration to remove.
   */
  remove(request: AxiosRequestConfig): void {
    const requestId = request.__requestId;
    this.requests = this.requests.filter((req) => req.__requestId !== requestId);
  }

  /**
   * Returns a shallow copy of all stored request configurations.
   *
   * @returns An array of AxiosRequestConfig.
   */
  getAll(): AxiosRequestConfig[] {
    return this.requests.slice();
  }

  /**
   * Clears all stored requests.
   */
  clear(): void {
    this.requests = [];
  }
}
