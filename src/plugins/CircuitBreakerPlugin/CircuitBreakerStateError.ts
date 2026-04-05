import { AxiosError } from 'axios';
import type { AxiosRequestConfig, InternalAxiosRequestConfig, AxiosResponse } from 'axios';

import type { CircuitBreakerState } from './CircuitBreakerPlugin';

export class CircuitBreakerStateError extends AxiosError {
  public readonly circuitState: CircuitBreakerState;

  constructor(
    message: string,
    circuitState: CircuitBreakerState,
    request: AxiosRequestConfig,
    code?: string,
    response?: AxiosResponse,
  ) {
    super(
      message,
      code ?? 'ECIRCUIT_BREAKER_STATE',
      request as InternalAxiosRequestConfig,
      undefined,
      response,
    );
    this.name = 'CircuitBreakerStateError';
    this.circuitState = circuitState;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
