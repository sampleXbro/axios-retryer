import './global-axios-augmentation';

export {
  type CoreRetryEvents,
  type RetryMode,
  type RetryHooks,
  type RetryManagerEvents,
  type RetryEventArgs,
  type RetryEventListener,
  type RetryManagerOptions,
  type RetryStrategy,
  type RetryPlugin,
  type PluginContext,
  type AxiosRetryerBackoffType,
  type AxiosRetryerHttpMethod,
  type AxiosRetryerRequestMetadata,
  type AxiosRetryerRequestPriority,
  type AxiosRetryerRetryableStatus,
  type AxiosRetryerStatusRange,
  type AxiosRetryerDetailedMetrics,
  type Logger,
  RETRY_MODES,
  AXIOS_RETRYER_HTTP_METHODS,
  AXIOS_RETRYER_REQUEST_PRIORITIES,
  AXIOS_RETRYER_BACKOFF_TYPES,
} from './types';

// Export core functionality
export { RetryManager } from './core/RetryManager';
export {
  AxiosRetryerError,
  PluginRegistrationError,
  QueueClearedError,
  QueueDestroyedError,
  QueueFullError,
  QueuedRequestCanceledError,
  RequestAbortedError,
  RetryerConfigError,
} from './core/errors';
export { DefaultRetryStrategy } from './core/strategies/DefaultRetryStrategy';

// Note: Plugin-specific types and implementations are exported from documented plugin entry points.
// Prefer dedicated subpaths such as:
// import { TokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
// The `axios-retryer/plugins` barrel remains available as a documented convenience entry.

// ========== Functional API ==========

import { RetryManager } from './core/RetryManager';
import { DefaultRetryStrategy } from './core/strategies/DefaultRetryStrategy';
import type { AxiosError } from 'axios';
import type { AxiosRetryerBackoffType, RetryManagerOptions, RetryStrategy } from './types';

// Prevents TypeScript from widening TPluginEvents based on call-site usage,
// ensuring the type parameter is always inferred from the declaration site only.
type NoInferType<T> = [T][T extends unknown ? 0 : never];

/**
 * Creates a new RetryManager instance with the given options.
 * Functional alternative to using the `new RetryManager()` constructor.
 * 
 * @param options Configuration options for the retry manager
 * @returns A configured RetryManager instance
 * 
 * @example
 * ```typescript
 * const retryer = createRetryer({ retries: 3, debug: true });
 * retryer.axiosInstance.get('/api/data').then(response => console.log(response.data));
 * ```
 */
export function createRetryer<TPluginEvents extends object = {}>(
  options?: RetryManagerOptions<NoInferType<TPluginEvents>>,
): RetryManager<TPluginEvents> {
  return new RetryManager<TPluginEvents>(options);
}

/**
 * Interface for creating a custom retry strategy
 */
export interface RetryStrategyConfig {
  /**
   * Custom function to determine if an error is retryable
   */
  isRetryable?: (error: AxiosError) => boolean;
  
  /**
   * Custom function to determine if a request should be retried
   */
  shouldRetry?: (error: AxiosError, attempt: number, maxRetries: number) => boolean;
  
  /**
   * Custom function to calculate the delay between retry attempts
   */
  getDelay?: (attempt: number, maxRetries: number, backoffType?: AxiosRetryerBackoffType) => number;
}

/**
 * Creates a custom retry strategy with the given configuration.
 * Functional alternative to implementing the RetryStrategy interface directly.
 * 
 * @param config Configuration for the retry strategy
 * @returns A RetryStrategy implementation
 * 
 * @example
 * ```typescript
 * const customStrategy = createRetryStrategy({
 *   isRetryable: (error) => (error.response?.status ?? 0) >= 500,
 *   getDelay: (attempt) => attempt * 1000 // linear backoff
 * });
 * 
 * const retryer = createRetryer({ 
 *   retryStrategy: customStrategy
 * });
 * ```
 */
export function createRetryStrategy(config: RetryStrategyConfig = {}): RetryStrategy {
  const baseStrategy = new DefaultRetryStrategy();
  
  return {
    getIsRetryable(error: AxiosError): boolean {
      if (config.isRetryable) {
        return config.isRetryable(error);
      }
      return baseStrategy.getIsRetryable(error);
    },
    
    shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
      if (config.shouldRetry) {
        return config.shouldRetry(error, attempt, maxRetries);
      }
      return baseStrategy.shouldRetry(error, attempt, maxRetries);
    },
    
    getDelay(attempt: number, maxRetries: number, backoffType?: AxiosRetryerBackoffType): number {
      if (config.getDelay) {
        return config.getDelay(attempt, maxRetries, backoffType);
      }
      return baseStrategy.getDelay(attempt, maxRetries, backoffType);
    }
  };
}
