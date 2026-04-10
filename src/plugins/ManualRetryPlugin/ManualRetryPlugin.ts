'use strict';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import type { PluginContext, RequestStore, RetryPlugin } from '../../types';
import { InMemoryRequestStore } from '../../store/InMemoryRequestStore';
import { cloneValue } from '../../utils/clone';
import { getRequestMetadata, setRequestMetadataValue } from '../../utils/requestMetadata';

const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options']);
const SENSITIVE_REPLAY_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-api-key',
  'api-key',
  'apikey',
  'token',
  'refresh-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
] as const;
const SENSITIVE_REPLAY_HEADER_SET = new Set<string>(SENSITIVE_REPLAY_HEADERS);

export interface ManualRetryPluginEvents {
  onManualRetryProcessStarted?: () => void;
  onRequestRemovedFromStore?: (request: AxiosRequestConfig) => void;
}

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
   * Whether requests carrying auth or session material are eligible for storage.
   * When `false`, requests with credentials in headers or `config.auth` are skipped.
   *
   * @default false
   */
  storeAuthRequests?: boolean;

  /**
   * Called before each stored request is replayed during manual retry.
   * Return the (optionally modified) config to proceed, or `null` to skip this request.
   */
  beforeRetry?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;

  /**
   * Called after the plugin has applied its default storage safeguards but before
   * the request is written to the store. Return a modified config to keep it, or
   * `null` to skip storing it entirely.
   */
  prepareRequestForStore?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;

  /**
   * Called during replay to re-attach auth/session headers to the request.
   * When provided, this hook is the only source of auth material on replay —
   * the plugin will NOT read from axios instance defaults.
   *
   * When omitted, replayed requests carry no auth headers (safe default).
   * This prevents cross-principal replay where a failed request is replayed
   * under a different user's session.
   *
   * @example
   * ```ts
   * new ManualRetryPlugin({
   *   rehydrateAuth: (config) => {
   *     config.headers = config.headers || {};
   *     config.headers['Authorization'] = `Bearer ${getCurrentToken()}`;
   *     return config;
   *   },
   * });
   * ```
   */
  rehydrateAuth?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;

  /**
   * Custom request store implementation.
   * Defaults to the built-in InMemoryRequestStore.
   */
  requestStore?: RequestStore;
}

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
    this.maxRequestsToStore = options.maxRequestsToStore ?? 200;
    this.maxAge = options.manualRetryMaxAge ?? 5 * 60 * 1000;
    this.storeNonIdempotent = options.storeNonIdempotent ?? false;
    this.storeAuthRequests = options.storeAuthRequests ?? false;
    this.beforeRetryCallback = options.beforeRetry;
    this.prepareRequestForStoreCallback = options.prepareRequestForStore;
    this.rehydrateAuthCallback = options.rehydrateAuth;
    this.customStore = options.requestStore;
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
    if (this.storeNonIdempotent) {
      return true;
    }

    const method = (config.method || 'get').toLowerCase();
    if (IDEMPOTENT_METHODS.has(method)) {
      return true;
    }

    return this.hasHeader(config, 'Idempotency-Key');
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

    if (this.hasSensitiveAuthMaterial(config) && !this.storeAuthRequests) {
      this.context.getLogger()?.debug('[ManualRetryPlugin] Skipping storage for auth-bearing request', {
        requestId: getRequestMetadata(config)?.requestId,
      });
      return null;
    }

    const storedConfig: AxiosRequestConfig = {
      ...config,
      data: cloneValue(config.data),
      headers: config.headers ? { ...config.headers } : {},
      params: cloneValue(config.params),
    };

    this.stripAuthHeaders(storedConfig);

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

  private hasSensitiveAuthMaterial(config: AxiosRequestConfig): boolean {
    if (config.auth) {
      return true;
    }

    return Object.keys(config.headers ?? {}).some((headerName) =>
      SENSITIVE_REPLAY_HEADER_SET.has(headerName.toLowerCase()),
    );
  }

  private hasHeader(config: AxiosRequestConfig, headerName: string): boolean {
    const target = headerName.toLowerCase();
    return Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === target);
  }

  private stripAuthHeaders(config: AxiosRequestConfig): void {
    if (!config.headers) {
      return;
    }

    for (const key of Object.keys(config.headers)) {
      if (SENSITIVE_REPLAY_HEADER_SET.has(key.toLowerCase())) {
        delete config.headers[key];
      }
    }

    delete config.auth;
  }

  /**
   * Prevents Axios from merging auth headers from `defaults.headers.common`
   * into the replayed request. Without this, a request that failed under user A
   * could be replayed with user B's token if the defaults changed between
   * failure and replay.
   */
  private neutralizeDefaultAuthHeaders(config: AxiosRequestConfig): void {
    const defaults = this.context.axiosInstance.defaults;
    const defaultHeaders = defaults.headers as Record<string, unknown> | undefined;
    const commonHeaders = (defaultHeaders?.common as Record<string, unknown> | undefined) ?? {};

    config.headers = config.headers || {};

    for (const headerName of SENSITIVE_REPLAY_HEADERS) {
      const target = headerName.toLowerCase();
      const hasInCommon = Object.keys(commonHeaders).some((k) => k.toLowerCase() === target);
      const hasInDefaults = defaultHeaders
        ? Object.keys(defaultHeaders).some((k) => k.toLowerCase() === target)
        : false;

      if (hasInCommon || hasInDefaults) {
        // Setting to undefined prevents Axios mergeConfig from adding the default value
        config.headers[headerName] = undefined as unknown as string;
      }
    }

    if (defaults.auth) {
      config.auth = undefined;
    }
  }
}
