import type { Logger, RetryEventArgs, RetryEventListener, RetryManagerEvents } from '../types';

type HookListeners<TPluginEvents extends object> = {
  [K in keyof RetryManagerEvents<TPluginEvents>]?: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[];
};

const DEFAULT_MAX_LISTENERS_PER_EVENT = 50;

export interface EventBusOptions {
  maxListenersPerEvent?: number;
  /**
   * When `true`, exceeding the listener limit throws an error instead of
   * logging a warning and dropping the registration.
   * @default false
   */
  strictListenerLimit?: boolean;
}

export class EventBus<TPluginEvents extends object = Record<never, never>> {
  private listeners: HookListeners<TPluginEvents> = {};
  private readonly maxListenersPerEvent: number;
  private readonly strictListenerLimit: boolean;

  constructor(
    private readonly logger: Logger,
    options: EventBusOptions | number = {},
  ) {
    // Accept plain number for backwards compatibility with internal callers that
    // pass only `maxListenersPerEvent` (e.g. tests: `new EventBus(logger, 3)`).
    if (typeof options === 'number') {
      this.maxListenersPerEvent = options;
      this.strictListenerLimit = false;
    } else {
      this.maxListenersPerEvent = options.maxListenersPerEvent ?? DEFAULT_MAX_LISTENERS_PER_EVENT;
      this.strictListenerLimit = options.strictListenerLimit ?? false;
    }
  }

  public emit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void {
    const listeners = this.listeners[event] as RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[] | undefined;
    listeners?.forEach((listener) => {
      try {
        listener(...args);
      } catch (error) {
        this.logger.error(`Error in "${String(event)}" listener:`, error);
      }
    });
  }

  /**
   * Identical to `emit` — fires all registered listeners for the event.
   *
   * The name is kept for backward compatibility with existing plugins that call
   * `context.triggerAndEmit(...)`. Despite the name difference, there is no
   * semantic distinction between `emit` and `triggerAndEmit`: both simply
   * invoke the registered listeners and do not call any separate "hooks".
   */
  public triggerAndEmit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void {
    this.emit(event, ...args);
  }

  public on<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): void {
    const listeners = (this.listeners[event] ?? []) as RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[];
    if (listeners.length >= this.maxListenersPerEvent) {
      const message =
        `EventBus: listener limit (${this.maxListenersPerEvent}) reached for event "${String(event)}". ` +
        'This may indicate a listener leak. Call off() to remove unused listeners.';
      if (this.strictListenerLimit) {
        throw new Error(message);
      }
      this.logger.warn(message, { event, count: listeners.length });
      return;
    }
    listeners.push(listener);
    this.listeners[event] = listeners as HookListeners<TPluginEvents>[K];
    this.logger.debug('Event listener added', { event });
  }

  public off<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): boolean {
    const listeners = this.listeners[event] as RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[] | undefined;
    if (!listeners) return false;

    const index = listeners.indexOf(listener);
    if (index === -1) return false;

    listeners.splice(index, 1);
    if (listeners.length === 0) {
      delete this.listeners[event];
    }

    this.logger.debug('Event listener removed', { event });
    return true;
  }

  public clear(): void {
    this.listeners = {};
  }

  public hasListeners<K extends keyof RetryManagerEvents<TPluginEvents>>(event: K): boolean {
    return Boolean(this.listeners[event]?.length);
  }
}
