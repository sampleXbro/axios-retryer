import type { AxiosRequestConfig } from 'axios';

import { RetryerConfigError } from '../../../core/errors/RetryerConfigError';
import { validateExcludeUrls } from '../../../utils/validateExcludeUrls';
import { InMemoryCircuitBreakerStateAdapter } from '../managers';
import {
  CIRCUIT_BREAKER_SCOPES,
  type CircuitBreakerOptions,
  type CircuitBreakerScope,
  type CircuitBreakerStateAdapter,
} from '../types';

export type ResolvedCircuitBreakerOptions = Required<
  Omit<CircuitBreakerOptions, 'shouldCountError' | 'scope' | 'stateAdapter'>
> & {
  shouldCountError?: CircuitBreakerOptions['shouldCountError'];
  scope: CircuitBreakerScope | ((config: AxiosRequestConfig) => string);
  stateAdapter: CircuitBreakerStateAdapter;
};

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: Required<
  Omit<CircuitBreakerOptions, 'shouldCountError' | 'scope' | 'stateAdapter'>
> = {
  failureThreshold: 5,
  openTimeout: 30000,
  halfOpenMax: 1,
  successThreshold: 1,
  useSlidingWindow: false,
  slidingWindowSize: 60000,
  adaptiveTimeout: false,
  adaptiveTimeoutPercentile: 0.95,
  adaptiveTimeoutSampleSize: 100,
  adaptiveTimeoutMultiplier: 1.5,
  maxTrackedScopes: 500,
  excludeUrls: [],
};

export function resolveCircuitBreakerOptions(
  options: Partial<CircuitBreakerOptions> = {},
): ResolvedCircuitBreakerOptions {
  const resolvedOptions: ResolvedCircuitBreakerOptions = {
    ...DEFAULT_CIRCUIT_BREAKER_OPTIONS,
    ...options,
    scope: options.scope ?? CIRCUIT_BREAKER_SCOPES.HOST_AND_URL,
    stateAdapter: options.stateAdapter ?? new InMemoryCircuitBreakerStateAdapter(),
  };

  validateCircuitBreakerOptions(resolvedOptions);

  return resolvedOptions;
}

export function validateCircuitBreakerOptions(options: ResolvedCircuitBreakerOptions): void {
  if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
    throw new RetryerConfigError(
      'failureThreshold must be a positive integer',
      'failureThreshold',
      options.failureThreshold,
    );
  }

  if (!Number.isInteger(options.openTimeout) || options.openTimeout < 0) {
    throw new RetryerConfigError('openTimeout must be a non-negative integer', 'openTimeout', options.openTimeout);
  }

  if (!Number.isInteger(options.halfOpenMax) || options.halfOpenMax < 1) {
    throw new RetryerConfigError('halfOpenMax must be a positive integer', 'halfOpenMax', options.halfOpenMax);
  }

  if (
    options.successThreshold !== undefined &&
    (!Number.isInteger(options.successThreshold) || options.successThreshold < 1)
  ) {
    throw new RetryerConfigError(
      'successThreshold must be a positive integer',
      'successThreshold',
      options.successThreshold,
    );
  }

  if (options.successThreshold > options.halfOpenMax) {
    options.successThreshold = options.halfOpenMax;
  }

  if (options.excludeUrls.length === 0) {
    return;
  }

  const redosErrors = validateExcludeUrls(options.excludeUrls);
  if (redosErrors.length === 0) {
    return;
  }

  throw new RetryerConfigError(
    redosErrors.map((error) => error.reason).join('\n'),
    'excludeUrls',
    redosErrors.map((error) => error.pattern),
  );
}
