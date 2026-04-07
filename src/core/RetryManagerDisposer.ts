import type { Logger, PluginContext } from '../types';
import type { EventBus } from './EventBus';
import type { PluginRegistry } from './PluginRegistry';
import type { RequestQueue } from './requestQueue';
import type { RetryScheduler } from './RetryScheduler';
import type { RequestLifecycleManager } from './RequestLifecycleManager';

type RetryManagerDisposerOptions = {
  logger: Logger;
  requestLifecycle: RequestLifecycleManager;
  requestQueue: RequestQueue;
  retryScheduler: RetryScheduler;
  ejectRetryerInterceptors: () => void;
  pluginRegistry: PluginRegistry;
  eventBus: EventBus<object>;
};

export class RetryManagerDisposer {
  constructor(private readonly options: RetryManagerDisposerOptions) {}

  public destroy(context: PluginContext): void {
    const timerStats = this.options.retryScheduler.getTimerStats();
    this.options.logger.warn('Destroying RetryManager', {
      activeRequests: this.options.requestLifecycle.getActiveCount(),
      activeRetryTimers: timerStats.activeRetryTimers,
      activeTimers: timerStats.activeTimers,
    });

    this.options.requestLifecycle.cancelAllRequests();
    this.options.requestQueue.destroy();
    this.options.retryScheduler.destroy();
    this.options.ejectRetryerInterceptors();
    this.options.pluginRegistry.cleanup(context);
    this.options.eventBus.clear();

    this.options.logger.log('RetryManager destroyed successfully');
  }
}
