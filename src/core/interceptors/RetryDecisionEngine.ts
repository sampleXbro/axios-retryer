'use strict';

import type { AxiosError } from 'axios';

import type { RetryMode, RetryStrategy } from '../../types';
import { RETRY_MODES } from '../../types';
import type { InternalAxiosRetryerRequestMetadata } from '../../utils/requestMetadata';
import { extractRetryAfterHeader, parseRetryAfterMs } from '../RetryScheduler';

/**
 * Pure decision result for a failed request.
 *
 * The interceptor turns this into side effects (event emission, scheduling,
 * logging). Keep this type free of side-effect carriers (loggers, emitters).
 */
export type RetryDecision =
  | { kind: 'retry'; attempt: number; maxRetries: number; retryAfterMs: number }
  | { kind: 'no-retry'; retryable: boolean };

const NON_RETRYABLE_INTERNAL_CODES = new Set([
  'REQUEST_CANCELED',
  'EREQUEST_ABORTED',
  'QUEUE_DESTROYED',
  'QUEUE_CLEARED',
  'QUEUE_FULL',
]);

export interface DecideRetryInput {
  error: AxiosError;
  metadata: InternalAxiosRetryerRequestMetadata;
  defaultMaxRetries: number;
  defaultMode: RetryMode;
  strategy: RetryStrategy;
  cancelledInQueue: boolean;
}

/**
 * Pure function: given the error and resolved metadata, decide whether this
 * request should retry, give up retryable, or give up non-retryable.
 *
 * Does not emit events, does not log, does not touch the queue. The caller
 * (ErrorInterceptorHandler) owns those side effects so that the decision logic
 * can be tested in isolation.
 */
export function decideRetry(input: DecideRetryInput): RetryDecision {
  const { error, metadata, defaultMaxRetries, defaultMode, strategy, cancelledInQueue } = input;

  const maxRetries = metadata.requestRetries !== undefined ? metadata.requestRetries : defaultMaxRetries;
  const requestMode = metadata.requestMode || defaultMode;
  const attempt = (metadata.retryAttempt || 0) + 1;

  if (cancelledInQueue || isNonRetryableInternalError(error)) {
    return { kind: 'no-retry', retryable: strategy.getIsRetryable(error) };
  }

  if (requestMode === RETRY_MODES.AUTOMATIC && strategy.shouldRetry(error, attempt, maxRetries)) {
    const retryAfterHeader = extractRetryAfterHeader(error.response?.headers);
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    return { kind: 'retry', attempt, maxRetries, retryAfterMs };
  }

  return { kind: 'no-retry', retryable: strategy.getIsRetryable(error) };
}

export function isNonRetryableInternalError(error: AxiosError): boolean {
  return error.code !== undefined && NON_RETRYABLE_INTERNAL_CODES.has(error.code);
}
