import { AxiosRetryerError } from './AxiosRetryerError';

export class PluginRegistrationError extends AxiosRetryerError {
  public readonly pluginName?: string;
  public readonly pluginVersion?: string;

  constructor(
    message: string,
    code: 'EPLUGIN_ALREADY_REGISTERED' | 'EINVALID_PLUGIN_VERSION',
    pluginName?: string,
    pluginVersion?: string,
  ) {
    super(message, code);
    this.pluginName = pluginName;
    this.pluginVersion = pluginVersion;
  }
}
