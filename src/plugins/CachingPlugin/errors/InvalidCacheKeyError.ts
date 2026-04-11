export class InvalidCacheKeyError extends Error {
  constructor() {
    super('URL is required for cache key generation');
    this.name = 'InvalidCacheKeyError';
  }
}
