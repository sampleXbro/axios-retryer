import type { CacheStorage, CacheStorageEntry, CachedItem } from '../types';

export class InMemoryCacheStorage implements CacheStorage {
  private readonly storage = new Map<string, CachedItem>();

  public get(key: string): CachedItem | undefined {
    return this.storage.get(key);
  }

  public set(key: string, value: CachedItem): void {
    this.storage.set(key, value);
  }

  public delete(key: string): void {
    this.storage.delete(key);
  }

  public clear(): void {
    this.storage.clear();
  }

  public entries(): readonly CacheStorageEntry[] {
    return Array.from(this.storage, ([key, value]) => ({ key, value }));
  }
}
