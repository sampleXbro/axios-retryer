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
  RetryManagerEvents,
  RetryManagerOptions,
  RetryMode,
  RetryPlugin,
  RetryStrategy,
} from '../types';
import { RETRY_MODES } from '../types';
import { DefaultRetryStrategy } from './strategies/DefaultRetryStrategy';
import { EventBus } from './EventBus';
import { PluginRegistry } from './PluginRegistry';
import { RequestLifecycleManager } from './RequestLifecycleManager';
import { RetryManagerDisposer } from './RetryManagerDisposer';
import { RetryerConfigError } from './errors/RetryerConfigError';
import { RequestQueue } from './requestQueue';
import { RetryScheduler } from './RetryScheduler';
import { assignRequestMetadata, getRequestMetadata } from '../utils/requestMetadata';
import { DependencyGatekeeper } from './DependencyGatekeeper';
import { RequestInterceptorHandler } from './interceptors/RequestInterceptor';
import { ResponseInterceptorHandler } from './interceptors/ResponseInterceptor';
import { ErrorInterceptorHandler } from './interceptors/ErrorInterceptor';

const DEFAULT_CONFIG = {
  MODE: RETRY_MODES.AUTOMATIC,
  RETRIES: 3,
  THROW_ON_FAILED_RETRIES: true,
  THROW_ON_CANCEL: true,
  DEBUG: false,
  MAX_CONCURRENT_REQUESTS: 5,
  CANCEL_PENDING_ON_DEPENDENCY_FAILURE: true,
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

export class RetryManager<TPluginEvents extends object = Record<never, never>> {
  private readonly _axiosInstance: AxiosInstance;
  private readonly mode: RetryMode;
  private readonly retries: number;
  private readonly throwErrorOnFailedRetries: boolean;
  private readonly throwErrorOnCancelRequest: boolean;
  private readonly debug: boolean;
  private readonly logger: Logger;
  private _metricsRecorder: MetricsRecorder | null = null;
  private readonly eventBus: EventBus<TPluginEvents>;
  private readonly pluginRegistry: PluginRegistry;
  private readonly requestLifecycle: RequestLifecycleManager;
  private readonly retryScheduler: RetryScheduler;
  private readonly disposer: RetryManagerDisposer;
  private readonly _pluginContext: PluginContext<TPluginEvents>;

  private inRetryProgress = false;
  private readonly retryStrategy: RetryStrategy;

  private readonly requestQueue: RequestQueue;
  private requestInterceptorId: number | null = null;
  private responseInterceptorId: number | null = null;

  private readonly blockingPriorityThreshold: RetryManagerOptions['blockingPriorityThreshold'];
  private readonly cancelPendingOnDependencyFailure: boolean;
  private readonly dependencyGatekeeper: DependencyGatekeeper;
  private readonly requestInterceptorHandler: RequestInterceptorHandler;
  private readonly responseInterceptorHandler: ResponseInterceptorHandler;
  private readonly errorInterceptorHandler: ErrorInterceptorHandler;

  constructor(options: RetryManagerOptions = {}) {
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
    this.blockingPriorityThreshold = options.blockingPriorityThreshold;
    this.cancelPendingOnDependencyFailure =
      options.cancelPendingOnDependencyFailure ?? DEFAULT_CONFIG.CANCEL_PENDING_ON_DEPENDENCY_FAILURE;
    this.retryStrategy =
      options.retryStrategy ??
      new DefaultRetryStrategy(
        options.retryableStatuses,
        options.retryableMethods,
        options.backoffType,
        undefined,
        this.logger,
      );
    this.requestQueue = new RequestQueue({
      maxConcurrent: options.maxConcurrentRequests ?? DEFAULT_CONFIG.MAX_CONCURRENT_REQUESTS,
      queueDelay: options.queueDelay,
      maxQueueSize: options.maxQueueSize,
    });

    this._axiosInstance = options.axiosInstance || this.createAxiosInstance();
    this.pluginRegistry = new PluginRegistry(this.logger);
    this.eventBus = new EventBus<TPluginEvents>(this.logger);
    this.retryScheduler = new RetryScheduler(this.logger, this.retryStrategy);
    this.requestLifecycle = new RequestLifecycleManager({
      logger: this.logger,
      requestQueue: this.requestQueue,
      retryScheduler: this.retryScheduler,
      onRequestCancelled: (requestId) => {
        this.dependencyGatekeeper.handleRequestCancelled(requestId);
        this.triggerAndEmitInternal('onRequestCancelled', requestId);
      },
    });

    this.dependencyGatekeeper = new DependencyGatekeeper({
      blockingPriorityThreshold: this.blockingPriorityThreshold,
      cancelPendingOnDependencyFailure: this.cancelPendingOnDependencyFailure,
      requestQueue: this.requestQueue,
      requestLifecycle: this.requestLifecycle,
      emitEvent: (event, ...args) =>
        (this.triggerAndEmitInternal as (event: string, ...args: unknown[]) => void)(event, ...args),
    });

    this.requestInterceptorHandler = new RequestInterceptorHandler({
      logger: this.logger,
      requestLifecycle: this.requestLifecycle,
      dependencyGatekeeper: this.dependencyGatekeeper,
      requestQueue: this.requestQueue,
      throwErrorOnCancelRequest: this.throwErrorOnCancelRequest,
      createSilentCancelConfig: (c, id) => this.createSilentCancelConfig(c, id),
      emitEvent: (event, ...args) =>
        (this.triggerAndEmitInternal as (event: string, ...args: unknown[]) => void)(event, ...args),
    });

    this.responseInterceptorHandler = new ResponseInterceptorHandler({
      logger: this.logger,
      requestLifecycle: this.requestLifecycle,
      dependencyGatekeeper: this.dependencyGatekeeper,
      requestQueue: this.requestQueue,
      emitEvent: (event, ...args) =>
        (this.triggerAndEmitInternal as (event: string, ...args: unknown[]) => void)(event, ...args),
      handleRetryProcessFinish: this.handleRetryProcessFinish,
    });

    this.errorInterceptorHandler = new ErrorInterceptorHandler({
      axiosInstance: this._axiosInstance,
      logger: this.logger,
      requestLifecycle: this.requestLifecycle,
      dependencyGatekeeper: this.dependencyGatekeeper,
      requestQueue: this.requestQueue,
      retryScheduler: this.retryScheduler,
      retryStrategy: this.retryStrategy,
      emitEvent: (event, ...args) =>
        (this.triggerAndEmitInternal as (event: string, ...args: unknown[]) => void)(event, ...args),
      markRetryProcessStart: () => {
        if (!this.inRetryProgress) {
          this.logger.debug('Starting retry process');
          this.triggerAndEmitInternal('onRetryProcessStarted');
          this.inRetryProgress = true;
        }
      },
      handleRetryProcessFinish: this.handleRetryProcessFinish,
      retries: this.retries,
      mode: this.mode,
      throwErrorOnFailedRetries: this.throwErrorOnFailedRetries,
      throwErrorOnCancelRequest: this.throwErrorOnCancelRequest,
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

  private validateOptions(options: RetryManagerOptions): void {
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
      this.requestInterceptorHandler.handleRequest,
      (error: AxiosError) => {
        this.logger.error('Request interceptor error', {
          message: error.message,
          code: error.code,
          ...(this.debug ? { stack: error.stack } : {}),
        });
        return Promise.reject(error);
      },
    );
    this.responseInterceptorId = this._axiosInstance.interceptors.response.use(
      this.responseInterceptorHandler.handleResponse,
      this.errorInterceptorHandler.handleError,
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

  private handleRetryProcessFinish = (): void => {
    if (this.requestLifecycle.getActiveCount() === 0 && this.inRetryProgress) {
      this.logger.debug('Retry process finished');
      this.triggerAndEmitInternal('onRetryProcessFinished');
      this.inRetryProgress = false;
    }
  };

  private triggerAndEmitInternal = <K extends keyof CoreRetryEvents>(
    event: K,
    ...args: RetryEventArgs<CoreRetryEvents, K>
  ): void => {
    this.eventBus.triggerAndEmit(event, ...args);
  };

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
    const wasActive = this.requestLifecycle.getActiveRequests().has(requestId);
    this.requestLifecycle.cancelRequest(requestId);
    if (wasActive) {
      this.requestQueue.markComplete();
    }
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
    this._metricsRecorder?.emitMetricsUpdated?.();
  };

  private createPluginContext(): PluginContext<TPluginEvents> {
    const axiosInstance = this._axiosInstance;
    return {
      get axiosInstance() {
        return axiosInstance;
      },
      getLogger: () => this.logger,
      on: <K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
      ): void => {
        this.eventBus.on(event, listener);
      },
      off: <K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
      ): boolean => {
        return this.eventBus.off(event, listener);
      },
      emit: <K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
      ): void => {
        this.eventBus.emit(event, ...args);
      },
      triggerAndEmit: <K extends keyof RetryManagerEvents<TPluginEvents>>(
        event: K,
        ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
      ): void => {
        this.eventBus.triggerAndEmit(event, ...args);
      },
      cancelRequest: (id: string) => this.requestLifecycle.cancelRequest(id),
      cancelAllRequests: () => this.requestLifecycle.cancelAllRequests(),
      cancelQueuedRequests: () => this.requestLifecycle.cancelQueuedRequests(),
      registerQueueGate: (name: string, fn: (req: AxiosRequestConfig) => boolean) =>
        this.requestQueue.registerProcessingGate(name, fn),
      unregisterQueueGate: (name: string) => this.requestQueue.unregisterProcessingGate(name),
      refreshQueue: () => this.requestQueue.refresh(),
      registerMetricsRecorder: (recorder: MetricsRecorder | null) => {
        this._metricsRecorder = recorder;
      },
      getTimerStats: () => this.retryScheduler.getTimerStats(),
      releaseRequestTracking: (config: AxiosRequestConfig) => {
        const release = this.requestLifecycle.release(config);
        if (release.released) {
          this.requestQueue.markComplete();
        }
      },
    };
  }
}
