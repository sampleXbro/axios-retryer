'use strict';

import type { AxiosRequestConfig } from 'axios';

import type { RetryPlugin, AxiosRetryerRequestPriority, CriticalRequestProvider } from '../../types';
import type { RetryManager } from '../../core/RetryManager';
import { getRequestMetadata } from '../../utils/requestMetadata';

/**
 * Options for the CriticalRequestPlugin.
 */
export interface CriticalRequestPluginOptions {
  /**
   * The priority level threshold for blocking other requests.
   * Requests with priority greater than or equal to this value are considered critical
   * and will block lower-priority requests until they are resolved or retried.
   *
   * @example
   * ```typescript
   * import { AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';
   *
   * blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL
   * ```
   */
  blockingQueueThreshold: AxiosRetryerRequestPriority;

  /**
   * Whether to cancel all queued requests when a critical request fails.
   * @default true
   */
  cancelQueuedOnCriticalFailure?: boolean;
}

/**
 * Plugin that adds critical request support with queue blocking.
 *
 * When a request has a priority at or above the configured threshold, it is
 * considered "critical". While critical requests are active, lower-priority
 * requests are held in the queue. If a critical request fails terminally,
 * queued requests are cancelled (configurable).
 *
 * @example
 * ```typescript
 * import { CriticalRequestPlugin } from 'axios-retryer/plugins/CriticalRequestPlugin';
 * import { AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';
 *
 * const criticalPlugin = new CriticalRequestPlugin({
 *   blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
 * });
 * manager.use(criticalPlugin);
 * ```
 */
export class CriticalRequestPlugin implements RetryPlugin {
  public name = 'CriticalRequestPlugin';
  public version = '1.0.0';

  private manager!: RetryManager;
  private readonly threshold: AxiosRetryerRequestPriority;
  private readonly cancelOnFailure: boolean;
  private readonly criticalRequestIds = new Set<string>();
  private onFailureHandler!: (config: AxiosRequestConfig) => void;

  constructor(options: CriticalRequestPluginOptions) {
    this.threshold = options.blockingQueueThreshold;
    this.cancelOnFailure = options.cancelQueuedOnCriticalFailure ?? true;
  }

  public initialize(manager: RetryManager): void {
    this.manager = manager;

    const provider: CriticalRequestProvider = {
      isCriticalRequest: (config) => this.isCritical(config),
      hasActiveCriticalRequests: () => this.criticalRequestIds.size > 0,
      trackRequestStarted: (requestId, config) => {
        if (this.isCritical(config)) {
          this.criticalRequestIds.add(requestId);
        }
      },
      trackRequestEnded: (requestId) => {
        this.criticalRequestIds.delete(requestId);
      },
      reset: () => {
        this.criticalRequestIds.clear();
      },
    };

    manager.registerCriticalRequestProvider(provider);

    this.onFailureHandler = (config: AxiosRequestConfig) => {
      if (this.isCritical(config)) {
        this.manager.getLogger()?.warn('[CriticalRequestPlugin] Critical request failed', {
          requestId: getRequestMetadata(config)?.requestId,
        });
        manager.triggerAndEmit('onCriticalRequestFailed');
        if (this.cancelOnFailure) {
          manager.cancelQueuedRequests();
        }
      }
    };

    manager.on('onFailure', this.onFailureHandler);
  }

  public onBeforeDestroyed(manager: RetryManager): void {
    manager.off('onFailure', this.onFailureHandler);
    manager.registerCriticalRequestProvider(null);
    this.criticalRequestIds.clear();
  }

  /**
   * Check whether a request config qualifies as critical based on the threshold.
   */
  public isCritical(config: AxiosRequestConfig): boolean {
    const priority = getRequestMetadata(config)?.priority;
    return priority !== undefined && priority >= this.threshold;
  }

  /**
   * Returns the number of currently active critical requests.
   */
  public getActiveCriticalRequestCount(): number {
    return this.criticalRequestIds.size;
  }
}
