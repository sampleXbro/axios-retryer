import { AxiosError } from 'axios';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

/**
 * Error thrown when the request queue has reached its maximum capacity
 * and cannot accept new requests.
 */
export class QueueFullError extends AxiosError {
  constructor(request: AxiosRequestConfig) {
    super(
      'Request queue is full. The maximum queue size has been reached.',
      'EQUEUE_FULL',
      request as InternalAxiosRequestConfig,
    );
    this.name = 'QueueFullError';
  }
} 