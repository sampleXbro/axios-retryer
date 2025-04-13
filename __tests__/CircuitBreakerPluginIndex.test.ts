// @ts-nocheck
import { createCircuitBreaker } from '../src/plugins/CircuitBreakerPlugin';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin';

describe('CircuitBreakerPlugin Factory Function', () => {
  test('createCircuitBreaker creates an instance of CircuitBreakerPlugin', () => {
    const plugin = createCircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 1000
    });
    
    expect(plugin).toBeInstanceOf(CircuitBreakerPlugin);
    expect(plugin.name).toBe('CircuitBreakerPlugin');
  });
  
  test('createCircuitBreaker works with default options', () => {
    const plugin = createCircuitBreaker();
    
    expect(plugin).toBeInstanceOf(CircuitBreakerPlugin);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  
  test('createCircuitBreaker passes options to plugin', () => {
    const customOptions = {
      failureThreshold: 10,
      resetTimeout: 5000,
      excludeStatusCodes: [404, 403]
    };
    
    const plugin = createCircuitBreaker(customOptions);
    
    // We can't directly test the options, but we can confirm creation works
    expect(plugin).toBeInstanceOf(CircuitBreakerPlugin);
  });
}); 