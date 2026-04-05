import { AxiosRetryerError } from './AxiosRetryerError';

export class RequestAbortedError extends AxiosRetryerError {
  public readonly requestId?: string;

  constructor(requestId?: string) {
    super(`Request aborted. ID: ${requestId}`, 'EREQUEST_ABORTED');
    this.requestId = requestId;
  }
}
