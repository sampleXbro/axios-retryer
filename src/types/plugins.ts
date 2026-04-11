import type { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

import type { AxiosRetryerBackoffType } from './common';
import type { RetryEventArgs, RetryEventListener, RetryManagerEvents } from './events';
import type { MetricsRecorder } from './metrics';

/**
 * Logger interface used by RetryManager and its collaborators.
 * Supply a custom implementation via {@link RetryManagerOptions.logger}
 * to redirect or suppress log output.
 */
export interface Logger {
  log(message: string, data?: unknown): void;
  error(message: string, error?: unknown): void;
  warn(message: string, data?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

/**
 * By implementing this interface, we can write our own custom retry logic
 * */
export interface RetryStrategy {
  /**
   * Add any logic here to determine that the error is retryable
   * @returns boolean
   * */
  getIsRetryable(error: AxiosError): boolean;
  /**
   * Add any logic here to determine that the request should be retried.
   * @returns boolean
   * */
  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean;
  /**
   * Add any logic here to get the retry delay on each attempt.
   * @returns number
   * */
  getDelay(attempt: number, maxRetries: number, backoffType?: AxiosRetryerBackoffType): number;
}

/**
 * By implementing this interface, we can write our own custom request store
 * */
export interface RequestStore {
  /**
   * Add a request config to the store
   * */
  add(request: AxiosRequestConfig): void;
  /**
   * Remove a request config to the store
   * */
  remove(request: AxiosRequestConfig): void;
  /**
   * Get all request configs from the store
   * */
  getAll(): AxiosRequestConfig[];
  /**
   * Clear request store
   * */
  clear(): void;
}

/**
 * Context object passed to plugins during initialization and teardown.
 * Provides the plugin-facing view of RetryManager capabilities including
 * plugin-only wiring hooks that are not part of the public manager API.
 */
export interface PluginContext<TPluginEvents extends object = Record<never, never>> {
  /** The Axios instance managed by RetryManager. */
  readonly axiosInstance: AxiosInstance;
  /** Returns the configured logger. */
  getLogger(): Logger;
  /** Subscribe to a manager or plugin event. */
  on<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): void;
  /** Unsubscribe from a manager or plugin event. */
  off<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): boolean;
  /** Emit an event (fires listeners only, does not call hooks). */
  emit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void;
  /** Call hooks and emit an event. */
  triggerAndEmit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void;
  /** Cancel a specific in-flight or queued request by its ID. */
  cancelRequest(requestId: string): void;
  /** Cancel all active and queued requests. */
  cancelAllRequests(): void;
  /** Cancel only requests currently waiting in the queue. */
  cancelQueuedRequests(): void;
  /**
   * Register a queue gate that must approve each request before it is dispatched.
   * Used by plugins that need to block request processing under certain conditions.
   */
  registerQueueGate(name: string, canProcess: (request: AxiosRequestConfig) => boolean): void;
  /** Remove a previously registered queue gate. */
  unregisterQueueGate(name: string): boolean;
  /** Trigger a queue drain pass. Useful after a gate condition changes. */
  refreshQueue(): void;
  /**
   * Register or unregister a metrics recorder.
   * Pass `null` to detach. Used by MetricsPlugin to expose metric data to the RetryManager's getMetrics() method.
   */
  registerMetricsRecorder(recorder: MetricsRecorder | null): void;
  /**
   * Return active timer counts.
   * Used by MetricsPlugin to populate the timerHealth section of detailed metrics.
   */
  getTimerStats(): { activeTimers: number; activeRetryTimers: number };
  /**
   * Release lifecycle tracking for a request config and mark its queue slot complete.
   * Used by TokenRefreshPlugin when a tracked request is intercepted for token refresh.
   */
  releaseRequestTracking(config: AxiosRequestConfig): void;
}

/**
 * AxiosRetryer plugin interface that can be attached with {@link RetryManager.use} and removed with {@link RetryManager.unuse}
 * */
export interface RetryPlugin<TPluginEvents extends object = Record<never, never>> {
  /**
   * Plugin name. Should be unique
   * */
  name: string;
  /**
   * Plugin version (e.g. 1.0.0)
   * */
  version: string;
  /**
   * Phantom covariant marker for TypeScript to infer `TPluginEvents` at call sites
   * such as `manager.use(plugin)`. Never set this at runtime; implementations may
   * simply omit it (it is always `undefined`).
   * */
  readonly _events?: Readonly<TPluginEvents>;
  /**
   * Called when the plugin is attached and initialized.
   * @param context Plugin context providing manager capabilities and plugin-only wiring hooks.
   * */
  initialize: (context: PluginContext<TPluginEvents>) => void;
  /**
   * Called before the plugin is removed.
   * @param context Plugin context providing manager capabilities and plugin-only wiring hooks.
   * */
  onBeforeDestroyed?: (context: PluginContext<TPluginEvents>) => void;
}
