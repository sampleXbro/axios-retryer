import type { Logger, RetryEventArgs, RetryEventListener, RetryManagerEvents } from '../types';

type HookListeners<TPluginEvents extends object> = {
  [K in keyof RetryManagerEvents<TPluginEvents>]?: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[];
};

export class EventBus<TPluginEvents extends object = Record<never, never>> {
  private listeners: HookListeners<TPluginEvents> = {};

  constructor(private readonly logger: Logger) {}

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
   * Alias for `emit`. Kept for backward compatibility with plugins that call
   * `context.triggerAndEmit(...)`.
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
