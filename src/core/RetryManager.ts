'use strict';

import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';

import { RetryLogger } from '../services/logger';
import { InMemoryRequestStore } from '../store/InMemoryRequestStore';
import type {
  AxiosRetryerMetrics,
  AxiosRetryerRequestPriority,
  RequestStore,
  RetryHooks,
  RetryManagerOptions,
  RetryMode,
  RetryPlugin,
  RetryStrategy,
} from '../types';
import { AXIOS_RETRYER_REQUEST_PRIORITIES, RETRY_MODES } from '../types';
import { DefaultRetryStrategy } from './DefaultRetryStrategy';
import { RequestQueue } from './requestQueue';

// Default configuration constants
const DEFAULT_CONFIG = {
  MODE: RETRY_MODES.AUTOMATIC,
  RETRIES: 3,
  THROW_ON_FAILED_RETRIES: true,
  THROW_ON_CANCEL: true,
  DEBUG: false,
} as const;

interface ExtendedAbortController extends AbortController {
  priority: number;
}

/**
 * Manages retries for Axios requests, including manual and automatic modes.
 *
 * @remarks
 * - Automatic retries happen if the `RetryStrategy` deems them retryable and the 'retries' field >= 1.
 * - Manual retries can be triggered by calling {@link RetryManager.retryFailedRequests}.
 */
export class RetryManager {
  private readonly axiosInternalInstance: AxiosInstance;
  private readonly mode: RetryMode;
  private readonly retries: number;
  private readonly throwErrorOnFailedRetries: boolean;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly debug: boolean;
  private readonly logger: RetryLogger;
  private readonly hooks?: RetryHooks;
  private readonly blockingQueueThreshold: AxiosRetryerRequestPriority | undefined;
  private readonly metrics: AxiosRetryerMetrics;
  private inRetryProgress: boolean;
  private retryStrategy: RetryStrategy;
  private requestStore: RequestStore;
  private activeRequests: Map<string, ExtendedAbortController>;
  private requestIndex: number;
  private plugins: Map<string, RetryPlugin>;

  private requestQueue: RequestQueue;

  constructor(options: RetryManagerOptions) {
    this.validateOptions(options);

    this.mode = options.mode ?? DEFAULT_CONFIG.MODE;
    this.retries = options.retries ?? DEFAULT_CONFIG.RETRIES;
    this.throwErrorOnFailedRetries = options.throwErrorOnFailedRetries ?? DEFAULT_CONFIG.THROW_ON_FAILED_RETRIES;
    this.throwErrorOnCancelRequest = options.throwErrorOnCancelRequest ?? DEFAULT_CONFIG.THROW_ON_CANCEL;
    this.retryStrategy =
      options.retryStrategy ??
      new DefaultRetryStrategy(options.retryableStatuses, options.retryableMethods, options.backoffType);
    this.requestStore = new InMemoryRequestStore(
      options.maxRequestsToStore || 200,
      options.hooks?.onRequestRemovedFromStore,
    );
    this.hooks = options.hooks;
    this.activeRequests = new Map();
    this.debug = options.debug ?? DEFAULT_CONFIG.DEBUG;
    this.logger = new RetryLogger(this.debug);
    this.requestIndex = 0;
    this.plugins = new Map();
    this.inRetryProgress = false;
    this.requestQueue = new RequestQueue(
      options.maxConcurrentRequests || 5,
      options.queueDelay,
      this.checkCriticalRequests,
      options.blockingQueueThreshold,
    );
    this.blockingQueueThreshold = options.blockingQueueThreshold;

    this.axiosInternalInstance = options.axiosInstance || this.createAxiosInstance();

    this.metrics = new Proxy<AxiosRetryerMetrics>({
      totalRequests: 0,
      successfulRetries: 0,
      failedRetries: 0,
      completelyFailedRequests: 0,
      canceledRequests: 0,
    }, {
      get: (target, prop, receiver) => {
        return Reflect.get(target, prop, receiver);
      },
      set: (target, prop, value, receiver) => {
        const success = Reflect.set(target, prop, value, receiver);
        this.hooks?.onMetricsUpdated?.(target);
        return success;
      },
    });

    this.setupInterceptors();
  }

  private validateOptions(options: RetryManagerOptions): void {
    if (options.retries !== undefined && options.retries < 0) {
      throw new Error('Retries must be a non-negative number');
    }
  }

  private createAxiosInstance(): AxiosInstance {
    return axios.create({
      timeout: 30000, // Default timeout
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  private generateRequestId(url?: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${url ?? 'unknown'}-${timestamp}-${random}-${++this.requestIndex}`;
  }

  private setupInterceptors(): void {
    this.axiosInternalInstance.interceptors.request.use(
      this.onRequest as (
        value: InternalAxiosRequestConfig<unknown>,
      ) => InternalAxiosRequestConfig<unknown> | Promise<InternalAxiosRequestConfig<unknown>>,
      this.onRequestError,
    );

    this.axiosInternalInstance.interceptors.response.use(this.onSuccessfulResponse, this.handleError);
  }

  private onRequestError = (error: AxiosError): Promise<AxiosError> => {
    this.logger.error('Request interceptor error:', error);
    return Promise.reject(error);
  };

  private onRequest = (config: AxiosRequestConfig) => {
    const controller = new AbortController() as ExtendedAbortController;
    const requestId = config.__requestId ?? this.generateRequestId(config.url);

    config.__requestId = requestId;
    config.__timestamp = Date.now();
    config.__priority = config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    config.signal = controller.signal;
    controller.priority = config.__priority;

    this.activeRequests.set(requestId, controller);
    this.metrics.totalRequests++;

    return this.requestQueue.enqueue(config);
  };

  private handleRetryProcessFinish = (): void => {
    if (this.activeRequests.size === 0 && this.inRetryProgress) {
      this.metrics.completelyFailedRequests = this.requestStore.getAll()?.length ?? 0;
      this.triggerHook('onRetryProcessFinished', this.metrics);
      this.inRetryProgress = false;
    }
  };

  private onSuccessfulResponse = (response: AxiosResponse): AxiosResponse => {
    const config = response.config;
    const requestId = config.__requestId;

    if (requestId) {
      this.activeRequests.delete(requestId);
    }

    if (config.__isRetrying) {
      this.metrics.successfulRetries++;
      this.triggerHook('afterRetry', config, true);
      config.__isRetrying = false;
    }

    this.requestQueue.markComplete();

    this.handleRetryProcessFinish();
    return response;
  };

  private async scheduleRetry(
    config: AxiosRequestConfig,
    attempt: number,
    maxRetries: number,
  ): Promise<AxiosResponse> {
    if (!this.inRetryProgress) {
      this.triggerHook('onRetryProcessStarted');
      this.inRetryProgress = true;
    }

    config.__retryAttempt = attempt;
    config.__isRetrying = true;

    this.logger.log(
      `Retry scheduled: Priority: ${config.__priority}; Attempt: ${attempt}/${maxRetries}; RequestID: ${config.__requestId}`,
    );

    this.triggerHook('beforeRetry', config);

    const delay = this.retryStrategy.getDelay(Number(config.__retryAttempt), maxRetries);

    await this.sleep(delay);

    if (config.signal?.aborted) {
      this.metrics.canceledRequests++;
      return this.handleCancelAction(config);
    }

    if (config.__requestId) {
      this.activeRequests.delete(config.__requestId);
    }

    return this.axiosInternalInstance.request(config);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private handleCancelAction(config: AxiosRequestConfig): Promise<never> {
    config.__isRetrying = false;

    this.handleRetryProcessFinish();

    return this.throwErrorOnCancelRequest
      ? Promise.reject(`Request aborted. ID: ${config.__requestId}`)
      : Promise.resolve(null as never);
  }

  private handleError = async (error: AxiosError): Promise<AxiosResponse | null> => {
    let cancelled = false;
    const config = error.config;

    if (!config || Object.values(config).length === 0) {
      return Promise.reject(error);
    }

    if (error.code === 'REQUEST_CANCELED') {
      cancelled = true;
    }

    this.requestQueue.markComplete();

    if (config.__isRetrying) {
      this.metrics.failedRetries++;
      this.triggerHook('afterRetry', config, false);
    }

    config.__priority = config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    const maxRetries = config.__requestRetries || this.retries;
    const requestMode = config.__requestMode || this.mode;
    const attempt = (config.__retryAttempt || 0) + 1;

    if (
      !cancelled &&
      requestMode === RETRY_MODES.AUTOMATIC &&
      this.retryStrategy.shouldRetry(error, attempt, maxRetries)
    ) {
      return this.scheduleRetry(config, attempt, maxRetries);
    }

    return this.handleNoRetriesAction(error, this.retryStrategy.getIsRetryable(error));
  };

  private handleNoRetriesAction(error: AxiosError, shouldStore = true): Promise<null> {
    const config = error.config as AxiosRequestConfig;
    config.__isRetrying = false;

    this.triggerHook('onFailure', config);

    if (shouldStore) {
      this.requestStore.add(config);
    }

    if (config.__requestId) {
      this.activeRequests.delete(config.__requestId);
    }

    this.handleRetryProcessFinish();

    // eslint-disable-next-line eqeqeq
    if (this.blockingQueueThreshold != undefined && Number(config.__priority) >= this.blockingQueueThreshold) {
      this.triggerHook('onCriticalRequestFailed');
      this.activeRequests.forEach((_, requestId) => {
        this.requestQueue.cancelQueuedRequest(requestId);
      });
    }

    return this.throwErrorOnFailedRetries ? Promise.reject(error) : Promise.resolve(null);
  }

  private triggerHook<K extends keyof RetryHooks>(hookName: K, ...args: Parameters<NonNullable<RetryHooks[K]>>): void {
    try {
      // Core hooks
      const hook = this.hooks?.[hookName];
      if (hook) {
        (hook as (...args: Parameters<NonNullable<RetryHooks[K]>>) => void)(...args);
      }

      // Plugin hooks
      this.plugins.forEach((plugin) => {
        const pluginHook = plugin.hooks?.[hookName];
        if (pluginHook) {
          (pluginHook as (...args: Parameters<NonNullable<RetryHooks[K]>>) => void)(...args);
        }
      });

      this.logger.log(`Hook "${hookName}" executed`, (args[0] as any)?.__requestId ?? args[0]);
    } catch (error) {
      this.logger.error(`Error executing "${hookName}" hook:`, error);
    }
  }

  private checkCriticalRequests = (): boolean => {
    let has = false;

    this.activeRequests.forEach((r) => {
      // eslint-disable-next-line eqeqeq
      if (this.blockingQueueThreshold != undefined && Number(r.priority) >= this.blockingQueueThreshold) {
        has = true;
      }
    });

    return has;
  };

  private validatePluginVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+$/.test(version);
  }

  // Public Methods

  /**
   * Register a plugin with version validation.
   */
  public use = (plugin: RetryPlugin): void => {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    if (!this.validatePluginVersion(plugin.version)) {
      throw new Error(`Invalid plugin version format: ${plugin.version}`);
    }

    this.plugins.set(plugin.name, plugin);
    plugin.initialize(this);

    this.logger.log(`Plugin registered: ${plugin.name}@${plugin.version}`);
  };

  /**
   * Get currently registered plugins.
   */
  public listPlugins = (): { name: string; version: string }[] => {
    return Array.from(this.plugins.values()).map(({ name, version }) => ({ name, version }));
  };

  /**
   * Retry all failed requests with exponential backoff.
   */
  public async retryFailedRequests<T = unknown>(): Promise<AxiosResponse<T>[]> {
    const failedRequests = this.requestStore.getAll();

    this.requestStore.clear();

    return Promise.all(
      failedRequests.map(async (config) => {
        config.__retryAttempt = 1;
        return this.scheduleRetry(config, config.__retryAttempt, config.__requestRetries || this.retries);
      }),
    );
  }

  /**
   * Get metrics about retry operations.
   */
  public getMetrics = () => {
    return { ...this.metrics };
  };

  /**
   * Get the axios instance for making requests.
   */
  public get axiosInstance(): AxiosInstance {
    return this.axiosInternalInstance;
  };

  /**
   * Cancel a specific request.
   */
  public cancelRequest = (requestId: string): void => {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(requestId);
      this.metrics.canceledRequests++;
      this.requestQueue.cancelQueuedRequest(requestId);
      this.logger.log(`Request ${requestId} cancelled.`);
      this.hooks?.onRequestCancelled?.(requestId);
    }
  };

  /**
   * Cancel all ongoing requests.
   */
  public cancelAllRequests = (): void => {
    this.activeRequests.forEach((controller, requestId) => {
      controller.abort();
      this.metrics.canceledRequests++;
      this.requestQueue.cancelQueuedRequest(requestId);
      this.logger.log(`Request ${requestId} cancelled.`);
      this.hooks?.onRequestCancelled?.(requestId);
    });
    this.activeRequests.clear();
  };
}
