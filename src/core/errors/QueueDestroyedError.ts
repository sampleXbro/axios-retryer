import { AxiosError } from 'axios';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

export class QueueDestroyedError extends AxiosError {
  constructor(request?: AxiosRequestConfig) {
    super(
      'Queue has been destroyed',
      'QUEUE_DESTROYED',
      request as InternalAxiosRequestConfig | undefined,
    );
    this.name = 'QueueDestroyedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
