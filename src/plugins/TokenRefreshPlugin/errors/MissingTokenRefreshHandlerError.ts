import { AxiosRetryerError } from '../../../core/errors/AxiosRetryerError';

export class MissingTokenRefreshHandlerError extends AxiosRetryerError {
  constructor(message = 'No token refresh handler provided') {
    super(message, 'EMISSING_TOKEN_REFRESH_HANDLER');
  }
}
