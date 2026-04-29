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

type CancelAllRequestsOptions = {
  includeQueued?: boolean;
  preservedQueuedRequestIds?: ReadonlySet<string>;
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
    // Prefer caller-supplied correlationId (e.g. propagated from upstream tracing).
    // Otherwise fall back to an X-Correlation-Id request header, then to requestId.
    const correlationId = metadata?.correlationId ?? readCorrelationHeader(config) ?? requestId;
    const callerSignal = config.signal;

    assignRequestMetadata(config, {
      requestId,
      correlationId,
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

  public cancelAllRequests(options: CancelAllRequestsOptions = {}): void {
    const includeQueued = options.includeQueued ?? true;
    const preservedQueuedRequestIds = options.preservedQueuedRequestIds;
    const timerStats = this.options.retryScheduler.getTimerStats();
    this.options.logger.warn('Cancelling all requests', {
      activeCount: this.activeRequests.size,
      queuedCount: this.options.requestQueue.getWaitingCount(),
      activeRetryTimers: timerStats.activeRetryTimers,
      includeQueued,
    });

    this.activeRequests.forEach((controller, requestId) => {
      this.releaseAbortSignalLink(controller);
      if (
        !includeQueued &&
        (preservedQueuedRequestIds?.has(requestId) || this.options.requestQueue.hasQueuedRequest(requestId))
      ) {
        return;
      }

      controller.abort();
      if (includeQueued) {
        this.options.requestQueue.cancelQueuedRequest(requestId);
      }
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

const CORRELATION_HEADER_NAMES = ['x-correlation-id', 'x-request-id'];

function readCorrelationHeader(config: AxiosRequestConfig): string | undefined {
  const headers = config.headers;
  if (!headers) return undefined;

  // AxiosHeaders is a class — its keys aren't enumerable via Object.entries.
  const axiosHeaders = headers as { get?: (name: string) => unknown };
  if (typeof axiosHeaders.get === 'function') {
    for (const name of CORRELATION_HEADER_NAMES) {
      const value = axiosHeaders.get(name);
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number') return String(value);
    }
    return undefined;
  }

  // Fallback for plain-object header maps.
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (CORRELATION_HEADER_NAMES.includes(key.toLowerCase())) {
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number') return String(value);
    }
  }
  return undefined;
}
