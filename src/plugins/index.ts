/**
 * Convenience barrel for all documented plugins.
 *
 * @deprecated
 * The `axios-retryer/plugins` barrel imports all plugins in a single bundle
 * (~52 KB raw), which prevents tree-shaking. Prefer dedicated per-plugin
 * entry points so bundlers only include what you use:
 *
 * ```ts
 * // Before (barrel — imports everything):
 * import { CachingPlugin } from 'axios-retryer/plugins';
 *
 * // After (focused — tree-shakeable):
 * import { CachingPlugin } from 'axios-retryer/plugins/CachingPlugin';
 * ```
 *
 * The barrel will remain available for backward compatibility, but may be
 * removed in a future major release.
 */
export * from './CachingPlugin';
export * from './CircuitBreakerPlugin';
export * from './DebugSanitizationPlugin';
export * from './ManualRetryPlugin';
export * from './MetricsPlugin';
export * from './TokenRefreshPlugin';
