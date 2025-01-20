import 'axios';
import { AxiosRetryerRequestPriority, RetryMode } from './index';

declare module 'axios' {
  interface AxiosRequestConfig {
    __retryAttempt?: number;
    __requestRetries?: number;
    __requestMode?: RetryMode;
    __requestId?: string;
    __isRetrying?: boolean;
    __priority?: AxiosRetryerRequestPriority;
    __timestamp?: number;
  }
}