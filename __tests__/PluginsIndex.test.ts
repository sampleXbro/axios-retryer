import {
  CachingPlugin,
  CircuitBreakerPlugin,
  CriticalRequestPlugin,
  DebugSanitizationPlugin,
  ManualRetryPlugin,
  MetricsPlugin,
  TokenRefreshPlugin,
  createCachePlugin,
  createCircuitBreaker,
  createCriticalRequestPlugin,
  createDebugSanitizationPlugin,
  createManualRetryPlugin,
  createMetricsPlugin,
  createTokenRefreshPlugin,
} from '../src/plugins';

describe('Plugins barrel entry point', () => {
  test('exports plugin classes and factories from a single import path', () => {
    const cachePlugin = createCachePlugin();
    const circuitBreakerPlugin = createCircuitBreaker();
    const criticalRequestPlugin = createCriticalRequestPlugin({ blockingQueueThreshold: 4 });
    const debugSanitizationPlugin = createDebugSanitizationPlugin();
    const manualRetryPlugin = createManualRetryPlugin();
    const metricsPlugin = createMetricsPlugin();
    const tokenRefreshPlugin = createTokenRefreshPlugin(async () => ({ token: 'fresh-token' }));

    expect(cachePlugin).toBeInstanceOf(CachingPlugin);
    expect(circuitBreakerPlugin).toBeInstanceOf(CircuitBreakerPlugin);
    expect(criticalRequestPlugin).toBeInstanceOf(CriticalRequestPlugin);
    expect(debugSanitizationPlugin).toBeInstanceOf(DebugSanitizationPlugin);
    expect(manualRetryPlugin).toBeInstanceOf(ManualRetryPlugin);
    expect(metricsPlugin).toBeInstanceOf(MetricsPlugin);
    expect(tokenRefreshPlugin).toBeInstanceOf(TokenRefreshPlugin);
  });
});
