import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

import { RetryerConfigError } from '../../core/errors/RetryerConfigError';
import type { PluginContext, RetryPlugin } from '../../types';
import { assignRequestMetadata, ensureRequestMetadata } from '../../utils/requestMetadata';
import { validateExcludeUrls } from '../../utils/validateExcludeUrls';
import { AdaptiveTimeoutTracker, type ResponseTimeMetrics } from './AdaptiveTimeoutTracker';
import { CircuitBreakerScopeManager, InMemoryCircuitBreakerStateAdapter } from './CircuitBreakerScopeManager';
import { CircuitBreakerStateError } from './CircuitBreakerStateError';
import {
  CIRCUIT_BREAKER_STATES,
  CIRCUIT_BREAKER_SCOPES,
  type CircuitBreakerMetrics,
  type CircuitBreakerOptions,
  type CircuitBreakerPluginEvents,
  type CircuitBreakerScope,
  type CircuitBreakerScopeMetrics,
  type CircuitBreakerScopeState,
  type CircuitBreakerState,
  type CircuitBreakerStateAdapter,
  type ScopeMetricsBaseline,
} from './CircuitBreakerTypes';

export type {
  CircuitBreakerAdaptiveTimeoutMetrics,
  CircuitBreakerFailureRecord,
  CircuitBreakerMetrics,
  CircuitBreakerOptions,
  CircuitBreakerPluginEvents,
  CircuitBreakerScope,
  CircuitBreakerScopeMetrics,
  CircuitBreakerScopeState,
  CircuitBreakerState,
  CircuitBreakerStateAdapter,
} from './CircuitBreakerTypes';
export { CIRCUIT_BREAKER_STATES, CIRCUIT_BREAKER_SCOPES } from './CircuitBreakerTypes';
export { InMemoryCircuitBreakerStateAdapter } from './CircuitBreakerScopeManager';

/**
 * Enhanced CircuitBreakerPlugin with sliding window failure counting,
 * selective error monitoring, adaptive timeout management, granular recovery,
 * URL exclusion, scoped circuit state, and optional distributed state adapters.
 *
 * @implements {RetryPlugin}
 */
export class CircuitBreakerPlugin implements RetryPlugin<CircuitBreakerPluginEvents> {
  public static STATES = CIRCUIT_BREAKER_STATES;

  public readonly name = 'CircuitBreakerPlugin';
  public readonly version = '2.0.0';
  public readonly _events?: Readonly<CircuitBreakerPluginEvents>;

  private readonly _options: Required<Omit<CircuitBreakerOptions, 'shouldCountError' | 'scope' | 'stateAdapter'>> & {
    shouldCountError?: CircuitBreakerOptions['shouldCountError'];
    scope: CircuitBreakerScope | ((config: AxiosRequestConfig) => string);
    stateAdapter: CircuitBreakerStateAdapter;
  };
  private _requestInterceptorId?: number;
  private _responseInterceptorId?: number;
  private _context!: PluginContext<CircuitBreakerPluginEvents>;
  private readonly _adaptiveTimeoutTracker: AdaptiveTimeoutTracker;
  private readonly _scopeManager: CircuitBreakerScopeManager;
  private readonly _metricBaselines = new Map<string, ScopeMetricsBaseline>();

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    const defaults: Required<Omit<CircuitBreakerOptions, 'shouldCountError' | 'scope' | 'stateAdapter'>> = {
      failureThreshold: 5,
      openTimeout: 30000,
      halfOpenMax: 1,
      successThreshold: 1,
      useSlidingWindow: false,
      slidingWindowSize: 60000,
      adaptiveTimeout: false,
      adaptiveTimeoutPercentile: 0.95,
      adaptiveTimeoutSampleSize: 100,
      adaptiveTimeoutMultiplier: 1.5,
      maxTrackedScopes: 500,
      excludeUrls: [],
    };

    this._options = {
      ...defaults,
      ...options,
      scope: options.scope ?? CIRCUIT_BREAKER_SCOPES.HOST_AND_URL,
      stateAdapter: options.stateAdapter ?? new InMemoryCircuitBreakerStateAdapter(),
    };

    this._validateOptions();

    this._adaptiveTimeoutTracker = new AdaptiveTimeoutTracker({
      percentile: this._options.adaptiveTimeoutPercentile,
      sampleSize: this._options.adaptiveTimeoutSampleSize,
      multiplier: this._options.adaptiveTimeoutMultiplier,
      maxTrackedScopes: this._options.maxTrackedScopes,
    });

    // Logger not available at construction time; injected via setLogger() during initialize().
    this._scopeManager = new CircuitBreakerScopeManager({
      scope: this._options.scope,
      stateAdapter: this._options.stateAdapter,
      maxTrackedScopes: this._options.maxTrackedScopes,
    });
  }

  // ---------------------------------------------------------------------------
  // @internal — Test-facing delegation properties and methods (not part of the public API)
  // ---------------------------------------------------------------------------

  /** @internal */
  get _responseMetrics(): Record<string, ResponseTimeMetrics> {
    return this._adaptiveTimeoutTracker.responseMetrics;
  }

  /** @internal */
  get _scopeStateCache(): Map<string, CircuitBreakerScopeState> {
    return this._scopeManager.scopeStateCache;
  }

  /** @internal */
  get _knownScopes(): Map<string, { scopeKey: string; normalizedUrl: string; host?: string }> {
    return this._scopeManager.knownScopes;
  }

  /** @internal */
  _normalizeUrl(url: string): string {
    return this._scopeManager.normalizeUrl(url);
  }

  /** @internal */
  _resolveScopeKey(config: AxiosRequestConfig, normalizedUrl: string, host?: string): string {
    return this._scopeManager.resolveScopeKeyPublic(config, normalizedUrl, host);
  }

  /** @internal */
  _getScopeDetails(config: AxiosRequestConfig): { scopeKey: string; normalizedUrl: string; host?: string } {
    return this._scopeManager.getScopeDetails(config);
  }

  /** @internal */
  async _writeScopeState(scopeKey: string, state: CircuitBreakerScopeState): Promise<void> {
    return this._scopeManager.writeState(scopeKey, state);
  }

  // ---------------------------------------------------------------------------
  // Plugin lifecycle
  // ---------------------------------------------------------------------------

  public initialize(context: PluginContext<CircuitBreakerPluginEvents>): void {
    this._context = context;
    const logger = context.getLogger();

    this._scopeManager.setLogger(logger);
    this._scopeManager.baseURLGetter = () => context.axiosInstance.defaults.baseURL;

    logger.debug('CircuitBreakerPlugin: Initializing with options:', { ...this._options });

    const axiosInstance = context.axiosInstance;

    this._requestInterceptorId = axiosInstance.interceptors.request.use(async (config) => {
      const metadata = ensureRequestMetadata(config);

      if (this._options.adaptiveTimeout && config.url && !metadata.timestamp) {
        assignRequestMetadata(config, { timestamp: Date.now() });
      }

      if (this._isUrlExcluded(config)) {
        logger.debug(`CircuitBreakerPlugin: URL excluded from circuit breaking: ${config.url}`);
        return config;
      }

      const scopeDetails = this._scopeManager.getScopeDetails(config);

      const decision = await this._scopeManager.withLock(scopeDetails.scopeKey, async () => {
        let scopeState = await this._scopeManager.readState(scopeDetails.scopeKey);

        if (scopeState.state === CIRCUIT_BREAKER_STATES.OPEN) {
          if (Date.now() >= scopeState.nextAttempt) {
            scopeState = await this._transitionToHalfOpen(scopeDetails.scopeKey, scopeState);
          } else {
            return { action: 'reject-open', scopeState } as const;
          }
        }

        if (scopeState.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
          if (scopeState.halfOpenCount >= this._options.halfOpenMax) {
            return { action: 'reject-half-open', scopeState } as const;
          }
          scopeState.halfOpenCount++;
          await this._scopeManager.writeState(scopeDetails.scopeKey, scopeState);
          logger.debug(
            `CircuitBreakerPlugin: HALF_OPEN test request #${scopeState.halfOpenCount} of ${this._options.halfOpenMax} for ${scopeDetails.scopeKey}`,
          );
        }

        return { action: 'allow', scopeState } as const;
      });

      if (decision.action === 'reject-open') {
        const remainingTime = decision.scopeState.nextAttempt - Date.now();
        logger.debug(
          `CircuitBreakerPlugin: Circuit is OPEN for ${scopeDetails.scopeKey}: failing fast. Will retry in ${remainingTime}ms`,
        );
        return Promise.reject(
          this._createCircuitStateError(config, decision.scopeState, 'Circuit is open: failing fast.'),
        );
      }

      if (decision.action === 'reject-half-open') {
        logger.debug(
          `CircuitBreakerPlugin: Circuit is HALF_OPEN for ${scopeDetails.scopeKey}: too many test requests.`,
        );
        return Promise.reject(
          this._createCircuitStateError(config, decision.scopeState, 'Circuit is half-open: too many test requests.'),
        );
      }

      if (this._options.adaptiveTimeout) {
        const timeout = this._adaptiveTimeoutTracker.getComputedTimeout(scopeDetails.scopeKey);
        if (timeout !== undefined) {
          config.timeout = timeout;
          logger.debug(`CircuitBreakerPlugin: Setting adaptive timeout for ${scopeDetails.scopeKey}: ${timeout}ms`);
        }
      }

      return config;
    });

    this._responseInterceptorId = axiosInstance.interceptors.response.use(
      async (response) => {
        if (this._options.adaptiveTimeout && response.config.url) {
          const scopeDetails = this._scopeManager.getScopeDetails(response.config);
          this._adaptiveTimeoutTracker.trackResponseTime(
            response,
            scopeDetails.scopeKey,
            scopeDetails.normalizedUrl,
            scopeDetails.host,
          );
        }

        if (this._isUrlExcluded(response.config)) {
          return response;
        }

        const scopeDetails = this._scopeManager.getScopeDetails(response.config);

        await this._scopeManager.withLock(scopeDetails.scopeKey, async () => {
          const scopeState = await this._scopeManager.readState(scopeDetails.scopeKey);

          if (scopeState.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
            scopeState.successCount++;
            const successThreshold = this._options.successThreshold || 1;

            if (scopeState.successCount >= successThreshold) {
              logger.debug(
                `CircuitBreakerPlugin: HALF_OPEN success threshold reached (${scopeState.successCount}/${successThreshold}) for ${scopeDetails.scopeKey}`,
              );
              await this._resetScope(scopeDetails.scopeKey);
            } else {
              await this._scopeManager.writeState(scopeDetails.scopeKey, scopeState);
              logger.debug(
                `CircuitBreakerPlugin: HALF_OPEN success: ${scopeState.successCount}/${successThreshold} successful test requests for ${scopeDetails.scopeKey}`,
              );
            }
          } else if (scopeState.state === CIRCUIT_BREAKER_STATES.CLOSED && scopeState.failureCount > 0) {
            scopeState.failureCount = 0;
            scopeState.lastFailureStatus = undefined;
            scopeState.lastFailureCode = undefined;
            await this._scopeManager.writeState(scopeDetails.scopeKey, scopeState);
          }
        });

        return response;
      },
      async (error) => {
        if (!error.config) {
          return Promise.reject(error);
        }

        if (this._isUrlExcluded(error.config)) {
          return Promise.reject(error);
        }

        if (!this._shouldCountError(error)) {
          logger.debug('CircuitBreakerPlugin: Error excluded from circuit breaking by shouldCountError');
          return Promise.reject(error);
        }

        const scopeDetails = this._scopeManager.getScopeDetails(error.config);

        await this._scopeManager.withLock(scopeDetails.scopeKey, async () => {
          const scopeState = await this._scopeManager.readState(scopeDetails.scopeKey);
          this._rememberFailure(scopeState, error);

          if (this._options.useSlidingWindow) {
            this._addFailureToSlidingWindow(scopeState, error);
            const currentCount = this._getFailureCountInWindow(scopeState);

            if (currentCount >= this._options.failureThreshold) {
              logger.debug(
                `CircuitBreakerPlugin: Sliding window failure threshold reached for ${scopeDetails.scopeKey}: ${currentCount} failures in window`,
              );
              await this._tripScope(scopeDetails.scopeKey, scopeState);
            } else {
              await this._scopeManager.writeState(scopeDetails.scopeKey, scopeState);
            }
          } else {
            scopeState.failureCount++;
            logger.debug(
              `CircuitBreakerPlugin: Failure count increased for ${scopeDetails.scopeKey}: ${scopeState.failureCount}/${this._options.failureThreshold}`,
            );

            if (
              scopeState.state === CIRCUIT_BREAKER_STATES.HALF_OPEN ||
              scopeState.failureCount >= this._options.failureThreshold
            ) {
              await this._tripScope(scopeDetails.scopeKey, scopeState);
            } else {
              await this._scopeManager.writeState(scopeDetails.scopeKey, scopeState);
            }
          }
        });

        return Promise.reject(error);
      },
    );
  }

  public onBeforeDestroyed(context: PluginContext<CircuitBreakerPluginEvents>): void {
    context.getLogger().debug('CircuitBreakerPlugin: Removing CircuitBreakerPlugin');
    const axiosInstance = context.axiosInstance;
    if (this._requestInterceptorId !== undefined) {
      axiosInstance.interceptors.request.eject(this._requestInterceptorId);
    }
    if (this._responseInterceptorId !== undefined) {
      axiosInstance.interceptors.response.eject(this._responseInterceptorId);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public getState(scopeKey?: string): CircuitBreakerState {
    if (scopeKey) {
      return this._scopeManager.scopeStateCache.get(scopeKey)?.state ?? CIRCUIT_BREAKER_STATES.CLOSED;
    }

    const states = Array.from(this._scopeManager.scopeStateCache.values()).map((s) => s.state);
    if (states.includes(CIRCUIT_BREAKER_STATES.OPEN)) return CIRCUIT_BREAKER_STATES.OPEN;
    if (states.includes(CIRCUIT_BREAKER_STATES.HALF_OPEN)) return CIRCUIT_BREAKER_STATES.HALF_OPEN;
    return CIRCUIT_BREAKER_STATES.CLOSED;
  }

  public manualReset(scopeKey?: string): void {
    const scopeKeys = this._scopeManager.getTrackedScopeKeys(scopeKey);

    scopeKeys.forEach((key) => {
      const previousState = this._scopeManager.scopeStateCache.get(key)?.state ?? CIRCUIT_BREAKER_STATES.CLOSED;
      this._scopeManager.scopeStateCache.set(key, this._scopeManager.createInitialState());
      this._metricBaselines.delete(key);

      if (previousState !== CIRCUIT_BREAKER_STATES.CLOSED) {
        this._emitStateChange(key, previousState, CIRCUIT_BREAKER_STATES.CLOSED, 'manual-reset');
      }
    });

    if (scopeKey) {
      this._scopeManager.deleteDistributedScope(scopeKey);
      this._context?.getLogger().debug(`CircuitBreakerPlugin: Circuit reset for ${scopeKey}`);
      return;
    }

    this._scopeManager.clearDistributedState(scopeKeys);
    this._context?.getLogger().debug('CircuitBreakerPlugin: Circuit reset: entering CLOSED state');
  }

  /**
   * Backwards-compatible alias retained for existing tests and internal callers.
   * @internal
   */
  _reset(scopeKey?: string): void {
    this.manualReset(scopeKey);
  }

  /**
   * @internal Exposed for test inspection only; not part of the public API.
   */
  _trackResponseTime(response: AxiosResponse): void {
    if (!response.config.url || !this._options.adaptiveTimeout) {
      return;
    }
    const scopeDetails = this._scopeManager.getScopeDetails(response.config);
    this._adaptiveTimeoutTracker.trackResponseTime(
      response,
      scopeDetails.scopeKey,
      scopeDetails.normalizedUrl,
      scopeDetails.host,
    );
  }

  public resetMetrics(): void {
    const resetAt = Date.now();
    this._metricBaselines.clear();
    this._scopeManager.getTrackedScopeKeys().forEach((key) => {
      const state = this._scopeManager.scopeStateCache.get(key) ?? this._scopeManager.createInitialState();
      this._metricBaselines.set(key, {
        failureCount: state.failureCount,
        successCount: state.successCount,
        halfOpenCount: state.halfOpenCount,
        resetAt,
      });
    });
    this._adaptiveTimeoutTracker.reset();
    this._context?.getLogger().debug('CircuitBreakerPlugin: Circuit metrics reset.');
  }

  public getAdaptiveTimeoutMetrics() {
    if (!this._options.adaptiveTimeout) {
      return [];
    }
    return this._adaptiveTimeoutTracker.getAdaptiveTimeoutMetrics();
  }

  public getMetrics(): CircuitBreakerMetrics {
    const scopeMetrics = this._getScopeMetrics();
    return {
      state: this.getState(),
      failureCount: scopeMetrics.reduce((sum, scope) => sum + scope.failureCount, 0),
      halfOpenCount: scopeMetrics.reduce((sum, scope) => sum + scope.halfOpenCount, 0),
      successCount: scopeMetrics.reduce((sum, scope) => sum + scope.successCount, 0),
      nextAttemptIn: scopeMetrics.reduce((max, scope) => Math.max(max, scope.nextAttemptIn), 0),
      failuresInWindow: scopeMetrics.reduce((sum, scope) => sum + scope.failuresInWindow, 0),
      adaptiveTimeouts: this.getAdaptiveTimeoutMetrics(),
      scopeMetrics,
    };
  }

  // ---------------------------------------------------------------------------
  // State machine transitions
  // ---------------------------------------------------------------------------

  private async _tripScope(scopeKey: string, scopeState: CircuitBreakerScopeState): Promise<void> {
    if (scopeState.state !== CIRCUIT_BREAKER_STATES.OPEN) {
      const previousState = scopeState.state;
      scopeState.state = CIRCUIT_BREAKER_STATES.OPEN;
      scopeState.nextAttempt = Date.now() + this._options.openTimeout;
      scopeState.successCount = 0;
      scopeState.halfOpenCount = 0;
      await this._scopeManager.writeState(scopeKey, scopeState);
      this._emitStateChange(
        scopeKey,
        previousState,
        CIRCUIT_BREAKER_STATES.OPEN,
        previousState === CIRCUIT_BREAKER_STATES.HALF_OPEN ? 'half-open-failure' : 'failure-threshold',
        Math.max(0, scopeState.nextAttempt - Date.now()),
      );
      this._context
        ?.getLogger()
        .error(
          `CircuitBreakerPlugin: Circuit tripped: entering OPEN state for ${scopeKey} until ${new Date(scopeState.nextAttempt).toISOString()}`,
        );
    }
  }

  private async _resetScope(scopeKey: string): Promise<void> {
    const previousState = this._scopeManager.scopeStateCache.get(scopeKey)?.state ?? CIRCUIT_BREAKER_STATES.CLOSED;
    await this._scopeManager.writeState(scopeKey, this._scopeManager.createInitialState());
    if (previousState !== CIRCUIT_BREAKER_STATES.CLOSED) {
      this._emitStateChange(scopeKey, previousState, CIRCUIT_BREAKER_STATES.CLOSED, 'success-threshold-reached');
    }
    this._context?.getLogger().debug(`CircuitBreakerPlugin: Circuit reset: entering CLOSED state for ${scopeKey}.`);
  }

  private async _transitionToHalfOpen(
    scopeKey: string,
    scopeState: CircuitBreakerScopeState,
  ): Promise<CircuitBreakerScopeState> {
    const previousState = scopeState.state;
    scopeState.state = CIRCUIT_BREAKER_STATES.HALF_OPEN;
    scopeState.halfOpenCount = 0;
    scopeState.successCount = 0;
    await this._scopeManager.writeState(scopeKey, scopeState);
    this._emitStateChange(scopeKey, previousState, CIRCUIT_BREAKER_STATES.HALF_OPEN, 'open-timeout-elapsed');
    this._context?.getLogger().debug(`CircuitBreakerPlugin: Transitioning to HALF_OPEN for ${scopeKey}.`);
    return scopeState;
  }

  private _emitStateChange(
    scopeKey: string,
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    reason:
      | 'failure-threshold'
      | 'half-open-failure'
      | 'open-timeout-elapsed'
      | 'success-threshold-reached'
      | 'manual-reset',
    nextAttemptIn?: number,
  ): void {
    if (from === to) return;
    this._context?.triggerAndEmit?.('onCircuitStateChanged', {
      scopeKey,
      from,
      to,
      reason,
      ...(nextAttemptIn !== undefined ? { nextAttemptIn } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Failure tracking helpers
  // ---------------------------------------------------------------------------

  private _rememberFailure(scopeState: CircuitBreakerScopeState, error: AxiosError): void {
    scopeState.lastFailureStatus = error.response?.status;
    scopeState.lastFailureCode = error.code;
  }

  private _addFailureToSlidingWindow(scopeState: CircuitBreakerScopeState, error: AxiosError): void {
    scopeState.recentFailures.push({
      timestamp: Date.now(),
      url: error.config?.url || 'unknown',
      status: error.response?.status,
      errorCode: error.code,
    });
    scopeState.failureCount++;
    this._cleanupOldFailures(scopeState);
  }

  private _cleanupOldFailures(scopeState: CircuitBreakerScopeState): void {
    if (!this._options.useSlidingWindow) return;
    const windowStart = Date.now() - this._options.slidingWindowSize;
    scopeState.recentFailures = scopeState.recentFailures.filter((f) => f.timestamp >= windowStart);
  }

  private _getFailureCountInWindow(scopeState: CircuitBreakerScopeState): number {
    if (!this._options.useSlidingWindow) return scopeState.failureCount;
    this._cleanupOldFailures(scopeState);
    return scopeState.recentFailures.length;
  }

  private _shouldCountError(error: AxiosError): boolean {
    if (!this._options.shouldCountError) return true;
    try {
      return this._options.shouldCountError(error);
    } catch (callbackError) {
      this._context
        ?.getLogger()
        .warn('CircuitBreakerPlugin: shouldCountError callback threw; counting error by default', {
          error: callbackError instanceof Error ? callbackError.message : callbackError,
        });
      return true;
    }
  }

  private _isUrlExcluded(config: AxiosRequestConfig): boolean {
    if (!config.url || !this._options.excludeUrls || this._options.excludeUrls.length === 0) {
      return false;
    }
    return this._options.excludeUrls.some((pattern) => {
      if (pattern instanceof RegExp) return pattern.test(config.url || '');
      return config.url === pattern;
    });
  }

  private _createCircuitStateError(
    config: AxiosRequestConfig,
    scopeState: CircuitBreakerScopeState,
    message: string,
  ): AxiosError {
    const errorConfig: AxiosRequestConfig = { ...config };
    assignRequestMetadata(errorConfig, { requestRetries: 0 });

    const response =
      scopeState.lastFailureStatus !== undefined
        ? ({
            status: scopeState.lastFailureStatus,
            statusText: 'Circuit Open',
            config: errorConfig as never,
            headers: {},
            data: { error: message },
          } as never)
        : undefined;

    return new CircuitBreakerStateError(message, scopeState.state, errorConfig, scopeState.lastFailureCode, response);
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  private _getScopeMetrics(): CircuitBreakerScopeMetrics[] {
    const now = Date.now();
    return Array.from(this._scopeManager.getKnownScopes()).map((scope) => {
      const state = this._scopeManager.scopeStateCache.get(scope.scopeKey) ?? this._scopeManager.createInitialState();
      return {
        scopeKey: scope.scopeKey,
        url: scope.normalizedUrl,
        host: scope.host,
        state: state.state,
        failureCount: this._getVisibleCounter(scope.scopeKey, 'failureCount', state.failureCount),
        halfOpenCount: this._getVisibleCounter(scope.scopeKey, 'halfOpenCount', state.halfOpenCount),
        successCount: this._getVisibleCounter(scope.scopeKey, 'successCount', state.successCount),
        nextAttemptIn: Math.max(0, state.nextAttempt - now),
        failuresInWindow: this._getVisibleFailuresInWindow(scope.scopeKey, state),
      };
    });
  }

  private _getVisibleCounter(
    scopeKey: string,
    counter: keyof Pick<ScopeMetricsBaseline, 'failureCount' | 'halfOpenCount' | 'successCount'>,
    value: number,
  ): number {
    const baseline = this._metricBaselines.get(scopeKey);
    return Math.max(0, value - (baseline?.[counter] ?? 0));
  }

  private _getVisibleFailuresInWindow(scopeKey: string, scopeState: CircuitBreakerScopeState): number {
    if (!this._options.useSlidingWindow) {
      return this._getVisibleCounter(scopeKey, 'failureCount', scopeState.failureCount);
    }
    this._cleanupOldFailures(scopeState);
    const resetAt = this._metricBaselines.get(scopeKey)?.resetAt ?? 0;
    return scopeState.recentFailures.filter((f) => f.timestamp >= resetAt).length;
  }

  private _validateOptions(): void {
    if (!Number.isInteger(this._options.failureThreshold) || this._options.failureThreshold < 1) {
      throw new RetryerConfigError(
        'failureThreshold must be a positive integer',
        'failureThreshold',
        this._options.failureThreshold,
      );
    }
    if (!Number.isInteger(this._options.openTimeout) || this._options.openTimeout < 0) {
      throw new RetryerConfigError(
        'openTimeout must be a non-negative integer',
        'openTimeout',
        this._options.openTimeout,
      );
    }
    if (!Number.isInteger(this._options.halfOpenMax) || this._options.halfOpenMax < 1) {
      throw new RetryerConfigError('halfOpenMax must be a positive integer', 'halfOpenMax', this._options.halfOpenMax);
    }
    if (
      this._options.successThreshold !== undefined &&
      (!Number.isInteger(this._options.successThreshold) || this._options.successThreshold < 1)
    ) {
      throw new RetryerConfigError(
        'successThreshold must be a positive integer',
        'successThreshold',
        this._options.successThreshold,
      );
    }
    if (this._options.successThreshold > this._options.halfOpenMax) {
      this._options.successThreshold = this._options.halfOpenMax;
    }
    if (this._options.excludeUrls.length > 0) {
      const redosErrors = validateExcludeUrls(this._options.excludeUrls);
      if (redosErrors.length > 0) {
        throw new RetryerConfigError(
          redosErrors.map((e) => e.reason).join('\n'),
          'excludeUrls',
          redosErrors.map((e) => e.pattern),
        );
      }
    }
  }
}
