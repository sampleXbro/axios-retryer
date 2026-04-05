import 'axios';
import type { AxiosRetryerRequestMetadata } from './types';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Per-request options for axios-retryer.
     * Use this to override priority, requestId, requestRetries, requestMode,
     * backoffType, or retryableStatuses on a per-request basis.
     *
     * Fields marked `readonly` (retryAttempt, isRetrying, timestamp) are
     * managed by the library. Setting them externally has no effect and is
     * intentionally excluded from the type to prevent accidental mutation.
     */
    __axiosRetryer?: AxiosRetryerRequestMetadata;
  }
}
