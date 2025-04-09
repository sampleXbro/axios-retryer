# Changelog

All notable changes to this project will be documented in this file.

## 1.4.1 - 09.04.2025
- **Queue Size Limits**: Added the `maxQueueSize` option to limit the number of requests that can be queued. When the queue is full, new requests will be rejected with `QueueFullError`. Prevents memory issues during high load.
- **Sensitive Data Protection**: Added automatic redaction of tokens, passwords, and other sensitive information in logs and error reporting. Configurable via `enableSanitization` and `sanitizeOptions`.
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
