# Changelog

All notable changes to this project will be documented in this file.

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

### Notes
- This is the first beta release. Future changes, additions, and bug fixes will appear in subsequent versions.
- Feedback and contributions are welcome—please see the [Contributing](./CONTRIBUTING.md) guidelines for more details.
