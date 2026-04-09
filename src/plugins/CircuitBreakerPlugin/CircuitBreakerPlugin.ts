import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

import { RetryerConfigError } from '../../core/errors/RetryerConfigError';
import type { PluginContext } from '../../types';
import type { RetryPlugin } from '../../types';
import { assignRequestMetadata, ensureRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';
import { CircuitBreakerStateError } from './CircuitBreakerStateError';

type MaybePromise<T> = T | Promise<T>;

export const CIRCUIT_BREAKER_STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
} as const;

export type CircuitBreakerState = (typeof CIRCUIT_BREAKER_STATES)[keyof typeof CIRCUIT_BREAKER_STATES];

export const CIRCUIT_BREAKER_SCOPES = {
  HOST: 'host',
  URL: 'url',
  HOST_AND_URL: 'host+url',
} as const;

export type CircuitBreakerScope = (typeof CIRCUIT_BREAKER_SCOPES)[keyof typeof CIRCUIT_BREAKER_SCOPES];

/**
 * Configuration options for the Circuit Breaker behavior.
 */
export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures required to trip the circuit.
   * Once this threshold is exceeded, the circuit transitions from `CLOSED` to `OPEN`.
   */
  failureThreshold: number;

  /**
   * Duration (in milliseconds) the circuit remains in the `OPEN` state
   * before allowing a test request in the `HALF_OPEN` state.
   */
  openTimeout: number;

  /**
   * Maximum number of test requests allowed in `HALF_OPEN` state
   * before deciding to either reset (back to `CLOSED`) or trip again to `OPEN`.
   */
  halfOpenMax: number;

  /**
   * Number of successful test requests required in HALF_OPEN state to reset the circuit.
   * This allows for more confidence before fully closing the circuit.
   * Must be <= halfOpenMax.
   */
  successThreshold?: number;

  /**
   * If true, uses a sliding window approach to count failures over time rather than consecutive failures.
   * This provides more accurate failure detection in high-volume systems.
   */
  useSlidingWindow?: boolean;

  /**
   * The duration (in milliseconds) of the sliding window when useSlidingWindow is true.
   * Only failures within this time period are counted toward the failure threshold.
   */
  slidingWindowSize?: number;

  /**
   * Callback function to determine which errors should contribute to circuit breaking.
   * This allows selective monitoring of specific error types.
   * If not provided, all errors count.
   */
  shouldCountError?: (error: AxiosError) => boolean;

  /**
   * Adaptive timeout configuration. When true, the circuit breaker will track response times
   * and adjust timeouts accordingly.
   */
  adaptiveTimeout?: boolean;

  /**
   * Percentile (0-1) to use for adaptive timeout calculation. Default is 0.95 (95th percentile).
   */
  adaptiveTimeoutPercentile?: number;

  /**
   * Number of historical response times to track for adaptive timeout calculation.
   */
  adaptiveTimeoutSampleSize?: number;

  /**
   * Timeout multiplier (e.g., 1.5 = 150% of the calculated percentile).
   */
  adaptiveTimeoutMultiplier?: number;

  /**
   * Maximum number of unique scope keys tracked in the adaptive-timeout response-metrics map.
   * Prevents unbounded memory growth under adversarial or high-cardinality URL spaces.
   * When the cap is reached, the oldest entry is evicted. Default: 500.
   */
  maxTrackedScopes?: number;

  /**
   * Allow specific endpoints to be excluded from circuit breaking.
   * These URLs will always be allowed through regardless of circuit state.
   *
   * String patterns use exact URL equality. `RegExp` patterns are tested against
   * the full request URL on every request — prefer string patterns when possible.
   *
   * **Security note (ReDoS):** Avoid catastrophically backtracking patterns such as
   * `/(a+)+$/` combined with long non-matching URLs. JavaScript's regex engine is
   * single-threaded and synchronous; a pathological pattern will block the event loop.
   * Validate any user-controlled or externally-sourced patterns before use.
   */
  excludeUrls?: readonly (string | RegExp)[];

  /**
   * Controls how circuit state is grouped.
   * `host+url` scopes by host and normalized URL, which is the default.
   */
  scope?: CircuitBreakerScope | ((config: AxiosRequestConfig) => string);

  /**
   * Optional adapter for sharing circuit state across processes or hosts.
   */
  stateAdapter?: CircuitBreakerStateAdapter;
}

export interface CircuitBreakerFailureRecord {
  timestamp: number;
  url: string;
  status?: number;
  errorCode?: string;
}

export interface CircuitBreakerScopeState {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  halfOpenCount: number;
  nextAttempt: number;
  recentFailures: CircuitBreakerFailureRecord[];
  lastFailureStatus?: number;
  lastFailureCode?: string;
}

export interface CircuitBreakerScopeMetrics {
  scopeKey: string;
  url: string;
  host?: string;
  state: CircuitBreakerState;
  failureCount: number;
  halfOpenCount: number;
  successCount: number;
  nextAttemptIn: number;
  failuresInWindow: number;
}

export interface CircuitBreakerAdaptiveTimeoutMetrics {
  scopeKey: string;
  url: string;
  host?: string;
  timeoutMs: number;
  p95ResponseTimeMs: number;
  samplesCount: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  halfOpenCount: number;
  successCount: number;
  nextAttemptIn: number;
  failuresInWindow: number;
  adaptiveTimeouts: CircuitBreakerAdaptiveTimeoutMetrics[];
  scopeMetrics: CircuitBreakerScopeMetrics[];
}

export interface CircuitBreakerStateAdapter {
  get(key: string): MaybePromise<CircuitBreakerScopeState | undefined>;
  set(key: string, state: CircuitBreakerScopeState): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  clear(): MaybePromise<void>;
}

export interface CircuitBreakerPluginEvents {
  onCircuitStateChanged?: (payload: {
    scopeKey: string;
    from: CircuitBreakerState;
    to: CircuitBreakerState;
    reason:
      | 'failure-threshold'
      | 'half-open-failure'
      | 'open-timeout-elapsed'
      | 'success-threshold-reached'
      | 'manual-reset';
    nextAttemptIn?: number;
  }) => void;
}

export class InMemoryCircuitBreakerStateAdapter implements CircuitBreakerStateAdapter {
  private readonly state = new Map<string, CircuitBreakerScopeState>();

  public get(key: string): CircuitBreakerScopeState | undefined {
    const stored = this.state.get(key);
    return stored ? cloneScopeState(stored) : undefined;
  }

  public set(key: string, state: CircuitBreakerScopeState): void {
    this.state.set(key, cloneScopeState(state));
  }

  public delete(key: string): void {
    this.state.delete(key);
  }

  public clear(): void {
    this.state.clear();
  }
}

/**
 * Interface to track response time metrics for adaptive timeouts
 */
interface ResponseTimeMetrics {
  times: number[];
  sampleSize: number;
  lastCalculated: number;
  currentPercentileMs: number;
  scopeKey: string;
  normalizedUrl: string;
  host?: string;
}

interface ScopeDetails {
  scopeKey: string;
  normalizedUrl: string;
  host?: string;
}

function cloneScopeState(state: CircuitBreakerScopeState): CircuitBreakerScopeState {
  return {
    ...state,
    recentFailures: state.recentFailures.map((failure) => ({ ...failure })),
  };
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function';
}

/**
 * Enhanced CircuitBreakerPlugin
 *
 * This plugin implements an advanced Circuit Breaker pattern with:
 * - Sliding window failure counting (time-based rather than just consecutive)
 * - Selective error monitoring (filter which errors should trip the circuit)
 * - Adaptive timeout management (learns from response times)
 * - Granular recovery with success threshold
 * - URL exclusion capabilities
 * - Scoped circuit state per host / normalized endpoint
 * - Optional distributed state adapters for shared circuit state
 *
 * When enabled, it monitors for failure patterns and temporarily "opens the circuit"
 * to prevent further calls to problematic services, with intelligent recovery mechanisms.
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
  /** @internal Exposed for test inspection only; not part of the public API. */
  _responseMetrics: Record<string, ResponseTimeMetrics> = {};
  private readonly _scopeStateCache = new Map<string, CircuitBreakerScopeState>();
  private readonly _knownScopes = new Map<string, ScopeDetails>();
  /** Per-scope promise chain that serializes async read-modify-write cycles. */
  private readonly _scopeLocks = new Map<string, Promise<void>>();

  /**
   * Creates an instance of CircuitBreakerPlugin with advanced options.
   * @param {Partial<CircuitBreakerOptions>} [options] - Configuration options.
   */
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
  }

  /**
   * Initializes the plugin by setting up request and response interceptors.
   * Called when the plugin is attached.
   *
   * @param {RetryManager} manager - The RetryManager instance.
   */
  public initialize(context: PluginContext<CircuitBreakerPluginEvents>): void {
    this._context = context;
    const axiosInstance = context.axiosInstance;

    this._log('debug', 'Initializing CircuitBreakerPlugin with options:', {
      ...this._options,
    });

    this._requestInterceptorId = axiosInstance.interceptors.request.use(async (config) => {
      const metadata = ensureRequestMetadata(config);

      if (this._options.adaptiveTimeout && config.url && !metadata.timestamp) {
        assignRequestMetadata(config, { timestamp: Date.now() });
      }

      if (this._isUrlExcluded(config)) {
        this._log('debug', `URL excluded from circuit breaking: ${config.url}`);
        return config;
      }

      const scopeDetails = this._getScopeDetails(config);

      // Serialize read-modify-write within a scope to prevent lost updates under concurrency.
      const decision = await this._withScopeLock(scopeDetails.scopeKey, async () => {
        let scopeState = await this._readScopeState(scopeDetails.scopeKey);

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
          await this._writeScopeState(scopeDetails.scopeKey, scopeState);
          this._log(
            'debug',
            `HALF_OPEN test request #${scopeState.halfOpenCount} of ${this._options.halfOpenMax} for ${scopeDetails.scopeKey}`,
          );
        }

        return { action: 'allow', scopeState } as const;
      });

      if (decision.action === 'reject-open') {
        const remainingTime = decision.scopeState.nextAttempt - Date.now();
        this._log(
          'debug',
          `Circuit is OPEN for ${scopeDetails.scopeKey}: failing fast. Will retry in ${remainingTime}ms`,
        );
        return Promise.reject(
          this._createCircuitStateError(config, decision.scopeState, 'Circuit is open: failing fast.'),
        );
      }

      if (decision.action === 'reject-half-open') {
        this._log('debug', `Circuit is HALF_OPEN for ${scopeDetails.scopeKey}: too many test requests.`);
        return Promise.reject(
          this._createCircuitStateError(config, decision.scopeState, 'Circuit is half-open: too many test requests.'),
        );
      }

      if (this._options.adaptiveTimeout) {
        const responseMetrics = this._responseMetrics[scopeDetails.scopeKey];
        if (responseMetrics && responseMetrics.currentPercentileMs > 0) {
          config.timeout = Math.round(responseMetrics.currentPercentileMs * this._options.adaptiveTimeoutMultiplier);
          this._log('debug', `Setting adaptive timeout for ${scopeDetails.scopeKey}: ${config.timeout}ms`);
        }
      }

      return config;
    });

    this._responseInterceptorId = axiosInstance.interceptors.response.use(
      async (response) => {
        if (this._options.adaptiveTimeout && response.config.url) {
          this._trackResponseTime(response);
        }

        if (this._isUrlExcluded(response.config)) {
          return response;
        }

        const scopeDetails = this._getScopeDetails(response.config);

        await this._withScopeLock(scopeDetails.scopeKey, async () => {
          const scopeState = await this._readScopeState(scopeDetails.scopeKey);

          if (scopeState.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
            scopeState.successCount++;
            const successThreshold = this._options.successThreshold || 1;

            if (scopeState.successCount >= successThreshold) {
              this._log(
                'debug',
                `HALF_OPEN success threshold reached (${scopeState.successCount}/${successThreshold}) for ${scopeDetails.scopeKey}`,
              );
              await this._resetScope(scopeDetails.scopeKey);
            } else {
              await this._writeScopeState(scopeDetails.scopeKey, scopeState);
              this._log(
                'debug',
                `HALF_OPEN success: ${scopeState.successCount}/${successThreshold} successful test requests for ${scopeDetails.scopeKey}`,
              );
            }
          } else if (scopeState.state === CIRCUIT_BREAKER_STATES.CLOSED && scopeState.failureCount > 0) {
            scopeState.failureCount = 0;
            scopeState.lastFailureStatus = undefined;
            scopeState.lastFailureCode = undefined;
            await this._writeScopeState(scopeDetails.scopeKey, scopeState);
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

        if (this._options.shouldCountError && !this._options.shouldCountError(error)) {
          this._log('debug', 'Error excluded from circuit breaking by shouldCountError');
          return Promise.reject(error);
        }

        const scopeDetails = this._getScopeDetails(error.config);

        await this._withScopeLock(scopeDetails.scopeKey, async () => {
          const scopeState = await this._readScopeState(scopeDetails.scopeKey);
          this._rememberFailure(scopeState, error);

          if (this._options.useSlidingWindow) {
            this._addFailureToSlidingWindow(scopeState, error);
            const currentCount = this._getFailureCountInWindow(scopeState);

            if (currentCount >= this._options.failureThreshold) {
              this._log(
                'debug',
                `Sliding window failure threshold reached for ${scopeDetails.scopeKey}: ${currentCount} failures in window`,
              );
              await this._tripScope(scopeDetails.scopeKey, scopeState);
            } else {
              await this._writeScopeState(scopeDetails.scopeKey, scopeState);
            }
          } else {
            scopeState.failureCount++;
            this._log(
              'debug',
              `Failure count increased for ${scopeDetails.scopeKey}: ${scopeState.failureCount}/${this._options.failureThreshold}`,
            );

            if (
              scopeState.state === CIRCUIT_BREAKER_STATES.HALF_OPEN ||
              scopeState.failureCount >= this._options.failureThreshold
            ) {
              await this._tripScope(scopeDetails.scopeKey, scopeState);
            } else {
              await this._writeScopeState(scopeDetails.scopeKey, scopeState);
            }
          }
        });

        return Promise.reject(error);
      },
    );
  }

  /**
   * Called before the plugin is removed.
   * Ejects the interceptors.
   *
   * @param {RetryManager} manager - The RetryManager instance.
   */
  public onBeforeDestroyed(context: PluginContext<CircuitBreakerPluginEvents>): void {
    this._log('debug', 'Removing CircuitBreakerPlugin');
    const axiosInstance = context.axiosInstance;
    if (this._requestInterceptorId !== undefined) {
      axiosInstance.interceptors.request.eject(this._requestInterceptorId);
    }
    if (this._responseInterceptorId !== undefined) {
      axiosInstance.interceptors.response.eject(this._responseInterceptorId);
    }
  }

  /**
   * Returns the current state of the circuit breaker.
   * Useful for monitoring or metrics collection.
   */
  public getState(scopeKey?: string): CircuitBreakerState {
    if (scopeKey) {
      return this._scopeStateCache.get(scopeKey)?.state ?? CIRCUIT_BREAKER_STATES.CLOSED;
    }

    const states = Array.from(this._scopeStateCache.values()).map((scopeState) => scopeState.state);
    if (states.includes(CIRCUIT_BREAKER_STATES.OPEN)) {
      return CIRCUIT_BREAKER_STATES.OPEN;
    }
    if (states.includes(CIRCUIT_BREAKER_STATES.HALF_OPEN)) {
      return CIRCUIT_BREAKER_STATES.HALF_OPEN;
    }
    return CIRCUIT_BREAKER_STATES.CLOSED;
  }

  /**
   * Returns metrics about the circuit breaker's operation.
   * Includes current failure count, state, and time until next attempt.
   */
  public getMetrics(): CircuitBreakerMetrics {
    const now = Date.now();
    const scopeMetrics = Array.from(this._knownScopes.values()).map((scope) => {
      const state = this._scopeStateCache.get(scope.scopeKey) ?? this._createInitialScopeState();
      return {
        scopeKey: scope.scopeKey,
        url: scope.normalizedUrl,
        host: scope.host,
        state: state.state,
        failureCount: state.failureCount,
        halfOpenCount: state.halfOpenCount,
        successCount: state.successCount,
        nextAttemptIn: Math.max(0, state.nextAttempt - now),
        failuresInWindow: this._getFailureCountInWindow(state),
      };
    });

    return {
      state: this.getState(),
      failureCount: scopeMetrics.reduce((sum, scope) => sum + scope.failureCount, 0),
      halfOpenCount: scopeMetrics.reduce((sum, scope) => sum + scope.halfOpenCount, 0),
      successCount: scopeMetrics.reduce((sum, scope) => sum + scope.successCount, 0),
      nextAttemptIn: scopeMetrics.reduce((max, scope) => Math.max(max, scope.nextAttemptIn), 0),
      failuresInWindow: scopeMetrics.reduce((sum, scope) => sum + scope.failuresInWindow, 0),
      adaptiveTimeouts: this._options.adaptiveTimeout
        ? Object.values(this._responseMetrics).map((metrics) => ({
            scopeKey: metrics.scopeKey,
            url: metrics.normalizedUrl,
            host: metrics.host,
            timeoutMs: Math.round(metrics.currentPercentileMs * this._options.adaptiveTimeoutMultiplier),
            p95ResponseTimeMs: metrics.currentPercentileMs,
            samplesCount: metrics.times.length,
          }))
        : [],
      scopeMetrics,
    };
  }

  /**
   * Resets all known scopes immediately.
   * @internal Exposed for test usage only; not part of the public API.
   */
  _reset(scopeKey?: string): void {
    const scopeKeys = scopeKey ? [scopeKey] : Array.from(this._knownScopes.keys());

    scopeKeys.forEach((key) => {
      const previousState = this._scopeStateCache.get(key)?.state ?? CIRCUIT_BREAKER_STATES.CLOSED;
      const initialState = this._createInitialScopeState();
      this._scopeStateCache.set(key, initialState);
      const result = this._options.stateAdapter.set(key, cloneScopeState(initialState));
      if (isPromiseLike(result)) {
        void result;
      }
      if (previousState !== CIRCUIT_BREAKER_STATES.CLOSED) {
        this._emitStateChange(key, previousState, CIRCUIT_BREAKER_STATES.CLOSED, 'manual-reset');
      }
    });

    this._log('debug', 'Circuit reset: entering CLOSED state.');
  }

  private async _tripScope(scopeKey: string, scopeState: CircuitBreakerScopeState): Promise<void> {
    if (scopeState.state !== CIRCUIT_BREAKER_STATES.OPEN) {
      const previousState = scopeState.state;
      scopeState.state = CIRCUIT_BREAKER_STATES.OPEN;
      scopeState.nextAttempt = Date.now() + this._options.openTimeout;
      scopeState.successCount = 0;
      scopeState.halfOpenCount = 0;
      await this._writeScopeState(scopeKey, scopeState);
      this._emitStateChange(
        scopeKey,
        previousState,
        CIRCUIT_BREAKER_STATES.OPEN,
        previousState === CIRCUIT_BREAKER_STATES.HALF_OPEN ? 'half-open-failure' : 'failure-threshold',
        Math.max(0, scopeState.nextAttempt - Date.now()),
      );
      this._log(
        'error',
        `Circuit tripped: entering OPEN state for ${scopeKey} until ${new Date(scopeState.nextAttempt).toISOString()}`,
      );
    }
  }

  private async _resetScope(scopeKey: string): Promise<void> {
    const previousState = this._scopeStateCache.get(scopeKey)?.state ?? CIRCUIT_BREAKER_STATES.CLOSED;
    const initialState = this._createInitialScopeState();
    await this._writeScopeState(scopeKey, initialState);
    if (previousState !== CIRCUIT_BREAKER_STATES.CLOSED) {
      this._emitStateChange(scopeKey, previousState, CIRCUIT_BREAKER_STATES.CLOSED, 'success-threshold-reached');
    }
    this._log('debug', `Circuit reset: entering CLOSED state for ${scopeKey}.`);
  }

  private async _transitionToHalfOpen(
    scopeKey: string,
    scopeState: CircuitBreakerScopeState,
  ): Promise<CircuitBreakerScopeState> {
    const previousState = scopeState.state;
    scopeState.state = CIRCUIT_BREAKER_STATES.HALF_OPEN;
    scopeState.halfOpenCount = 0;
    scopeState.successCount = 0;
    await this._writeScopeState(scopeKey, scopeState);
    this._emitStateChange(scopeKey, previousState, CIRCUIT_BREAKER_STATES.HALF_OPEN, 'open-timeout-elapsed');
    this._log('debug', `Circuit transitioning to HALF_OPEN state for ${scopeKey}.`);
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
    if (from === to) {
      return;
    }

    this._context?.triggerAndEmit?.('onCircuitStateChanged', {
      scopeKey,
      from,
      to,
      reason,
      ...(nextAttemptIn !== undefined ? { nextAttemptIn } : {}),
    });
  }

  private _rememberFailure(scopeState: CircuitBreakerScopeState, error: AxiosError): void {
    scopeState.lastFailureStatus = error.response?.status;
    scopeState.lastFailureCode = error.code;
  }

  private _createCircuitStateError(
    config: AxiosRequestConfig,
    scopeState: CircuitBreakerScopeState,
    message: string,
  ): AxiosError {
    const errorConfig: AxiosRequestConfig = {
      ...config,
    };
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

  /**
   * Adds a failure to the sliding window for time-based failure tracking.
   */
  private _addFailureToSlidingWindow(scopeState: CircuitBreakerScopeState, error: AxiosError): void {
    const failure: CircuitBreakerFailureRecord = {
      timestamp: Date.now(),
      url: error.config?.url || 'unknown',
      status: error.response?.status,
      errorCode: error.code,
    };

    scopeState.recentFailures.push(failure);
    scopeState.failureCount++;
    this._cleanupOldFailures(scopeState);
    this._log('debug', `Added failure to sliding window. Current count: ${scopeState.recentFailures.length}`);
  }

  /**
   * Removes failures that are outside the sliding window timeframe.
   */
  private _cleanupOldFailures(scopeState: CircuitBreakerScopeState): void {
    if (!this._options.useSlidingWindow) {
      return;
    }

    const windowStart = Date.now() - this._options.slidingWindowSize;
    scopeState.recentFailures = scopeState.recentFailures.filter((failure) => failure.timestamp >= windowStart);
  }

  /**
   * Gets the number of failures in the current sliding window.
   */
  private _getFailureCountInWindow(scopeState: CircuitBreakerScopeState): number {
    if (!this._options.useSlidingWindow) {
      return scopeState.failureCount;
    }

    this._cleanupOldFailures(scopeState);
    return scopeState.recentFailures.length;
  }

  /**
   * Tracks response time for adaptive timeout calculation.
   * @internal Exposed for test inspection only; not part of the public API.
   */
  _trackResponseTime(response: AxiosResponse): void {
    if (!response.config.url || !this._options.adaptiveTimeout) {
      return;
    }

    const scopeDetails = this._getScopeDetails(response.config);
    let responseTime = 0;

    if (response.headers && response.headers['x-response-time']) {
      responseTime = parseInt(response.headers['x-response-time'], 10);
    } else if (getRequestMetadata(response.config)?.timestamp) {
      responseTime = Date.now() - (getRequestMetadata(response.config)?.timestamp || 0);
    }

    if (responseTime <= 0) {
      responseTime = 100;
    }

    if (!this._responseMetrics[scopeDetails.scopeKey]) {
      const keys = Object.keys(this._responseMetrics);
      if (keys.length >= this._options.maxTrackedScopes) {
        // Evict the oldest (first-inserted) scope to keep the map bounded.
        delete this._responseMetrics[keys[0]];
      }
      this._responseMetrics[scopeDetails.scopeKey] = {
        times: [],
        sampleSize: this._options.adaptiveTimeoutSampleSize,
        lastCalculated: 0,
        currentPercentileMs: 0,
        scopeKey: scopeDetails.scopeKey,
        normalizedUrl: scopeDetails.normalizedUrl,
        host: scopeDetails.host,
      };
    }

    const metrics = this._responseMetrics[scopeDetails.scopeKey];
    metrics.times.push(responseTime);

    if (metrics.times.length > metrics.sampleSize) {
      metrics.times.shift();
    }

    this._updateTimeoutPercentile(scopeDetails.scopeKey);
  }

  /**
   * Updates the timeout percentile calculation for a specific scope.
   * Recalculates only every 10 samples to avoid an O(n log n) sort on every response.
   * Always calculates on the first sample (currentPercentileMs === 0).
   */
  private _updateTimeoutPercentile(scopeKey: string): void {
    const metrics = this._responseMetrics[scopeKey];
    if (!metrics || metrics.times.length === 0) {
      return;
    }

    // Recalculate every min(10, sampleSize) samples to bound the O(n log n) sort cost.
    const recalcInterval = Math.min(10, metrics.sampleSize);
    if (metrics.currentPercentileMs > 0 && metrics.times.length % recalcInterval !== 0) {
      return;
    }

    const sortedTimes = [...metrics.times].sort((a, b) => a - b);
    const percentile = this._options.adaptiveTimeoutPercentile;
    const index = Math.max(0, Math.min(Math.ceil(sortedTimes.length * percentile) - 1, sortedTimes.length - 1));
    metrics.currentPercentileMs = sortedTimes[index];
    metrics.lastCalculated = Date.now();

    this._log(
      'debug',
      `Updated adaptive timeout for ${scopeKey}: ${metrics.currentPercentileMs}ms at ${percentile * 100}th percentile`,
    );
  }

  /**
   * Normalizes a URL for grouping similar endpoints.
   * e.g., /users/123 and /users/456 become /users/:id
   * Strips query strings and replaces numeric/UUID path segments with :id.
   */
  private _normalizeUrl(url: string): string {
    let normalized = url.split('?')[0].split('#')[0];

    normalized = normalized.replace(
      /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)(\/|$)/gi,
      '/:id$2',
    );

    return normalized;
  }

  /**
   * Checks if a URL is excluded from circuit breaking.
   */
  private _isUrlExcluded(config: AxiosRequestConfig): boolean {
    if (!config.url || !this._options.excludeUrls || this._options.excludeUrls.length === 0) {
      return false;
    }

    return this._options.excludeUrls.some((pattern) => {
      if (pattern instanceof RegExp) {
        return pattern.test(config.url || '');
      }
      return config.url === pattern;
    });
  }

  /**
   * Helper method for logging with the appropriate log level.
   */
  private _log(level: 'debug' | 'error' | 'warn', message: string, data?: unknown): void {
    if (this._context && typeof this._context.getLogger === 'function') {
      const logger = this._context.getLogger();
      const formattedMsg = `${this.name}: ${message}`;

      switch (level) {
        case 'debug':
          logger.debug(formattedMsg, data as object | undefined);
          break;
        case 'error':
          logger.error(formattedMsg, data);
          break;
        case 'warn':
          logger.warn(formattedMsg, data);
          break;
      }
    }
  }

  private _createInitialScopeState(): CircuitBreakerScopeState {
    return {
      state: CIRCUIT_BREAKER_STATES.CLOSED,
      failureCount: 0,
      successCount: 0,
      halfOpenCount: 0,
      nextAttempt: Date.now(),
      recentFailures: [],
      lastFailureStatus: undefined,
      lastFailureCode: undefined,
    };
  }

  /**
   * Serializes async read-modify-write operations for a single scope key.
   * Each call chains onto the previous promise for that key, preventing concurrent
   * interleaving that would cause lost updates (especially with external state adapters).
   */
  private _withScopeLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._scopeLocks.get(scopeKey) ?? Promise.resolve();
    const next = prev.then(fn, fn) as Promise<T>;
    // Store a void-typed chain so the lock map stays GC-friendly.
    this._scopeLocks.set(
      scopeKey,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  private async _readScopeState(scopeKey: string): Promise<CircuitBreakerScopeState> {
    const storedState = await this._options.stateAdapter.get(scopeKey);
    // Clone once: isolate from the adapter's internal storage.
    const scopeState = storedState ? cloneScopeState(storedState) : this._createInitialScopeState();
    // Cache the same reference; _writeScopeState will replace it with a fresh clone.
    this._scopeStateCache.set(scopeKey, scopeState);
    return scopeState;
  }

  private async _writeScopeState(scopeKey: string, scopeState: CircuitBreakerScopeState): Promise<void> {
    // Clone once: isolate cache and adapter from the caller's mutable reference.
    const clonedState = cloneScopeState(scopeState);
    this._scopeStateCache.set(scopeKey, clonedState);
    await this._options.stateAdapter.set(scopeKey, clonedState);
  }

  private _getScopeDetails(config: AxiosRequestConfig): ScopeDetails {
    const normalizedUrl = this._normalizeUrl(this._extractPathFromConfig(config));
    const host = this._extractHostFromConfig(config);

    let scopeKey: string;
    if (typeof this._options.scope === 'function') {
      scopeKey = this._options.scope(config);
    } else {
      switch (this._options.scope) {
        case 'host':
          scopeKey = host || normalizedUrl || 'unknown';
          break;
        case 'url':
          scopeKey = normalizedUrl || host || 'unknown';
          break;
        case 'host+url':
        default:
          scopeKey = host ? `${host}${normalizedUrl}` : '__global__';
          break;
      }
    }

    if (!this._knownScopes.has(scopeKey)) {
      // Evict the oldest entry when the cap is reached to keep both tracking
      // maps bounded. Uses insertion-order iteration of Map as a cheap FIFO.
      if (this._knownScopes.size >= this._options.maxTrackedScopes) {
        const oldestKey = this._knownScopes.keys().next().value as string;
        this._knownScopes.delete(oldestKey);
        this._scopeStateCache.delete(oldestKey);
      }
      this._knownScopes.set(scopeKey, { scopeKey, normalizedUrl, host });
    }

    return this._knownScopes.get(scopeKey)!;
  }

  private _extractPathFromConfig(config: AxiosRequestConfig): string {
    const resolvedUrl = this._resolveUrl(config);
    if (resolvedUrl) {
      return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}` || '/';
    }

    return config.url || '/';
  }

  private _extractHostFromConfig(config: AxiosRequestConfig): string | undefined {
    return this._resolveUrl(config)?.host;
  }

  private _resolveUrl(config: AxiosRequestConfig): URL | null {
    if (!config.url) {
      return null;
    }

    const baseURL = config.baseURL ?? this._context?.axiosInstance.defaults.baseURL;
    const isAbsolute = /^[a-z][a-z\d+\-.]*:\/\//i.test(config.url);

    if (!isAbsolute && !baseURL) {
      return null;
    }

    try {
      return new URL(config.url, baseURL);
    } catch (_error) {
      return null;
    }
  }
}
