'use strict';

import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';

import { RetryLogger } from '../services/logger';
import type {
  AxiosRetryerDetailedMetrics,
  CoreRetryEvents,
  Logger,
  MetricsRecorder,
  PluginContext,
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
import { RequestLifecycleManager } from './RequestLifecycleManager';
import { RequestAbortedError } from './errors/RequestAbortedError';
import { RetryManagerDisposer } from './RetryManagerDisposer';
import { RetryerConfigError } from './errors/RetryerConfigError';
import { RequestQueue } from './requestQueue';
import { parseRetryAfterMs, RetryScheduler } from './RetryScheduler';
import { assignRequestMetadata, ensureRequestMetadata, getRequestMetadata, setRequestMetadataValue } from '../utils/requestMetadata';

const DEFAULT_CONFIG = {
  MODE: RETRY_MODES.AUTOMATIC,
  RETRIES: 3,
  THROW_ON_FAILED_RETRIES: true,
  THROW_ON_CANCEL: true,
  DEBUG: false,
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

export class RetryManager<TPluginEvents extends object = {}> {
  private readonly _axiosInstance: AxiosInstance;
  private readonly mode: RetryMode;
  private readonly retries: number;
  private readonly throwErrorOnFailedRetries: boolean;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly debug: boolean;
  private readonly logger: Logger;
  private readonly hooks?: RetryHooks<TPluginEvents>;
  private _metricsRecorder: MetricsRecorder | null = null;
  private readonly eventBus: EventBus<TPluginEvents>;
  private readonly pluginRegistry: PluginRegistry;
  private readonly requestLifecycle: RequestLifecycleManager;
  private readonly retryScheduler: RetryScheduler;
  private readonly disposer: RetryManagerDisposer;
  private readonly _pluginContext: PluginContext<TPluginEvents>;

  private inRetryProgress = false;
  private retryStrategy: RetryStrategy;

  private requestQueue: RequestQueue;
  private requestInterceptorId: number | null = null;
  private responseInterceptorId: number | null = null;

  constructor(options: RetryManagerOptions<TPluginEvents> = {}) {
    this.debug = options.debug ?? DEFAULT_CONFIG.DEBUG;
    this.logger = options.logger ?? new RetryLogger(this.debug);
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
    this.requestQueue = new RequestQueue({
      maxConcurrent: options.maxConcurrentRequests ?? DEFAULT_CONFIG.MAX_CONCURRENT_REQUESTS,
      queueDelay: options.queueDelay,
      maxQueueSize: options.maxQueueSize,
    });
    this._axiosInstance = options.axiosInstance || this.createAxiosInstance();
    this.pluginRegistry = new PluginRegistry(this.logger);
    this.eventBus = new EventBus<TPluginEvents>({
      hooks: this.hooks,
      logger: this.logger,
    });
    this.retryScheduler = new RetryScheduler(this.logger, this.retryStrategy);
    this.requestLifecycle = new RequestLifecycleManager({
      logger: this.logger,
      requestQueue: this.requestQueue,
      retryScheduler: this.retryScheduler,
      getMetricsRecorder: () => this._metricsRecorder,
      onRequestCancelled: (requestId) => this.triggerAndEmitInternal('onRequestCancelled', requestId),
    });
    this._pluginContext = this.createPluginContext();
    this.disposer = new RetryManagerDisposer({
      logger: this.logger,
      requestLifecycle: this.requestLifecycle,
      requestQueue: this.requestQueue,
      retryScheduler: this.retryScheduler,
      ejectRetryerInterceptors: this.ejectRetryerInterceptors,
      pluginRegistry: this.pluginRegistry,
      eventBus: this.eventBus as unknown as EventBus<object>,
    });
    this.setupInterceptors();

    this.logger.debug('RetryManager initialized successfully');
  }

  private validateOptions(options: RetryManagerOptions<TPluginEvents>): void {
    if (options.retries !== undefined && options.retries < 0) {
      this.logger.error('Invalid retries configuration', { retries: options.retries });
      throw new RetryerConfigError('Retries must be a non-negative number', 'retries', options.retries);
    }

    this.assertPositiveIntegerOption(options.maxConcurrentRequests, 'maxConcurrentRequests');
    this.assertPositiveIntegerOption(options.maxQueueSize, 'maxQueueSize');
    this.assertNonNegativeIntegerOption(options.queueDelay, 'queueDelay');
  }

  private assertPositiveIntegerOption(value: number | undefined, optionName: string): void {
    if (value === undefined) {
      return;
    }

    if (!Number.isInteger(value) || value < 1) {
      this.logger.error(`Invalid ${optionName} configuration`, { [optionName]: value });
      throw new RetryerConfigError(`${optionName} must be a positive integer`, optionName, value);
    }
  }

  private assertNonNegativeIntegerOption(value: number | undefined, optionName: string): void {
    if (value === undefined) {
      return;
    }

    if (!Number.isInteger(value) || value < 0) {
      this.logger.error(`Invalid ${optionName} configuration`, { [optionName]: value });
      throw new RetryerConfigError(`${optionName} must be a non-negative integer`, optionName, value);
    }
  }

  private createAxiosInstance(): AxiosInstance {
    this.logger.debug('Creating default Axios instance');
    return axios.create({
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  private createSilentCancelConfig(config: AxiosRequestConfig, requestId: string): AxiosRequestConfig {
    const silentConfig: AxiosRequestConfig = {
      ...config,
      cancelToken: undefined,
      signal: undefined,
    };

    const metadata = getRequestMetadata(config);
    if (metadata) {
      assignRequestMetadata(silentConfig, metadata);
    }

    assignRequestMetadata(silentConfig, {
      requestId,
      isRetrying: false,
      silentlyCancelled: true,
    });

    silentConfig.adapter = async () => this.createSilentCancelResponse(silentConfig);
    return silentConfig;
  }

  /**
   * Builds a synthetic response for silently-cancelled requests.
   *
   * Uses HTTP 204 as a non-error status so that response interceptors registered
   * downstream receive it without throwing. The real signal is the `silentlyCancelled`
   * flag on `config.__axiosRetryer` — interceptors that need to distinguish this case
   * should check `getRequestMetadata(config)?.silentlyCancelled`.
   */
  private createSilentCancelResponse(config: AxiosRequestConfig): AxiosResponse<null> {
    return {
      config: config as InternalAxiosRequestConfig<null>,
      data: null,
      headers: {},
      status: 204,
      statusText: 'Request Aborted',
    };
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
      ...(this.debug ? { stack: error.stack } : {}),
    });
    return Promise.reject(error);
  };

  private onRequest = async (config: AxiosRequestConfig) => {
    const { requestId, priority, callerAborted } = this.requestLifecycle.beginRequest(config);

    if (callerAborted) {
      this.logger.warn('Request aborted before queueing', {
        requestId,
        source: 'caller',
      });
      this._metricsRecorder?.recordCancellation(true);
      return this.throwErrorOnCancelRequest
        ? Promise.reject(new RequestAbortedError(requestId))
        : Promise.resolve(this.createSilentCancelConfig(config, requestId) as never);
    }

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
      this.requestLifecycle.removeById(requestId);

      if (config.signal?.aborted) {
        this._metricsRecorder?.recordCancellation(true);
        return this.throwErrorOnCancelRequest
          ? Promise.reject(new RequestAbortedError(requestId))
          : Promise.resolve(this.createSilentCancelConfig(config, requestId) as never);
      }

      this.logger.error('Queue error when enqueuing request', {
        requestId,
        error,
      });
      throw error;
    }
  };

  private handleRetryProcessFinish = (): void => {
    if (this.requestLifecycle.getActiveCount() === 0 && this.inRetryProgress) {
      this.logger.debug('Retry process finished');
      this.triggerAndEmitInternal('onRetryProcessFinished');
      this.inRetryProgress = false;
    }
  };

  private onSuccessfulResponse = (response: AxiosResponse): AxiosResponse => {
    const config = response.config;
    const metadata = getRequestMetadata(config);

    if (metadata?.silentlyCancelled) {
      this.logger.debug('Request cancelled without throwing', {
        requestId: metadata.requestId,
      });
      this.handleRetryProcessFinish();
      this.emitMetricsUpdated();
      return null as never;
    }

    const release = this.requestLifecycle.release(config);
    this.requestQueue.markComplete();

    this.logger.debug('Request succeeded', {
      requestId: release.requestId,
      status: response.status,
      retrying: getRequestMetadata(config)?.isRetrying,
    });

    if (metadata?.isRetrying && metadata.priority !== undefined) {
      this._metricsRecorder?.recordRetrySuccess(metadata.priority);
      this.triggerAndEmitInternal('afterRetry', config, true);
      setRequestMetadataValue(config, 'isRetrying', false);
    }

    this.handleRetryProcessFinish();
    this.emitMetricsUpdated();
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
      this.requestLifecycle.removeById(metadata.requestId);
    }

    if (cancelledFromQueue || config.signal?.aborted) {
      this.logger.warn('Retry cancelled', {
        requestId: metadata?.requestId,
        source: cancelledFromQueue ? 'queue' : 'user',
      });
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
    this.emitMetricsUpdated();
    return this.throwErrorOnCancelRequest
      ? Promise.reject(new RequestAbortedError(getRequestMetadata(config)?.requestId))
      : Promise.resolve(null as never);
  }

  private handleError = async (error: AxiosError): Promise<AxiosResponse | null> => {
    let cancelledInQueue = false;
    const config = error.config;

    // Axios 1.x always provides a config object on errors; guard only against missing config.
    if (!config) {
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
    const maxRetries = effectiveMetadata.requestRetries !== undefined ? effectiveMetadata.requestRetries : this.retries;
    const requestMode = effectiveMetadata.requestMode || this.mode;
    const attempt = (effectiveMetadata.retryAttempt || 0) + 1;

    if (requestMode === RETRY_MODES.AUTOMATIC && this.retryStrategy.shouldRetry(error, attempt, maxRetries)) {
      const retryAfterHeader = error.response?.headers?.['retry-after'];
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      if (retryAfterMs > 0) {
        setRequestMetadataValue(config, 'retryAfterMs', retryAfterMs);
      }

      this.logger.debug('Auto-retrying request', {
        requestId: effectiveMetadata.requestId,
        attempt,
        maxRetries,
        ...(getRequestMetadata(config)?.retryAfterMs ? { retryAfterMs: getRequestMetadata(config)?.retryAfterMs } : {}),
      });
      this.emitMetricsUpdated();
      return this.scheduleRetry(config, attempt, maxRetries, cancelledInQueue);
    }

    return this.handleNoRetriesAction(error, this.retryStrategy.getIsRetryable(error));
  };

  private handleNoRetriesAction(error: AxiosError, retryable = false): Promise<null> {
    const config = error.config as AxiosRequestConfig;
    setRequestMetadataValue(config, 'isRetrying', false);
    const metadata = getRequestMetadata(config);

    this.logger.warn('Final request failure', {
      requestId: metadata?.requestId,
      finalAttempt: metadata?.retryAttempt || 0,
      retryable,
    });

    this.triggerAndEmitInternal('onFailure', config);

    this._metricsRecorder?.recordTerminalFailure(false);

    if (metadata?.requestId) {
      this.requestLifecycle.removeById(metadata.requestId);
    }

    this.handleRetryProcessFinish();

    if (!error.response) {
      this.triggerAndEmitInternal('onInternetConnectionError', config);
    }

    this.emitMetricsUpdated();
    return this.throwErrorOnFailedRetries ? Promise.reject(error) : Promise.resolve(null);
  }

  private triggerAndEmitInternal = <K extends keyof CoreRetryEvents>(
    event: K,
    ...args: RetryEventArgs<CoreRetryEvents, K>
  ): void => {
    this.eventBus.triggerAndEmit(event, ...args);
  };

  private removeActiveRequest(requestId: string): boolean {
    return this.requestLifecycle.removeById(requestId);
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
    beforeRetryerInterceptors?: boolean,
  ): RetryManager<TPluginEvents & TAddedPluginEvents> => {
    const installBeforeRetryerInterceptors =
      beforeRetryerInterceptors ??
      (plugin as RetryPlugin<TAddedPluginEvents> & { interceptorPlacement?: 'beforeRetryer' | 'afterRetryer' })
        .interceptorPlacement !== 'afterRetryer';

    this.pluginRegistry.use(
      plugin,
      this._pluginContext,
      {
        ejectRetryerInterceptors: this.ejectRetryerInterceptors,
        installRetryerInterceptors: this.setupInterceptors,
      },
      installBeforeRetryerInterceptors,
    );

    return this as RetryManager<TPluginEvents & TAddedPluginEvents>;
  };

  public unuse = (pluginName: string): boolean => {
    return this.pluginRegistry.unuse(pluginName, this._pluginContext);
  };

  public getLogger(): Logger {
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

  public get axiosInstance(): AxiosInstance {
    return this._axiosInstance;
  }

  public cancelRequest = (requestId: string): void => {
    this.requestLifecycle.cancelRequest(requestId);
  };

  public cancelAllRequests = (): void => {
    this.requestLifecycle.cancelAllRequests();
  };

  /**
   * Cancel all requests currently waiting in the queue without aborting in-progress requests.
   */
  public cancelQueuedRequests = (): void => {
    this.requestLifecycle.cancelQueuedRequests();
  };

  public destroy = (): void => {
    this.disposer.destroy(this._pluginContext);
  };

  public getMetrics = (): AxiosRetryerDetailedMetrics => {
    this.logger.debug('Generating metrics snapshot');
    const timerStats = this.retryScheduler.getTimerStats();
    if (!this._metricsRecorder) {
      return {
        ...EMPTY_METRICS,
        timerHealth: { ...timerStats, healthScore: 0 },
      };
    }
    return this._metricsRecorder.buildDetailedMetrics(timerStats);
  };

  public resetMetrics = (): void => {
    this.logger.debug('Resetting metrics state');
    this._metricsRecorder?.reset();
    this.emitMetricsUpdated();
  };

  private createPluginContext(): PluginContext<TPluginEvents> {
    const self = this;
    return {
      get axiosInstance() { return self._axiosInstance; },
      getLogger: () => self.logger,
      on<K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
      ): void {
        self.eventBus.on(event, listener);
      },
      off<K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
      ): boolean {
        return self.eventBus.off(event, listener);
      },
      emit<K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
      ): void {
        self.eventBus.emit(event, ...args);
      },
      triggerAndEmit<K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
      ): void {
        self.eventBus.triggerAndEmit(event, ...args);
      },
      cancelRequest: (id: string) => self.requestLifecycle.cancelRequest(id),
      cancelAllRequests: () => self.requestLifecycle.cancelAllRequests(),
      cancelQueuedRequests: () => self.requestLifecycle.cancelQueuedRequests(),
      registerQueueGate: (name: string, fn: (req: AxiosRequestConfig) => boolean) =>
        self.requestQueue.registerProcessingGate(name, fn),
      unregisterQueueGate: (name: string) => self.requestQueue.unregisterProcessingGate(name),
      refreshQueue: () => self.requestQueue.refresh(),
      registerMetricsRecorder: (recorder: MetricsRecorder | null) => { self._metricsRecorder = recorder; },
      getTimerStats: () => self.retryScheduler.getTimerStats(),
      releaseRequestTracking: (config: AxiosRequestConfig) => {
        const release = self.requestLifecycle.release(config);
        if (release.released) {
          self.requestQueue.markComplete();
        }
      },
    };
  }

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
    const hasQuery = queryIndex >= 0;
    const hasHash = hashIndex >= 0;

    if (!hasQuery && !hasHash) {
      return url;
    }

    if (!hasQuery) {
      return url.slice(0, hashIndex);
    }

    if (!hasHash) {
      return url.slice(0, queryIndex);
    }

    return url.slice(0, Math.min(queryIndex, hashIndex));
  }

  private emitMetricsUpdated(): void {
    this._metricsRecorder?.emitMetricsUpdated?.();
  }
}
