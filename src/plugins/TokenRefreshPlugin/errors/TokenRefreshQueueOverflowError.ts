import { AxiosRetryerError } from '../../../core/errors/AxiosRetryerError';

/**
 * Raised when the TokenRefreshPlugin queue exceeds `maxQueuedRequests`.
 * Prevents unbounded memory growth (and a DoS surface) under sustained 401 conditions.
 */
export class TokenRefreshQueueOverflowError extends AxiosRetryerError {
  public readonly queueSize: number;

  constructor(queueSize: number) {
    super(`Token refresh queue overflowed: ${queueSize} requests pending.`, 'ETOKEN_REFRESH_QUEUE_OVERFLOW');
    this.queueSize = queueSize;
  }
}
