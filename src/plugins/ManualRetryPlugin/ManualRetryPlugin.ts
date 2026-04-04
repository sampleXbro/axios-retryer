'use strict';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import type { RetryPlugin, RequestStore } from '../../types';
import type { RetryManager } from '../../core/RetryManager';
import { InMemoryRequestStore } from '../../store/InMemoryRequestStore';
import { getRequestMetadata, setRequestMetadataValue } from '../../utils/requestMetadata';

const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options']);
const AUTH_HEADERS_TO_STRIP = ['authorization', 'x-auth-token', 'x-api-key'];

/**
 * Options for the ManualRetryPlugin.
 */
export interface ManualRetryPluginOptions {
  /**
   * Maximum number of requests to store for later retry.
   * @default 200
   */
  maxRequestsToStore?: number;

  /**
   * Maximum age (in milliseconds) of stored failed requests eligible for manual retry.
   * Requests older than this are discarded when `retryFailedRequests()` is called.
   * @default 300000 (5 minutes)
   */
  manualRetryMaxAge?: number;

  /**
   * Whether to store non-idempotent requests (POST, PUT, PATCH, DELETE) for manual retry.
   * When `false`, only GET, HEAD, and OPTIONS requests are stored; non-idempotent
   * requests are stored only if they carry an `Idempotency-Key` header.
   * @default false
   */
  storeNonIdempotent?: boolean;

  /**
   * Called before each stored request is replayed during manual retry.
   * Return the (optionally modified) config to proceed, or `null` to skip this request.
   */
  beforeRetry?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;

  /**
   * Custom request store implementation.
   * Defaults to the built-in InMemoryRequestStore.
   */
  requestStore?: RequestStore;
}

/**
 * Plugin that stores failed requests and allows replaying them later via `retryFailedRequests()`.
 *
 * Listens to the `onFailure` event to capture terminal failures, strips auth headers
 * before storage, and re-applies them from the axios instance defaults on replay.
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
export class ManualRetryPlugin implements RetryPlugin {
  public name = 'ManualRetryPlugin';
  public version = '1.0.0';

  private manager!: RetryManager;
  private store!: RequestStore;
  private readonly maxRequestsToStore: number;
  private readonly maxAge: number;
  private readonly storeNonIdempotent: boolean;
  private readonly beforeRetryCallback?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  private readonly customStore?: RequestStore;
  private onFailureHandler!: (config: AxiosRequestConfig) => void;

  constructor(options: ManualRetryPluginOptions = {}) {
    this.maxRequestsToStore = options.maxRequestsToStore ?? 200;
    this.maxAge = options.manualRetryMaxAge ?? 5 * 60 * 1000;
    this.storeNonIdempotent = options.storeNonIdempotent ?? false;
    this.beforeRetryCallback = options.beforeRetry;
    this.customStore = options.requestStore;
  }

  public initialize(manager: RetryManager): void {
    this.manager = manager;
    this.store = this.customStore ?? new InMemoryRequestStore(
      this.maxRequestsToStore,
      manager.triggerAndEmit,
    );

    this.onFailureHandler = (config: AxiosRequestConfig) => {
      if (this.isEligible(config)) {
        const storedConfig: AxiosRequestConfig = {
          ...config,
          headers: config.headers ? { ...config.headers } : {},
        };
        this.stripAuthHeaders(storedConfig);
        this.store.add(storedConfig);
      }
    };

    manager.on('onFailure', this.onFailureHandler);
  }

  public onBeforeDestroyed(manager: RetryManager): void {
    manager.off('onFailure', this.onFailureHandler);
  }

  /**
   * Retries all stored failed requests that have not expired.
   * Requests older than `manualRetryMaxAge` are discarded.
   *
   * @returns Array of successful responses.
   */
  public async retryFailedRequests<T = unknown>(): Promise<AxiosResponse<T>[]> {
    const allStored = this.store.getAll();
    this.store.clear();

    const now = Date.now();
    const failedRequests = allStored.filter((config) => {
      const age = now - (getRequestMetadata(config)?.timestamp || 0);
      if (age > this.maxAge) {
        this.manager.getLogger()?.debug('[ManualRetryPlugin] Discarding expired stored request', {
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

    this.manager.getLogger()?.debug('[ManualRetryPlugin] Starting manual retry process', {
      count: failedRequests.length,
      discarded: allStored.length - failedRequests.length,
    });
    this.manager.triggerAndEmit('onManualRetryProcessStarted');

    const results: AxiosResponse<T>[] = [];
    for (let i = 0; i < failedRequests.length; i++) {
      const config = failedRequests[i];

      const transformedConfig = this.beforeRetryCallback ? this.beforeRetryCallback(config) : config;
      if (!transformedConfig) {
        this.manager.getLogger()?.debug('[ManualRetryPlugin] Request skipped by beforeRetry callback', {
          requestId: getRequestMetadata(config)?.requestId,
        });
        continue;
      }

      this.reApplyAuthHeaders(transformedConfig);
      delete transformedConfig.signal;
      setRequestMetadataValue(transformedConfig, 'retryAttempt', 0);
      setRequestMetadataValue(transformedConfig, 'isRetrying', false);

      if (i > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200 * i, 2000)));
      }

      const response = await this.manager.axiosInstance.request<T>(transformedConfig);
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
    if (this.storeNonIdempotent) {
      return true;
    }

    const method = (config.method || 'get').toLowerCase();
    if (IDEMPOTENT_METHODS.has(method)) {
      return true;
    }

    return !!config.headers?.['Idempotency-Key'];
  }

  private stripAuthHeaders(config: AxiosRequestConfig): void {
    if (!config.headers) {
      return;
    }

    for (const key of Object.keys(config.headers)) {
      if (AUTH_HEADERS_TO_STRIP.includes(key.toLowerCase())) {
        delete config.headers[key];
      }
    }

    delete config.auth;
  }

  private reApplyAuthHeaders(config: AxiosRequestConfig): void {
    const defaults = this.manager.axiosInstance.defaults;
    if (defaults.headers) {
      const commonHeaders = (defaults.headers as { common?: Record<string, unknown> }).common || {};
      for (const headerName of AUTH_HEADERS_TO_STRIP) {
        const capitalizedHeaderName = headerName.charAt(0).toUpperCase() + headerName.slice(1);
        const topLevelHeaders = defaults.headers as Record<string, unknown>;
        const value = commonHeaders[headerName] ?? commonHeaders[capitalizedHeaderName] ?? topLevelHeaders[headerName];
        if (value) {
          config.headers = config.headers || {};
          config.headers[headerName] = value;
        }
      }
    }

    if (defaults.auth) {
      config.auth = defaults.auth;
    }
  }
}
