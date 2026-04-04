import type { RetryManager } from './RetryManager';
import type { RetryPlugin } from '../types';
import { RetryLogger } from '../services/logger';

type InterceptorControls = {
  ejectRetryerInterceptors: () => void;
  installRetryerInterceptors: () => void;
};

type GenericHookMap = Partial<Record<string, (...args: readonly unknown[]) => unknown>>;

type RegisteredPlugin = {
  name: string;
  version: string;
  initialize: (manager: RetryManager) => void;
  onBeforeDestroyed?: (manager: RetryManager) => void;
  hooks?: GenericHookMap;
};

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();

  constructor(private readonly logger: RetryLogger) {}

  public getPlugins(): IterableIterator<RegisteredPlugin> {
    return this.plugins.values();
  }

  public list(): { name: string; version: string }[] {
    return Array.from(this.plugins.values()).map(({ name, version }) => ({ name, version }));
  }

  public use<TPluginEvents extends object>(
    plugin: RetryPlugin<TPluginEvents>,
    manager: RetryManager,
    controls: InterceptorControls,
    beforeRetryerInterceptors = true,
  ): void {
    const registeredPlugin = plugin as unknown as RegisteredPlugin;

    if (this.plugins.has(plugin.name)) {
      this.logger.error('Plugin already registered', { plugin: plugin.name });
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    if (!this.validatePluginVersion(plugin.version)) {
      this.logger.error('Invalid plugin version', { version: plugin.version });
      throw new Error(`Invalid plugin version format: ${plugin.version}`);
    }

    this.plugins.set(plugin.name, registeredPlugin);

    try {
      if (beforeRetryerInterceptors) {
        controls.ejectRetryerInterceptors();
      }

      registeredPlugin.initialize(manager);

      if (beforeRetryerInterceptors) {
        controls.installRetryerInterceptors();
      }

      this.logger.log('Plugin registered', {
        name: plugin.name,
        version: plugin.version,
      });
    } catch (error) {
      this.plugins.delete(plugin.name);

      if (beforeRetryerInterceptors) {
        controls.installRetryerInterceptors();
      }

      throw error;
    }
  }

  public unuse(pluginName: string, manager: RetryManager): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      this.logger.debug('Plugin removal failed - not found', { pluginName });
      return false;
    }

    if (typeof plugin.onBeforeDestroyed === 'function') {
      plugin.onBeforeDestroyed(manager as RetryManager<object>);
    }

    this.plugins.delete(pluginName);
    this.logger.log('Plugin removed', { name: plugin.name, version: plugin.version });
    return true;
  }

  public cleanup(manager: RetryManager): void {
    this.plugins.forEach((plugin) => {
      if (typeof plugin.onBeforeDestroyed === 'function') {
        plugin.onBeforeDestroyed(manager as RetryManager<object>);
      }
    });

    this.plugins.clear();
  }

  private validatePluginVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+$/.test(version);
  }
}
