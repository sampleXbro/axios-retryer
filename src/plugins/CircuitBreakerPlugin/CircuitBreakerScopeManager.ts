import type { AxiosRequestConfig } from 'axios';

import type { Logger } from '../../types';
import {
  CIRCUIT_BREAKER_SCOPES,
  CIRCUIT_BREAKER_STATES,
  cloneScopeState,
  isPromiseLike,
  type CircuitBreakerScope,
  type CircuitBreakerScopeState,
  type CircuitBreakerStateAdapter,
  type ScopeDetails,
} from './CircuitBreakerTypes';

const NO_OP_LOGGER: Logger = { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

/**
 * Default in-memory state adapter. Stores circuit state as deep clones to
 * prevent accidental mutation of internal state from external references.
 */
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

interface ScopeManagerOptions {
  scope: CircuitBreakerScope | ((config: AxiosRequestConfig) => string);
  stateAdapter: CircuitBreakerStateAdapter;
  maxTrackedScopes: number;
}

/**
 * Manages per-scope circuit breaker state: URL normalization, scope key resolution,
 * async read-modify-write locking, and distributed state adapter I/O.
 */
export class CircuitBreakerScopeManager {
  /**
   * @internal Exposed for test inspection only; not part of the public API.
   */
  readonly scopeStateCache = new Map<string, CircuitBreakerScopeState>();

  /** @internal Exposed for test inspection only; not part of the public API. */
  readonly knownScopes = new Map<string, ScopeDetails>();
  private readonly scopeLocks = new Map<string, Promise<void>>();

  private readonly scope: CircuitBreakerScope | ((config: AxiosRequestConfig) => string);
  private readonly stateAdapter: CircuitBreakerStateAdapter;
  private readonly maxTrackedScopes: number;
  private logger: Logger = NO_OP_LOGGER;

  /** Provides the current Axios baseURL for relative URL resolution. Set after plugin initialization. */
  baseURLGetter: (() => string | undefined) | undefined;

  constructor(options: ScopeManagerOptions) {
    this.scope = options.scope;
    this.stateAdapter = options.stateAdapter;
    this.maxTrackedScopes = options.maxTrackedScopes;
  }

  public setLogger(logger: Logger): void {
    this.logger = logger;
  }

  public createInitialState(): CircuitBreakerScopeState {
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

  public withLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scopeLocks.get(scopeKey) ?? Promise.resolve();
    const next = prev.then(fn, fn) as Promise<T>;
    this.scopeLocks.set(
      scopeKey,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  public async readState(scopeKey: string): Promise<CircuitBreakerScopeState> {
    let storedState: CircuitBreakerScopeState | undefined;
    try {
      storedState = await this.stateAdapter.get(scopeKey);
    } catch (error) {
      this.handleAdapterError('get', scopeKey, error);
    }
    const cachedState = this.scopeStateCache.get(scopeKey);
    const scopeState = storedState
      ? cloneScopeState(storedState)
      : cachedState
        ? cloneScopeState(cachedState)
        : this.createInitialState();
    this.scopeStateCache.set(scopeKey, scopeState);
    return scopeState;
  }

  public async writeState(scopeKey: string, scopeState: CircuitBreakerScopeState): Promise<void> {
    const clonedState = cloneScopeState(scopeState);
    this.scopeStateCache.set(scopeKey, clonedState);
    try {
      await this.stateAdapter.set(scopeKey, clonedState);
    } catch (error) {
      this.handleAdapterError('set', scopeKey, error);
    }
  }

  public getScopeDetails(config: AxiosRequestConfig): ScopeDetails {
    const normalizedUrl = this.normalizeUrl(this.extractPath(config));
    const host = this.extractHost(config);
    const scopeKey = this.resolveScopeKey(config, normalizedUrl, host);

    if (!this.knownScopes.has(scopeKey)) {
      if (this.knownScopes.size >= this.maxTrackedScopes) {
        const oldestKey = this.knownScopes.keys().next().value as string;
        this.knownScopes.delete(oldestKey);
        this.scopeStateCache.delete(oldestKey);
      }
      this.knownScopes.set(scopeKey, { scopeKey, normalizedUrl, host });
    }

    return this.knownScopes.get(scopeKey)!;
  }

  public getKnownScopes(): IterableIterator<ScopeDetails> {
    return this.knownScopes.values();
  }

  public getTrackedScopeKeys(scopeKey?: string): string[] {
    if (scopeKey) {
      return [scopeKey];
    }
    return Array.from(new Set([...this.knownScopes.keys(), ...this.scopeStateCache.keys()]));
  }

  public deleteDistributedScope(scopeKey: string): void {
    try {
      const result = this.stateAdapter.delete(scopeKey);
      if (isPromiseLike(result)) {
        void result.catch((error) => {
          this.handleAdapterError('delete', scopeKey, error);
          this.restoreDistributedClosedState([scopeKey]);
        });
      }
    } catch (error) {
      this.handleAdapterError('delete', scopeKey, error);
      this.restoreDistributedClosedState([scopeKey]);
    }
  }

  public clearDistributedState(scopeKeys: readonly string[]): void {
    try {
      const result = this.stateAdapter.clear();
      if (isPromiseLike(result)) {
        void result.catch((error) => {
          this.handleAdapterError('clear', '*', error);
          this.restoreDistributedClosedState(scopeKeys);
        });
      }
    } catch (error) {
      this.handleAdapterError('clear', '*', error);
      this.restoreDistributedClosedState(scopeKeys);
    }
  }

  private restoreDistributedClosedState(scopeKeys: readonly string[]): void {
    scopeKeys.forEach((key) => {
      const result = this.stateAdapter.set(key, this.createInitialState());
      if (isPromiseLike(result)) {
        void result.catch((error) => {
          this.handleAdapterError('set', key, error);
        });
      }
    });
  }

  private resolveScopeKey(config: AxiosRequestConfig, normalizedUrl: string, host?: string): string {
    const defaultScopeKey = host ? `${host}${normalizedUrl}` : normalizedUrl || 'unknown';

    if (typeof this.scope === 'function') {
      try {
        const customScopeKey = this.scope(config);
        if (typeof customScopeKey === 'string' && customScopeKey.length > 0) {
          return customScopeKey;
        }
        this.logger.warn('CircuitBreakerPlugin: Custom scope callback returned an empty scope key; using default', {
          url: config.url,
        });
        return defaultScopeKey;
      } catch (error) {
        this.logger.warn('CircuitBreakerPlugin: Custom scope callback threw; using default scope', {
          error: error instanceof Error ? error.message : error,
          url: config.url,
        });
        return defaultScopeKey;
      }
    }

    switch (this.scope) {
      case CIRCUIT_BREAKER_SCOPES.HOST:
        return host || normalizedUrl || 'unknown';
      case CIRCUIT_BREAKER_SCOPES.URL:
        return normalizedUrl || host || 'unknown';
      case CIRCUIT_BREAKER_SCOPES.HOST_AND_URL:
      default:
        return defaultScopeKey;
    }
  }

  public normalizeUrl(url: string): string {
    let normalized = url.split('?')[0].split('#')[0];
    normalized = normalized.replace(
      /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)(\/|$)/gi,
      '/:id$2',
    );
    return normalized;
  }

  public resolveScopeKeyPublic(config: AxiosRequestConfig, normalizedUrl: string, host?: string): string {
    return this.resolveScopeKey(config, normalizedUrl, host);
  }

  private extractPath(config: AxiosRequestConfig): string {
    const resolved = this.resolveUrl(config);
    if (resolved) {
      return `${resolved.pathname}${resolved.search}${resolved.hash}` || '/';
    }
    return config.url || '/';
  }

  private extractHost(config: AxiosRequestConfig): string | undefined {
    return this.resolveUrl(config)?.host;
  }

  private resolveUrl(config: AxiosRequestConfig): URL | null {
    if (!config.url) {
      return null;
    }
    const baseURL = config.baseURL ?? this.baseURLGetter?.();
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

  private handleAdapterError(operation: 'get' | 'set' | 'delete' | 'clear', scopeKey: string, error: unknown): void {
    this.logger.warn(`CircuitBreakerPlugin: State adapter ${operation} failed; continuing with local circuit state`, {
      scopeKey,
      error: error instanceof Error ? error.message : error,
    });
  }
}
