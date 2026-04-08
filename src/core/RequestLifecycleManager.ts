import type { AxiosRequestConfig } from 'axios';

import type { AxiosRetryerRequestPriority, Logger } from '../types';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';
import { assignRequestMetadata, getRequestMetadata } from '../utils/requestMetadata';
import type { RetryScheduler } from './RetryScheduler';
import type { RequestQueue } from './requestQueue';

export interface TrackedRequestController extends AbortController {
  __disposeSignalLink?: () => void;
}

type CallerAbortSignal = NonNullable<AxiosRequestConfig['signal']>;

type RequestLifecycleManagerOptions = {
  logger: Logger;
  requestQueue: RequestQueue;
  retryScheduler: RetryScheduler;
  onRequestCancelled: (requestId: string) => void;
};

export type BeginRequestResult = {
  requestId: string;
  priority: AxiosRetryerRequestPriority;
  controller: TrackedRequestController;
  callerAborted: boolean;
};

export class RequestLifecycleManager {
  private readonly activeRequests = new Map<string, TrackedRequestController>();
  private readonly activeConfigs = new Map<string, AxiosRequestConfig>();
  private requestIndex = 0;

  constructor(private readonly options: RequestLifecycleManagerOptions) {}

  public beginRequest(config: AxiosRequestConfig): BeginRequestResult {
    const controller = new AbortController() as TrackedRequestController;
    const metadata = getRequestMetadata(config);
    const requestId = metadata?.requestId ?? this.generateRequestId();
    const priority = metadata?.priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    const callerSignal = config.signal;

    assignRequestMetadata(config, {
      requestId,
      timestamp: Date.now(),
      priority,
    });

    config.signal = controller.signal;

    if (callerSignal) {
      this.linkCallerAbortSignal(requestId, controller, callerSignal);
    }

    if (!controller.signal.aborted) {
      this.activeRequests.set(requestId, controller);
      this.activeConfigs.set(requestId, config);
    }

    return {
      requestId,
      priority,
      controller,
      callerAborted: controller.signal.aborted,
    };
  }

  public release(config: AxiosRequestConfig): { requestId?: string; released: boolean } {
    const requestId = getRequestMetadata(config)?.requestId;
    if (!requestId) {
      return { released: false };
    }

    const released = this.removeById(requestId);

    return {
      requestId,
      released,
    };
  }

  public removeById(requestId: string): boolean {
    const controller = this.activeRequests.get(requestId);
    if (!controller) {
      return false;
    }

    this.releaseAbortSignalLink(controller);
    this.activeRequests.delete(requestId);
    this.activeConfigs.delete(requestId);
    return true;
  }

  public cancelRequest(requestId: string): void {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      const wasQueued = this.options.requestQueue.cancelQueuedRequest(requestId);
      this.options.logger.debug('Cancelling request', {
        requestId,
        wasActive: true,
        wasQueued,
      });
      controller.abort();
      this.removeById(requestId);
      this.options.onRequestCancelled(requestId);
    }

    this.options.retryScheduler.cancelRetryTimer(requestId);
  }

  public cancelAllRequests(): void {
    const timerStats = this.options.retryScheduler.getTimerStats();
    this.options.logger.warn('Cancelling all requests', {
      activeCount: this.activeRequests.size,
      queuedCount: this.options.requestQueue.getWaitingCount(),
      activeRetryTimers: timerStats.activeRetryTimers,
    });

    this.activeRequests.forEach((controller, requestId) => {
      controller.abort();
      this.releaseAbortSignalLink(controller);
      this.options.requestQueue.cancelQueuedRequest(requestId);
      this.options.onRequestCancelled(requestId);
    });
    this.activeRequests.clear();
    this.activeConfigs.clear();

    this.options.retryScheduler.cancelAllRetryTimers();
  }

  public cancelQueuedRequests(): void {
    this.activeRequests.forEach((_, requestId) => {
      const wasCancelled = this.options.requestQueue.cancelQueuedRequest(requestId);
      if (wasCancelled) {
        this.options.onRequestCancelled(requestId);
      }
    });
  }

  public getActiveCount(): number {
    return this.activeRequests.size;
  }

  public getActiveRequests(): Map<string, TrackedRequestController> {
    return this.activeRequests;
  }

  private generateRequestId(): string {
    const counter = ++this.requestIndex;
    const cryptoApi =
      typeof globalThis !== 'undefined' && typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;

    if (typeof cryptoApi?.randomUUID === 'function') {
      return `req_${cryptoApi.randomUUID()}`;
    }

    if (typeof cryptoApi?.getRandomValues === 'function') {
      const values = cryptoApi.getRandomValues(new Uint32Array(2));
      return `req_${values[0].toString(36)}${values[1].toString(36)}_${counter.toString(36)}`;
    }

    return `req_${Date.now().toString(36)}_${counter.toString(36)}`;
  }

  private linkCallerAbortSignal(
    requestId: string,
    controller: TrackedRequestController,
    callerSignal: CallerAbortSignal,
  ): void {
    const abortFromCaller = (): void => {
      controller.abort((callerSignal as AbortSignal & { reason?: unknown }).reason);
      this.options.requestQueue.cancelQueuedRequest(requestId);
      this.options.retryScheduler.cancelRetryTimer(requestId);
    };

    if (callerSignal.aborted) {
      abortFromCaller();
      return;
    }

    if (typeof callerSignal.addEventListener !== 'function' || typeof callerSignal.removeEventListener !== 'function') {
      return;
    }

    const addEventListener = callerSignal.addEventListener.bind(callerSignal);
    const removeEventListener = callerSignal.removeEventListener.bind(callerSignal);

    addEventListener('abort', abortFromCaller, { once: true });
    controller.__disposeSignalLink = () => {
      removeEventListener('abort', abortFromCaller);
      delete controller.__disposeSignalLink;
    };
  }

  private releaseAbortSignalLink(controller: TrackedRequestController): void {
    controller.__disposeSignalLink?.();
  }
}
