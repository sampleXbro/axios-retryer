import type { AxiosRequestConfig, AxiosResponseHeaders, RawAxiosResponseHeaders } from 'axios';

import type { Logger, RetryStrategy } from '../types';
import type { EmitCoreEvent } from '../types/events';
import { getRequestMetadata } from '../utils/requestMetadata';
import { TimerManager } from './TimerManager';

/** Maximum delay enforced from a server-supplied Retry-After header (5 minutes). */
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Extracts the raw `Retry-After` header value from an Axios response headers object.
 * Handles both the AxiosHeaders class (with `.get()`) and plain header records.
 */
export function extractRetryAfterHeader(
  headers: AxiosResponseHeaders | Partial<RawAxiosResponseHeaders> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const axiosHeaders = headers as { get?: (name: string) => unknown };
  if (typeof axiosHeaders.get === 'function') {
    return normalizeRetryAfterValue(axiosHeaders.get('retry-after'));
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after') {
      return normalizeRetryAfterValue(value);
    }
  }

  return undefined;
}

export function normalizeRetryAfterValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 ? normalizeRetryAfterValue(value[0]) : undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

export function parseRetryAfterMs(headerValue: string | undefined | null): number {
  if (!headerValue) {
    return 0;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    // Preserve millisecond precision for HTTP-date values — do not round to the nearest second.
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }

  return 0;
}

export class RetryScheduler {
  private readonly timerManager = new TimerManager();
  private readonly activeRetryTimers = new Map<string, () => void>();

  constructor(
    private readonly logger: Logger,
    private readonly retryStrategy: RetryStrategy,
    private readonly emitEvent?: EmitCoreEvent,
  ) {}

  public getRetryDelay(config: AxiosRequestConfig, attempt: number, maxRetries: number): number {
    const metadata = getRequestMetadata(config);
    let delay = this.retryStrategy.getDelay(attempt, maxRetries, metadata?.backoffType);

    if (metadata?.retryAfterMs && metadata.retryAfterMs > delay) {
      delay = metadata.retryAfterMs;
    }

    return delay;
  }

  public async waitForRetryDelay(config: AxiosRequestConfig, delay: number): Promise<boolean> {
    const { promise, cancel } = this.timerManager.createSleep(delay);
    const requestId = getRequestMetadata(config)?.requestId;

    if (requestId) {
      this.activeRetryTimers.set(requestId, cancel);
    }

    try {
      await promise;
      return true;
    } catch (_error) {
      this.logger.warn('Retry sleep cancelled', { requestId });
      return false;
    } finally {
      if (requestId) {
        this.activeRetryTimers.delete(requestId);
      }
    }
  }

  public async wait(delay: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.timerManager.createTimeout(resolve, delay);
    });
  }

  public cancelRetryTimer(requestId: string, source: 'user' | 'system' = 'user'): boolean {
    const cancelRetryTimer = this.activeRetryTimers.get(requestId);
    if (!cancelRetryTimer) {
      return false;
    }

    cancelRetryTimer();
    this.activeRetryTimers.delete(requestId);
    this.logger.debug('Cancelled retry timer', { requestId, source });
    this.emitEvent?.('onRetryTimerCancelled', { requestId, source });
    return true;
  }

  public cancelAllRetryTimers(): void {
    this.activeRetryTimers.forEach((cancelFn, requestId) => {
      cancelFn();
      this.logger.debug('Cancelled retry timer', { requestId, source: 'system' });
      this.emitEvent?.('onRetryTimerCancelled', { requestId, source: 'system' });
    });
    this.activeRetryTimers.clear();
  }

  public getTimerStats(): { activeTimers: number; activeRetryTimers: number } {
    return {
      activeTimers: this.timerManager.getActiveTimerCount(),
      activeRetryTimers: this.activeRetryTimers.size,
    };
  }

  public destroy(): void {
    this.cancelAllRetryTimers();
    this.timerManager.destroy();
  }
}
