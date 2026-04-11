'use strict';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import type { PluginContext, RequestStore, RetryPlugin } from '../../types';
import { InMemoryRequestStore } from '../../store/InMemoryRequestStore';
import { getRequestMetadata, setRequestMetadataValue } from '../../utils/requestMetadata';
import { resolveManualRetryPluginOptions } from './configs';
import type { ManualRetryPluginEvents, ManualRetryPluginOptions } from './types';
import {
  cloneStoredRequest,
  hasSensitiveAuthMaterial,
  isEligibleForManualRetry,
  neutralizeDefaultAuthHeaders,
} from './utils';

export type { ManualRetryPluginEvents, ManualRetryPluginOptions } from './types';

/**
 * Plugin that stores failed requests and allows replaying them later via `retryFailedRequests()`.
 *
 * Listens to the `onFailure` event to capture terminal failures and strips auth headers
 * before storage. Auth material is NOT re-applied on replay unless an explicit
 * `rehydrateAuth` hook is provided, preventing cross-principal replay.
 *
 * @example
 * ```typescript
 * import { ManualRetryPlugin } from 'axios-retryer/plugins/ManualRetryPlugin';
 *
 * const manualRetry = new ManualRetryPlugin({ manualRetryMaxAge: 60_000 });
 * manager.use(manualRetry);
 *
 * // Later, after failures:
 * const results = await manualRetry.retryFailedRequests();
 * ```
 */
export class ManualRetryPlugin implements RetryPlugin<ManualRetryPluginEvents> {
  public name = 'ManualRetryPlugin';
  public version = '1.0.0';
  public readonly _events?: Readonly<ManualRetryPluginEvents>;

  private context!: PluginContext<ManualRetryPluginEvents>;
  private store!: RequestStore;
  private readonly maxRequestsToStore: number;
  private readonly maxAge: number;
  private readonly storeNonIdempotent: boolean;
  private readonly storeAuthRequests: boolean;
  private readonly beforeRetryCallback?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  private readonly prepareRequestForStoreCallback?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  private readonly rehydrateAuthCallback?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  private readonly customStore?: RequestStore;
  private onFailureHandler!: (config: AxiosRequestConfig) => void;

  constructor(options: ManualRetryPluginOptions = {}) {
    const resolvedOptions = resolveManualRetryPluginOptions(options);
    this.maxRequestsToStore = resolvedOptions.maxRequestsToStore;
    this.maxAge = resolvedOptions.manualRetryMaxAge;
    this.storeNonIdempotent = resolvedOptions.storeNonIdempotent;
    this.storeAuthRequests = resolvedOptions.storeAuthRequests;
    this.beforeRetryCallback = resolvedOptions.beforeRetry;
    this.prepareRequestForStoreCallback = resolvedOptions.prepareRequestForStore;
    this.rehydrateAuthCallback = resolvedOptions.rehydrateAuth;
    this.customStore = resolvedOptions.requestStore;
  }

  public initialize(context: PluginContext<ManualRetryPluginEvents>): void {
    this.context = context;
    this.store = this.customStore ?? new InMemoryRequestStore(this.maxRequestsToStore, context.triggerAndEmit);

    this.onFailureHandler = (config: AxiosRequestConfig) => {
      const preparedConfig = this.prepareStoredRequest(config);
      if (preparedConfig) {
        this.store.add(preparedConfig);
      }
    };

    context.on('onFailure', this.onFailureHandler);
  }

  public onBeforeDestroyed(context: PluginContext<ManualRetryPluginEvents>): void {
    context.off('onFailure', this.onFailureHandler);
    this.store?.clear();
  }

  /**
   * Retries all stored failed requests that have not expired.
   * Requests older than `manualRetryMaxAge` are discarded.
   *
   * Replay is fail-fast: if any replayed request fails, the promise rejects
   * with that error and remaining stored requests are not replayed.
   *
   * @returns Array of replay responses.
   */
  public async retryFailedRequests<T = unknown>(): Promise<AxiosResponse<T>[]> {
    const allStored = this.store.getAll();
    this.store.clear();

    const now = Date.now();
    const failedRequests = allStored.filter((config) => {
      const age = now - (getRequestMetadata(config)?.timestamp || 0);
      if (age > this.maxAge) {
        this.context.getLogger()?.debug('[ManualRetryPlugin] Discarding expired stored request', {
          requestId: getRequestMetadata(config)?.requestId,
          ageMs: age,
          maxAgeMs: this.maxAge,
        });
        return false;
      }
      return true;
    });

    if (failedRequests.length === 0) {
      return [];
    }

    this.context.getLogger()?.debug('[ManualRetryPlugin] Starting manual retry process', {
      count: failedRequests.length,
      discarded: allStored.length - failedRequests.length,
    });
    this.context.triggerAndEmit('onManualRetryProcessStarted');

    const results: AxiosResponse<T>[] = [];
    for (let i = 0; i < failedRequests.length; i++) {
      const config = failedRequests[i];

      const transformedConfig = this.beforeRetryCallback ? this.beforeRetryCallback(config) : config;
      if (!transformedConfig) {
        this.context.getLogger()?.debug('[ManualRetryPlugin] Request skipped by beforeRetry callback', {
          requestId: getRequestMetadata(config)?.requestId,
        });
        continue;
      }

      if (this.rehydrateAuthCallback) {
        const rehydrated = this.rehydrateAuthCallback(transformedConfig);
        if (!rehydrated) {
          this.context.getLogger()?.debug('[ManualRetryPlugin] Request skipped by rehydrateAuth callback', {
            requestId: getRequestMetadata(config)?.requestId,
          });
          continue;
        }
      } else {
        // Explicitly neutralize auth headers that Axios would otherwise merge
        // from instance defaults, preventing cross-principal replay.
        this.neutralizeDefaultAuthHeaders(transformedConfig);
      }

      delete transformedConfig.signal;
      setRequestMetadataValue(transformedConfig, 'retryAttempt', 0);
      setRequestMetadataValue(transformedConfig, 'isRetrying', false);
      setRequestMetadataValue(transformedConfig, 'manualReplayAttempt', true);

      if (i > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200 * i, 2000)));
      }

      const response = await this.context.axiosInstance.request<T>(transformedConfig);
      results.push(response);
    }

    return results;
  }

  /**
   * Returns a copy of all currently stored failed requests.
   */
  public getStoredRequests(): AxiosRequestConfig[] {
    return this.store.getAll();
  }

  /**
   * Clears all stored failed requests without retrying them.
   */
  public clearStoredRequests(): void {
    this.store.clear();
  }

  private isEligible(config: AxiosRequestConfig): boolean {
    return isEligibleForManualRetry(config, this.storeNonIdempotent);
  }

  private prepareStoredRequest(config: AxiosRequestConfig): AxiosRequestConfig | null {
    if (getRequestMetadata(config)?.manualReplayAttempt) {
      this.context.getLogger()?.debug('[ManualRetryPlugin] Skipping replay failure to avoid re-storing it', {
        requestId: getRequestMetadata(config)?.requestId,
      });
      return null;
    }

    if (!this.isEligible(config)) {
      return null;
    }

    if (hasSensitiveAuthMaterial(config) && !this.storeAuthRequests) {
      this.context.getLogger()?.debug('[ManualRetryPlugin] Skipping storage for auth-bearing request', {
        requestId: getRequestMetadata(config)?.requestId,
      });
      return null;
    }

    const storedConfig = cloneStoredRequest(config);

    if (!this.prepareRequestForStoreCallback) {
      return storedConfig;
    }

    const preparedConfig = this.prepareRequestForStoreCallback(storedConfig);
    if (!preparedConfig) {
      this.context.getLogger()?.debug('[ManualRetryPlugin] Request skipped by prepareRequestForStore', {
        requestId: getRequestMetadata(config)?.requestId,
      });
    }

    return preparedConfig;
  }

  /**
   * Prevents Axios from merging auth headers from `defaults.headers.common`
   * into the replayed request. Without this, a request that failed under user A
   * could be replayed with user B's token if the defaults changed between
   * failure and replay.
   */
  private neutralizeDefaultAuthHeaders(config: AxiosRequestConfig): void {
    const defaults = this.context.axiosInstance.defaults;
    neutralizeDefaultAuthHeaders(
      config,
      defaults.headers as Record<string, unknown> | undefined,
      Boolean(defaults.auth),
    );
  }
}
