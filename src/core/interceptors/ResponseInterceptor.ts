import type { AxiosResponse } from 'axios';

import type { Logger } from '../../types';
import type { DependencyGatekeeper } from '../DependencyGatekeeper';
import type { RequestLifecycleManager } from '../RequestLifecycleManager';
import type { RequestQueue } from '../requestQueue';
import { getRequestMetadata, setRequestMetadataValue } from '../../utils/requestMetadata';

export interface ResponseInterceptorOptions {
  logger: Logger;
  requestLifecycle: RequestLifecycleManager;
  dependencyGatekeeper: DependencyGatekeeper;
  requestQueue: RequestQueue;
  emitEvent: (event: string, ...args: any[]) => void;
  handleRetryProcessFinish: () => void;
}

export class ResponseInterceptorHandler {
  private readonly logger: Logger;
  private readonly requestLifecycle: RequestLifecycleManager;
  private readonly dependencyGatekeeper: DependencyGatekeeper;
  private readonly requestQueue: RequestQueue;
  private readonly emitEvent: (event: string, ...args: any[]) => void;
  private readonly handleRetryProcessFinish: () => void;

  constructor(options: ResponseInterceptorOptions) {
    this.logger = options.logger;
    this.requestLifecycle = options.requestLifecycle;
    this.dependencyGatekeeper = options.dependencyGatekeeper;
    this.requestQueue = options.requestQueue;
    this.emitEvent = options.emitEvent;
    this.handleRetryProcessFinish = options.handleRetryProcessFinish;
  }

  public handleResponse = (response: AxiosResponse): AxiosResponse => {
    const config = response.config;
    const metadata = getRequestMetadata(config);

    if (metadata?.silentlyCancelled) {
      this.logger.debug('Request cancelled without throwing', {
        requestId: metadata.requestId,
      });
      this.handleRetryProcessFinish();
      return null as never;
    }

    const release = this.requestLifecycle.release(config);
    this.requestQueue.markComplete();
    this.dependencyGatekeeper.finishBlockingRequest(config, 'success');

    this.logger.debug('Request succeeded', {
      requestId: release.requestId,
      status: response.status,
      retrying: getRequestMetadata(config)?.isRetrying,
    });

    if (metadata?.isRetrying && metadata.priority !== undefined) {
      this.emitEvent('afterRetry', config, true);
      setRequestMetadataValue(config, 'isRetrying', false);
    }

    this.emitEvent('onRequestSucceeded', {
      requestId: release.requestId,
      config,
      status: response.status,
      attempts: (metadata?.retryAttempt ?? 0) + 1,
    });

    this.handleRetryProcessFinish();
    return response;
  };
}
