import { AxiosError } from 'axios';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

export class QueuedRequestCanceledError extends AxiosError {
  public readonly requestId: string;

  constructor(requestId: string, request: AxiosRequestConfig) {
    super(
      `Request is cancelled ID: ${requestId}`,
      'REQUEST_CANCELED',
      request as InternalAxiosRequestConfig,
    );
    this.name = 'QueuedRequestCanceledError';
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
