'use strict';

import type { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';

import { RetryLogger } from '../services/logger';
import type { RequestStore } from '../store/RequestStore';
import { InMemoryRequestStore } from '../store/RequestStore';
import { DefaultRetryStrategy } from './RetryStrategy';
import type {
  AxiosRetryerRequestConfig,
  RetryHooks,
  RetryManagerOptions,
  RetryMode, RetryPlugin,
  RetryStrategy
} from '../types';

/**
 * Manages retries for Axios requests, including manual and automatic modes.
 *
 * @remarks
 * - Automatic retries happen if the `RetryStrategy` deems them retryable and the 'retries' field >= 1.
 * - Manual retries can be triggered by calling {@link RetryManager.retryFailedRequests}.
 */
export class RetryManager {
  private readonly axiosInstance: AxiosInstance;
  private readonly mode: RetryMode;
  private readonly retries: number;
  private readonly throwErrorOnFailedRetries: boolean | undefined;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly debug: boolean;
  private readonly logger: RetryLogger;
  private readonly hooks?: RetryHooks;
  private retryStrategy: RetryStrategy;
  private requestStore: RequestStore;
  private activeRequests: Map<string, AbortController>;
  private requestIndex: number;
  private plugins: Map<string, RetryPlugin>;

  constructor(options: RetryManagerOptions) {
    this.mode = options.mode;
    this.retries = options.retries || 3;
    this.throwErrorOnFailedRetries = options.throwErrorOnFailedRetries ?? true;
    this.retryStrategy = options.retryStrategy ?? new DefaultRetryStrategy();
    this.requestStore = options.requestStore ?? new InMemoryRequestStore();
    this.hooks = options.hooks;
    this.plugins = new Map();
    this.activeRequests = new Map();
    this.throwErrorOnCancelRequest = options.throwErrorOnCancelRequest ?? true;
    this.debug = options.debug ?? false;
    this.logger = new RetryLogger(this.debug);
    this.requestIndex = 0;

    this.axiosInstance = options.axiosInstance || axios.create();
    this.setupInterceptors();
  }

  private generateRequestId(url?: string): string {
    return `${url ?? 'unknown-url'}-${++this.requestIndex}`;
  }

  private setupInterceptors(): void {
    this.axiosInstance.interceptors.request.use(this.onRequest);

    this.axiosInstance.interceptors.response.use(this.onSuccessfulResponse, this.handleError);
  }

  private onRequest = (config: InternalAxiosRequestConfig) => {
    /**
     * Create an AbortController for current request
     * */
    const controller = new AbortController();

    const requestId = this.generateRequestId(config.url);
    (config as AxiosRetryerRequestConfig).__requestId = requestId;
    (config as AxiosRetryerRequestConfig).signal = controller.signal;

    this.activeRequests.set(requestId, controller);
    return config;
  };

  private onSuccessfulResponse = (response: AxiosResponse) => {
    const config = response.config as AxiosRetryerRequestConfig;

    const requestId = config.__requestId;
    if (requestId) {
      this.activeRequests.delete(requestId);
    }

    if (!!config.__retryAttempt) {
      this.triggerHook('afterRetry', config, true);

    }

    return response;
  };

  private handleNoRetriesAction = (config: AxiosRetryerRequestConfig): void => {
    this.triggerHook('onFailure', config);

    this.requestStore.add(config);

    if (config.__requestId) {
      this.activeRequests.delete(config.__requestId);
    }
    if (this.activeRequests.size === 0) {
      const failedRequests = this.requestStore.getAll()?.length ?? 0;

      this.triggerHook('onAllRetriesCompleted', failedRequests);
    }
  };

  private scheduleRetry = <T>(config: AxiosRetryerRequestConfig, maxRetries: number): Promise<AxiosResponse<T>> => {
    const delay = this.retryStrategy.getDelay(Number(config.__retryAttempt), maxRetries);

    this.triggerHook('beforeRetry', config);

    return new Promise((resolve, reject) => {
      const delayTimeout = setTimeout(async () => {
        /**
         * If request is aborted before retry, handle it:
         * */
        if (config.signal?.aborted) {
          clearTimeout(delayTimeout);
          this.handleNoRetriesAction(config);
          /**
           * If throwErrorOnCancelRequest is true, we call reject with Axios Cancel();
           * if false, we resolve silently
           * */
          return this.throwErrorOnCancelRequest
            ? reject(new axios.Cancel(`Request aborted: ${config.url}`))
            : Promise.resolve(`Request aborted: ${config.url}`);
        }

        if (config.__requestId) {
          this.activeRequests.delete(config.__requestId);
        }

        try {
          const res = await this.axiosInstance.request(config);
          clearTimeout(delayTimeout);
          return resolve(res as never);
        } catch (err) {
          clearTimeout(delayTimeout);
          if (this.throwErrorOnFailedRetries && this.activeRequests.size === 0) {
            reject(err);
          }
          return Promise.resolve(err);
        }
      }, delay);
    });
  };

  private handleError = <T>(error: AxiosError): Promise<AxiosResponse<T>> => {
    const config = error.config as AxiosRetryerRequestConfig;
    if (!config) {
      return Promise.reject(error);
    }

    if (config.__isRetrying) {
      this.logger.log(`After retry hook called: RequestID: ${config.__requestId}`);

      this.triggerHook('afterRetry', config, false);
    }
    config.__isRetrying = true;

    const maxRetries = config.__requestRetries || this.retries;
    const requestMode = config.__requestMode || this.mode;
    const attempt = (config.__retryAttempt || 0) + 1;

    const isAutomatic = requestMode === 'automatic';
    const canRetry = isAutomatic && this.retryStrategy.shouldRetry(error, attempt, maxRetries);

    if (canRetry) {
      config.__retryAttempt = attempt;
      this.logger.log(
        `Retry is scheduled: Attempting to retry: ${attempt}; Max retries: ${maxRetries}; RequestID: ${config.__requestId}`,
      );

      return this.scheduleRetry(config, maxRetries);
    }

    /**
     * If we reached here, no more automatic retries.
     * */
    this.logger.log(
      `No more automatic retries left: Max retries: ${maxRetries}; RequestID: ${config.__requestId}`,
    );

    this.handleNoRetriesAction(config);

    return Promise.reject(error);
  };

  /**
   * Trigger a specific plugin hook.
   */
  private triggerHook<K extends keyof RetryHooks>(
      hookName: K,
      ...args: Parameters<NonNullable<RetryHooks[K]>>
  ): void {
    // Trigger the hook if it's defined
    const hook = this.hooks?.[hookName];
    if (hook) {
      (hook as (...args: Parameters<NonNullable<RetryHooks[K]>>) => void)(...args);

      this.logger.log(`Call ${hookName} hook`)
    }

    // Iterate through plugins and trigger their hooks
    this.plugins.forEach((plugin) => {
      const pluginHook = plugin.hooks?.[hookName];
      if (pluginHook) {
        try {
          (pluginHook as (...args: Parameters<NonNullable<RetryHooks[K]>>) => void)(...args);
        } catch (error) {
          this.logger.error(`Error in plugin "${plugin.name}" during "${hookName}" hook: ${error}`, error);
        }
      }
    });
  }

  /**
   * Register a plugin.
   */
  public use(plugin: RetryPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    this.plugins.set(plugin.name, plugin);
    plugin.initialize(this);

    this.logger.log(`Plugin registered: ${plugin.name}@${plugin.version}`);
  }

  /**
   * List all registered plugin names.
   */
  public listPlugins(): string[] {
    const pluginNames: string[] = [];

    this.plugins.forEach(plugin => pluginNames.push(plugin.name));

    return pluginNames;
  }

  /**
   * Manually retry all failed requests currently stored.
   */
  public retryFailedRequests = <T = unknown>(): Promise<AxiosResponse<T>[]> => {
    const failedRequests = this.requestStore.getAll();
    this.requestStore.clear();

    const promises = failedRequests.map((config) => {
      // Reset attempts before new request
      config.__retryAttempt = 1;
      return this.axiosInstance.request(config);
    });
    return Promise.all(promises);
  };

  /**
   * Access the internal axios instance to make requests.
   */
  public getAxiosInstance = (): AxiosInstance => {
    return this.axiosInstance;
  };

  /**
   * Cancel a specific request by ID
   * */
  public cancelRequest = (requestId: string): void => {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(requestId);
      this.logger.log(`Request ${requestId} cancelled.`);
    }
  };

  /**
   * Cancel all ongoing requests
   * */
  public cancelAllRequests = (): void => {
    this.activeRequests.forEach((controller, requestId) => {
      controller.abort();
      this.logger.log(`Request ${requestId} cancelled.`);
    });
    this.activeRequests.clear();
  };
}
