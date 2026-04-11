import { AxiosRetryerError } from '../../../core/errors/AxiosRetryerError';

export class TokenRefreshTimeoutError extends AxiosRetryerError {
  public readonly retryableRefreshFailure = true;

  constructor(message = 'Token refresh timeout') {
    super(message, 'ETOKEN_REFRESH_TIMEOUT');
  }
}
