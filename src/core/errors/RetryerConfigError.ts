import { AxiosRetryerError } from './AxiosRetryerError';

export class RetryerConfigError extends AxiosRetryerError {
  public readonly optionName?: string;
  public readonly optionValue?: unknown;

  constructor(message: string, optionName?: string, optionValue?: unknown) {
    super(message, 'EINVALID_CONFIG');
    this.optionName = optionName;
    this.optionValue = optionValue;
  }
}
