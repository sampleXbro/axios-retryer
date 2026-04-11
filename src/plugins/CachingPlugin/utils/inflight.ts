import type { AxiosResponse } from 'axios';

export interface InflightCacheEntry {
  promise: Promise<AxiosResponse<unknown>>;
  resolve: (response: AxiosResponse<unknown>) => void;
  reject: (error: unknown) => void;
}

export function createInflightCacheEntry(): InflightCacheEntry {
  let resolve!: (response: AxiosResponse<unknown>) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<AxiosResponse<unknown>>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  // Leaders may never await this promise directly. Attach a noop rejection handler
  // so leader-only failures do not surface as unhandled rejections.
  promise.catch(() => {});

  return { promise, resolve, reject };
}
