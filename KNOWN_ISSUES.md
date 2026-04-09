# Known Issues

This document outlines known issues, unexpected behaviors, and edge cases for **axios-retryer 2.x**. It is meant to complement the [migration guide](./MIGRATION.md) and [security policy](./SECURITY.md).

## Resolved or materially improved in 2.0

- **Metrics consistency:** Core metrics initialization, shared nested state, and `NaN` averages were fixed; populated counters and `onMetricsUpdated` now require **`MetricsPlugin`**. If you see zeros, confirm the plugin is installed.
- **Token refresh replay:** Refreshed business requests go through `RetryManager` again (queue, cancellation, plugins) instead of bypassing them.
- **Standardized errors:** Library-thrown failures use named error classes for clearer handling.

## Active issues

### 1. Sensitive data can remain in memory

**Severity:** High  
**Component:** Manual retry store, caching plugin  
**Description:** Failed requests stored for manual replay and responses held by the caching plugin can retain headers, tokens, payloads, and bodies in process memory.

**Mitigation:** Prefer automatic mode for high-sensitivity traffic; keep `maxRequestsToStore` low; use `ManualRetryPlugin` defaults that avoid storing auth-bearing requests unless you explicitly opt in; do not share one caching-enabled manager across users or tenants; use `prepareRequestForStore` to redact payloads.

### 2. Shared cache instances can mix user-specific data

**Severity:** High  
**Component:** `CachingPlugin`  
**Description:** Cache keys do not isolate principals by default. A shared `RetryManager` can serve one user’s cached response to another for the same URL shape.

**Mitigation:** Use separate manager instances per user, tenant, or session; disable caching for personalized endpoints; scope caching to public or tenant-agnostic resources only.

### 3. Cache keys and debug output may include sensitive values

**Severity:** Medium  
**Component:** `CachingPlugin`, debug logging  
**Description:** Keys are derived from URL, params, body, and optionally headers. Secrets in those inputs can appear in memory and in logs when debug is on.

**Mitigation:** Avoid secrets in query strings; avoid `compareHeaders: true` for auth-heavy traffic; keep `debug: false` in production unless logs are controlled; use `DebugSanitizationPlugin` when you need redacted debug output.

---

## Unexpected behaviors (by design)

### `onAllBlockingRequestsResolved` is success-only

**Severity:** Low (by design)  
**Component:** Core queue / `blockingPriorityThreshold`  
**Description:** `onAllBlockingRequestsResolved` fires only when all in-flight blocking requests (at or above the configured threshold) finish with a **successful** HTTP outcome. It does **not** fire when a blocker fails, is cancelled, or when dependents are cleared after `onBlockingRequestFailed`.

**Mitigation:** Use `onBlockingRequestFailed`, `onRequestCancelled`, and `onRequestError` for failure and cancellation paths; rely on the resolution event only for “all blockers succeeded” coordination.

### POST retries and idempotency

**Severity:** Low (by design)  
**Component:** Core retry strategy  
**Description:** `POST` is not retried by default unless you provide an `Idempotency-Key` (or customize the strategy).

**Mitigation:** Send `Idempotency-Key` on mutating requests, or adjust your retry strategy explicitly.

---

## Configuration notes

### Low `maxConcurrentRequests`

Very low concurrency can cause long queues and tail latency. Tune for your workload rather than copying test-only values.

### Circuit breaker timing

`openTimeout` and related settings affect both failure detection and recovery; changing them moves both behaviors together.

---

## Test and environment notes

### Timing-sensitive tests

Tests that depend on real delays can be flaky on slow CI runners.

**Mitigation:** Prefer bounded assertions (`toBeGreaterThan`, generous timeouts) for timing-heavy cases.

---

## Version compatibility

### Node.js

CI and local development typically use current Node.js **18+** (22.x is commonly used). Older Node versions may work but are not a focus for testing.

### Axios

**Peer dependency:** `axios >= 1.7.4` (earlier releases have known security issues). Stay on supported Axios versions and run `npm audit` regularly.

---

## Reporting issues

1. Check this document and [MIGRATION.md](./MIGRATION.md).  
2. Search [GitHub issues](https://github.com/sampleXbro/axios-retryer/issues).  
3. Open a new issue with reproduction steps, environment, expected vs actual behavior, and library version.

---

**Last updated:** 2026-04-09  
**Last full test run:** 70 test suites, 769 tests passing (see `pnpm test` in CI or locally).
