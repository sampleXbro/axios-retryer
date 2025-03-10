export { CircuitBreakerPlugin } from './CircuitBreakerPlugin';
export { type CircuitBreakerOptions } from './CircuitBreakerPlugin';

import { CircuitBreakerPlugin, type CircuitBreakerOptions } from './CircuitBreakerPlugin';

/**
 * Creates a CircuitBreakerPlugin instance.
 * Functional alternative to using the `new CircuitBreakerPlugin()` constructor.
 *
 * The circuit breaker pattern prevents repeated requests to a failing service by
 * temporarily blocking requests after a threshold of failures is reached.
 *
 * @param options Configuration options for the CircuitBreakerPlugin
 * @returns A configured CircuitBreakerPlugin instance
 * 
 * @example
 * ```typescript
 * const circuitBreaker = createCircuitBreaker({
 *   failureThreshold: 5,     // Trip circuit after 5 consecutive failures
 *   openTimeout: 30000,      // Remain open for 30s before allowing half-open test
 *   halfOpenMax: 1,          // Allow 1 test request in half-open state
 *   useSlidingWindow: true,  // Use sliding window for failure analysis
 *   slidingWindowSize: 60000 // 60-second sliding window
 * });
 * 
 * manager.use(circuitBreaker);
 * ```
 */
export function createCircuitBreaker(options: Partial<CircuitBreakerOptions> = {}): CircuitBreakerPlugin {
  return new CircuitBreakerPlugin(options);
}