<div align="center">
  <img src="assets/axios-retryer-logo.png" alt="axios-retryer logo" />
  <h1>axios-retryer</h1>
  <p><strong>A TypeScript-first Axios retry library with concurrency control, request prioritization, token refresh, response caching, and circuit breaker plugins.</strong></p>
  
  [![npm version](https://img.shields.io/npm/v/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer?target=_blank)
  [![npm downloads](https://img.shields.io/npm/dm/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer?target=_blank)
  [![codecov](https://codecov.io/github/sampleXbro/axios-retryer/graph/badge.svg?token=BRQB5DJVLK)](https://codecov.io/github/sampleXbro/axios-retryer?target=_blank)
  [![Known Vulnerabilities](https://snyk.io/test/github/sampleXbro/axios-retryer/badge.svg)](https://snyk.io/test/github/sampleXbro/axios-retryer?target=_blank)
  ![Build](https://github.com/sampleXbro/axios-retryer/actions/workflows/publish.yml/badge.svg?target=_blank)
  [![Gzipped Size](https://img.shields.io/bundlephobia/minzip/axios-retryer)](https://bundlephobia.com/package/axios-retryer?target=_blank)
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-First-blue)](https://www.typescriptlang.org/)
  [![Axios](https://img.shields.io/badge/Axios-Compatible-5A29E4)](https://axios-http.com/)
</div>

<hr />

<p align="center">
  <b>Build resilient Axios clients without stitching together retries, queues, auth refresh logic, and plugin glue by hand.</b>
</p>

<p align="center">
  <a href="#-installation">Installation</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-key-features">Features</a> •
  <a href="#-plugins">Plugins</a> •
  <a href="#-examples">Examples</a> •
  <a href="#-api-reference">API</a> •
  <a href="BENCHMARK_RESULTS.md">📊 Benchmarks</a>
</p>

## 🤔 Why axios-retryer?

Most Axios retry helpers stop at "try again after a delay." Real apps usually need more than that:

- **Transient failures**: APIs fail for lots of boring reasons: timeouts, 429s, brief 5xx spikes, flaky networks.
- **Authentication**: Access tokens expire, and retrying correctly after refresh is harder than it looks.
- **Concurrency control**: Frontends and workers can easily flood an upstream if every request fires at once.
- **Operational visibility**: Once retries start happening, teams need a clear picture of what the client is doing.

**axios-retryer** is built for that broader problem. It wraps Axios with retry logic, concurrency control, request priority, manual retry flows, and optional plugins for token refresh, response caching, and circuit breaking.

If you are looking for an Axios retry library for TypeScript that can also handle concurrency limits, token refresh, caching, and request prioritization, this is the kind of problem axios-retryer is designed for.

Instead of just retrying on failure, axios-retryer gives you:

- 🔄 **Intelligent retries** with customizable strategies
- 🔑 **Built-in token refresh** handling
- 🚦 **Request prioritization** and traffic control
- 📊 **Detailed metrics** for monitoring and debugging
- 🧩 **Plugin architecture** for extending functionality

## ✅ Good Fit For

- Frontend apps that need retries plus token refresh and predictable concurrency
- Node.js services or workers that call third-party APIs under rate limits
- Teams that want a single Axios integration point instead of scattered retry helpers
- TypeScript projects that want a typed retry manager instead of ad hoc interceptors

## 🚫 Probably Not For

- Tiny apps that only need "retry a GET request a few times" and nothing else
- Projects that are not using Axios
- Teams that prefer writing custom interceptors instead of adopting a request manager

## 🚀 Performance & Reliability

The project ships with a benchmark suite that exercises healthy traffic, transient failures, rate limiting, queue contention, sustained load, outage recovery, caching, circuit breaking, and token refresh.

Current release benchmarks for the standard profile show:

- **Healthy-path throughput:** `2646.58 req/sec`
- **Priority queue p95 under contention:** `661.39ms`
- **Peak burst throughput:** `4012.74 req/sec`
- **Caching hot-read hit rate:** `100%`
- **Release benchmark suite:** `7/7` benchmark runs passing
- **Test suite:** `63/63` suites and `630/630` tests passing

These numbers come from the included local benchmark suite and are best used as a relative guide for this library's behavior, not as a universal guarantee for every app or network.

**[📊 View Detailed Benchmark Results](BENCHMARK_RESULTS.md)** for more context and scenario-by-scenario numbers.

## 📊 axios-retryer vs axios-retry and retry-axios

| Feature                         | axios-retryer                                       | axios-retry                     | retry-axios                    |
|---------------------------------|-----------------------------------------------------|---------------------------------|--------------------------------|
| Automatic & Manual Modes        | ✅ Either auto-retry or manually queue & retry       | ❌ Automatic only               | ❌ Automatic only              |
| Concurrency Control             | ✅ maxConcurrentRequests + priority queue            | ❌ No concurrency management    | ❌ No concurrency management   |
| Priority-Based Requests         | ✅ CRITICAL → LOW priorities with blocking threshold | ❌ Not supported                | ❌ Not supported               |
| Customizable Retry Strategy     | ✅ Fully customizable strategy + functional API      | ⚠️ Basic configuration only     | ⚠️ Basic configuration only    |
| Request Store & Manual Retry    | ✅ Store failed requests and retry later             | ❌ No                           | ❌ No                          |
| Events, Hooks & Plugins         | ✅ Rich event system and plugin architecture         | ❌ Limited hooks                | ❌ Limited hooks               |
| Cancellation                    | ✅ Cancel individual or all requests                 | ❌ No direct support            | ❌ No direct support           |
| Detailed Metrics & Debugging    | ✅ Comprehensive metrics and debugging               | ⚠️ Basic logging               | ⚠️ Basic logging              |
| Selective Plugin Imports        | ✅ Core + separate plugin entry points               | ❌ Not a core feature           | ❌ Not a core feature          |
| Token Refresh                   | ✅ Built-in plugin                                   | ❌ Manual implementation        | ❌ Manual implementation       |
| Circuit Breaking                | ✅ Built-in plugin                                   | ❌ No                           | ❌ No                          |
| Request Caching                 | ✅ Built-in plugin                                   | ❌ No                           | ❌ No                          |
| TypeScript Support              | ✅ Full types                                        | ⚠️ Basic                       | ⚠️ Basic                      |
| Observability                   | ✅ Rich metrics and events                           | ❌ Minimal                      | ❌ Minimal                     |
| Multiple Backoff Strategies     | ✅ Static, linear, exponential, custom               | ⚠️ Limited options             | ⚠️ Limited options            |

## 📦 Installation

Install `axios-retryer` exactly like any other Axios companion package:

> **Requires `axios` >= 1.7.4** — earlier versions contain known security vulnerabilities (prototype pollution, DoS).

```bash
# Using npm
npm install axios-retryer

# Using yarn
yarn add axios-retryer

# Using pnpm
pnpm add axios-retryer
```

The plugin layer currently includes `TokenRefreshPlugin`, `CircuitBreakerPlugin`, `CachingPlugin`, `ManualRetryPlugin`, `DebugSanitizationPlugin`, `RequestDependencyPlugin`, and `MetricsPlugin`.

## ⚡ Quick Start

This gives you a managed Axios instance with retries enabled:

```typescript
// Import the library
import { createRetryer } from 'axios-retryer';

// Create a retry manager with sensible defaults
const retryer = createRetryer({
  retries: 3,
  debug: false
});

// Use the managed Axios instance
retryer.axiosInstance.get('https://api.example.com/data')
  .then(response => console.log(response.data))
  .catch(error => console.error('All retries failed:', error));
```

Try it now:
[![Edit on CodeSandbox](https://img.shields.io/badge/Edit_on-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/sandbox/axios-retryer-demo-fppdc4?target=_blank)

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       axios-retryer                            │
├────────────┬─────────────┬───────────────┬────────────────────┤
│            │             │               │                    │
│ RetryManager  RequestQueue  RetryStrategy   Plugins System    │
│            │             │               │                    │
└────────────┴─────────────┴───────────────┴────────────────────┘
                                    │
                                    ▼
┌─────────────────────┬─────────────────────┬─────────────────────┐
│  TokenRefreshPlugin │  CircuitBreakerPlugin│   CachingPlugin    │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

### Core vs Plugin Boundary

The library is intentionally split into a small core and optional plugins:

| Responsibility | Owner | Entry point |
|---|---|---|
| Retry orchestration (auto/manual), queue, concurrency | **Core** | `axios-retryer` |
| Request prioritization and scheduling | **Core** | `axios-retryer` |
| Lifecycle events and hook system | **Core** | `axios-retryer` |
| Custom retry strategies | **Core** | `axios-retryer` |
| Error types and constants | **Core** | `axios-retryer` |
| Injectable logger | **Core** | `axios-retryer` |
| Token refresh flow | **Plugin** | `axios-retryer/plugins/TokenRefreshPlugin` |
| Response caching | **Plugin** | `axios-retryer/plugins/CachingPlugin` |
| Circuit breaking | **Plugin** | `axios-retryer/plugins/CircuitBreakerPlugin` |
| Manual retry storage and replay | **Plugin** | `axios-retryer/plugins/ManualRetryPlugin` |
| Request dependency gating | **Plugin** | `axios-retryer/plugins/RequestDependencyPlugin` |
| Debug log sanitization | **Plugin** | `axios-retryer/plugins/DebugSanitizationPlugin` |
| Metrics collection | **Plugin** | `axios-retryer/plugins/MetricsPlugin` |

**Rules of thumb:**
- Features that every retry user needs belong in core.
- Features that only some users need belong in a plugin.
- Plugin-specific types are exported from the plugin entry point, not the root.
- New behavior should grow an existing plugin before creating a new one.

<details>
<summary>📑 <b>Detailed Table of Contents</b></summary>

- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Key Features](#-key-features)
- [Class-based vs Functional API](#-class-based-vs-functional-api)
- [Configuration Options](#-configuration-options)
- [Automatic vs Manual Mode](#-automatic-vs-manual-mode)
- [Events](#-events)
- [Plugins](#-plugins)
  - [TokenRefreshPlugin](#tokenrefreshplugin)
  - [CircuitBreakerPlugin](#circuitbreakerplugin)
  - [CachingPlugin](#cachingplugin)
  - [ManualRetryPlugin](#manualretryplugin)
  - [DebugSanitizationPlugin](#debugsanitizationplugin)
  - [RequestDependencyPlugin](#requestdependencyplugin)
  - [MetricsPlugin](#metricsplugin)
- [Import Only What You Need](#-import-only-what-you-need)
- [Environment Support](#-environment-support)
  - [Node.js Support](#nodejs-support)
  - [Browser Support](#browser-support)
  - [Hybrid Applications](#hybrid-applications)
- [Advanced Topics](#-advanced-topics)
  - [Concurrency & Priority](#concurrency--priority)
  - [Custom Retry Strategies](#custom-retry-strategies)
  - [Sensitive Data Protection](#sensitive-data-protection)
  - [Handling Queue Overflow](#handling-queue-overflow)
  - [Plugin Management Best Practices](#plugin-management-best-practices)
- [Examples](#-examples)
- [API Reference](#-api-reference)
- [Troubleshooting](#-troubleshooting)
- [Known Issues](./KNOWN_ISSUES.md)
- [Benchmark Results](./BENCHMARK_RESULTS.md)
- [v1 → v2 Migration Guide](./MIGRATION.md)
- [Compatibility](#-compatibility)
- [Contributing](#-contributing)
- [License](#-license)

</details>

## 🔑 Key Features

- **Dual Retry Modes**: Choose between automatic retries based on error types or manual failure handling, and pair manual mode with `ManualRetryPlugin` when you want stored replay.
- **Priority Queue**: Assign different priorities (CRITICAL to LOW) to ensure important requests go first.
- **Concurrency Control**: Limit the number of concurrent requests to prevent overwhelming servers.
- **Rich Event System**: Subscribe to lifecycle events for monitoring and customization.
- **Plugin Architecture**: Keep the core small and opt into token refresh, circuit breaking, caching, manual replay, metrics, sanitization, and critical-request controls only when you need them.
- **Queue Size Limits**: Prevent memory issues during high traffic with configurable queue limits.
- **Sensitive Data Protection**: Add `DebugSanitizationPlugin` for redacted debug logs and diagnostics.
- **Cancellation Support**: Cancel individual requests or all ongoing requests at once.
- **Comprehensive Metrics**: Add `MetricsPlugin` when you want populated metrics snapshots and `onMetricsUpdated` events.
- **Debug Mode**: Get detailed logs about the retry process when needed.
- **Tree-Shakable**: Only include what you need for optimal bundle size.

## 🔐 Security Notes

axios-retryer offers redaction through `DebugSanitizationPlugin`, but it is not a security boundary by itself.

- **Failed requests can stay in memory**: When `ManualRetryPlugin` is installed, failed `AxiosRequestConfig` objects can be kept in memory so they can be replayed later.
- **Cached responses stay in memory by default**: The built-in `CachingPlugin` storage keeps cached responses in process memory until eviction or cleanup. Custom cache adapters can persist that data elsewhere, but cached payloads should still be treated as sensitive application data.
- **Do not assume storage is redacted**: `DebugSanitizationPlugin` only protects plugin-managed logs. Replayable request storage and cached responses may still contain raw tokens, headers, or payload data.
- **Avoid sharing one retryer across users or tenants**: This is especially important in SSR, backend, or worker environments when caching is enabled.
- **Be careful with debug mode**: Debug logging is useful in development, but production environments handling sensitive data should keep it off unless logs are tightly controlled.

For a fuller breakdown, see [SECURITY.md](./SECURITY.md).

## 🛡️ Production Safe Defaults and Sharp Edges

This section summarises the most important decisions to make before going to production.

### Safe defaults

| Plugin | Secure default | What it prevents |
|--------|---------------|-----------------|
| `CachingPlugin` | `skipWhenAuthPresent: true` | Caching responses to authenticated requests; prevents cross-user cache collisions on a shared retryer instance. |
| `ManualRetryPlugin` | `storeAuthRequests: false` | Storing requests that carry auth headers or `config.auth`; prevents replaying credentials that may have expired. |
| `ManualRetryPlugin` | No `rehydrateAuth` by default | Replayed requests carry no auth headers unless you explicitly supply a `rehydrateAuth` hook, preventing cross-principal replay. |

### When to avoid caching

- **Authenticated or personalised responses**: Even with `skipWhenAuthPresent: true`, if you turn it off (`false`), use `varyHeaders` to bind cache entries to the correct identity rather than sharing them across principals.
- **Short-lived or real-time data**: A `timeToRevalidate: 0` (never expires) cache for frequently changing data will serve stale content. Set a sensible TTR or use `invalidateCache()` after mutations.
- **Large response bodies in high-throughput services**: The in-memory adapter holds snapshots of every cached response. Use `maxItems` and `cleanupInterval` to cap memory usage, or supply a custom storage adapter backed by Redis/Memcached.

### When to avoid ManualRetryPlugin

- **Mutations (POST/PUT/PATCH/DELETE) without idempotency keys**: Non-idempotent requests are not stored by default (`storeNonIdempotent: false`). Enabling this for non-idempotent operations risks duplicate side effects on replay.
- **Shared retryer instances across users**: `retryFailedRequests()` replays all stored failures. If requests from different users share one instance, replay could mix data. Use one retryer per user/session boundary, or filter carefully with `beforeRetry`.

### Recommended plugin combinations for common scenarios

**Resilient API client (single-user, frontend)**
```ts
const retryer = createRetryer({ retries: 3, backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL });
retryer.use(new TokenRefreshPlugin(refreshFn));
retryer.use(new CachingPlugin({ timeToRevalidate: 30_000, maxItems: 500 }));
retryer.use(new CircuitBreakerPlugin({ failureThreshold: 5, openTimeout: 10_000 }));
```

**Backend service calling downstream APIs (multi-user)**
```ts
// One retryer per downstream service — do NOT share across tenants.
const retryer = createRetryer({ retries: 3, maxConcurrentRequests: 20 });
// No CachingPlugin — downstream responses are user-specific.
// No ManualRetryPlugin — replay semantics are complex in multi-tenant code.
retryer.use(new CircuitBreakerPlugin({ failureThreshold: 10, openTimeout: 30_000 }));
retryer.use(new MetricsPlugin());
```

**Offline-capable SPA with manual retry**
```ts
const retryer = createRetryer({ mode: RETRY_MODES.MANUAL });
const manualRetry = new ManualRetryPlugin({
  manualRetryMaxAge: 60_000,
  rehydrateAuth: (config) => {
    config.headers = config.headers || {};
    config.headers['Authorization'] = `Bearer ${store.getAccessToken()}`;
    return config;
  },
});
retryer.use(manualRetry);

// Reconnect handler:
window.addEventListener('online', () => manualRetry.retryFailedRequests());
```

## 🧰 Class-based vs Functional API

axios-retryer offers both traditional class-based and modern functional APIs:

### Class-based API

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  retries: 3,
  debug: false
});

manager.axiosInstance.get('/api/data')
  .then(response => console.log(response.data));
```

### Functional API

```typescript
import { createRetryer, createRetryStrategy } from 'axios-retryer';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';

// Create retry manager
const retryer = createRetryer({
  retries: 3,
  debug: false
});

// Create custom retry strategy
const customStrategy = createRetryStrategy({
  isRetryable: (error) => (error.response?.status ?? 0) >= 500,
  getDelay: (attempt) => attempt * 1000
});

// Create and use plugin
retryer.use(
  createTokenRefreshPlugin(
    async (axiosInstance) => {
      const { data } = await axiosInstance.post('/auth/refresh');
      return { token: data.accessToken };
    }
  )
);

// Use the axios instance
retryer.axiosInstance.get('/api/data')
  .then(response => console.log(response.data));
```

## ⚙️ Configuration Options

```typescript
import { 
  createRetryer, 
  RETRY_MODES,
  AXIOS_RETRYER_HTTP_METHODS,
  AXIOS_RETRYER_BACKOFF_TYPES,
  AXIOS_RETRYER_REQUEST_PRIORITIES 
} from 'axios-retryer';

const retryer = createRetryer({
  // Core settings
  mode: RETRY_MODES.AUTOMATIC,
  retries: 3,                               // Maximum retry attempts
  debug: false,                             // Enable detailed logging
  
  // Concurrency settings
  maxConcurrentRequests: 5,                 // Limit parallel requests
  queueDelay: 100,                          // Conservative default pacing for queued requests
  
  // Retry behavior
  retryableStatuses: [408, 429, [500, 599] as const], // Status codes to retry
  retryableMethods: [
    AXIOS_RETRYER_HTTP_METHODS.GET,
    AXIOS_RETRYER_HTTP_METHODS.HEAD,
    AXIOS_RETRYER_HTTP_METHODS.OPTIONS,
  ], // Methods to retry
  backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL, // Delay type
  
  // Error handling
  throwErrorOnFailedRetries: true,          // Throw after all retries fail
  throwErrorOnCancelRequest: true           // Throw when requests are canceled
});
```

Use `DebugSanitizationPlugin` when you want redacted request and error diagnostics:

```typescript
import { createDebugSanitizationPlugin } from 'axios-retryer/plugins/DebugSanitizationPlugin';

retryer.use(createDebugSanitizationPlugin());
```

## 🔄 Automatic vs Manual Mode

Choose the mode based on how you want failures to surface in your app.

### Automatic Mode (Default)

Use this when you want axios-retryer to handle transient failures for you:

```typescript
import { createRetryer, RETRY_MODES } from 'axios-retryer';

const retryer = createRetryer({ mode: RETRY_MODES.AUTOMATIC, retries: 3 });

// Will automatically retry up to 3 times on failure
retryer.axiosInstance.get('/api/data');
```

### Manual Mode

Use this when you want failures to stop after the first attempt. Add `ManualRetryPlugin` when you also want failed requests stored and replayed later, for example after reconnecting or after a user action:

```typescript
import { createRetryer, RETRY_MODES } from 'axios-retryer';
import { createManualRetryPlugin } from 'axios-retryer/plugins/ManualRetryPlugin';

const retryer = createRetryer({ mode: RETRY_MODES.MANUAL });
const manualRetry = createManualRetryPlugin();

retryer.use(manualRetry);

// Initial request - no automatic retries
retryer.axiosInstance.get('/api/data')
  .catch(() => console.log('Request failed'));

// Later - perhaps when back online or after user action
manualRetry.retryFailedRequests()
  .then(responses => console.log('Retried successfully:', responses));
```

## 🔔 Events

You can subscribe to lifecycle events for logging, dashboards, and custom workflows. Most apps only need a few of these:

Plugin-specific events become available in the `on()`/`off()` typings on the `RetryManager` value returned from `use()` (or after reassigning). For example, `onTokenRefreshed` is typed after `const retryerWithTokenRefresh = retryer.use(createTokenRefreshPlugin(...))`.

```typescript
import { createRetryer } from 'axios-retryer';
import { createMetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';

const retryer = createRetryer();
retryer.use(createMetricsPlugin());

retryer
  .on('onRetryProcessStarted', () => {
    console.log('Starting retry process');
  })
  .on('beforeRetry', (config) => {
    console.log(`Retrying request to ${config.url}`);
  })
  .on('afterRetry', (config, success) => {
    console.log(`Retry ${success ? 'succeeded' : 'failed'} for ${config.url}`);
  })
  .on('onRetryProcessFinished', () => {
    console.log('All retries completed');
  })
  .on('onMetricsUpdated', (metrics) => {
    updateDashboard(metrics); // Requires MetricsPlugin
  });

// Unsubscribe when needed
const handler = () => console.log('Retry finished');
retryer.on('onRetryProcessFinished', handler);
retryer.off('onRetryProcessFinished', handler);
```

## 🧩 Plugins

Start with the core retry manager, then add plugins only where they make sense for your app:

```typescript
import { createRetryer } from 'axios-retryer';
import { AXIOS_RETRYER_HTTP_METHODS } from 'axios-retryer';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { createCircuitBreaker } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';

const retryer = createRetryer();

// Token refresh for authentication
retryer.use(
  createTokenRefreshPlugin(
    async (axiosInstance) => {
      const refreshToken = localStorage.getItem('refreshToken');
      const { data } = await axiosInstance.post('/auth/refresh', { refreshToken });
      return { token: data.accessToken };
    },
    {
      authHeaderName: 'Authorization',
      refreshStatusCodes: [401],
      tokenPrefix: 'Bearer ',
      maxRefreshAttempts: 3,
      customErrorDetector: (response) => {
        return response?.errors?.some(err => 
          err.extensions?.code === 'UNAUTHENTICATED' || 
          err.message?.includes('token expired')
        );
      }
    }
  )
);

// Circuit breaker to prevent overwhelming failing services
retryer.use(
  createCircuitBreaker({
    failureThreshold: 5,    // Trip after 5 failures
    openTimeout: 30000,     // Wait 30s before testing again
    halfOpenMax: 2          // Allow 2 test requests
  })
);

// Response caching to reduce traffic
retryer.use(
  createCachePlugin({
    timeToRevalidate: 60000,   // Cache lifetime in ms (1 minute)
    cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET], // HTTP methods to cache
    cleanupInterval: 300000,   // Cleanup every 5 minutes
    maxItems: 100,             // Maximum cache entries
    compareHeaders: false,     // Whether to include headers in cache key
    cacheOnlyRetriedRequests: false // Whether to cache only retry attempts
  })
);
```

All documented plugin entry points are first-class public API:

| Plugin | Import | Use when |
|--------|--------|----------|
| `TokenRefreshPlugin` | `createTokenRefreshPlugin` | access tokens expire and protected requests need replay after refresh |
| `CircuitBreakerPlugin` | `createCircuitBreaker` | a failing upstream should trip open and fail fast |
| `CachingPlugin` | `createCachePlugin` | repeated reads should be deduped or served from memory |
| `ManualRetryPlugin` | `createManualRetryPlugin` | terminal failures should be stored and replayed later |
| `DebugSanitizationPlugin` | `createDebugSanitizationPlugin` | debug logs must redact auth headers, params, and payload fields |
| `RequestDependencyPlugin` | `createRequestDependencyPlugin` | higher-priority or dependency-gated traffic should block lower-priority work |
| `MetricsPlugin` | `createMetricsPlugin` | `getMetrics()` and `onMetricsUpdated` should report real retry data |

### TokenRefreshPlugin

Automatically refreshes authentication tokens when protected requests fail with `401`:

```typescript
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';

retryer.use(
  createTokenRefreshPlugin(
    // Function that performs the refresh
    async (axiosInstance) => {
      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) {
        throw new Error('Refresh token not found');
      }
      const { data } = await axiosInstance.post('/auth/refresh', { refreshToken });
      localStorage.setItem('accessToken', data.accessToken);
      return { token: data.accessToken };
    },
    // Configuration options
    {
      authHeaderName: 'Authorization',  // Header name for auth token
      refreshStatusCodes: [401],        // Status codes triggering refresh
      tokenPrefix: 'Bearer ',           // Token prefix in header
      maxRefreshAttempts: 3,            // Max refresh attempts
      customErrorDetector: (response) => {
        if (typeof response !== 'object' || response === null || !('errors' in response)) {
          return false;
        }

        const errors = (response as {
          errors?: Array<{ extensions?: { code?: string }; message?: string }>;
        }).errors;

        return Array.isArray(errors) && errors.some((err) => 
          err.extensions?.code === 'UNAUTHENTICATED' || 
          err.message?.includes('token expired')
        );
      }
    }
  )
);
```

The `customErrorDetector` option is useful for GraphQL APIs and APIs that report authentication problems in a successful `200` response body instead of through HTTP status codes.

If the refresh callback throws a regular error before making the refresh request, axios-retryer treats that as a terminal refresh failure and stops the remaining refresh attempts. This is useful for cases like a missing refresh token in storage.

### CircuitBreakerPlugin

Prevents a failing upstream from being hammered over and over again:

```typescript
import { createCircuitBreaker } from 'axios-retryer/plugins/CircuitBreakerPlugin';

retryer.use(
  createCircuitBreaker({
    failureThreshold: 5,       // Number of failures before tripping
    openTimeout: 30000,        // Time (ms) to wait before testing again
    halfOpenMax: 2,            // Test requests allowed in half-open state
    successThreshold: 2,       // Successes needed to close circuit
    useSlidingWindow: true,    // Use a time window for counting failures
    slidingWindowSize: 60000   // 60-second sliding window
  })
);
```

### CachingPlugin

Caches responses to reduce network traffic and improve perceived performance:

```typescript
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';
import { AXIOS_RETRYER_HTTP_METHODS } from 'axios-retryer';

const cachePlugin = createCachePlugin({
  timeToRevalidate: 60000,   // Cache lifetime in ms (1 minute)
  cacheMethods: [AXIOS_RETRYER_HTTP_METHODS.GET], // HTTP methods to cache
  cleanupInterval: 300000,   // Cleanup every 5 minutes
  maxItems: 100,             // Maximum cache entries
  compareHeaders: false,     // Whether to include headers in cache key
  cacheOnlyRetriedRequests: false, // Whether to cache only retry attempts
  cacheKeyBuilder: ({ method, normalizedUrl, normalizedParams }) =>
    `${method}|${normalizedUrl}|${normalizedParams}` // Optional custom key contract
});

// Register the plugin
retryer.use(cachePlugin);

// Later, you can:

// 1. Invalidate one exact cache entry
const userOneKey = cachePlugin.buildCacheKey({ method: 'get', url: '/api/users/1' });
cachePlugin.invalidateCache({ exact: userOneKey });

// 2. Invalidate a whole prefix scope
cachePlugin.invalidateCache({ prefix: 'GET|/api/users/' });

// 3. Clear the entire cache
cachePlugin.clearCache();

// 4. Get cache statistics
const stats = cachePlugin.getCacheStats();
console.log(`Cache size: ${stats.size}, Average age: ${stats.averageAge}ms`);
```

#### Custom Cache Storage

Custom cache adapters are now an indexed contract. In addition to `get`, `set`, `delete`, and `clear`, they must implement `entries()` and return the adapter's current cache index.

That index is what powers:

- periodic cleanup
- `maxAge` and `maxItems` enforcement
- prefix and `RegExp` invalidation
- restart-safe cache management with persistent or distributed stores

Minimal adapter shape:

```typescript
import type {
  CacheStorage,
  CacheStorageEntry,
  CachedItem,
} from 'axios-retryer/plugins/CachingPlugin';

class RedisBackedCacheStorage implements CacheStorage {
  async get(key: string): Promise<CachedItem | undefined> {
    // ...
  }

  async set(key: string, value: CachedItem): Promise<void> {
    // ...
  }

  async delete(key: string): Promise<void> {
    // ...
  }

  async clear(): Promise<void> {
    // ...
  }

  async entries(): Promise<readonly CacheStorageEntry[]> {
    // Return the adapter's full index for cleanup and invalidation scans.
    // ...
  }
}
```

#### Per-Request Cache Configuration

You can override global caching settings on a per-request basis:

```typescript
// Force cache a request that would normally not be cached
retryer.axiosInstance.post('/api/items', data, {
  __cachingOptions: {
    cache: true, // Override global settings to force caching
    ttr: 30000   // Custom 30-second TTR for this request
  }
});

// Disable caching for a specific request
retryer.axiosInstance.get('/api/time-sensitive-data', {
  __cachingOptions: {
    cache: false // Skip caching for this request
  }
});

// Set a custom TTR while using default caching rules
retryer.axiosInstance.get('/api/semi-static-data', {
  __cachingOptions: {
    ttr: 300000 // This request's cache will live for 5 minutes
  }
});
```

The CachingPlugin provides smart cache invalidation:

- **Precise Invalidation**: Invalidate specific cache entries by exact key
- **Scoped Bulk Invalidation**: Invalidate whole cache-key prefixes when you mean a family of entries
- **Stable Cache Keys**: Canonical request-derived keys reduce property-order surprises
- **Cache Statistics**: Monitor cache size and performance
- **Per-Request Control**: Override global cache settings for individual requests

This plugin is particularly useful for:
- Caching frequently accessed, rarely changed data
- Improving perceived performance in user interfaces
- Reducing server load and network traffic
- Working offline with previously cached data

Security guidance for caching:

- Do not cache user-specific or auth-scoped endpoints unless you isolate cache instances per user or per tenant
- Be careful with shared server-side retryer instances, because cached responses can otherwise bleed across callers
- Avoid putting secrets in query params, request bodies, or cache key material when possible
- If you enable `compareHeaders`, remember that headers become part of the cache key material

### ManualRetryPlugin

Stores terminal failures and replays them later with optional age limits and idempotency safeguards:

```typescript
import { createManualRetryPlugin } from 'axios-retryer/plugins/ManualRetryPlugin';

const manualRetry = createManualRetryPlugin({
  manualRetryMaxAge: 5 * 60 * 1000,
  maxRequestsToStore: 100,
  storeNonIdempotent: false,
  storeAuthRequests: false,
  prepareRequestForStore: (config) => ({
    ...config,
    data: { redacted: true },
  }),
});

retryer.use(manualRetry);

const responses = await manualRetry.retryFailedRequests();
```

This is the manual replay path in `2.x`.

By default, the plugin stores idempotent requests only, skips auth-bearing requests, and strips sensitive auth headers before persistence. If you intentionally need to replay auth-bearing requests, opt in with `storeAuthRequests: true` and use `prepareRequestForStore` to redact or filter stored payloads.

On replay it re-applies auth defaults from the managed Axios instance when those defaults are available.

### DebugSanitizationPlugin

Moves sensitive-data redaction out of the core manager and into an explicit plugin:

```typescript
import { createDebugSanitizationPlugin } from 'axios-retryer/plugins/DebugSanitizationPlugin';

retryer.use(
  createDebugSanitizationPlugin({
    sanitizeOptions: {
      sensitiveHeaders: ['X-API-Key', 'Session-Token'],
      sensitiveFields: ['password', 'creditCard', 'ssn'],
      redactionChar: '#',
    },
  }),
);
```

This plugin sanitizes request URLs, headers, request payloads, and response payloads in plugin-managed debug logs only. It does not redact what stays in memory stores or caches.

### RequestDependencyPlugin

Lets blocking traffic hold lower-priority queue work until the blocking request resolves:

```typescript
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';
import { createRequestDependencyPlugin } from 'axios-retryer/plugins/RequestDependencyPlugin';

retryer.use(
  createRequestDependencyPlugin({
    blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
    cancelPendingOnDependencyFailure: true,
  }),
);
```

Use this when a checkout, write path, or other urgent workflow should take precedence over background traffic, or when dependent requests must wait for a blocker to finish.

### MetricsPlugin

Metrics collection is optional in v2 so the core stays smaller and cheaper by default:

```typescript
import { createMetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';

retryer.use(createMetricsPlugin());

retryer.on('onMetricsUpdated', (metrics) => {
  console.log(metrics.successfulRetries);
});
```

Without `MetricsPlugin`, `getMetrics()` still returns the full metrics shape, but the counters stay at their zero defaults.

## 📦 Import Only What You Need

axios-retryer ships a compact core entry point plus documented plugin entry points, so you can keep browser bundles lean without making imports awkward:

- **Tree-Shaking Support**: The library supports modern tree-shaking techniques, allowing bundlers to eliminate unused code from your final bundle.

- **Preferred for application code**: Import plugin factories from focused subpaths so bundlers and readers both see exactly what you use:

```typescript
// Core functionality only
import { createRetryer } from 'axios-retryer';

// Add plugin factories only when needed
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { createCircuitBreaker } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';
```

- **Convenience barrel**: `axios-retryer/plugins` also works when a single import line reads better, but the focused subpaths are the primary documented path because they make plugin ownership and bundle intent explicit.

- **Build targets**:
  - **ES Modules**: Best for modern applications with bundlers (Webpack, Rollup, etc.)
  - **CommonJS**: For Node.js environments and older applications
  - **Optional UMD Browser Bundle**: Generate locally with `npm run build:browser` when you need a script-tag build
  
Bundle size depends on your bundler, your Axios version, and which plugins you include. The Bundlephobia badge above is the best quick estimate, and the local `stats/` reports are the most accurate source for this repo.

## 🌐 Environment Support

axios-retryer works in both Node.js and browser environments anywhere Axios itself is a good fit:

### Node.js Support

- **Works with modern Node.js runtimes**
- **CommonJS format** for traditional Node.js applications
- **ESM format** for Node.js with ES modules support
- **Optimized server handling** of retries, concurrency, and priorities
- **Seamless integration** with Node.js HTTP clients and server-side rendering frameworks

### Browser Support

- **Works in modern browsers** through bundlers
- **Optional UMD bundle** can be generated locally for direct browser usage via script tag
- **ESM bundle** for modern bundlers and browsers with ES module support
- **Respects browser constraints** like connection limits and concurrent requests
- **Works with service workers** and offline-first applications

### Hybrid Applications

For applications that run in both Node.js and the browser, such as SSR frameworks:
- **Environment detection** to optimize for each platform
- **Consistent API** across environments
- **Safe usage** with isomorphic applications

## 🔬 Advanced Topics

### Plugin Management Best Practices

To keep plugin usage predictable across a larger app:

```typescript
import { createRetryer } from 'axios-retryer';
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';

// 1. Create a single RetryManager instance for your application
const retryer = createRetryer({ retries: 3 });

// 2. Register plugins with meaningful variable names
const cachePlugin = createCachePlugin({ timeToRevalidate: 60000 });
retryer.use(cachePlugin);

const tokenPlugin = createTokenRefreshPlugin(/* refresh function */);
retryer.use(tokenPlugin);

// 3. Export both the RetryManager and plugins for use throughout the app
export { retryer, cachePlugin, tokenPlugin };
```

#### Avoiding Duplicate Plugins

Multiple instances of the same plugin type can cause unexpected behavior:

```typescript
// DON'T: Create separate plugin instances across files
// file1.js
retryer.use(createCachePlugin({ timeToRevalidate: 60000 }));

// file2.js - This creates a SECOND instance!
retryer.use(createCachePlugin({ timeToRevalidate: 30000 }));

// DO: Create one instance and share it
// shared.js
export const cachePlugin = createCachePlugin({ timeToRevalidate: 60000 });
export const retryer = createRetryer();
retryer.use(cachePlugin);

// file1.js and file2.js - Import and use the shared instances
import { retryer, cachePlugin } from './shared';
```

### Concurrency & Priority

Control request flow with priorities and concurrency limits:

```typescript
import {
  createRetryer,
  AXIOS_RETRYER_REQUEST_PRIORITIES
} from 'axios-retryer';
import { createRequestDependencyPlugin } from 'axios-retryer/plugins/RequestDependencyPlugin';

const retryer = createRetryer({
  maxConcurrentRequests: 3,
});

retryer.use(
  createRequestDependencyPlugin({
    blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
  }),
);

// Critical auth request (blocks lower priority requests)
retryer.axiosInstance.post('/auth/login', credentials, {
  __axiosRetryer: {
    priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL // 4
  }
});

// Important user data (blocks medium/low priority)
retryer.axiosInstance.get('/api/user-profile', {
  __axiosRetryer: {
    priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH // 2
  }
});

// Background analytics (processed last)
retryer.axiosInstance.post('/api/analytics', eventData, {
  __axiosRetryer: {
    priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW // 0
  }
});
```

### Custom Retry Strategies

Create specialized retry logic for your application:

```typescript
import { createRetryer, createRetryStrategy } from 'axios-retryer';

// Create a custom retry strategy
const customStrategy = createRetryStrategy({
  // Determine which errors should be retried
  isRetryable: (error) => {
    // Only retry server errors and network failures
    return !error.response || (error.response.status >= 500 && error.response.status < 600);
  },
  
  // Logic to decide if a retry should be attempted
  shouldRetry: (error, attempt, maxRetries) => {
    // Don't retry POST requests more than once
    if (error.config?.method?.toLowerCase() === 'post' && attempt >= 1) {
      return false;
    }
    return attempt <= maxRetries;
  },
  
  // Calculate delay between retries
  getDelay: (attempt) => {
    // Linear backoff with jitter
    const baseDelay = attempt * 1000; // 1s, 2s, 3s...
    const jitter = Math.random() * 500; // 0-500ms of jitter
    return baseDelay + jitter;
  }
});

const retryer = createRetryer({
  retryStrategy: customStrategy
});
```

### Sensitive Data Protection

Protect sensitive information in plugin-managed debug logs and error reporting:

```typescript
import { createDebugSanitizationPlugin } from 'axios-retryer/plugins/DebugSanitizationPlugin';

const retryer = createRetryer({ debug: true });

retryer.use(createDebugSanitizationPlugin({
  sanitizeOptions: {
    sensitiveHeaders: ['X-API-Key', 'Session-Token'],
    sensitiveFields: ['password', 'creditCard', 'ssn'],
    redactionChar: '#',
    sanitizeRequestData: true,
    sanitizeResponseData: true,
    sanitizeUrlParams: true,
  },
}));
```

Important caveat:

- This redaction support is best understood as a logging safeguard.
- It does not guarantee that replayable failed-request storage or cached responses are fully sanitized in memory.
- If your requests carry high-sensitivity data, prefer automatic mode, shorter cache retention, smaller `ManualRetryPlugin.maxRequestsToStore` values, and separate retryer instances per security boundary.

### Handling Queue Overflow

If you expect bursts of traffic, handle queue overflow explicitly:

```typescript
import { createRetryer, QueueFullError } from 'axios-retryer';

const retryer = createRetryer({
  maxConcurrentRequests: 10,
  maxQueueSize: 50 // At most 50 requests can be queued
});

try {
  await retryer.axiosInstance.get('/api/data');
} catch (error) {
  if (error instanceof QueueFullError) {
    console.log('System overloaded, please try again later');
    // Implement backpressure or user feedback
  } else {
    // Handle other errors
    console.error('Request failed:', error);
  }
}
```

### Standardized Library Errors

Library-thrown errors now use named classes so you can handle them with `instanceof` instead of string matching.

```typescript
import {
  createRetryer,
  PluginRegistrationError,
  QueueFullError,
  RetryerConfigError,
} from 'axios-retryer';
import {
  TokenRefreshAbortError,
  TokenRefreshTimeoutError,
} from 'axios-retryer/plugins/TokenRefreshPlugin';
```

Core errors such as invalid configuration, duplicate plugin registration, queue overflow, queue cancellation, and request aborts are exported from the root entry. Plugin-specific errors stay on their plugin entry points, such as `InvalidCacheKeyError`, `CircuitBreakerStateError`, `MissingTokenRefreshHandlerError`, `TokenRefreshAbortError`, `TokenRefreshFailedError`, and `TokenRefreshTimeoutError`.

## 📋 Examples

### Basic Usage with Automatic Retries

```typescript
import { createRetryer } from 'axios-retryer';

const retryer = createRetryer({
  retries: 3,
  debug: true // For development only
});

retryer.axiosInstance.get('https://api.example.com/data')
  .then(response => console.log('Data:', response.data))
  .catch(error => console.error('Failed after retries:', error));
```

### Offline Support with Manual Retries

```typescript
import { createRetryer, RETRY_MODES } from 'axios-retryer';
import { createManualRetryPlugin } from 'axios-retryer/plugins/ManualRetryPlugin';

const retryer = createRetryer({
  mode: RETRY_MODES.MANUAL
});
const manualRetry = createManualRetryPlugin();

retryer.use(manualRetry);

// When offline, requests will fail but be stored
async function submitForm(data) {
  try {
    await retryer.axiosInstance.post('/api/submit', data);
    showSuccess('Form submitted successfully');
  } catch (error) {
    showWarning('Form saved for later submission');
    // Store indicator that we have pending submissions
    localStorage.setItem('hasPendingSubmissions', 'true');
  }
}

// When online, retry all pending requests
window.addEventListener('online', async () => {
  if (localStorage.getItem('hasPendingSubmissions') === 'true') {
    try {
      const results = await manualRetry.retryFailedRequests();
      // set results to your stores
      showSuccess('Pending submissions completed');
      localStorage.removeItem('hasPendingSubmissions');
    } catch (error) {
      showError('Failed to submit pending data');
    }
  }
});
```

### Complete Real-world Example

```typescript
import { 
  createRetryer, 
  RETRY_MODES, 
  AXIOS_RETRYER_HTTP_METHODS,
  AXIOS_RETRYER_REQUEST_PRIORITIES 
} from 'axios-retryer';
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';
import { createCircuitBreaker } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import { createRequestDependencyPlugin } from 'axios-retryer/plugins/RequestDependencyPlugin';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import axios from 'axios';

// Create the base axios instance
const baseAxios = axios.create({
  baseURL: 'https://api.example.com',
  timeout: 5000
});

// Create a fully-configured retry manager
const api = createRetryer({
  mode: RETRY_MODES.AUTOMATIC,
  retries: 3,
  debug: process.env.NODE_ENV !== 'production',
  axiosInstance: baseAxios,
  
  // Concurrency settings
  maxConcurrentRequests: 8,
  
  // Status codes and methods to retry
  retryableStatuses: [408, 429, [500, 599] as const],
  retryableMethods: [
    AXIOS_RETRYER_HTTP_METHODS.GET,
    AXIOS_RETRYER_HTTP_METHODS.HEAD,
    AXIOS_RETRYER_HTTP_METHODS.OPTIONS,
    AXIOS_RETRYER_HTTP_METHODS.PUT,
  ]
});

api.use(
  createRequestDependencyPlugin({
    blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
  }),
);

// Add token refresh capabilities
const apiWithTokenRefresh = api.use(
  createTokenRefreshPlugin(
    async (axiosInstance) => {
      const refreshToken = localStorage.getItem('refreshToken');
      const { data } = await axiosInstance.post('/auth/refresh', { refreshToken });
      localStorage.setItem('accessToken', data.accessToken);
      return { token: data.accessToken };
    },
    { tokenPrefix: 'Bearer ' }
  )
);

// Add circuit breaker to prevent overwhelming failing services
api.use(
  createCircuitBreaker({
    failureThreshold: 5,
    openTimeout: 30000,
    halfOpenMax: 2
  })
);

// Add caching for GET requests
api.use(
  createCachePlugin({
    timeToRevalidate: 60000, // 1 minute
    maxItems: 100
  })
);

// Subscribe to events for logging/monitoring
api
  .on('onRetryProcessStarted', () => {
    logEvent('api_retry_started');
  })
  .on('onRetryProcessFinished', () => {
    logEvent('api_retry_finished');
  });

apiWithTokenRefresh.on('onTokenRefreshed', () => {
  logEvent('token_refreshed');
});

// Export API functions with different priorities
export const apiService = {
  fetchCriticalData: () => 
    api.axiosInstance.get('/critical-endpoint', {
      __axiosRetryer: {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL
      }
    }),
    
  fetchUserProfile: (userId) => 
    api.axiosInstance.get(`/users/${userId}`, {
      __axiosRetryer: {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH
      }
    }),
    
  updateUserData: (userId, data) => 
    api.axiosInstance.put(`/users/${userId}`, data, {
      __axiosRetryer: {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH
      }
    }),
    
  fetchRecommendations: () => 
    api.axiosInstance.get('/recommendations', {
      __axiosRetryer: {
        priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW
      }
    }),
    
  logout: () => {
    api.cancelAllRequests(); // Cancel any pending requests
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    return api.axiosInstance.post('/auth/logout');
  }
};
```

## 🔍 Troubleshooting

### 📋 Known Issues

For a comprehensive list of known issues, unexpected behaviors, and workarounds, see **[KNOWN_ISSUES.md](./KNOWN_ISSUES.md)**.

### Common Issues

#### Requests are not being retried
- Check that you're using the `axiosInstance` property from the RetryManager, not your original axios instance
- Verify that the request method is in your `retryableMethods` list (default: GET, HEAD, OPTIONS)
- Ensure the status code is considered retryable in your configuration

#### Queue is getting full
- Increase `maxQueueSize` in your options
- Consider implementing backpressure by temporarily pausing new requests
- Use the `QueueFullError` to detect when the queue is at capacity

#### Memory usage concerns
- If you use `ManualRetryPlugin`, set a reasonable `maxRequestsToStore` to limit how many requests are kept in memory
- Install `DebugSanitizationPlugin` if you need redacted debug logs during troubleshooting

#### Performance issues
- Reduce `maxConcurrentRequests` to prevent overwhelming your backend
- Use the CachingPlugin to avoid redundant requests
- Make sure you have proper priority settings for important requests

#### Timer accumulation issues
- Monitor timer health with `getTimerStats()` and check `timerHealth.healthScore` in metrics
- Use `destroy()` method when done with RetryManager to prevent timer leaks
- If you see high timer counts, check for proper request cancellation
- Consider reducing retry delays if you have many concurrent failing requests

### Debugging Tips

When debugging, enable debug mode for detailed logs:

```typescript
import { createRetryer } from 'axios-retryer';
import { createMetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';

const retryer = createRetryer({ debug: true });
retryer.use(createMetricsPlugin());
```

You can also monitor metrics in real-time once `MetricsPlugin` is installed:

```typescript
retryer.on('onMetricsUpdated', (metrics) => {
  console.log('Current retry metrics:', metrics);
});
```

Monitor timer health during development:

```typescript
// Check timer health periodically
setInterval(() => {
  const stats = retryer.getTimerStats();
  const metrics = retryer.getMetrics();
  console.log(`Timers: ${stats.activeTimers}, Retry timers: ${stats.activeRetryTimers}`);
  console.log(`Health score: ${metrics.timerHealth.healthScore}`);
}, 5000);

// Clean up when your app shuts down
process.on('SIGTERM', () => {
  retryer.destroy();
});
```

## 🔄 Migration Guide

v2 makes the core-vs-plugin boundary explicit and moves some previously implicit behavior behind opt-in plugins.

Start with the dedicated guide:

- **[Migrate from 1.x to 2.0](./MIGRATION.md)**

The most important changes are:

- Core sanitization options moved to `DebugSanitizationPlugin`
- Populated metrics now require `MetricsPlugin`
- Plugin imports are documented on `axios-retryer/plugins` and per-plugin subpaths
- `maxRefreshAttempts` now means the exact number of refresh attempts
- Plugin-specific event typing is attached through `use()` or explicit generics
- The browser bundle is now an optional local build via `npm run build:browser`

## 🔄 Compatibility

axios-retryer is compatible with:

| Environment | Support |
|-------------|---------|
| Node.js     | ✅ Modern Node.js runtimes supported by Axios |
| Browsers    | ✅ Modern browsers supported by Axios |
| React / Vue / Angular | ✅ Works anywhere Axios works |
| React Native | ✅ Supported through Axios-compatible setups |
| TypeScript  | ✅ v4.0+ |

### Bundle Size Impact

Bundle size depends on which entry points you import and how your bundler handles tree-shaking. For practical sizing, check the Bundlephobia badge at the top of this README or the local `stats/` reports generated by `npm run build`.

## 📘 API Reference

### Core Functions
- `createRetryer(options?: RetryManagerOptions)`: Creates a retry manager instance
- `createRetryStrategy(config: RetryStrategyConfig)`: Creates a custom retry strategy

### Plugin Factories
- `createTokenRefreshPlugin(refreshFn, options?)`: Creates a token refresh plugin
- `createCircuitBreaker(options)`: Creates a circuit breaker plugin
- `createCachePlugin(options?)`: Creates a response caching plugin
- `createManualRetryPlugin(options?)`: Creates a manual replay plugin for terminal failures
- `createDebugSanitizationPlugin(options?)`: Creates a redacted debug logging plugin
- `createRequestDependencyPlugin(options)`: Creates a request dependency and queue-gating plugin
- `createMetricsPlugin()`: Creates the optional metrics recorder plugin

### Plugin Methods
- **CachingPlugin**:
  - `clearCache()`: Clears all cached responses
  - `buildCacheKey(config)`: Builds the canonical cache key for an exact-match invalidation target
  - `invalidateCache(matcher)`: Invalidates specific cache entries by exact key, prefix, or `RegExp` across the configured indexed storage backend
  - `getCacheStats()`: Returns statistics about the cache (size, age, etc.)
- **CircuitBreakerPlugin**:
  - `getState()`: Returns the current state of the circuit breaker
  - `getMetrics()`: Returns breaker-wide and per-scope metrics
- **ManualRetryPlugin**:
  - `retryFailedRequests()`: Replays stored failed requests
  - `getStoredRequests()`: Returns a copy of currently stored requests
  - `clearStoredRequests()`: Drops stored requests without replaying them
- **RequestDependencyPlugin**:
  - `isBlockingRequest(config)`: Checks whether a request meets the blocking threshold
  - `getActiveBlockingRequestCount()`: Returns the number of active blocking requests
- **MetricsPlugin**:
  - Install it, then use `retryer.getMetrics()` and `onMetricsUpdated` on the manager

### RetryManager Class

The main class for managing retries with comprehensive timer management:

#### Core Properties
- `axiosInstance`: The wrapped axios instance to use for requests

#### Request Management Methods
- `cancelRequest(requestId: string)`: Cancel a specific request by ID (includes timer cleanup)
- `cancelAllRequests()`: Cancel all ongoing requests and timers

#### Timer Management Methods
- `getTimerStats()`: Get active timer counts for monitoring timer health
  ```typescript
  const stats = retryManager.getTimerStats();
  // Returns: { activeTimers: number, activeRetryTimers: number }
  ```
- `destroy()`: Complete cleanup of all resources, timers, and make the instance unusable
  ```typescript
  retryManager.destroy(); // Cleans up all timers, cancels requests, removes interceptors
  ```

#### Plugin Management
- `use(plugin: RetryPlugin, beforeRetryerInterceptors?: boolean)`: Register a plugin and return the same manager with widened plugin event typings
- `unuse(pluginName: string)`: Unregister a plugin by name
- `listPlugins()`: Get list of registered plugins with their names and versions

#### Event Management
- `on(event: EventName, listener: ListenerForThatEvent)`: Subscribe to an event
- `off(event: EventName, listener: ListenerForThatEvent)`: Unsubscribe from an event

#### Metrics & Monitoring
- `getMetrics()`: Get comprehensive retry statistics including timer health
  Install `MetricsPlugin` if you want populated retry counters instead of the zeroed default snapshot.
  ```typescript
  const metrics = retryManager.getMetrics();
  // Includes new timerHealth object:
  // {
  //   totalRequests: number,
  //   successfulRetries: number,
  //   // ... other metrics
  //   timerHealth: {
  //     activeTimers: number,        // Active internal timers
  //     activeRetryTimers: number,   // Active retry timers
  //     healthScore: number          // 0 = excellent, 100+ = potential issues
  //   }
  // }
  ```

#### Other Methods
- `getLogger()`: Get the internal logger instance for debugging
- `triggerAndEmit(event: EventName, ...args)`: Trigger hooks and emit events programmatically (useful for plugins)

### Events

Subscribe to these events to monitor retry behavior:

- `onRetryProcessStarted`: When retry process begins
- `beforeRetry`: Before each retry attempt
- `afterRetry`: After each retry attempt  
- `onFailure`: When a retry attempt fails
- `onRetryProcessFinished`: When all retries complete
- `onMetricsUpdated`: When metrics are updated (MetricsPlugin)
- `onTokenRefreshed`: When a token is refreshed (TokenRefreshPlugin)
- `onRequestCancelled`: When a request is cancelled
- `onInternetConnectionError`: When a network error occurs
- `onBlockingRequestFailed`: When a blocking request fails (RequestDependencyPlugin)
- `onAllBlockingRequestsResolved`: When all blocking requests complete (RequestDependencyPlugin)
- `onManualRetryProcessStarted`: When manual retry process begins (ManualRetryPlugin)

### Timer Health Monitoring

Monitor timer accumulation and prevent event loop congestion:

```typescript
// Check timer health
const stats = retryManager.getTimerStats();
console.log(`Active timers: ${stats.activeTimers}`);
console.log(`Active retry timers: ${stats.activeRetryTimers}`);

// Monitor via metrics
const metrics = retryManager.getMetrics();
if (metrics.timerHealth.healthScore > 50) {
  console.warn('High timer count detected - consider investigating');
}

// Clean up when done
retryManager.destroy(); // Prevents timer leaks
```

### Performance Notes

The library keeps a few implementation details in place to stay practical under load:

- Priority queue operations are optimized for larger waiting queues
- Timer cleanup is tracked so long-running apps can spot leaks early
- Plugins ship as separate entry points so unused functionality can stay out of the bundle

For complete API documentation, see the [TypeScript definitions](https://github.com/sampleXbro/axios-retryer/blob/main/src/types/index.ts).

## 👥 Community & Contributing

We welcome contributions! Here's how you can help:

- **Report bugs**: Open an issue describing the bug and how to reproduce it
- **Suggest features**: Open an issue describing your idea
- **Submit PRs**: Fork the repo, make changes, and submit a PR
- **Improve docs**: Help improve or translate the documentation
- **Share examples**: Add real-world examples showing how to use the library

For detailed contribution guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## 📄 License

This project is licensed under the MIT License.

---

<p align="center">
  <i>Made with ❤️ by <a href="https://github.com/sampleXbro">sampleX (Serhii Zhabskyi)</a></i>
</p> 
