# Changelog

All notable changes to this project will be documented in this file.

## next
- Added `CircuitBraker` plugin, tests and benchmark for it
- Made all the plugins tree-shakeable

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
