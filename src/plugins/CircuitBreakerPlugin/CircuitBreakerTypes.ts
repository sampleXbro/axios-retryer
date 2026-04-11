import type { AxiosError, AxiosRequestConfig } from 'axios';

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
   * Must be <= halfOpenMax.
   */
  successThreshold?: number;

  /**
   * If true, uses a sliding window approach to count failures over time rather than consecutive failures.
   */
  useSlidingWindow?: boolean;

  /**
   * The duration (in milliseconds) of the sliding window when useSlidingWindow is true.
   */
  slidingWindowSize?: number;

  /**
   * Callback function to determine which errors should contribute to circuit breaking.
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
   * Prevents unbounded memory growth. When the cap is reached, the oldest entry is evicted.
   * Default: 500.
   */
  maxTrackedScopes?: number;

  /**
   * Allow specific endpoints to be excluded from circuit breaking.
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
  get(key: string): CircuitBreakerScopeState | undefined | Promise<CircuitBreakerScopeState | undefined>;
  set(key: string, state: CircuitBreakerScopeState): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
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

export interface ScopeDetails {
  scopeKey: string;
  normalizedUrl: string;
  host?: string;
}

export interface ScopeMetricsBaseline {
  failureCount: number;
  successCount: number;
  halfOpenCount: number;
  resetAt: number;
}

export function cloneScopeState(state: CircuitBreakerScopeState): CircuitBreakerScopeState {
  return {
    ...state,
    recentFailures: state.recentFailures.map((failure) => ({ ...failure })),
  };
}

export function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function';
}
