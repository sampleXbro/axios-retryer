import type { AxiosRequestConfig } from 'axios';

import type { Logger, RetryStrategy } from '../types';
import type { EmitCoreEvent } from '../types/events';
import {
  extractRetryAfterHeader,
  MAX_RETRY_AFTER_MS,
  normalizeRetryAfterValue,
  parseRetryAfterMs,
} from '../utils/http';
import { getRequestMetadata } from '../utils/requestMetadata';
import { TimerManager } from './TimerManager';

// Re-export so existing internal imports of these utilities from this module continue to work.
export { extractRetryAfterHeader, MAX_RETRY_AFTER_MS, normalizeRetryAfterValue, parseRetryAfterMs };

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
