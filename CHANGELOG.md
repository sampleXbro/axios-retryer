# Changelog

All notable changes to this project will be documented in this file.

## 2.0.0 - 05.04.2026

> `1.5.4` was prepared but never published. The fixes and API cleanup planned for that release ship in `2.0.0`.

### ⚠️ Breaking Changes
- **Core sanitization options moved to `DebugSanitizationPlugin`.** The root `RetryManager` options no longer accept `enableSanitization` or `sanitizeOptions`; install the sanitization plugin explicitly when you need redacted debug logs.
- **Populated retry metrics now require `MetricsPlugin`.** `getMetrics()` still returns the full metrics shape, but live counters and `onMetricsUpdated` reporting are now opt-in to keep the core smaller.
- **Root manual replay moved fully to `ManualRetryPlugin`.** `retryFailedRequests()`, `maxRequestsToStore`, `requestStore`, and `beforeManualRetry` are no longer part of the core manager surface in `2.0`.
- **Legacy `plugin.hooks` support was removed.** Plugins must subscribe through `retryer.on(...)` inside `initialize()`.
- **`onRetryProcessFinished` is now lifecycle-only.** It no longer carries a metrics payload; use `onMetricsUpdated` with `MetricsPlugin` when you need snapshots.
- **The browser bundle is now an optional local build.** Generate it with `npm run build:browser` when you need a script-tag artifact.
- **`maxRefreshAttempts` now means the exact number of refresh attempts.** Previously the loop ran `maxRefreshAttempts + 1` times, so `maxRefreshAttempts: 3` silently produced 4 attempts. If you relied on the old (off-by-one) behavior, decrease your value by 1 (e.g. `3` → `2` to keep the same total attempts).
- **`CriticalRequestPlugin` removed.** Prefer built-in request priority (`CRITICAL` / `RequestPriority`) and queue `canProcess` customization for similar behavior.

### ✨ Added
- **`RequestDependencyPlugin`** (documented subpath `axios-retryer/plugins/RequestDependencyPlugin`) for dependency-aware request gating
- **Core lifecycle and resource management** (`RequestLifecycleManager`, `RetryManagerDisposer`, `TimerManager`) to clarify teardown and timer ownership
- **Focused `tsconfig.build.json`** for production builds alongside root `tsconfig.json` for tooling and tests

### 🐛 Bug Fixes
- Fixed `TokenRefreshPlugin` replay flow so refreshed business requests go back through `RetryManager` instead of bypassing queueing, metrics, cancellation handling, and other plugins
- Fixed `TokenRefreshPlugin` teardown so request interceptors are ejected correctly and repeated `use/unuse` cycles do not leak behavior
- Fixed invalid `RetryManager` option handling so bad config now throws the intended validation error instead of failing during logger setup
- Fixed retry metrics initialization and empty-metrics snapshots so instances no longer share nested metric state and averages no longer return `NaN`
- Fixed failure accounting for `retries: 0` and terminal failure paths so production metrics are now internally consistent
- Fixed failed-request store eviction to remove the oldest stored request instead of the newest one
- Standardized library-thrown errors into named classes across core and plugin flows, including config validation, plugin registration, queue state, circuit-breaker fail-fast responses, cache key generation, and token refresh failures

### ⚡ Performance & Benchmarking
- Reworked the benchmark suite around deterministic, user-facing scenarios instead of noisy random demos
- Added structured benchmark reporting with `quick`, `standard`, and `full` profiles plus machine-readable rollup output
- Benchmarks now cover healthy-path overhead, transient failure recovery, rate limiting, queue contention, sustained load, outage recovery, caching effectiveness, circuit-breaker protection, and token-refresh storms
- Preserved runtime defaults for end users while explicitly benchmarking the low-latency queue configuration

### 🧪 Testing
- Added regression coverage for token refresh replay, interceptor cleanup, queue wait metrics, retry-disabled terminal failures, request store eviction, benchmark helper utilities, error standardization, auth and metadata safety, lifecycle teardown, and caching storage adapters
- Full suite validated at `63/63` test suites and `630/630` tests passing
- Release benchmark suite validated at `7/7` benchmarks passing

### 📚 Documentation
- Updated the README to reflect the current core-vs-plugin public API, per-plugin entry points, `RequestDependencyPlugin`, metrics and sanitization plugins, and current benchmark and test counts
- Added and refined the `1.x` → `2.0` migration guide (including metrics vs manual-replay ordering and barrel deprecation notes)
- Refreshed `SECURITY.md` supported-version policy for `2.x`
- Refreshed `KNOWN_ISSUES.md` for `2.0` behavior and current test metadata
- Removed obsolete `PRODUCTION_READINESS.md`; use `README.md` and `BENCHMARK_RESULTS.md` for performance and validation context

## 1.5.3 - 04.05.2025

### 🐛 **Bug Fixes**
- **CRITICAL**: Fixed TokenRefreshPlugin concurrent request handling for `customErrorDetector`
  - 🔧 **Issue**: When 4-5 requests simultaneously triggered custom auth errors (200 OK responses with auth errors in body), the plugin was calling token refresh for each request instead of queueing them
  - ✅ **Fix**: Added missing `this.isRefreshing = true` in `handleSuccessResponse` method to properly queue concurrent requests during token refresh
  - 🎯 **Impact**: Prevents multiple unnecessary token refresh calls, improves performance, and avoids potential rate limiting issues

### 🧪 **Testing Improvements**
- **Added comprehensive concurrent request tests** for TokenRefreshPlugin:
  - ✅ Test for 4-5 concurrent 401 status code requests (already existing, verified)
  - ✅ **NEW**: Test for 4-5 concurrent requests with custom auth errors in 200 OK responses  
  - 📊 Both scenarios now properly verify only 1 token refresh call occurs regardless of concurrent request count
  - 🔍 Tests validate proper queuing behavior and successful retry of all requests with refreshed token

## 1.5.2 - 27.05.2025

**🎯 MAJOR MILESTONE**: Comprehensive integration test suite added with 90%+ edge case and error scenario coverage
### Added benchmark results

### 🧪 **Testing & Quality Improvements**
- **MAJOR**: Added comprehensive integration test suite covering edge cases and error scenarios
  - 📊 **54 integration tests** across 4 test suites with **100% success rate**
  - 🎯 **90%+ coverage** of edge cases and error scenarios (up from 40-60%)
  - ⚡ **17 seconds** total test runtime - fast and reliable
 
### 🐛 **Bug Fixes**
- **Fixed Plugin Lifecycle Issues**: Resolved plugin cleanup hooks being called multiple times
  - ✅ Plugin `onBeforeDestroyed` hooks now called exactly once during destruction
  - 🔧 Improved plugin lifecycle management and test isolation

### 📈 **Code Quality**
- **Statement Coverage**: 67% (up significantly from previous versions)
- **Branch Coverage**: 57% (covers critical execution paths)  
- **Function Coverage**: 68% (comprehensive API testing)
- **Integration Test Success Rate**: 100% (54/54 tests passing)

### 📚 **Documentation Updates**
- **Updated KNOWN_ISSUES.md**: Marked resolved issues and improved test coverage metrics
- **Enhanced Test Documentation**: Comprehensive integration test suite documentation

## 1.5.0 - 23.05.2025
- **Performance Improvements**:
  - 🚀 **MAJOR**: Replaced O(n²) priority queue with O(log n) binary heap implementation - **100x better scaling**
  - ⚡ **MAJOR**: Fixed timer accumulation and event loop congestion with comprehensive TimerManager
  - **Result**: Eliminates memory leaks and dramatically improves high-volume performance

- **Test Coverage & Validation**:
  - 📈 Improved test coverage: **89.39% statements** (up from ~63%), **370 total tests** passing
  - 🏁 Added comprehensive benchmark suite with 4 testing scenarios
  - 📊 Validated **232 req/sec** throughput, **0 memory leaks**, **100% plugin compatibility**

- **Production Readiness**:
  - 🔧 Fixed TokenRefreshPlugin registration issues - achieved **100% success rate**
  - 📚 Updated documentation with validated performance data and deployment guidance

- **API Enhancements**:
  - 🆕 Added timer management APIs: `getTimerStats()`, enhanced `destroy()` method
  - 📊 Enhanced metrics with `timerHealth` monitoring and health score

## 1.4.8 - 19.05.2025
- **Fixed RequestQueue.getWaiting Method**: Restored backward compatibility by ensuring `getWaiting()` returns a copy of the array, maintaining compatibility with code that modifies the returned array.
- **Memory Optimizations**: Improved memory efficiency in high-volume request handling with proper cleanup of completed requests and optimized queue operations.

## 1.4.7 - 14.04.2025
- **Fixed RequestQueue.isBusy Behavior**: Fixed a logical error in the `isBusy` getter that was returning the opposite of expected behavior. Now correctly returns `true` when there are waiting or in-progress requests.
- **Enhanced Test Coverage**: Added comprehensive test suites for RequestQueue and RetryManager:
  - Added advanced edge case tests for RequestQueue handling
  - Added tests for binary insertion with multiple items in different order
  - Added tests for cancellation handling in the middle of a queue
  - Added tests for critical request blocking scenarios
  - Added basic and integration tests for RetryManager
- **Added per-request caching options**: Added per-request caching configuration `__cachingOptions`, allowing users to override global caching settings for specific requests.

## 1.4.4 - 13.04.2025
- **Fixed CachingPlugin**: Fixed bugs in the CachingPlugin's `runCacheCleanup` method:
  - Fixed issue with maxItems enforcement where oldest items weren't properly removed
  - Improved TypeScript compatibility when iterating through cache entries
  - Fixed edge cases with expired items not being properly cleaned up
- **Improved Test Suite**: Fixed and improved tests for CachingPlugin to avoid timing issues and race conditions

## 1.4.2 - 09.04.2025
- **Tree-Shakeable React Hooks**: Removed temporarily

## 1.4.1 - 09.04.2025
- **Queue Size Limits**: Added the `maxQueueSize` option to limit the number of requests that can be queued. When the queue is full, new requests will be rejected with `QueueFullError`. Prevents memory issues during high load.
- **Sensitive Data Protection**: Added redaction support for tokens, passwords, and other sensitive information in logs and error reporting. This now lives on the sanitization plugin surface.
- **Enhanced CircuitBreakerPlugin**: Added advanced features to the CircuitBreaker including sliding window analysis, adaptive timeouts, URL exclusion patterns, configurable success thresholds, and detailed monitoring metrics for more sophisticated failure detection and recovery.
- **Tree-Shakeable React Hooks**: Made React hooks individually importable via subpaths (e.g., `import { useGet } from 'axios-retryer/react/hooks/useGet'`) to reduce bundle size through tree shaking.
- **Custom Error Detection for TokenRefreshPlugin**: Added support for detecting auth errors in 200 OK responses through customErrorDetector option, useful for GraphQL and other APIs that return errors in the response body rather than HTTP status codes.
- **Enhanced CachingPlugin Integration**: Updated `useAxiosRetryerMutation` to properly integrate with the CachingPlugin for fine-grained cache invalidation.
- **Improved Cache Invalidation**: Added specific cache key invalidation to CachingPlugin with both exact matching and pattern matching support.
- **Error Handling Improvements**: Added proper error handling and validation in React hooks for RetryManager dependencies.

## 1.3.3 - 20.02.2025
- Hooks are deprecated and will be removed in the next major version
- RetryManager refactored and optimized

## 1.3.2 - 13.02.2025
- Added `CircuitBraker` plugin, tests and benchmark for it
- Added `Caching` plugin, tests and benchmark for it
- Made all the plugins tree-shakeable
- Plugins can now initialize before and after the retry manager interceptors `manager.use(plugin: RetryPlugin, beforeRetryerInterceptors = true)`

## 1.2.4 - 03.02.2025

### Added
- Added `__backoffType` and `__retryableStatuses` to the request config
- Added the `TokenRefresh` plugin
- Added more tests and optimized the logic
- Added `onInternetConnectionError`, `onTokenRefreshed`, `onTokenRefreshFailed` and `onBeforeTokenRefresh` events/hooks
- Added the request ID limit up to 40 symbols
- Added more logs for the `debug: true` mode
- Added `getLogger` public methods for plugins
- Tiny fixes

## 1.0.3 - 26-01-2025

### Added
- Added extended metrics
- Improved hi-load benchmark
- Added badges

## 1.0.2 - 23-01-2025

### Added
- Fix error handling on cancelling requests
- Add benchmark for high-load testing

## 1.0.1 - 23-01-2025

### Added
- Added bugfixes
- Added security improvements
- Added metrics improvements

## 1.0.0-beta.2.1 - 21-01-2025

### Added
- Added event lifecycle system
- Implemented request queue with priorities and concurrency limit
- Added more integration tests
- Improved typescript typings
- Removed ability to add custom request store due to limitations
- Added ability to specify request codes and methods that should be retried
- Added more lifecycle hooks
- Added `onBeforeDestroy` and `unuse` methods for plugins

## 1.0.0-beta.1 - 24-12-2024

### Added
- **Initial release** of `axios-retryer`.
- Support for **automatic** or **manual** retry modes.
- **DefaultRetryStrategy** handling network or server errors with an exponential delay.
- **Hooks**: `beforeRetry`, `afterRetry`, `onFailure`, and `onAllRetriesCompleted` for custom logic at various stages.
- **InMemoryRequestStore** for storing failed requests in manual mode (can be replaced with a custom store).
- Ability to **cancel** individual or all ongoing requests via `cancelRequest` or `cancelAllRequests`.
- Option to provide a custom `axiosInstance` to integrate with existing Axios configurations.
- TypeScript definitions and interfaces for easy integration in TypeScript projects.
- Basic **unit tests** covering success, failure, cancellation, and manual retry scenarios.
- Added basic plugins support and covered with tests

### Notes
- This is the first beta release. Future changes, additions, and bug fixes will appear in subsequent versions.
- Feedback and contributions are welcome—please see the [Contributing](./CONTRIBUTING.md) guidelines for more details.
