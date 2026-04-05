import { PluginRegistrationError } from './errors/PluginRegistrationError';
import type { Logger, PluginContext, RetryPlugin } from '../types';

type InterceptorControls = {
  ejectRetryerInterceptors: () => void;
  installRetryerInterceptors: () => void;
};

type RegisteredPlugin = {
  name: string;
  version: string;
  initialize: (context: PluginContext) => void;
  onBeforeDestroyed?: (context: PluginContext) => void;
};

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();

  constructor(private readonly logger: Logger) {}

  public getPlugins(): IterableIterator<RegisteredPlugin> {
    return this.plugins.values();
  }

  public list(): { name: string; version: string }[] {
    return Array.from(this.plugins.values()).map(({ name, version }) => ({ name, version }));
  }

  public use<TPluginEvents extends object>(
    plugin: RetryPlugin<TPluginEvents>,
    context: PluginContext,
    controls: InterceptorControls,
    beforeRetryerInterceptors = true,
  ): void {
    const registeredPlugin = plugin as unknown as RegisteredPlugin;

    if (this.plugins.has(plugin.name)) {
      this.logger.error('Plugin already registered', { plugin: plugin.name });
      throw new PluginRegistrationError(
        `Plugin "${plugin.name}" is already registered.`,
        'EPLUGIN_ALREADY_REGISTERED',
        plugin.name,
        plugin.version,
      );
    }

    if (!this.validatePluginVersion(plugin.version)) {
      this.logger.error('Invalid plugin version', { version: plugin.version });
      throw new PluginRegistrationError(
        `Invalid plugin version format: ${plugin.version}`,
        'EINVALID_PLUGIN_VERSION',
        plugin.name,
        plugin.version,
      );
    }

    this.plugins.set(plugin.name, registeredPlugin);

    try {
      if (beforeRetryerInterceptors) {
        controls.ejectRetryerInterceptors();
      }

      registeredPlugin.initialize(context);

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

  public unuse(pluginName: string, context: PluginContext): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      this.logger.debug('Plugin removal failed - not found', { pluginName });
      return false;
    }

    if (typeof plugin.onBeforeDestroyed === 'function') {
      plugin.onBeforeDestroyed(context);
    }

    this.plugins.delete(pluginName);
    this.logger.log('Plugin removed', { name: plugin.name, version: plugin.version });
    return true;
  }

  public cleanup(context: PluginContext): void {
    this.plugins.forEach((plugin) => {
      if (typeof plugin.onBeforeDestroyed === 'function') {
        plugin.onBeforeDestroyed(context);
      }
    });

    this.plugins.clear();
  }

  private validatePluginVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+$/.test(version);
  }
}
