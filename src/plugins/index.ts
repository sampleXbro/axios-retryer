/**
 * Convenience entry point for documented plugins.
 *
 * This keeps plugin imports ergonomic for end users:
 * `import { createCachePlugin } from 'axios-retryer/plugins'`
 *
 * Dedicated per-plugin entry points remain supported as well.
 */
export * from './CachingPlugin';
export * from './CircuitBreakerPlugin';
export * from './CriticalRequestPlugin';
export * from './DebugSanitizationPlugin';
export * from './ManualRetryPlugin';
export * from './MetricsPlugin';
export * from './TokenRefreshPlugin';
