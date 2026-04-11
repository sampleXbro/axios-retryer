import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

import type { Logger, RetryMode, RetryStrategy } from '../../types';
import { RETRY_MODES, AXIOS_RETRYER_REQUEST_PRIORITIES } from '../../types';
import { RequestAbortedError } from '../errors/RequestAbortedError';
import type { DependencyGatekeeper } from '../DependencyGatekeeper';
import type { RequestLifecycleManager } from '../RequestLifecycleManager';
import type { RequestQueue } from '../requestQueue';
import {
  extractRetryAfterHeader,
  normalizeRetryAfterValue,
  parseRetryAfterMs,
  type RetryScheduler,
} from '../RetryScheduler';
import {
  assignRequestMetadata,
  ensureRequestMetadata,
  getRequestMetadata,
  setRequestMetadataValue,
} from '../../utils/requestMetadata';

export interface ErrorInterceptorOptions {
  axiosInstance: AxiosInstance;
  logger: Logger;
  requestLifecycle: RequestLifecycleManager;
  dependencyGatekeeper: DependencyGatekeeper;
  requestQueue: RequestQueue;
  retryScheduler: RetryScheduler;
  retryStrategy: RetryStrategy;
  emitEvent: (event: string, ...args: unknown[]) => void;
  markRetryProcessStart: () => void;
  handleRetryProcessFinish: () => void;
  retries: number;
  mode: RetryMode;
  throwErrorOnFailedRetries: boolean;
  throwErrorOnCancelRequest: boolean;
}

export class ErrorInterceptorHandler {
  private readonly options: ErrorInterceptorOptions;

  constructor(options: ErrorInterceptorOptions) {
    this.options = options;
  }

  public handleError = async (error: AxiosError): Promise<AxiosResponse | null> => {
    let cancelledInQueue = false;
    const config = error.config;

    if (!config) {
      this.options.logger.error('Handling error without valid config', { error: error.message });
      return Promise.reject(error);
    }

    if (error.code === 'REQUEST_CANCELED') {
      cancelledInQueue = true;
    }

    this.options.requestQueue.markComplete();

    this.options.logger.error('Request failed', this.buildErrorMeta(config, error));

    const metadata = ensureRequestMetadata(config);

    if (!cancelledInQueue && metadata.isRetrying && metadata.priority !== undefined) {
      this.options.emitEvent('afterRetry', config, false, error);
    }

    assignRequestMetadata(config, {
      priority: metadata.priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
    });

    const effectiveMetadata = getRequestMetadata(config)!;
    const maxRetries =
      effectiveMetadata.requestRetries !== undefined ? effectiveMetadata.requestRetries : this.options.retries;
    const requestMode = effectiveMetadata.requestMode || this.options.mode;
    const attempt = (effectiveMetadata.retryAttempt || 0) + 1;
    const isNonRetryableInternalError = this.isNonRetryableInternalError(error);

    if (
      requestMode === RETRY_MODES.AUTOMATIC &&
      !isNonRetryableInternalError &&
      this.options.retryStrategy.shouldRetry(error, attempt, maxRetries)
    ) {
      const retryAfterHeader = this.getRetryAfterHeader(error.response?.headers);
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      if (retryAfterMs > 0) {
        setRequestMetadataValue(config, 'retryAfterMs', retryAfterMs);
      }

      this.options.logger.debug('Auto-retrying request', {
        requestId: effectiveMetadata.requestId,
        attempt,
        maxRetries,
        ...(getRequestMetadata(config)?.retryAfterMs ? { retryAfterMs: getRequestMetadata(config)?.retryAfterMs } : {}),
      });
      return this.scheduleRetry(config, attempt, maxRetries, cancelledInQueue);
    }

    return this.handleNoRetriesAction(error, this.options.retryStrategy.getIsRetryable(error));
  };

  private async scheduleRetry(
    config: AxiosRequestConfig,
    attempt: number,
    maxRetries: number,
    cancelledFromQueue = false,
  ): Promise<AxiosResponse> {
    this.options.markRetryProcessStart();

    assignRequestMetadata(config, {
      retryAttempt: attempt,
      isRetrying: true,
    });

    const metadata = getRequestMetadata(config);
    const delay = this.options.retryScheduler.getRetryDelay(
      config,
      Number(metadata?.retryAttempt ?? attempt),
      maxRetries,
    );

    this.options.logger.debug('Scheduling retry attempt', {
      requestId: metadata?.requestId,
      attempt,
      maxRetries,
      delayMs: delay,
      backoffType: metadata?.backoffType ?? 'default',
    });

    const sleepCompleted = await this.options.retryScheduler.waitForRetryDelay(config, delay);
    this.options.emitEvent('onRetryScheduled', delay, config);

    if (!sleepCompleted) {
      return this.handleCancelAction(config);
    }

    this.options.logger.debug('Executing retry attempt', {
      requestId: metadata?.requestId,
      timeSinceFirstAttempt: Date.now() - (metadata?.timestamp || 0),
    });

    if (metadata?.requestId) {
      this.options.requestLifecycle.removeById(metadata.requestId);
    }

    if (cancelledFromQueue || config.signal?.aborted) {
      this.options.logger.warn('Retry cancelled', {
        requestId: metadata?.requestId,
        source: cancelledFromQueue ? 'queue' : 'user',
      });
      return this.handleCancelAction(config);
    }

    this.options.emitEvent('beforeRetry', config);
    return this.options.axiosInstance.request(config);
  }

  private handleCancelAction(config: AxiosRequestConfig): Promise<never> {
    setRequestMetadataValue(config, 'isRetrying', false);
    this.options.dependencyGatekeeper.finishBlockingRequest(config, 'cancel');
    this.options.logger.warn('Handling request cancellation', { requestId: getRequestMetadata(config)?.requestId });
    this.options.handleRetryProcessFinish();
    return this.options.throwErrorOnCancelRequest
      ? Promise.reject(new RequestAbortedError(getRequestMetadata(config)?.requestId))
      : Promise.resolve(null as never);
  }

  private handleNoRetriesAction(error: AxiosError, retryable = false): Promise<null> {
    const config = error.config as AxiosRequestConfig;
    setRequestMetadataValue(config, 'isRetrying', false);
    const metadata = getRequestMetadata(config);
    const attempts = (metadata?.retryAttempt ?? 0) + 1;

    this.options.logger.warn('Final request failure', {
      requestId: metadata?.requestId,
      finalAttempt: metadata?.retryAttempt || 0,
      attempts,
      retryable,
    });

    this.options.emitEvent('onFailure', config);
    this.options.emitEvent('onRequestError', {
      error,
      config,
      status: error.response?.status ?? null,
      requestId: metadata?.requestId,
      attempts,
      retryable,
    });
    this.options.dependencyGatekeeper.finishBlockingRequest(config, 'failure');

    if (metadata?.requestId) {
      this.options.requestLifecycle.removeById(metadata.requestId);
    }

    this.options.handleRetryProcessFinish();

    if (!error.response) {
      this.options.emitEvent('onInternetConnectionError', config);
    }

    return this.options.throwErrorOnFailedRetries ? Promise.reject(error) : Promise.resolve(null);
  }

  private buildErrorMeta(config: AxiosRequestConfig, error: AxiosError): Record<string, unknown> {
    return {
      requestId: getRequestMetadata(config)?.requestId,
      url: this.getLogUrl(config.url),
      method: config.method?.toUpperCase(),
      status: error.response?.status,
      statusText: error.response?.statusText,
      code: error.code,
      message: error.message,
      retrying: getRequestMetadata(config)?.isRetrying,
    };
  }

  private getLogUrl(url?: string): string | undefined {
    if (!url) return url;
    const queryIndex = url.indexOf('?');
    const hashIndex = url.indexOf('#');
    if (queryIndex < 0 && hashIndex < 0) return url;
    if (queryIndex < 0) return url.slice(0, hashIndex);
    if (hashIndex < 0) return url.slice(0, queryIndex);
    return url.slice(0, Math.min(queryIndex, hashIndex));
  }

  /**
   * @internal Kept for backward-compatible test access.
   * Delegates to {@link extractRetryAfterHeader} in RetryScheduler.
   */
  private getRetryAfterHeader(headers: unknown): string | undefined {
    const headerValue = extractRetryAfterHeader(headers as Parameters<typeof extractRetryAfterHeader>[0]);
    // normalizeRetryAfterHeader is invoked here to satisfy the noUnusedLocals check;
    // both methods are also accessed directly via test casts for unit coverage.
    return headerValue !== undefined ? this.normalizeRetryAfterHeader(headerValue) : undefined;
  }

  /**
   * @internal Kept for backward-compatible test access.
   * Delegates to {@link normalizeRetryAfterValue} in RetryScheduler.
   */
  private normalizeRetryAfterHeader(value: unknown): string | undefined {
    return normalizeRetryAfterValue(value);
  }

  private isNonRetryableInternalError(error: AxiosError): boolean {
    return (
      error.code === 'REQUEST_CANCELED' ||
      error.code === 'EREQUEST_ABORTED' ||
      error.code === 'QUEUE_DESTROYED' ||
      error.code === 'QUEUE_CLEARED' ||
      error.code === 'QUEUE_FULL'
    );
  }
}
