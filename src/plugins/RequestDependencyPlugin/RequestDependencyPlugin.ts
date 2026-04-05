'use strict';

import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import type { AxiosRetryerRequestPriority, PluginContext, RetryPlugin } from '../../types';
import { assignRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';

export interface RequestDependencyPluginEvents {
  onBlockingRequestFailed?: (config: AxiosRequestConfig) => void;
  onAllBlockingRequestsResolved?: () => void;
}

/**
 * Options for the RequestDependencyPlugin.
 */
export interface RequestDependencyPluginOptions {
  /**
   * Requests with priority greater than or equal to this value are treated as blockers.
   * While blockers are active, lower-priority requests wait before entering the core queue.
   */
  blockingPriorityThreshold: AxiosRetryerRequestPriority;

  /**
   * Whether pending blocked requests should be canceled when a blocking request fails terminally.
   * @default true
   */
  cancelPendingOnDependencyFailure?: boolean;
}

/**
 * Plugin that adds request dependency gating based on request priority.
 */
export class RequestDependencyPlugin implements RetryPlugin<RequestDependencyPluginEvents> {
  public name = 'RequestDependencyPlugin';
  public version = '1.0.0';

  private context!: PluginContext<RequestDependencyPluginEvents>;
  private requestInterceptorId: number | null = null;
  private responseInterceptorId: number | null = null;
  private readonly blockingRequestIds = new Set<string>();
  private readonly blockingPriorityThreshold: AxiosRetryerRequestPriority;
  private readonly cancelPendingOnDependencyFailure: boolean;
  private onFailureHandler!: (config: AxiosRequestConfig) => void;
  private onRequestCancelledHandler!: (requestId: string) => void;
  private requestIndex = 0;

  constructor(options: RequestDependencyPluginOptions) {
    this.blockingPriorityThreshold = options.blockingPriorityThreshold;
    this.cancelPendingOnDependencyFailure = options.cancelPendingOnDependencyFailure ?? true;
  }

  public initialize(context: PluginContext<RequestDependencyPluginEvents>): void {
    this.context = context;
    context.registerQueueGate(this.name, this.canProcessRequest);
    this.requestInterceptorId = context.axiosInstance.interceptors.request.use(this.handleRequest);
    this.responseInterceptorId = context.axiosInstance.interceptors.response.use(
      this.handleSuccessfulResponse as (value: AxiosResponse<unknown>) => AxiosResponse<unknown>,
    );

    this.onFailureHandler = (config: AxiosRequestConfig) => {
      if (!this.isBlockingRequest(config)) {
        return;
      }

      this.context.getLogger()?.warn('[RequestDependencyPlugin] Blocking request failed', {
        requestId: getRequestMetadata(config)?.requestId,
      });

      this.finishBlockingRequest(config, true);
    };

    this.onRequestCancelledHandler = (requestId: string) => {
      this.finishBlockingRequestById(requestId, false);
    };

    context.on('onFailure', this.onFailureHandler);
    context.on('onRequestCancelled', this.onRequestCancelledHandler);
  }

  public onBeforeDestroyed(context: PluginContext<RequestDependencyPluginEvents>): void {
    context.off('onFailure', this.onFailureHandler);
    context.off('onRequestCancelled', this.onRequestCancelledHandler);
    context.unregisterQueueGate(this.name);

    if (this.requestInterceptorId !== null) {
      context.axiosInstance.interceptors.request.eject(this.requestInterceptorId);
      this.requestInterceptorId = null;
    }

    if (this.responseInterceptorId !== null) {
      context.axiosInstance.interceptors.response.eject(this.responseInterceptorId);
      this.responseInterceptorId = null;
    }

    this.blockingRequestIds.clear();
    context.refreshQueue();
  }

  /**
   * Check whether a request config qualifies as a blocking request based on the threshold.
   */
  public isBlockingRequest(config: AxiosRequestConfig): boolean {
    const priority = getRequestMetadata(config)?.priority;
    return priority !== undefined && priority >= this.blockingPriorityThreshold;
  }

  /**
   * Returns the number of currently active blocking requests.
   */
  public getActiveBlockingRequestCount(): number {
    return this.blockingRequestIds.size;
  }

  private canProcessRequest = (config: AxiosRequestConfig): boolean => {
    return this.blockingRequestIds.size === 0 || this.isBlockingRequest(config);
  };

  private handleRequest = (
    config: InternalAxiosRequestConfig<unknown>,
  ): InternalAxiosRequestConfig<unknown> | Promise<InternalAxiosRequestConfig<unknown>> => {
    const requestId = this.ensureRequestId(config);
    if (this.isBlockingRequest(config)) {
      this.blockingRequestIds.add(requestId);
    }

    return config;
  };

  private handleSuccessfulResponse = <T>(response: AxiosResponse<T> | null): AxiosResponse<T> | null => {
    if (response) {
      this.finishBlockingRequest(response.config, false);
    }

    return response;
  };

  private finishBlockingRequest(config: AxiosRequestConfig, failed: boolean): void {
    const requestId = getRequestMetadata(config)?.requestId;
    if (!requestId) {
      return;
    }

    this.finishBlockingRequestById(requestId, failed, config);
  }

  private finishBlockingRequestById(requestId: string, failed: boolean, config?: AxiosRequestConfig): void {
    const wasTracked = this.blockingRequestIds.delete(requestId);
    if (!wasTracked && !failed) {
      return;
    }

    if (failed && config) {
      this.context.triggerAndEmit('onBlockingRequestFailed', config);

      if (this.cancelPendingOnDependencyFailure) {
        this.context.cancelQueuedRequests();
      }
    }

    if (wasTracked && this.blockingRequestIds.size === 0) {
      this.context.refreshQueue();
      this.context.triggerAndEmit('onAllBlockingRequestsResolved');
    }
  }

  private ensureRequestId(config: AxiosRequestConfig): string {
    const metadata = getRequestMetadata(config);
    if (metadata?.requestId) {
      return metadata.requestId;
    }

    const requestId = this.generateRequestId();
    assignRequestMetadata(config, { requestId });
    return requestId;
  }

  private generateRequestId(): string {
    const counter = ++this.requestIndex;
    return `dep_${Date.now().toString(36)}_${counter.toString(36)}`;
  }
}
