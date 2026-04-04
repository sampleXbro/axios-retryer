'use strict';

import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';

import { RetryLogger } from '../services/logger';
import { InMemoryRequestStore } from '../store/InMemoryRequestStore';
import type {
  AxiosRetryerDetailedMetrics,
  AxiosRetryerRequestPriority,
  CoreRetryEvents,
  CriticalRequestProvider,
  MetricsRecorder,
  RequestStore,
  RetryEventArgs,
  RetryEventListener,
  RetryHooks,
  RetryManagerEvents,
  RetryManagerOptions,
  RetryMode,
  RetryPlugin,
  RetryStrategy,
} from '../types';
import { AXIOS_RETRYER_REQUEST_PRIORITIES, RETRY_MODES } from '../types';
import { DefaultRetryStrategy } from './strategies/DefaultRetryStrategy';
import { EventBus } from './EventBus';
import { PluginRegistry } from './PluginRegistry';
import { RequestQueue } from './requestQueue';
import { parseRetryAfterMs, RetryScheduler } from './RetryScheduler';
import { assignRequestMetadata, ensureRequestMetadata, getRequestMetadata, setRequestMetadataValue } from '../utils/requestMetadata';

const DEFAULT_CONFIG = {
  MODE: RETRY_MODES.AUTOMATIC,
  RETRIES: 3,
  THROW_ON_FAILED_RETRIES: true,
  THROW_ON_CANCEL: true,
  DEBUG: false,
  MAX_REQUESTS_TO_STORE: 200,
  MAX_CONCURRENT_REQUESTS: 5,
};

const EMPTY_METRICS: AxiosRetryerDetailedMetrics = {
  totalRequests: 0,
  successfulRetries: 0,
  failedRetries: 0,
  completelyFailedRequests: 0,
  canceledRequests: 0,
  completelyFailedCriticalRequests: 0,
  errorTypesDistribution: { network: 0, server5xx: 0, client4xx: 0, cancelled: 0 },
  retryAttemptsDistribution: {},
  requestCountsByPriority: {},
  avgQueueWait: 0,
  avgRetryDelay: 0,
  priorityMetrics: [],
  timerHealth: { activeTimers: 0, activeRetryTimers: 0, healthScore: 0 },
};

interface ExtendedAbortController extends AbortController {
  __priority?: AxiosRetryerRequestPriority;
}

export class RetryManager<TPluginEvents extends object = {}> {
  private readonly _axiosInstance: AxiosInstance;
  private readonly mode: RetryMode;
  private readonly retries: number;
  private readonly throwErrorOnFailedRetries: boolean;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly debug: boolean;
  private readonly logger: RetryLogger;
  private readonly hooks?: RetryHooks<TPluginEvents>;
  private _metricsRecorder: MetricsRecorder | null = null;
  private readonly eventBus: EventBus<TPluginEvents>;
  private readonly pluginRegistry: PluginRegistry;
  private readonly retryScheduler: RetryScheduler;

  private inRetryProgress = false;
  private retryStrategy: RetryStrategy;
  public readonly requestStore: RequestStore;
  public blockingQueueThreshold: AxiosRetryerRequestPriority | undefined;
  private activeRequests: Map<string, ExtendedAbortController>;
  private requestIndex = 0;
  private _criticalRequestProvider: CriticalRequestProvider | null = null;

  private requestQueue: RequestQueue;
  private requestInterceptorId: number | null = null;
  private responseInterceptorId: number | null = null;

  constructor(options: RetryManagerOptions<TPluginEvents> = {}) {
    this.debug = options.debug ?? DEFAULT_CONFIG.DEBUG;
    this.logger = new RetryLogger(this.debug);
    this.validateOptions(options);

    this.logger.debug('Initializing RetryManager', {
      options: {
        mode: options.mode,
        retries: options.retries,
        maxConcurrent: options.maxConcurrentRequests,
        maxQueueSize: options.maxQueueSize,
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
    this.hooks = options.hooks;
    this.requestStore =
      options.requestStore ??
      new InMemoryRequestStore(
        options.maxRequestsToStore ?? DEFAULT_CONFIG.MAX_REQUESTS_TO_STORE,
        this.triggerAndEmitInternal,
      );
    this.activeRequests = new Map();
    this.blockingQueueThreshold = options.blockingQueueThreshold;
    this.requestQueue = new RequestQueue(
      options.maxConcurrentRequests ?? DEFAULT_CONFIG.MAX_CONCURRENT_REQUESTS,
      options.queueDelay,
      this.hasActiveCriticalRequests,
      this.isCriticalRequest,
      options.maxQueueSize,
    );
    this._axiosInstance = options.axiosInstance || this.createAxiosInstance();
    this.pluginRegistry = new PluginRegistry(this.logger);
    this.eventBus = new EventBus<TPluginEvents>({
      hooks: this.hooks,
      logger: this.logger,
      getPlugins: () => this.pluginRegistry.getPlugins(),
    });
    this.retryScheduler = new RetryScheduler(this.logger, this.retryStrategy);

    this.setupInterceptors();

    this.logger.debug('RetryManager initialized successfully');
  }

  private validateOptions(options: RetryManagerOptions<TPluginEvents>): void {
    if (options.retries !== undefined && options.retries < 0) {
      this.logger.error('Invalid retries configuration', { retries: options.retries });
      throw new Error('Retries must be a non-negative number');
    }

    this.assertPositiveIntegerOption(options.maxConcurrentRequests, 'maxConcurrentRequests');
    this.assertPositiveIntegerOption(options.maxQueueSize, 'maxQueueSize');
    this.assertPositiveIntegerOption(options.maxRequestsToStore, 'maxRequestsToStore');
    this.assertNonNegativeIntegerOption(options.queueDelay, 'queueDelay');
  }

  private assertPositiveIntegerOption(value: number | undefined, optionName: string): void {
    if (value === undefined) {
      return;
    }

    if (!Number.isInteger(value) || value < 1) {
      this.logger.error(`Invalid ${optionName} configuration`, { [optionName]: value });
      throw new Error(`${optionName} must be a positive integer`);
    }
  }

  private assertNonNegativeIntegerOption(value: number | undefined, optionName: string): void {
    if (value === undefined) {
      return;
    }

    if (!Number.isInteger(value) || value < 0) {
      this.logger.error(`Invalid ${optionName} configuration`, { [optionName]: value });
      throw new Error(`${optionName} must be a non-negative integer`);
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
    const urlPart = url ? url.substring(0, 40) : 'unknown';
    const counter = ++this.requestIndex;
    const uuid =
      typeof globalThis !== 'undefined' &&
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${counter.toString(36)}`;

    return `${urlPart}-${uuid}-${counter}`;
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

  private ejectRetryerInterceptors = (): void => {
    if (this.requestInterceptorId !== null) {
      this._axiosInstance.interceptors.request.eject(this.requestInterceptorId);
      this.requestInterceptorId = null;
    }

    if (this.responseInterceptorId !== null) {
      this._axiosInstance.interceptors.response.eject(this.responseInterceptorId);
      this.responseInterceptorId = null;
    }
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
    const metadata = ensureRequestMetadata(config);
    const requestId = metadata.requestId ?? this.generateRequestId(config.url);
    const priority = metadata.priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM;

    assignRequestMetadata(config, {
      requestId,
      timestamp: Date.now(),
      priority,
    });

    config.signal = controller.signal;
    controller.__priority = priority;

    this.activeRequests.set(requestId, controller);
    this._criticalRequestProvider?.trackRequestStarted(requestId, config);
    this._metricsRecorder?.recordRequestStart(
      priority,
    );

    this.logger.debug('New request created', this.buildRequestLogMeta(config, requestId));

    try {
      const queueStartTime = Date.now();
      const updatedConfig = await this.requestQueue.enqueue(config);
      this._metricsRecorder?.recordQueueWait(Date.now() - queueStartTime);
      return updatedConfig;
    } catch (error) {
      this.removeActiveRequest(requestId);
      this.logger.error('Queue error when enqueuing request', {
        requestId,
        error,
      });
      throw error;
    }
  };

  private handleRetryProcessFinish = (): void => {
    if (this.activeRequests.size === 0 && this.inRetryProgress) {
      this.logger.debug('Retry process finished');
      this.triggerAndEmitInternal('onRetryProcessFinished', this.getMetrics());
      this.inRetryProgress = false;
    }
  };

  private onSuccessfulResponse = (response: AxiosResponse): AxiosResponse => {
    const config = response.config;
    const requestId = getRequestMetadata(config)?.requestId;
    if (requestId) {
      this.removeActiveRequest(requestId);
    }
    this.requestQueue.markComplete();

    this.logger.debug('Request succeeded', {
      requestId,
      status: response.status,
      retrying: getRequestMetadata(config)?.isRetrying,
    });

    const metadata = getRequestMetadata(config);
    if (metadata?.isRetrying && metadata.priority !== undefined) {
      this._metricsRecorder?.recordRetrySuccess(metadata.priority);
      this.triggerAndEmitInternal('afterRetry', config, true);
      setRequestMetadataValue(config, 'isRetrying', false);
    }

    if (this.isCriticalRequest(config) && !this.hasActiveCriticalRequests()) {
      this.triggerAndEmitInternal('onAllCriticalRequestsResolved');
    }

    this.handleRetryProcessFinish();
    this.triggerAndEmitInternal('onMetricsUpdated', this.getMetrics());
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
      this.triggerAndEmitInternal('onRetryProcessStarted');
      this.inRetryProgress = true;
    }

    assignRequestMetadata(config, {
      retryAttempt: attempt,
      isRetrying: true,
    });

    const metadata = getRequestMetadata(config);
    const delay = this.retryScheduler.getRetryDelay(config, Number(metadata?.retryAttempt ?? attempt), maxRetries);

    this.logger.debug('Scheduling retry attempt', {
      requestId: metadata?.requestId,
      attempt,
      maxRetries,
      delayMs: delay,
      backoffType: metadata?.backoffType || 'default',
    });

    const sleepCompleted = await this.retryScheduler.waitForRetryDelay(config, delay);
    if (!sleepCompleted) {
      this._metricsRecorder?.recordCancellation(true);
      return this.handleCancelAction(config);
    }

    this._metricsRecorder?.recordRetryDelay(delay);

    this.logger.debug('Executing retry attempt', {
      requestId: metadata?.requestId,
      timeSinceFirstAttempt: Date.now() - (metadata?.timestamp || 0),
    });

    if (metadata?.requestId) {
      this.removeActiveRequest(metadata.requestId);
    }

    if (cancelledFromQueue || config.signal?.aborted) {
      this.logger.warn('Retry cancelled', {
        requestId: metadata?.requestId,
        source: cancelledFromQueue ? 'queue' : 'user',
      });
      if (cancelledFromQueue) {
        this.requestStore.add(config);
      }
      this._metricsRecorder?.recordCancellation(true);
      return this.handleCancelAction(config);
    }

    if (metadata?.priority !== undefined) {
      this._metricsRecorder?.recordRetryAttempt(attempt, metadata.priority);
    }

    this.triggerAndEmitInternal('beforeRetry', config);
    return this._axiosInstance.request(config);
  }

  private handleCancelAction(config: AxiosRequestConfig): Promise<never> {
    setRequestMetadataValue(config, 'isRetrying', false);
    this.logger.warn('Handling request cancellation', { requestId: getRequestMetadata(config)?.requestId });
    this.handleRetryProcessFinish();
    return this.throwErrorOnCancelRequest
      ? Promise.reject(new Error(`Request aborted. ID: ${getRequestMetadata(config)?.requestId}`))
      : Promise.resolve(null as never);
  }

  private handleError = async (error: AxiosError): Promise<AxiosResponse | null> => {
    let cancelledInQueue = false;
    const config = error.config;

    this.triggerAndEmitInternal('onMetricsUpdated', this.getMetrics());

    if (!config || Object.values(config).length === 0) {
      this.logger.error('Handling error without valid config', { error: error.message });
      return Promise.reject(error);
    }

    if (error.code === 'REQUEST_CANCELED') {
      cancelledInQueue = true;
    }

    this.requestQueue.markComplete();

    this.logger.error('Request failed', this.buildErrorMeta(config, error));

    const metadata = ensureRequestMetadata(config);

    if (!cancelledInQueue && metadata.isRetrying && metadata.priority !== undefined) {
      this._metricsRecorder?.recordRetryFailure(metadata.priority, error);
      this.triggerAndEmitInternal('afterRetry', config, false);
    }

    assignRequestMetadata(config, {
      priority: metadata.priority ?? AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
    });

    const effectiveMetadata = getRequestMetadata(config)!;
    const maxRetries = effectiveMetadata.requestRetries || this.retries;
    const requestMode = effectiveMetadata.requestMode || this.mode;
    const attempt = (effectiveMetadata.retryAttempt || 0) + 1;

    if (requestMode === RETRY_MODES.AUTOMATIC && this.retryStrategy.shouldRetry(error, attempt, maxRetries)) {
      const retryAfterHeader = error.response?.headers?.['retry-after'];
      setRequestMetadataValue(config, 'retryAfterMs', parseRetryAfterMs(retryAfterHeader));

      this.logger.debug('Auto-retrying request', {
        requestId: effectiveMetadata.requestId,
        attempt,
        maxRetries,
        ...(getRequestMetadata(config)?.retryAfterMs ? { retryAfterMs: getRequestMetadata(config)?.retryAfterMs } : {}),
      });
      return this.scheduleRetry(config, attempt, maxRetries, cancelledInQueue);
    }

    return this.handleNoRetriesAction(error, this.retryStrategy.getIsRetryable(error));
  };

  private handleNoRetriesAction(error: AxiosError, shouldStore = true): Promise<null> {
    const config = error.config as AxiosRequestConfig;
    setRequestMetadataValue(config, 'isRetrying', false);
    const metadata = getRequestMetadata(config);

    this.logger.warn('Final request failure', {
      requestId: metadata?.requestId,
      finalAttempt: metadata?.retryAttempt || 0,
      stored: shouldStore,
    });

    this.triggerAndEmitInternal('onFailure', config);

    if (shouldStore) {
      this.requestStore.add(config);
    }

    this._metricsRecorder?.recordTerminalFailure(this.isCriticalRequest(config));

    if (metadata?.requestId) {
      this.removeActiveRequest(metadata.requestId);
    }

    this.handleRetryProcessFinish();

    if (!error.response) {
      this.triggerAndEmitInternal('onInternetConnectionError', config);
    }

    if (!this._criticalRequestProvider && this.isCriticalRequest(config)) {
      this.logger.warn('Critical request failed', { requestId: metadata?.requestId });
      this.triggerAndEmitInternal('onCriticalRequestFailed');
      this.cancelQueuedRequests();
    }

    return this.throwErrorOnFailedRetries ? Promise.reject(error) : Promise.resolve(null);
  }

  private triggerAndEmitInternal = <K extends keyof CoreRetryEvents>(
    event: K,
    ...args: RetryEventArgs<CoreRetryEvents, K>
  ): void => {
    this.eventBus.triggerAndEmit(event, ...args);
  };

  private triggerHook = <K extends keyof CoreRetryEvents>(
    hookName: K,
    ...args: RetryEventArgs<CoreRetryEvents, K>
  ): void => {
    this.eventBus.triggerHook(hookName, ...args);
  };

  private isCriticalRequest = (config: AxiosRequestConfig): boolean => {
    if (this._criticalRequestProvider) {
      return this._criticalRequestProvider.isCriticalRequest(config);
    }

    const priority = getRequestMetadata(config)?.priority;
    return this.blockingQueueThreshold !== undefined && priority !== undefined && priority >= this.blockingQueueThreshold;
  };

  private hasActiveCriticalRequests = (): boolean => {
    if (this._criticalRequestProvider) {
      return this._criticalRequestProvider.hasActiveCriticalRequests();
    }

    if (this.blockingQueueThreshold === undefined) {
      return false;
    }

    let hasCriticalRequests = false;
    this.activeRequests.forEach((controller) => {
      if (controller.__priority !== undefined && controller.__priority >= this.blockingQueueThreshold!) {
        hasCriticalRequests = true;
      }
    });

    return hasCriticalRequests;
  };

  private removeActiveRequest(requestId: string): boolean {
    const controller = this.activeRequests.get(requestId);
    if (!controller) {
      return false;
    }

    this.activeRequests.delete(requestId);
    this._criticalRequestProvider?.trackRequestEnded(requestId);

    return true;
  }

  public emit = <K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void => {
    this.eventBus.emit(event, ...args);
  };

  public triggerAndEmit = <K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void => {
    this.eventBus.triggerAndEmit(event, ...args);
  };

  public use = <TAddedPluginEvents extends object>(
    plugin: RetryPlugin<TAddedPluginEvents>,
    beforeRetryerInterceptors = true,
  ): RetryManager<TPluginEvents & TAddedPluginEvents> => {
    this.pluginRegistry.use(
      plugin,
      this as unknown as RetryManager,
      {
        ejectRetryerInterceptors: this.ejectRetryerInterceptors,
        installRetryerInterceptors: this.setupInterceptors,
      },
      beforeRetryerInterceptors,
    );

    return this as RetryManager<TPluginEvents & TAddedPluginEvents>;
  };

  public unuse = (pluginName: string): boolean => {
    return this.pluginRegistry.unuse(pluginName, this as unknown as RetryManager);
  };

  public getLogger() {
    return this.logger;
  }

  public listPlugins = (): { name: string; version: string }[] => {
    return this.pluginRegistry.list();
  };

  public on = <K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): RetryManager<TPluginEvents> => {
    this.eventBus.on(event, listener);
    return this;
  };

  public off = <K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): boolean => {
    return this.eventBus.off(event, listener);
  };

  public retryFailedRequests = async <T = unknown>(): Promise<AxiosResponse<T>[]> => {
    const failedRequests = this.requestStore.getAll();
    this.requestStore.clear();

    if (failedRequests.length > 0) {
      this.logger.debug('Starting manual retry process', { count: failedRequests.length });
      this.triggerAndEmitInternal('onManualRetryProcessStarted');
    }

    const beforeManualRetry = this.hooks?.beforeManualRetry;
    const replayRequests = failedRequests
      .map((config) => (beforeManualRetry ? beforeManualRetry(config) : config))
      .filter((config): config is AxiosRequestConfig => config !== null);

    return Promise.all(
      replayRequests.map(async (config) => {
        setRequestMetadataValue(config, 'retryAttempt', 1);
        return this.scheduleRetry(config, 1, getRequestMetadata(config)?.requestRetries || this.retries);
      }),
    );
  };

  public get axiosInstance(): AxiosInstance {
    return this._axiosInstance;
  }

  public releaseRequestTracking = (config: AxiosRequestConfig): void => {
    const requestId = getRequestMetadata(config)?.requestId;
    if (requestId && this.removeActiveRequest(requestId)) {
      this.requestQueue.markComplete();

      if (this.isCriticalRequest(config) && !this.hasActiveCriticalRequests()) {
        this.triggerAndEmitInternal('onAllCriticalRequestsResolved');
      }
    }
  };

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
      this.removeActiveRequest(requestId);
      this._metricsRecorder?.recordCancellation();
      this.triggerAndEmitInternal('onRequestCancelled', requestId);
    }

    this.retryScheduler.cancelRetryTimer(requestId);
  };

  public cancelAllRequests = (): void => {
    const timerStats = this.retryScheduler.getTimerStats();
    this.logger.warn('Cancelling all requests', {
      activeCount: this.activeRequests.size,
      queuedCount: this.requestQueue.getWaitingCount(),
      activeRetryTimers: timerStats.activeRetryTimers,
    });

    this.activeRequests.forEach((controller, requestId) => {
      controller.abort();
      this._metricsRecorder?.recordCancellation();
      this.requestQueue.cancelQueuedRequest(requestId);
      this.triggerAndEmitInternal('onRequestCancelled', requestId);
    });
    this.activeRequests.clear();
    this._criticalRequestProvider?.reset();

    this.retryScheduler.cancelAllRetryTimers();
  };

  /**
   * Cancel all requests currently waiting in the queue without aborting in-progress requests.
   */
  public cancelQueuedRequests = (): void => {
    this.activeRequests.forEach((_, requestId) => {
      this.requestQueue.cancelQueuedRequest(requestId);
    });
  };

  public destroy = (): void => {
    const timerStats = this.retryScheduler.getTimerStats();
    this.logger.warn('Destroying RetryManager', {
      activeRequests: this.activeRequests.size,
      activeRetryTimers: timerStats.activeRetryTimers,
      activeTimers: timerStats.activeTimers,
    });

    this.cancelAllRequests();
    this.requestQueue.destroy();
    this.retryScheduler.destroy();
    this.ejectRetryerInterceptors();
    this.pluginRegistry.cleanup(this as unknown as RetryManager);
    this.eventBus.clear();

    this.logger.log('RetryManager destroyed successfully');
  };

  public getTimerStats = (): { activeTimers: number; activeRetryTimers: number } => {
    return this.retryScheduler.getTimerStats();
  };

  public getMetrics = (): AxiosRetryerDetailedMetrics => {
    this.logger.debug('Generating metrics snapshot');
    if (!this._metricsRecorder) {
      return { ...EMPTY_METRICS };
    }
    return this._metricsRecorder.buildDetailedMetrics(this.getTimerStats());
  };

  public resetMetrics = (): void => {
    this.logger.debug('Resetting metrics state');
    this._metricsRecorder?.reset();
    this.triggerAndEmitInternal('onMetricsUpdated', this.getMetrics());
  };

  /**
   * Register a metrics recorder (used by MetricsPlugin).
   * Pass `null` to remove the recorder. Without a recorder, getMetrics() returns zeros.
   */
  public registerMetricsRecorder = (recorder: MetricsRecorder | null): void => {
    this._metricsRecorder = recorder;
  };

  /**
   * Register a critical request provider (used by CriticalRequestPlugin).
   * Pass `null` to remove the provider.
   */
  public registerCriticalRequestProvider = (provider: CriticalRequestProvider | null): void => {
    this._criticalRequestProvider = provider;
  };

  private buildRequestLogMeta(config: AxiosRequestConfig, requestId: string): Record<string, unknown> {
    return {
      requestId,
      url: this.getLogUrl(config.url),
      method: config.method?.toUpperCase(),
      priority: getRequestMetadata(config)?.priority,
    };
  }

  private buildErrorMeta(config: AxiosRequestConfig, error: AxiosError): Record<string, unknown> {
    return {
      requestId: getRequestMetadata(config)?.requestId,
      url: this.getLogUrl(config.url),
      method: config.method?.toUpperCase(),
      status: error.response?.status,
      statusText: error.response?.statusText,
      code: error.code,
      message: error.message,
      retrying: getRequestMetadata(config)?.isRetrying,
    };
  }

  private getLogUrl(url?: string): string | undefined {
    if (!url) {
      return url;
    }

    const queryIndex = url.indexOf('?');
    const hashIndex = url.indexOf('#');
    const cutoffIndex = [queryIndex, hashIndex]
      .filter((index) => index >= 0)
      .reduce((smallest, index) => (smallest === -1 ? index : Math.min(smallest, index)), -1);

    return cutoffIndex === -1 ? url : url.slice(0, cutoffIndex);
  }
}
