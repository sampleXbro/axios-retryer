import type { CacheStorageEntry, CachedItem } from '../types';

export function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function';
}

export function getErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name };
  }

  return {};
}

export function getCacheEntryAccessTimestamp(cachedItem: CachedItem): number {
  return cachedItem.lastAccessedAt ?? cachedItem.timestamp;
}

export function sortCacheEntriesByAccess(entries: readonly CacheStorageEntry[]): CacheStorageEntry[] {
  return [...entries].sort(
    (left, right) =>
      getCacheEntryAccessTimestamp(left.value) - getCacheEntryAccessTimestamp(right.value) ||
      left.key.localeCompare(right.key),
  );
}
