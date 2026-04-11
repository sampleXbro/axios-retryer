export class InvalidCacheKeyError extends Error {
  constructor() {
    super('Cannot generate cache key: request URL is missing.');
    this.name = 'InvalidCacheKeyError';
  }
}
