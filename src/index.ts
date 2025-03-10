import './global-axios-augmentation';

export {
  type RetryMode,
  type RetryHooks,
  type RetryManagerOptions,
  type RetryStrategy,
  type RequestStore,
  type RetryPlugin,
  type AxiosRetryerBackoffType,
  type AxiosRetryerRequestPriority,
  type AxiosRetryerMetrics,
  RETRY_MODES,
  AXIOS_RETRYER_REQUEST_PRIORITIES,
  AXIOS_RETRYER_BACKOFF_TYPES,
} from './types';

// Export core functionality
export { RetryManager } from './core/RetryManager';
export { QueueFullError } from './core/errors/QueueFullError';
export { DefaultRetryStrategy } from './core/strategies/DefaultRetryStrategy';

// Only export type definitions for plugins
// The actual plugin implementations are exported from their own entry points
export type { TokenRefreshPluginOptions } from './plugins/TokenRefreshPlugin/types/';

// Note: Removed direct export of TokenRefreshPlugin to support tree-shaking
// Users should import plugins directly from their individual entry points:
// import { TokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';

// ========== Functional API ==========

import { RetryManager } from './core/RetryManager';
import { DefaultRetryStrategy } from './core/strategies/DefaultRetryStrategy';
import type { RetryManagerOptions, RetryStrategy, AxiosRetryerBackoffType } from './types';

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
export function createRetryer(options?: RetryManagerOptions): RetryManager {
  return new RetryManager(options);
}

/**
 * Interface for creating a custom retry strategy
 */
export interface RetryStrategyConfig {
  /**
   * Custom function to determine if an error is retryable
   */
  isRetryable?: (error: any) => boolean;
  
  /**
   * Custom function to determine if a request should be retried
   */
  shouldRetry?: (error: any, attempt: number, maxRetries: number) => boolean;
  
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
 *   isRetryable: (error) => error.response?.status >= 500,
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
    getIsRetryable(error: any): boolean {
      if (config.isRetryable) {
        return config.isRetryable(error);
      }
      return baseStrategy.getIsRetryable(error);
    },
    
    shouldRetry(error: any, attempt: number, maxRetries: number): boolean {
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
