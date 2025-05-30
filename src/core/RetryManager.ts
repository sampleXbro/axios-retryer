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
import { sanitizeData, sanitizeHeaders, sanitizeUrl, type SanitizeOptions } from '../utils/sanitize';
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
  ENABLE_SANITIZATION: true,
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

/**
 * Manages timers to prevent accumulation and event loop congestion
 */
class TimerManager {
  private activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private isDestroyed = false;

  /**
   * Creates a cancellable timeout with automatic cleanup
   */
  public createTimeout(callback: () => void, delay: number): { timerId: ReturnType<typeof setTimeout>; cancel: () => void } {
    if (this.isDestroyed) {
      // If destroyed, execute immediately to prevent hanging promises
      callback();
      return { timerId: null as any, cancel: () => {} };
    }

    const timerId = setTimeout(() => {
      this.activeTimers.delete(timerId);
      if (!this.isDestroyed) {
        callback();
      }
    }, delay);

    this.activeTimers.add(timerId);

    return {
      timerId,
      cancel: () => {
        if (this.activeTimers.has(timerId)) {
          clearTimeout(timerId);
          this.activeTimers.delete(timerId);
        }
      }
    };
  }

  /**
   * Creates a cancellable sleep promise
   */
  public createSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    
    const promise = new Promise<void>((resolve, reject) => {
      const { cancel } = this.createTimeout(resolve, ms);
      cancelFn = () => {
        cancel();
        reject(new Error('Sleep cancelled'));
      };
    });

    return { promise, cancel: cancelFn };
  }

  /**
   * Get count of active timers for monitoring
   */
  public getActiveTimerCount(): number {
    return this.activeTimers.size;
  }

  /**
   * Clear all active timers and mark as destroyed
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.activeTimers.forEach(timerId => {
      clearTimeout(timerId);
    });
    this.activeTimers.clear();
  }
}

interface ExtendedAbortController extends AbortController {
  __priority: number;
}

type HookListeners = {
  [K in keyof RetryHooks]?: ((...args: Parameters<NonNullable<RetryHooks[K]>>) => void)[];
};

export class RetryManager {
  private readonly _axiosInstance: AxiosInstance;
  private readonly mode: RetryMode;
  private readonly retries: number;
  private readonly throwErrorOnFailedRetries: boolean;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly debug: boolean;
  private readonly logger: RetryLogger;
  private readonly hooks?: RetryHooks;
  private readonly blockingQueueThreshold: AxiosRetryerRequestPriority | undefined;
  private readonly metrics: AxiosRetryerMetrics;
  private readonly enableSanitization: boolean;
  private readonly sanitizeOptions: SanitizeOptions;
  private inRetryProgress = false;
  private retryStrategy: RetryStrategy;
  private requestStore: RequestStore;
  private activeRequests: Map<string, ExtendedAbortController>;
  private requestIndex = 0;
  private plugins: Map<string, RetryPlugin>;
  private listeners: HookListeners = {};
  private timerManager: TimerManager;
  private activeRetryTimers = new Map<string, () => void>(); // Map of requestId to cancel function

  private requestQueue: RequestQueue;
  private requestInterceptorId: number | null = null;
  private responseInterceptorId: number | null = null;

  constructor(options: RetryManagerOptions = {}) {
    this.validateOptions(options);

    this.debug = options.debug ?? DEFAULT_CONFIG.DEBUG;
    this.logger = new RetryLogger(this.debug);
    this.enableSanitization = options.enableSanitization ?? DEFAULT_CONFIG.ENABLE_SANITIZATION;
    this.sanitizeOptions = options.sanitizeOptions ?? {};
    
    this.logger.debug('Initializing RetryManager', {
      options: {
        mode: options.mode,
        retries: options.retries,
        maxConcurrent: options.maxConcurrentRequests,
        maxQueueSize: options.maxQueueSize,
        enableSanitization: this.enableSanitization,
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
    this.plugins = new Map();
    this.inRetryProgress = false;
    this.requestQueue = new RequestQueue(
      options.maxConcurrentRequests ?? DEFAULT_CONFIG.MAX_CONCURRENT_REQUESTS,
      options.queueDelay,
      this.checkCriticalRequests,
      this.isCriticalRequest,
      options.maxQueueSize,
    );
    this.blockingQueueThreshold = options.blockingQueueThreshold;
    this._axiosInstance = options.axiosInstance || this.createAxiosInstance();
    this.metrics = { ...initialMetrics };

    this.timerManager = new TimerManager();

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
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  private generateRequestId(url?: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const urlPart = url ? url.substring(0, 40) : 'unknown';
    return `${urlPart}-${timestamp}-${random}-${++this.requestIndex}`;
  }

  private setupInterceptors = (): void => {
    this.logger.debug('Setting up Axios interceptors');
    this.requestInterceptorId = this._axiosInstance.interceptors.request.use(
      this.onRequest as (
        value: InternalAxiosRequestConfig<unknown>,
      ) => InternalAxiosRequestConfig<unknown> | Promise<InternalAxiosRequestConfig<unknown>>,
      this.onRequestError,
    );
    this.responseInterceptorId = this._axiosInstance.interceptors.response.use(
      this.onSuccessfulResponse,
      this.handleError,
    );
  };

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
      url: this.enableSanitization ? sanitizeUrl(config.url, this.sanitizeOptions) : config.url,
      method: config.method?.toUpperCase(),
      priority: config.__priority,
      ...(this.debug ? { headers: this.sanitizeForLogging(config.headers) } : {}),
    });

    if (!this.metrics.requestCountsByPriority[config.__priority]) {
      this.metrics.requestCountsByPriority[config.__priority] = 0;
    }
    this.metrics.requestCountsByPriority[config.__priority]++;

    try {
      // Enqueue request and wait for concurrency slot
      const updatedConfig = await this.requestQueue.enqueue(config);
      return updatedConfig;
    } catch (error) {
      // If queue is full, error gets propagated directly to the user
      this.activeRequests.delete(requestId);
      this.logger.error('Queue error when enqueuing request', {
        requestId,
        error,
      });
      throw error;
    }
  };

  private handleRetryProcessFinish = (): void => {
    if (this.activeRequests.size === 0 && this.inRetryProgress) {
      const failed = this.requestStore.getAll() || [];
      const failedRequests = failed.length;
      const failedCritical = failed.filter(this.isCriticalRequest).length;

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

    // Use cancellable sleep from timer manager
    const { promise: sleepPromise, cancel } = this.timerManager.createSleep(delay);
    
    // Store cancel function for this request  
    if (config.__requestId) {
      this.activeRetryTimers.set(config.__requestId, cancel);
    }

    try {
      await sleepPromise;
    } catch (error) {
      // Sleep was cancelled
      if (config.__requestId) {
        this.activeRetryTimers.delete(config.__requestId);
      }
      this.logger.warn('Retry sleep cancelled', { requestId: config.__requestId });
      this.metrics.canceledRequests++;
      this.metrics.errorTypes.cancelled++;
      return this.handleCancelAction(config);
    }

    // Clean up the timer reference
    if (config.__requestId) {
      this.activeRetryTimers.delete(config.__requestId);
    }

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
      if (cancelledFromQueue) this.requestStore.add(config);
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

    return this._axiosInstance.request(config);
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

    this.logger.error('Request failed', {
      requestId: config.__requestId,
      url: this.enableSanitization ? sanitizeUrl(config.url, this.sanitizeOptions) : config.url,
      method: config.method?.toUpperCase(),
      status: error.response?.status,
      statusText: error.response?.statusText,
      code: error.code,
      message: error.message,
      ...(this.debug
        ? {
            headers: this.sanitizeForLogging(config.headers),
            data: this.sanitizeForLogging(config.data),
            response: error.response
              ? {
                  data: this.sanitizeForLogging(error.response.data),
                  headers: this.sanitizeForLogging(error.response.headers),
                }
              : undefined,
          }
        : {}),
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
      const hook = this.hooks?.[hookName];
      if (hook) {
        (hook as (...args: Parameters<NonNullable<RetryHooks[K]>>) => void)(...args);
      }
      this.plugins.forEach((plugin) => {
        const pluginHook = plugin.hooks?.[hookName];
        if (pluginHook) {
          (pluginHook as (...args: Parameters<NonNullable<RetryHooks[K]>>) => void)(...args);
        }
      });
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
  public use = (plugin: RetryPlugin, beforeRetryerInterceptors = true): void => {
    if (this.plugins.has(plugin.name)) {
      this.logger.error('Plugin already registered', { plugin: plugin.name });
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    if (!this.validatePluginVersion(plugin.version)) {
      this.logger.error('Invalid plugin version', { version: plugin.version });
      throw new Error(`Invalid plugin version format: ${plugin.version}`);
    }

    this.plugins.set(plugin.name, plugin);

    if (beforeRetryerInterceptors) {
      if (this.requestInterceptorId !== null) {
        this._axiosInstance.interceptors.request.eject(this.requestInterceptorId);
      }
      if (this.responseInterceptorId !== null) {
        this._axiosInstance.interceptors.response.eject(this.responseInterceptorId);
      }
    }

    plugin.initialize(this);

    if (beforeRetryerInterceptors) {
      this.setupInterceptors();
    }

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
    this.logger.log('Plugin removed', { name: plugin.name, version: plugin.version });
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
    this.listeners[event]?.push(listener);
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
    return this._axiosInstance;
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
    
    // Cancel any active retry timer for this request
    const cancelRetryTimer = this.activeRetryTimers.get(requestId);
    if (cancelRetryTimer) {
      cancelRetryTimer();
      this.activeRetryTimers.delete(requestId);
      this.logger.debug('Cancelled retry timer', { requestId });
    }
  };

  public cancelAllRequests = (): void => {
    this.logger.warn('Cancelling all requests', {
      activeCount: this.activeRequests.size,
      queuedCount: this.requestQueue.getWaitingCount(),
      activeRetryTimers: this.activeRetryTimers.size,
    });
    
    this.activeRequests.forEach((controller, requestId) => {
      controller.abort();
      this.metrics.canceledRequests++;
      this.requestQueue.cancelQueuedRequest(requestId);
      this.triggerAndEmit('onRequestCancelled', requestId);
    });
    this.activeRequests.clear();
    
    // Cancel all active retry timers
    this.activeRetryTimers.forEach((cancelFn, requestId) => {
      cancelFn();
      this.logger.debug('Cancelled retry timer', { requestId });
    });
    this.activeRetryTimers.clear();
  };

  /**
   * Destroy the RetryManager and clean up all resources
   * This will cancel all requests, clear timers, and make the instance unusable
   */
  public destroy = (): void => {
    this.logger.warn('Destroying RetryManager', {
      activeRequests: this.activeRequests.size,
      activeRetryTimers: this.activeRetryTimers.size,
      activeTimers: this.timerManager.getActiveTimerCount(),
    });

    // Cancel all requests and retry timers
    this.cancelAllRequests();
    
    // Destroy the request queue
    this.requestQueue.destroy();
    
    // Destroy the timer manager
    this.timerManager.destroy();
    
    // Clear interceptors
    if (this.requestInterceptorId !== null) {
      this._axiosInstance.interceptors.request.eject(this.requestInterceptorId);
      this.requestInterceptorId = null;
    }
    if (this.responseInterceptorId !== null) {
      this._axiosInstance.interceptors.response.eject(this.responseInterceptorId);
      this.responseInterceptorId = null;
    }
    
    // Clean up plugins
    this.plugins.forEach((plugin, name) => {
      if (typeof plugin.onBeforeDestroyed === 'function') {
        plugin.onBeforeDestroyed(this);
      }
    });
    this.plugins.clear();
    
    // Clear all listeners
    this.listeners = {};
    
    this.logger.log('RetryManager destroyed successfully');
  };

  /**
   * Get timer statistics for monitoring
   */
  public getTimerStats = (): { activeTimers: number; activeRetryTimers: number } => {
    return {
      activeTimers: this.timerManager.getActiveTimerCount(),
      activeRetryTimers: this.activeRetryTimers.size,
    };
  };

  public getMetrics = (): AxiosRetryerDetailedMetrics => {
    this.logger.debug('Generating metrics snapshot');
    const totalRetries = this.metrics.failedRetries + this.metrics.successfulRetries;
    const timerStats = this.getTimerStats();
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
      timerHealth: {
        activeTimers: timerStats.activeTimers,
        activeRetryTimers: timerStats.activeRetryTimers,
        // Health score: 0 = excellent, 100+ = potential issues
        healthScore: timerStats.activeTimers + (timerStats.activeRetryTimers * 2),
      },
    };
  };

  /**
   * Sanitizes any sensitive information in the provided object based on configuration
   */
  private sanitizeForLogging<T>(obj: T): T {
    if (!this.enableSanitization || !obj) return obj;
    
    const sanitized = { ...obj } as any;
    
    if (sanitized.headers) {
      sanitized.headers = sanitizeHeaders(sanitized.headers, this.sanitizeOptions);
    }
    
    if (sanitized.data && this.sanitizeOptions.sanitizeRequestData !== false) {
      sanitized.data = sanitizeData(sanitized.data, this.sanitizeOptions);
    }
    
    if (sanitized.url) {
      sanitized.url = sanitizeUrl(sanitized.url, this.sanitizeOptions);
    }
    
    if (sanitized.baseURL) {
      sanitized.baseURL = sanitizeUrl(sanitized.baseURL, this.sanitizeOptions);
    }
    
    if (sanitized.auth) {
      sanitized.auth = { username: sanitized.auth.username, password: '********' };
    }
    
    return sanitized;
  }
}
