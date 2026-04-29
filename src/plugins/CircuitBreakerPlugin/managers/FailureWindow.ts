import type { AxiosError } from 'axios';

import type { CircuitBreakerScopeState } from '../types';

export interface FailureWindowOptions {
  useSlidingWindow: boolean;
  /** Window length in milliseconds. Ignored when `useSlidingWindow` is false. */
  slidingWindowSize: number;
}

/**
 * Pure helper that owns the per-scope failure list mutations.
 *
 * Append a failure with `add`, expire stale entries with `cleanup`, read the
 * effective count with `count`. The helper keeps `failureCount` aligned with
 * the in-window list so callers can rely on either field consistently.
 */
export class FailureWindow {
  constructor(private readonly options: FailureWindowOptions) {}

  public rememberLast(scopeState: CircuitBreakerScopeState, error: AxiosError): void {
    scopeState.lastFailureStatus = error.response?.status;
    scopeState.lastFailureCode = error.code;
  }

  public add(scopeState: CircuitBreakerScopeState, error: AxiosError): void {
    scopeState.recentFailures.push({
      timestamp: Date.now(),
      url: error.config?.url || 'unknown',
      status: error.response?.status,
      errorCode: error.code,
    });
    scopeState.failureCount++;
    this.cleanup(scopeState);
  }

  public cleanup(scopeState: CircuitBreakerScopeState): void {
    if (!this.options.useSlidingWindow) return;
    const windowStart = Date.now() - this.options.slidingWindowSize;
    const before = scopeState.recentFailures.length;
    scopeState.recentFailures = scopeState.recentFailures.filter((f) => f.timestamp >= windowStart);
    const evicted = before - scopeState.recentFailures.length;
    if (evicted > 0) {
      scopeState.failureCount = Math.max(0, scopeState.failureCount - evicted);
    }
  }

  public count(scopeState: CircuitBreakerScopeState): number {
    if (!this.options.useSlidingWindow) return scopeState.failureCount;
    this.cleanup(scopeState);
    return scopeState.recentFailures.length;
  }

  public countSince(scopeState: CircuitBreakerScopeState, sinceMs: number): number {
    this.cleanup(scopeState);
    return scopeState.recentFailures.filter((f) => f.timestamp >= sinceMs).length;
  }
}
