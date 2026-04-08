import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

import type { Logger } from '../../types';
import { RequestAbortedError } from '../errors/RequestAbortedError';
import type { DependencyGatekeeper } from '../DependencyGatekeeper';
import type { RequestLifecycleManager } from '../RequestLifecycleManager';
import type { RequestQueue } from '../requestQueue';
import { getRequestMetadata } from '../../utils/requestMetadata';

export interface RequestInterceptorOptions {
  logger: Logger;
  requestLifecycle: RequestLifecycleManager;
  dependencyGatekeeper: DependencyGatekeeper;
  requestQueue: RequestQueue;
  throwErrorOnCancelRequest: boolean;
  createSilentCancelConfig: (config: AxiosRequestConfig, requestId: string) => AxiosRequestConfig;
  emitEvent: (event: string, ...args: unknown[]) => void;
}

export class RequestInterceptorHandler {
  private readonly logger: Logger;
  private readonly requestLifecycle: RequestLifecycleManager;
  private readonly dependencyGatekeeper: DependencyGatekeeper;
  private readonly requestQueue: RequestQueue;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly createSilentCancelConfig: (config: AxiosRequestConfig, requestId: string) => AxiosRequestConfig;
  private readonly emitEvent: (event: string, ...args: unknown[]) => void;

  constructor(options: RequestInterceptorOptions) {
    this.logger = options.logger;
    this.requestLifecycle = options.requestLifecycle;
    this.dependencyGatekeeper = options.dependencyGatekeeper;
    this.requestQueue = options.requestQueue;
    this.throwErrorOnCancelRequest = options.throwErrorOnCancelRequest;
    this.createSilentCancelConfig = options.createSilentCancelConfig;
    this.emitEvent = options.emitEvent;
  }

  public handleRequest = async (
    config: InternalAxiosRequestConfig<unknown>,
  ): Promise<InternalAxiosRequestConfig<unknown>> => {
    const { requestId, priority, callerAborted } = this.requestLifecycle.beginRequest(config);

    if (callerAborted) {
      this.logger.warn('Request aborted before queueing', {
        requestId,
        source: 'caller',
      });
      return this.throwErrorOnCancelRequest
        ? Promise.reject(new RequestAbortedError(requestId))
        : Promise.resolve(this.createSilentCancelConfig(config, requestId) as never);
    }

    this.dependencyGatekeeper.trackIfBlocking(config);

    this.logger.debug('New request created', this.buildRequestLogMeta(config, requestId));

    try {
      const queueStartTime = Date.now();
      const queueSize = this.requestQueue.getWaitingCount() + 1;
      this.emitEvent('onRequestQueued', {
        requestId,
        config,
        priority,
        queueSize,
      });
      const updatedConfig = await this.requestQueue.enqueue(config);
      const queuedForMs = Date.now() - queueStartTime;
      this.emitEvent('onRequestDispatched', {
        requestId,
        config: updatedConfig,
        priority,
        queuedForMs,
      });
      return updatedConfig as InternalAxiosRequestConfig<unknown>;
    } catch (error) {
      this.requestLifecycle.removeById(requestId);

      if (config.signal?.aborted) {
        return this.throwErrorOnCancelRequest
          ? Promise.reject(new RequestAbortedError(requestId))
          : Promise.resolve(this.createSilentCancelConfig(config, requestId) as never);
      }

      this.logger.error('Queue error when enqueuing request', {
        requestId,
        error,
      });
      throw error;
    }
  };

  private buildRequestLogMeta(config: AxiosRequestConfig, requestId: string): Record<string, unknown> {
    return {
      requestId,
      url: this.getLogUrl(config.url),
      method: config.method?.toUpperCase(),
      priority: getRequestMetadata(config)?.priority,
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
}
