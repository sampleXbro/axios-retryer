import { AxiosRetryerError } from '../../core/errors/AxiosRetryerError';

export class TokenRefreshFailedError extends AxiosRetryerError {
  constructor(message = 'Token refresh failed') {
    super(message, 'ETOKEN_REFRESH_FAILED');
  }
}
