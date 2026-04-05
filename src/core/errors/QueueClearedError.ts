import { AxiosError } from 'axios';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

export class QueueClearedError extends AxiosError {
  constructor(request: AxiosRequestConfig) {
    super(
      'Queue cleared',
      'QUEUE_CLEARED',
      request as InternalAxiosRequestConfig,
    );
    this.name = 'QueueClearedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
