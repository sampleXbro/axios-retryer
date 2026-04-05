import { AxiosRetryerError } from '../../core/errors/AxiosRetryerError';

export class InvalidCacheKeyError extends AxiosRetryerError {
  constructor(message = 'URL is required for cache key generation') {
    super(message, 'EINVALID_CACHE_KEY');
  }
}
