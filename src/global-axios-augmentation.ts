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
    /**
     * Only if CachingPlugin is used
     * */
    __cachingOptions?: {
      /**
       * If true, this request will be cached regardless of global settings.
       * If false, this request won't be cached regardless of global settings.
       * If undefined, follows the global caching settings.
       */
      cache?: boolean;
      /**
       * Custom TTR (time to revalidate) for this specific request's cache entry in milliseconds.
       * Overrides the global timeToRevalidate setting.
       */
      ttr?: number;
    };
  }
}
