import type { AxiosRequestConfig } from 'axios';

import type { AxiosRetryerRequestPriority } from '../types';
import { getRequestMetadata } from '../utils/requestMetadata';
import type { RequestQueue } from './requestQueue';
import type { RequestLifecycleManager } from './RequestLifecycleManager';

export interface DependencyGatekeeperOptions {
  blockingPriorityThreshold?: AxiosRetryerRequestPriority;
  cancelPendingOnDependencyFailure: boolean;
  requestQueue: RequestQueue;
  requestLifecycle: RequestLifecycleManager;
  emitEvent: (event: string, ...args: unknown[]) => void;
}

export class DependencyGatekeeper {
  private readonly blockingRequestIds = new Set<string>();
  private readonly blockingPriorityThreshold?: AxiosRetryerRequestPriority;
  private readonly cancelPendingOnDependencyFailure: boolean;
  private readonly requestQueue: RequestQueue;
  private readonly requestLifecycle: RequestLifecycleManager;
  private readonly emitEvent: (event: string, ...args: unknown[]) => void;

  constructor(options: DependencyGatekeeperOptions) {
    this.blockingPriorityThreshold = options.blockingPriorityThreshold;
    this.cancelPendingOnDependencyFailure = options.cancelPendingOnDependencyFailure;
    this.requestQueue = options.requestQueue;
    this.requestLifecycle = options.requestLifecycle;
    this.emitEvent = options.emitEvent;

    if (this.blockingPriorityThreshold !== undefined) {
      this.requestQueue.registerProcessingGate(
        '__blocking',
        (cfg) => this.blockingRequestIds.size === 0 || this.isBlockingRequest(cfg),
      );
    }
  }

  public trackIfBlocking(config: AxiosRequestConfig): void {
    if (this.isBlockingRequest(config)) {
      const requestId = getRequestMetadata(config)?.requestId;
      if (requestId) {
        this.blockingRequestIds.add(requestId);
      }
    }
  }

  public handleRequestCancelled(requestId: string): void {
    const wasTracked = this.blockingRequestIds.delete(requestId);
    if (wasTracked && this.blockingRequestIds.size === 0) {
      this.requestQueue.refresh();
    }
  }

  public finishBlockingRequest(config: AxiosRequestConfig, outcome: 'success' | 'failure' | 'cancel'): void {
    const requestId = getRequestMetadata(config)?.requestId;
    if (!requestId) return;

    const wasTracked = this.blockingRequestIds.delete(requestId);
    if (!wasTracked && outcome !== 'failure') return;

    if (outcome === 'failure' && this.isBlockingRequest(config)) {
      this.emitEvent('onBlockingRequestFailed', config);
      if (this.cancelPendingOnDependencyFailure) {
        this.requestLifecycle.cancelQueuedRequests();
      }
    }

    if (wasTracked && this.blockingRequestIds.size === 0) {
      this.requestQueue.refresh();
      if (outcome === 'success') {
        this.emitEvent('onAllBlockingRequestsResolved');
      }
    }
  }

  private isBlockingRequest(config: AxiosRequestConfig): boolean {
    if (this.blockingPriorityThreshold === undefined) return false;
    const priority = getRequestMetadata(config)?.priority;
    return priority !== undefined && priority >= this.blockingPriorityThreshold;
  }
}
