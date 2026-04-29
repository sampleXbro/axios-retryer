import type { AxiosError, AxiosRequestConfig } from 'axios';

import type { AxiosRetryerRequestPriority } from './common';

export type RetryEventArgs<TEvents extends object, K extends keyof TEvents> =
  NonNullable<TEvents[K]> extends (...args: infer TArgs) => unknown ? TArgs : never;

export type RetryEventListener<TEvents extends object, K extends keyof TEvents> = (
  ...args: RetryEventArgs<TEvents, K>
) => void;

/**
 * Convenience name alias: a key in the core event map.
 */
export type CoreRetryEventName = keyof CoreRetryEvents;

/**
 * The argument tuple for a given core event name.
 *
 * Example: `CoreRetryEventArgs<'onRetryScheduled'>` is `[delayMs: number, config: AxiosRequestConfig]`.
 */
export type CoreRetryEventArgs<K extends CoreRetryEventName> = RetryEventArgs<CoreRetryEvents, K>;

/**
 * Type-safe emit-event callback used by interceptors and other internal collaborators.
 *
 * The string overload is permitted only for events declared in `CoreRetryEvents`. Any
 * mismatch in event name or payload shape is a compile-time error.
 */
export type EmitCoreEvent = <K extends CoreRetryEventName>(event: K, ...args: CoreRetryEventArgs<K>) => void;

/**
 * Terminal request error payload emitted by `onRequestError`.
 */
export interface AxiosRetryerRequestErrorEvent {
  /** Final Axios error object that caused request failure. */
  error: AxiosError;
  /** Final Axios request config that failed. */
  config: AxiosRequestConfig;
  /** HTTP status if available, otherwise `null` for network-level failures. */
  status: number | null;
  /** Request identifier if available. */
  requestId?: string;
  /** Total attempts performed including the initial attempt. */
  attempts: number;
  /** Whether the final error shape is considered retryable by the active strategy. */
  retryable: boolean;
}

/**
 * Queue-entry payload emitted by `onRequestQueued`.
 */
export interface AxiosRetryerRequestQueuedEvent {
  /** Request identifier generated or assigned by RetryManager. */
  requestId: string;
  /** Request config entering the queue. */
  config: AxiosRequestConfig;
  /** Resolved priority used for queue ordering. */
  priority: AxiosRetryerRequestPriority;
  /** Queue size immediately after this request was enqueued. */
  queueSize: number;
}

/**
 * Queue-dispatch payload emitted by `onRequestDispatched`.
 */
export interface AxiosRetryerRequestDispatchedEvent {
  /** Request identifier generated or assigned by RetryManager. */
  requestId: string;
  /** Request config dispatched from the queue. */
  config: AxiosRequestConfig;
  /** Resolved priority used for queue ordering. */
  priority: AxiosRetryerRequestPriority;
  /** Time spent waiting in the queue before dispatch (milliseconds). */
  queuedForMs: number;
}

/**
 * Success payload emitted by `onRequestSucceeded`.
 */
export interface AxiosRetryerRequestSucceededEvent {
  /** Request identifier generated or assigned by RetryManager. */
  requestId?: string;
  /** Final request config that succeeded. */
  config: AxiosRequestConfig;
  /** Final HTTP status code. */
  status: number;
  /** Total attempts performed including the initial attempt. */
  attempts: number;
}

/**
 * Core events exposed by RetryManager without any plugins attached.
 */
export interface CoreRetryEvents {
  /**
   * Triggered when the retry process begins.
   */
  onRetryProcessStarted?: () => void;
  /**
   * Triggered before each retry attempt.
   * @param config The Axios request configuration being retried.
   */
  beforeRetry?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered after a retry attempt.
   * @param config The Axios request configuration being retried.
   * @param success Whether the retry was successful.
   * @param error If the retry failed, the error that caused the failure.
   */
  afterRetry?: (config: AxiosRequestConfig, success: boolean, error?: AxiosError) => void;

  /**
   * Triggered when a retry is scheduled and waiting for the specified delay.
   * @param delayMs The delay in milliseconds.
   * @param config The Axios request configuration.
   */
  onRetryScheduled?: (delayMs: number, config: AxiosRequestConfig) => void;

  /**
   * Triggered for each failed retry attempt.
   * @param config The failed Axios request configuration.
   */
  onFailure?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered when a request enters the queue.
   *
   * @param payload Queue entry metadata for this request.
   */
  onRequestQueued?: (payload: AxiosRetryerRequestQueuedEvent) => void;

  /**
   * Triggered when a queued request is dispatched from the queue to the network layer.
   *
   * @param payload Dispatch metadata including queue wait duration.
   */
  onRequestDispatched?: (payload: AxiosRetryerRequestDispatchedEvent) => void;

  /**
   * Triggered when a request succeeds (initial attempt or after retries).
   *
   * @param payload Success metadata for this request.
   */
  onRequestSucceeded?: (payload: AxiosRetryerRequestSucceededEvent) => void;

  /**
   * Triggered once when a request fails terminally (all retries exhausted or no-retry terminal path).
   * Unlike `onFailure`, this event is emitted only for the final failure.
   *
   * @param payload Terminal error context for application-level handling.
   */
  onRequestError?: (payload: AxiosRetryerRequestErrorEvent) => void;

  /**
   * Triggered when all retries are completed.
   */
  onRetryProcessFinished?: () => void;

  /**
   * Triggered when an in-flight retry delay timer is cancelled — either because
   * the user aborted the request (`source: 'user'`) or because the system shut
   * the request down (`source: 'system'`, e.g. plugin destroy, queue clear).
   */
  onRetryTimerCancelled?: (payload: { requestId: string; source: 'user' | 'system' }) => void;

  /**
   * Triggered when a request cancelled.
   * @param requestId Id of the cancelled request.
   */
  onRequestCancelled?: (requestId: string) => void;

  /**
   * Called when a request fails due to network or connection issues, meaning
   * no valid server response was received (e.g., user is offline).
   *
   * @param request - The Axios request config that encountered a connection error.
   */
  onInternetConnectionError?: (request: AxiosRequestConfig) => void;

  /**
   * Triggered when a blocking request (at or above `blockingPriorityThreshold`) fails terminally.
   * Only fires when `blockingPriorityThreshold` is configured.
   *
   * @param config The Axios request config of the failed blocking request.
   */
  onBlockingRequestFailed?: (config: AxiosRequestConfig) => void;

  /**
   * Triggered when every in-flight blocking request (at or above `blockingPriorityThreshold`)
   * has **succeeded** (terminal success) and none remain in the internal blocker set.
   * Not emitted when a blocker fails (`onBlockingRequestFailed`) or is cancelled.
   * Only fires when `blockingPriorityThreshold` is configured.
   */
  onAllBlockingRequestsResolved?: () => void;
}

export type RetryManagerEvents<TPluginEvents extends object = Record<never, never>> = {
  [K in keyof CoreRetryEvents | keyof TPluginEvents]: K extends keyof TPluginEvents
    ? K extends keyof CoreRetryEvents
      ? CoreRetryEvents[K] & TPluginEvents[K]
      : TPluginEvents[K]
    : K extends keyof CoreRetryEvents
      ? CoreRetryEvents[K]
      : never;
};
