import type { Logger, RetryEventArgs, RetryEventListener, RetryManagerEvents } from '../types';
import { getRequestMetadata } from '../utils/requestMetadata';

type HookListeners<TPluginEvents extends object> = {
  [K in keyof RetryManagerEvents<TPluginEvents>]?: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[];
};

type EventBusOptions<TPluginEvents extends object> = {
  hooks?: Partial<RetryManagerEvents<TPluginEvents>>;
  logger: Logger;
};

export class EventBus<TPluginEvents extends object = {}> {
  private listeners: HookListeners<TPluginEvents> = {};

  constructor(
    private readonly options: EventBusOptions<TPluginEvents>,
  ) {}

  public getHook<K extends keyof RetryManagerEvents<TPluginEvents>>(
    hookName: K,
  ): RetryManagerEvents<TPluginEvents>[K] | undefined {
    return this.options.hooks?.[hookName];
  }

  public triggerHook<K extends keyof RetryManagerEvents<TPluginEvents>>(
    hookName: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void {
    try {
      const hook = this.options.hooks?.[hookName];
      if (hook) {
        (hook as (...hookArgs: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>) => unknown)(...args);
        this.options.logger.debug(`Hook "${String(hookName)}" executed`, {
          requestId: this.extractRequestId(args[0]),
        });
      }
    } catch (error) {
      this.options.logger.error(`Error executing "${String(hookName)}" hook:`, error);
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
        this.options.logger.error(`Error emitting "${String(event)}" listener:`, error);
      }
    });
  }

  public triggerAndEmit<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    ...args: RetryEventArgs<RetryManagerEvents<TPluginEvents>, K>
  ): void {
    this.triggerHook(event, ...args);
    this.emit(event, ...args);
  }

  public on<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): void {
    const listeners = (this.listeners[event] ?? []) as RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[];
    listeners.push(listener);
    this.listeners[event] = listeners as HookListeners<TPluginEvents>[K];
    this.options.logger.debug('Event listener added', { event });
  }

  public off<K extends keyof RetryManagerEvents<TPluginEvents>>(
    event: K,
    listener: RetryEventListener<RetryManagerEvents<TPluginEvents>, K>,
  ): boolean {
    const listeners = this.listeners[event] as RetryEventListener<RetryManagerEvents<TPluginEvents>, K>[] | undefined;
    if (!listeners) {
      return false;
    }

    const index = listeners.indexOf(listener);
    if (index === -1) {
      return false;
    }

    listeners.splice(index, 1);
    if (listeners.length === 0) {
      delete this.listeners[event];
    }

    this.options.logger.debug('Event listener removed', { event });
    return true;
  }

  public clear(): void {
    this.listeners = {};
  }

  public hasListeners<K extends keyof RetryManagerEvents<TPluginEvents>>(event: K): boolean {
    return Boolean(this.listeners[event]?.length);
  }

  public hasConfiguredHook<K extends keyof RetryManagerEvents<TPluginEvents>>(event: K): boolean {
    return typeof this.options.hooks?.[event] === 'function';
  }

  public hasSubscriptions<K extends keyof RetryManagerEvents<TPluginEvents>>(event: K): boolean {
    return this.hasConfiguredHook(event) || this.hasListeners(event);
  }

  private extractRequestId(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }

    return getRequestMetadata(value as never)?.requestId;
  }
}
