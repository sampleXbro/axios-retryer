import type { AxiosRequestConfig } from 'axios';

import type { RetryStrategy } from '../types';
import { RetryLogger } from '../services/logger';
import { getRequestMetadata } from '../utils/requestMetadata';

type SleepHandle = {
  promise: Promise<void>;
  cancel: () => void;
};

class TimerManager {
  private activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private isDestroyed = false;

  public createTimeout(
    callback: () => void,
    delay: number,
  ): { timerId: ReturnType<typeof setTimeout> | null; cancel: () => void } {
    if (this.isDestroyed) {
      callback();
      return { timerId: null, cancel: () => {} };
    }

    const timerId = setTimeout(() => {
      this.activeTimers.delete(timerId);
      if (!this.isDestroyed) {
        callback();
      }
    }, delay);

    this.activeTimers.add(timerId);

    return {
      timerId,
      cancel: () => {
        if (this.activeTimers.has(timerId)) {
          clearTimeout(timerId);
          this.activeTimers.delete(timerId);
        }
      },
    };
  }

  public createSleep(ms: number): SleepHandle {
    let cancelFn: () => void = () => {};

    const promise = new Promise<void>((resolve, reject) => {
      const { cancel } = this.createTimeout(resolve, ms);
      cancelFn = () => {
        cancel();
        reject(new Error('Sleep cancelled'));
      };
    });

    return { promise, cancel: cancelFn };
  }

  public getActiveTimerCount(): number {
    return this.activeTimers.size;
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.activeTimers.forEach((timerId) => {
      clearTimeout(timerId);
    });
    this.activeTimers.clear();
  }
}

export function parseRetryAfterMs(headerValue: string | undefined | null): number {
  if (!headerValue) {
    return 0;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const delayMs = dateMs - Date.now();
    return delayMs > 0 ? Math.ceil(delayMs / 1000) * 1000 : 0;
  }

  return 0;
}

export class RetryScheduler {
  private readonly timerManager = new TimerManager();
  private readonly activeRetryTimers = new Map<string, () => void>();

  constructor(
    private readonly logger: RetryLogger,
    private readonly retryStrategy: RetryStrategy,
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

  public cancelRetryTimer(requestId: string): boolean {
    const cancelRetryTimer = this.activeRetryTimers.get(requestId);
    if (!cancelRetryTimer) {
      return false;
    }

    cancelRetryTimer();
    this.activeRetryTimers.delete(requestId);
    this.logger.debug('Cancelled retry timer', { requestId });
    return true;
  }

  public cancelAllRetryTimers(): void {
    this.activeRetryTimers.forEach((cancelFn, requestId) => {
      cancelFn();
      this.logger.debug('Cancelled retry timer', { requestId });
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
