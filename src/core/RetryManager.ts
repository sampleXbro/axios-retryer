'use strict';

import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';

import { RetryLogger } from '../services/logger';
import { InMemoryRequestStore } from '../store/InMemoryRequestStore';
import type {
  AxiosRetryerDetailedMetrics,
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
import { DefaultRetryStrategy } from './strategies/DefaultRetryStrategy';
import { RequestQueue } from './requestQueue';

// Default configuration constants
const DEFAULT_CONFIG = {
  MODE: RETRY_MODES.AUTOMATIC,
  RETRIES: 3,
  THROW_ON_FAILED_RETRIES: true,
  THROW_ON_CANCEL: true,
  DEBUG: false,
  MAX_REQUESTS_TO_STORE: 200,
  MAX_CONCURRENT_REQUESTS: 5,
};

const initialMetrics: AxiosRetryerMetrics = {
  totalRequests: 0,
  successfulRetries: 0,
  failedRetries: 0,
  completelyFailedRequests: 0,
  canceledRequests: 0,
  completelyFailedCriticalRequests: 0,
  errorTypes: {
    network: 0,
    server5xx: 0,
    client4xx: 0,
    cancelled: 0,
  },
  retryAttemptsDistribution: {},
  retryPrioritiesDistribution: {},
  requestCountsByPriority: {},
  queueWaitDuration: 0,
  retryDelayDuration: 0,
};

const initialPriorityMetrics = {
  total: 0,
  successes: 0,
  failures: 0,
};

interface ExtendedAbortController extends AbortController {
  __priority: number;
}

type HookListeners = {
  [K in keyof RetryHooks]?: ((...args: Parameters<NonNullable<RetryHooks[K]>>) => void)[];
};

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
  private listeners: HookListeners = {};

  private requestQueue: RequestQueue;

  constructor(options: RetryManagerOptions = {}) {
    this.validateOptions(options);

    this.debug = options.debug ?? DEFAULT_CONFIG.DEBUG;
    this.logger = new RetryLogger(this.debug);
    this.logger.debug('Initializing RetryManager', {
      options: {
        mode: options.mode,
        retries: options.retries,
        maxConcurrent: options.maxConcurrentRequests,
      },
    });

    this.mode = options.mode ?? DEFAULT_CONFIG.MODE;
    this.retries = options.retries ?? DEFAULT_CONFIG.RETRIES;
    this.throwErrorOnFailedRetries = options.throwErrorOnFailedRetries ?? DEFAULT_CONFIG.THROW_ON_FAILED_RETRIES;
    this.throwErrorOnCancelRequest = options.throwErrorOnCancelRequest ?? DEFAULT_CONFIG.THROW_ON_CANCEL;
    this.retryStrategy =
      options.retryStrategy ??
      new DefaultRetryStrategy(
        options.retryableStatuses,
        options.retryableMethods,
        options.backoffType,
        undefined,
        this.logger,
      );
    this.requestStore = new InMemoryRequestStore(
      options.maxRequestsToStore ?? DEFAULT_CONFIG.MAX_REQUESTS_TO_STORE,
      this.triggerAndEmit,
    );
    this.hooks = options.hooks;
    this.activeRequests = new Map();
    this.requestIndex = 0;
    this.plugins = new Map();
    this.inRetryProgress = false;
    this.requestQueue = new RequestQueue(
      options.maxConcurrentRequests ?? DEFAULT_CONFIG.MAX_CONCURRENT_REQUESTS,
      options.queueDelay,
      this.checkCriticalRequests,
      this.isCriticalRequest,
    );
    this.blockingQueueThreshold = options.blockingQueueThreshold;

    this.axiosInternalInstance = options.axiosInstance || this.createAxiosInstance();

    this.metrics = { ...initialMetrics };

    this.setupInterceptors();

    this.logger.debug('RetryManager initialized successfully');
  }

  private validateOptions(options: RetryManagerOptions): void {
    if (options.retries !== undefined && options.retries < 0) {
      this.logger.error('Invalid retries configuration', { retries: options.retries });
      throw new Error('Retries must be a non-negative number');
    }
  }

  private createAxiosInstance(): AxiosInstance {
    this.logger.debug('Creating default Axios instance');
    return axios.create({
      timeout: 30_000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  private generateRequestId(url?: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    // Truncate URL to first 25 characters for cleaner IDs
    const urlPart = url ? url.substring(0, 40) : 'unknown';
    return `${urlPart}-${timestamp}-${random}-${++this.requestIndex}`;
  }

  private setupInterceptors(): void {
    this.logger.debug('Setting up Axios interceptors');
    this.axiosInternalInstance.interceptors.request.use(
      this.onRequest as (
        value: InternalAxiosRequestConfig<unknown>,
      ) => InternalAxiosRequestConfig<unknown> | Promise<InternalAxiosRequestConfig<unknown>>,
      this.onRequestError,
    );

    this.axiosInternalInstance.interceptors.response.use(this.onSuccessfulResponse, this.handleError);
  }

  private onRequestError = (error: AxiosError): Promise<AxiosError> => {
    this.logger.error('Request interceptor error', {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    return Promise.reject(error);
  };

  private onRequest = async (config: AxiosRequestConfig) => {
    const controller = new AbortController() as ExtendedAbortController;
    const requestId = config.__requestId ?? this.generateRequestId(config.url);

    config.__requestId = requestId;
    config.__timestamp = Date.now();
    config.__priority = config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    config.signal = controller.signal;
    controller.__priority = config.__priority;

    this.activeRequests.set(requestId, controller);
    this.metrics.totalRequests++;

    this.logger.debug('New request created', {
      requestId,
      url: config.url,
      method: config.method?.toUpperCase(),
      priority: config.__priority,
    });

    if (!this.metrics.requestCountsByPriority[config.__priority]) {
      this.metrics.requestCountsByPriority[config.__priority] = 0;
    }
    this.metrics.requestCountsByPriority[config.__priority]++;

    const queueSizeBefore = this.requestQueue.getWaitingCount();
    const promise = await this.requestQueue.enqueue(config);
    const queueWait = Date.now() - config.__timestamp;

    this.logger.debug('Request enqueued', {
      requestId,
      queueWaitMs: queueWait,
      queueSizeBefore,
      queueSizeAfter: this.requestQueue.getWaitingCount(),
    });

    this.metrics.queueWaitDuration += queueWait;

    return promise;
  };

  private handleRetryProcessFinish = (): void => {
    if (this.activeRequests.size === 0 && this.inRetryProgress) {
      const failedRequests = this.requestStore.getAll()?.length ?? 0;
      const failedCritical = this.requestStore.getAll()?.filter(this.isCriticalRequest).length ?? 0;

      this.metrics.completelyFailedRequests += failedRequests;
      this.metrics.completelyFailedCriticalRequests += failedCritical;

      this.logger.debug('Retry process finished', {
        failedRequests,
        failedCriticalRequests: failedCritical,
      });

      this.triggerAndEmit('onRetryProcessFinished', this.getMetrics());
      this.inRetryProgress = false;
    }
  };

  private onSuccessfulResponse = (response: AxiosResponse): AxiosResponse => {
    const config = response.config;
    const requestId = config.__requestId;

    if (requestId) {
      this.activeRequests.delete(requestId);
    }

    this.requestQueue.markComplete();

    this.logger.debug('Request succeeded', {
      requestId,
      status: response.status,
      retrying: config.__isRetrying,
    });

    // eslint-disable-next-line eqeqeq
    if (config.__isRetrying && config.__priority != undefined) {
      this.metrics.successfulRetries++;
      if (!this.metrics.retryPrioritiesDistribution[config.__priority]) {
        this.metrics.retryPrioritiesDistribution[config.__priority] = { ...initialPriorityMetrics };
      }
      this.metrics.retryPrioritiesDistribution[config.__priority].successes++;
      this.triggerAndEmit('afterRetry', config, true);
      config.__isRetrying = false;
    }

    if (this.isCriticalRequest(config) && !this.checkCriticalRequests()) {
      this.triggerAndEmit('onAllCriticalRequestsResolved');
    }

    this.handleRetryProcessFinish();

    this.triggerAndEmit('onMetricsUpdated', this.getMetrics());

    return response;
  };

  private async scheduleRetry(
    config: AxiosRequestConfig,
    attempt: number,
    maxRetries: number,
    cancelledFromQueue = false,
  ): Promise<AxiosResponse> {
    if (!this.inRetryProgress) {
      this.logger.debug('Starting retry process');
      this.triggerAndEmit('onRetryProcessStarted');
      this.inRetryProgress = true;
    }

    config.__retryAttempt = attempt;
    config.__isRetrying = true;

    const delay = this.retryStrategy.getDelay(Number(config.__retryAttempt), maxRetries, config.__backoffType);

    this.logger.debug('Scheduling retry attempt', {
      requestId: config.__requestId,
      attempt,
      maxRetries,
      delayMs: delay,
      backoffType: config.__backoffType || 'default',
    });

    await this.sleep(delay);
    this.metrics.retryDelayDuration += delay;

    this.logger.debug('Executing retry attempt', {
      requestId: config.__requestId,
      timeSinceFirstAttempt: Date.now() - (config.__timestamp || 0),
    });

    if (config.__requestId) {
      this.activeRequests.delete(config.__requestId);
    }

    if (cancelledFromQueue || config.signal?.aborted) {
      this.logger.warn('Retry cancelled', {
        requestId: config.__requestId,
        source: cancelledFromQueue ? 'queue' : 'user',
      });
      this.metrics.canceledRequests++;
      this.metrics.errorTypes.cancelled++;
      cancelledFromQueue && this.requestStore.add(config);
      return this.handleCancelAction(config);
    }

    this.metrics.retryAttemptsDistribution[attempt] = (this.metrics.retryAttemptsDistribution[attempt] ?? 0) + 1;

    this.triggerAndEmit('beforeRetry', config);

    // eslint-disable-next-line eqeqeq
    if (config.__priority != undefined) {
      if (!this.metrics.retryPrioritiesDistribution[config.__priority]) {
        this.metrics.retryPrioritiesDistribution[config.__priority] = { ...initialPriorityMetrics };
      }
      this.metrics.retryPrioritiesDistribution[config.__priority].total++;
    }

    return this.axiosInternalInstance.request(config);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.logger.debug('Sleeping between retries', { durationMs: ms });
      setTimeout(resolve, ms);
    });
  }

  private handleCancelAction(config: AxiosRequestConfig): Promise<never> {
    config.__isRetrying = false;
    this.logger.warn('Handling request cancellation', { requestId: config.__requestId });
    this.handleRetryProcessFinish();

    return this.throwErrorOnCancelRequest
      ? Promise.reject(new Error(`Request aborted. ID: ${config.__requestId}`))
      : Promise.resolve(null as never);
  }

  private handleError = async (error: AxiosError): Promise<AxiosResponse | null> => {
    let cancelledInQueue = false;
    const config = error.config;

    this.triggerAndEmit('onMetricsUpdated', this.getMetrics());

    if (!config || Object.values(config).length === 0) {
      this.logger.error('Handling error without valid config', { error: error.message });
      return Promise.reject(error);
    }

    if (error.code === 'REQUEST_CANCELED') {
      cancelledInQueue = true;
    }

    this.requestQueue.markComplete();

    this.logger.warn('Request failed', {
      requestId: config.__requestId,
      status: error.response?.status,
      code: error.code,
      attempt: config.__retryAttempt || 0,
    });

    // eslint-disable-next-line eqeqeq
    if (!cancelledInQueue && config.__isRetrying && config.__priority != undefined) {
      this.metrics.failedRetries++;
      if (!error.response) {
        this.metrics.errorTypes.network++;
      } else if (error.response.status >= 500) {
        this.metrics.errorTypes.server5xx++;
      } else if (error.response.status >= 400) {
        this.metrics.errorTypes.client4xx++;
      }
      if (!this.metrics.retryPrioritiesDistribution[config.__priority]) {
        this.metrics.retryPrioritiesDistribution[config.__priority] = { ...initialPriorityMetrics };
      }
      this.metrics.retryPrioritiesDistribution[config.__priority].failures++;
      this.triggerAndEmit('afterRetry', config, false);
    }

    config.__priority = config.__priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;
    const maxRetries = config.__requestRetries || this.retries;
    const requestMode = config.__requestMode || this.mode;
    const attempt = (config.__retryAttempt || 0) + 1;

    if (requestMode === RETRY_MODES.AUTOMATIC && this.retryStrategy.shouldRetry(error, attempt, maxRetries)) {
      this.logger.debug('Auto-retrying request', {
        requestId: config.__requestId,
        attempt,
        maxRetries,
      });
      return this.scheduleRetry(config, attempt, maxRetries, cancelledInQueue);
    }

    return this.handleNoRetriesAction(error, this.retryStrategy.getIsRetryable(error));
  };

  private handleNoRetriesAction(error: AxiosError, shouldStore = true): Promise<null> {
    const config = error.config as AxiosRequestConfig;
    config.__isRetrying = false;

    this.logger.warn('Final request failure', {
      requestId: config.__requestId,
      finalAttempt: config.__retryAttempt || 0,
      stored: shouldStore,
    });

    this.triggerAndEmit('onFailure', config);

    if (shouldStore) {
      this.requestStore.add(config);
    }

    if (config.__requestId) {
      this.activeRequests.delete(config.__requestId);
    }

    this.handleRetryProcessFinish();

    if (!error.response) {
      this.triggerAndEmit('onInternetConnectionError', config);
    }

    if (this.isCriticalRequest(config)) {
      this.logger.warn('Critical request failed', { requestId: config.__requestId });
      this.triggerAndEmit('onCriticalRequestFailed');
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
      // eslint-disable-next-line
      this.logger.debug(`Hook "${hookName}" executed`, (args[0] as any)?.__requestId);
    } catch (error) {
      this.logger.error(`Error executing "${hookName}" hook:`, error);
    }
  }

  private isCriticalRequest = (request: AxiosRequestConfig | ExtendedAbortController): boolean => {
    // eslint-disable-next-line eqeqeq
    return this.blockingQueueThreshold != undefined && Number(request.__priority) >= this.blockingQueueThreshold;
  };

  private checkCriticalRequests = (): boolean => {
    let has = false;
    this.activeRequests.forEach((r) => {
      if (this.isCriticalRequest(r)) {
        has = true;
      }
    });
    return has;
  };

  private emit = <K extends keyof RetryHooks>(event: K, ...args: Parameters<NonNullable<RetryHooks[K]>>): void => {
    this.listeners[event]?.forEach((listener) => {
      listener(...args);
    });
  };

  // Public Methods

  public triggerAndEmit = <K extends keyof RetryHooks>(
    event: K,
    ...args: Parameters<NonNullable<RetryHooks[K]>>
  ): void => {
    this.triggerHook(event, ...args);
    this.emit(event, ...args);
  };

  private validatePluginVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+$/.test(version);
  }

  /**
   * Register a plugin with version validation.
   */
  public use = (plugin: RetryPlugin): void => {
    if (this.plugins.has(plugin.name)) {
      this.logger.error('Plugin already registered', { plugin: plugin.name });
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    if (!this.validatePluginVersion(plugin.version)) {
      this.logger.error('Invalid plugin version', { version: plugin.version });
      throw new Error(`Invalid plugin version format: ${plugin.version}`);
    }

    this.plugins.set(plugin.name, plugin);
    plugin.initialize(this);

    this.logger.log('Plugin registered', {
      name: plugin.name,
      version: plugin.version,
    });
  };

  public unuse = (pluginName: string): boolean => {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      this.logger.debug('Plugin removal failed - not found', { pluginName });
      return false;
    }

    if (typeof plugin.onBeforeDestroyed === 'function') {
      plugin.onBeforeDestroyed(this);
    }

    this.plugins.delete(pluginName);
    this.logger.log('Plugin removed', {
      name: plugin.name,
      version: plugin.version,
    });
    return true;
  };

  public getLogger() {
    return this.logger;
  }

  public listPlugins = (): { name: string; version: string }[] => {
    return Array.from(this.plugins.values()).map(({ name, version }) => ({ name, version }));
  };

  public on = <K extends keyof RetryHooks>(
    event: K,
    listener: (...args: Parameters<NonNullable<RetryHooks[K]>>) => void,
  ): RetryManager => {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(listener);
    this.logger.debug('Event listener added', { event });
    return this;
  };

  public off = <K extends keyof RetryHooks>(
    event: K,
    listener: (...args: Parameters<NonNullable<RetryHooks[K]>>) => void,
  ): boolean => {
    const arr = this.listeners[event];
    if (!arr) {
      return false;
    }

    const index = arr.indexOf(listener);
    if (index === -1) {
      return false;
    }

    arr.splice(index, 1);
    if (arr.length === 0) {
      delete this.listeners[event];
    }

    this.logger.debug('Event listener removed', { event });
    return true;
  };

  public retryFailedRequests = async <T = unknown>(): Promise<AxiosResponse<T>[]> => {
    const failedRequests = this.requestStore.getAll();
    this.requestStore.clear();

    if (failedRequests.length > 0) {
      this.logger.debug('Starting manual retry process', { count: failedRequests.length });
      this.triggerAndEmit('onManualRetryProcessStarted');
    }

    return Promise.all(
      failedRequests.map(async (config) => {
        config.__retryAttempt = 1;
        return this.scheduleRetry(config, config.__retryAttempt, config.__requestRetries || this.retries);
      }),
    );
  };

  public get axiosInstance(): AxiosInstance {
    return this.axiosInternalInstance;
  }

  public cancelRequest = (requestId: string): void => {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      const wasQueued = this.requestQueue.cancelQueuedRequest(requestId);
      this.logger.debug('Cancelling request', {
        requestId,
        wasActive: true,
        wasQueued,
      });

      controller.abort();
      this.activeRequests.delete(requestId);
      this.metrics.canceledRequests++;
      this.triggerAndEmit('onRequestCancelled', requestId);
    }
  };

  public cancelAllRequests = (): void => {
    this.logger.warn('Cancelling all requests', {
      activeCount: this.activeRequests.size,
      queuedCount: this.requestQueue.getWaitingCount(),
    });

    this.activeRequests.forEach((controller, requestId) => {
      controller.abort();
      this.metrics.canceledRequests++;
      this.requestQueue.cancelQueuedRequest(requestId);
      this.triggerAndEmit('onRequestCancelled', requestId);
    });
    this.activeRequests.clear();
  };

  public getMetrics = (): AxiosRetryerDetailedMetrics => {
    this.logger.debug('Generating metrics snapshot');
    const totalRetries = this.metrics.failedRetries + this.metrics.successfulRetries;

    return {
      totalRequests: this.metrics.totalRequests,
      successfulRetries: this.metrics.successfulRetries,
      failedRetries: this.metrics.failedRetries,
      completelyFailedRequests: this.metrics.completelyFailedRequests,
      canceledRequests: this.metrics.canceledRequests,
      completelyFailedCriticalRequests: this.metrics.completelyFailedCriticalRequests,
      errorTypesDistribution: this.metrics.errorTypes,
      retryAttemptsDistribution: this.metrics.retryAttemptsDistribution,
      requestCountsByPriority: this.metrics.requestCountsByPriority,
      avgQueueWait: (this.metrics.queueWaitDuration / this.metrics.totalRequests) * 0.001,
      avgRetryDelay: (this.metrics.retryDelayDuration / totalRetries) * 0.001,
      priorityMetrics: Object.entries(this.metrics.retryPrioritiesDistribution).map(([priority, data]) => ({
        priority: Number(priority),
        ...data,
        successRate: data.total > 0 ? (data.successes / data.total) * 100 : 0,
        failureRate: data.total > 0 ? (data.failures / data.total) * 100 : 0,
      })),
    };
  };
}
