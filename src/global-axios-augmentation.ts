import 'axios';
import type { AxiosRetryerRequestPriority, RetryMode } from './index';
import type { AxiosRetryerBackoffType } from './types';

declare module 'axios' {
  interface AxiosRequestConfig {
    __retryAttempt?: number;
    __requestRetries?: number;
    __requestMode?: RetryMode;
    __requestId?: string;
    __isRetrying?: boolean;
    __priority?: AxiosRetryerRequestPriority;
    __timestamp?: number;
    __backoffType?: AxiosRetryerBackoffType;
    __retryableStatuses?: (number | [number, number])[];
    __isRetryRefreshRequest?: boolean;
  }
}
