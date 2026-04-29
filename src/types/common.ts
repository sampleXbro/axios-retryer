import type { Method } from 'axios';

/**
 *  manual - Requests fail immediately after the first attempt.
 *  Optional replay can be layered in with ManualRetryPlugin.
 *
 *  automatic - Requests retry automatically according to the configured
 *  retry strategy and retry count.
 * */

export const RETRY_MODES = {
  AUTOMATIC: 'automatic',
  MANUAL: 'manual',
} as const;

export type RetryMode = (typeof RETRY_MODES)[keyof typeof RETRY_MODES];

export const AXIOS_RETRYER_HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  PURGE: 'PURGE',
  LINK: 'LINK',
  UNLINK: 'UNLINK',
} as const;

export type AxiosRetryerHttpMethod = Method;

export const AXIOS_RETRYER_REQUEST_PRIORITIES = {
  CRITICAL: 4,
  HIGHEST: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
} as const;

export type AxiosRetryerRequestPriority =
  (typeof AXIOS_RETRYER_REQUEST_PRIORITIES)[keyof typeof AXIOS_RETRYER_REQUEST_PRIORITIES];

export const AXIOS_RETRYER_BACKOFF_TYPES = {
  STATIC: 0,
  LINEAR: 1,
  EXPONENTIAL: 2,
} as const;

export type AxiosRetryerBackoffType = (typeof AXIOS_RETRYER_BACKOFF_TYPES)[keyof typeof AXIOS_RETRYER_BACKOFF_TYPES];
export type AxiosRetryerStatusRange = readonly [number, number];
export type AxiosRetryerRetryableStatus = number | AxiosRetryerStatusRange;

export interface AxiosRetryerRequestMetadata {
  /** Current retry attempt count. Managed by the library; read-only for consumers. */
  readonly retryAttempt?: number;
  /** Override the max retry count for this specific request. */
  requestRetries?: number;
  /** Override the retry mode (automatic / manual) for this specific request. */
  requestMode?: RetryMode;
  /** Custom request identifier for cancellation targeting. */
  requestId?: string;
  /**
   * Stable correlation identifier propagated through retries and into all log
   * entries for this request. Useful for distributed tracing.
   * If omitted, defaults to `requestId`.
   */
  correlationId?: string;
  /** Whether the request is currently in a retry cycle. Managed by the library. */
  readonly isRetrying?: boolean;
  /** Override request priority for queue ordering. */
  priority?: AxiosRetryerRequestPriority;
  /** Request creation timestamp (ms). Managed by the library. */
  readonly timestamp?: number;
  /** Override the backoff strategy for this specific request. */
  backoffType?: AxiosRetryerBackoffType;
  /** Override the retryable status codes for this specific request. */
  retryableStatuses?: readonly AxiosRetryerRetryableStatus[];
  /** Extra metadata for this request. */
  extra?: unknown;
}
