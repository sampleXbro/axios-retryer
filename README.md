<div align="center">

[![npm version](https://img.shields.io/npm/v/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer)
[![npm downloads](https://img.shields.io/npm/dm/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer)
[![codecov](https://codecov.io/github/sampleXbro/axios-retryer/graph/badge.svg?token=BRQB5DJVLK)](https://codecov.io/github/sampleXbro/axios-retryer)
[![Known Vulnerabilities](https://snyk.io/test/github/sampleXbro/axios-retryer/badge.svg)](https://snyk.io/test/github/sampleXbro/axios-retryer)
![Build](https://github.com/sampleXbro/axios-retryer/actions/workflows/publish.yml/badge.svg)
[![Stress Tested](https://img.shields.io/badge/Stress%20Tested-10K%20Requests-success)](https://github.com/sampleXbro/axios-retryer)
[![Benchmark](https://img.shields.io/badge/Benchmark-1.1min%2F10K%20reqs-blue)](https://github.com/sampleXbro/axios-retryer/benchmark)

[![install size](https://img.shields.io/badge/dynamic/json?url=https://packagephobia.com/v2/api.json?p=axios-retryer&query=$.install.pretty&label=install%20size&style=flat-square)](https://packagephobia.now.sh/result?p=axios-retryer)
[![Gzipped Size](https://img.shields.io/bundlephobia/minzip/axios-retryer)](https://bundlephobia.com/package/axios-retryer)

</div>

# axios-retryer

A powerful library that enables automatic **or** manual retries for Axios requests with rich configuration, concurrency controls, priority-based queuing, hooks, and custom strategies. Perfect for handling intermittent network issues or flaky endpoints without rewriting all your Axios logic.

## Live Demo

[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/sandbox/axios-retryer-demo-fppdc4)


## Table of Contents

1. [Installation](#installation)
2. [Features](#features)
3. [Comparison with Other Libraries](#comparison-with-other-libraries)
4. [Quick Example](#quick-example)
5. [Usage](#usage)
  1. [Creating a RetryManager](#creating-a-retrymanager)
  2. [Automatic vs. Manual Mode](#automatic-vs-manual-mode)
  3. [Retry Strategies](#retry-strategies)
  4. [Hooks (Lifecycle Events)](#lifecycle-events)
  5. [Canceling Requests](#canceling-requests)
  6. [Concurrency & Priority](#concurrency--priority)
  7. [Plugins](#plugins)
  8. [Debug Mode](#debug-mode)
6. [API Reference](#api-reference)
7. [Examples](#examples)
  1. [Automatic Retries with Default Strategy](#1-automatic-retries-with-default-strategy)
  2. [Manual Mode: Queue & Retry Later](#2-manual-mode-queue--retry-later)
  3. [Priority & Concurrency Example](#3-priority--concurrency-example)
8. [Contributing](#contributing)
9. [License](#license)

## Installation

```bash
npm install axios-retryer
```

Or:

```bash
yarn add axios-retryer
```

## Features

- **Automatic or Manual Retry Modes**: Configure 'automatic' to retry network/server errors based on a retry strategy, or 'manual' to queue failed requests and retry them later.
- **Advanced Concurrency & Priority**: Limit concurrent requests with maxConcurrentRequests and manage them via a priority-based queue. Higher-priority requests can block lower-priority ones using blockingQueueThreshold.
- **Configurable Retry Logic**: Provide your own RetryStrategy (e.g., exponential or custom backoff) or use the built-in defaults.
- **Request Store**: Failed requests are stored in an in-memory RequestStore by default (or use your own). This makes it easy to retry manually.
- **Hooks and Events**: Tie into each stage (before retry, after retry, failure, all retries completed) for fine-grained control.
- **Plugin System**: Extend or modify behavior via simple plugin objects that can implement any of the lifecycle hooks.
- **Cancellation**: Cancel individual requests or all ongoing requests at once, leveraging AbortController.
- **Metrics**: Track total requests, failed retries, successful retries, cancellations, etc.
- **Debug Logging**: Optionally enable debug mode for detailed logs about the retry process.
- **TypeScript Support**: All types are included out of the box.

## Comparison with Other Libraries

| Feature                         | axios-retryer                                                                          | axios-retry                     | retry-axios                    |
|---------------------------------|----------------------------------------------------------------------------------------|---------------------------------|--------------------------------|
| Automatic & Manual Modes        | ✅ Either auto-retry or manually queue & retry (retryFailedRequests()).                 | ❌Automatic only.                | ❌Automatic only.               |
| Concurrency Control             | ✅ maxConcurrentRequests + a priority-based queue.                                      | ❌No concurrency management.     | ❌No concurrency management.    |
| Priority-Based Request Handling | ✅ (CRITICAL, HIGHEST, HIGH, MEDIUM, LOW) with a blockingQueueThreshold.                | ❌Not supported.                 | ❌Not supported.                |
| Customizable Retry Strategy     | ✅ Provide a custom class implementing RetryStrategy.                                   | ❌Some built-in config.          | ❌Some built-in config.         |
| Request Store / Manual Retry    | ✅ Store failed requests in memory (or custom) and retry later.                         | ❌No.                            | ❌No.                           |
| Hooks & Events & Plugin System  | ✅ Lifecycle hooks and events (beforeRetry, afterRetry, etc.) plus plugin architecture. | ❌Limited or no hooks or events. | ❌Limited or no hooks or evens. |
| Cancellation                    | ✅ Use cancelRequest/cancelAllRequests, internally uses AbortController.                | ❌Minimal or no direct support.  | ❌Minimal or no direct support. |
| Detailed Metrics & Debugging    | ✅ Built-in metrics and optional debug logging.                                         | ✅Basic logging.                 | ✅Basic logging.                |
| TypeScript Support              | ✅ Strong typings for hooks, config, strategies, etc.                                   | ✅Basic typings.                 | ✅Basic typings.                |

## Quick Example

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  mode: 'automatic',
  retries: 3,
  debug: false, // Enable if you want verbose logs
});

manager.axiosInstance.get('https://jsonplaceholder.typicode.com/posts')
  .then((response) => {
    console.log('Received data:', response.data);
  })
  .catch((error) => {
    console.error('Request failed after all retries:', error);
  });
```

## Usage

### Creating a RetryManager

```typescript
import { RetryManager, RETRY_MODES, AXIOS_RETRYER_BACKOFF_TYPES, AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';

const retryManager = new RetryManager({
  mode: RETRY_MODES.AUTOMATIC, // default = RETRY_MODES.AUTOMATIC
  retries: 2, // default = 3
  throwErrorOnFailedRetries: true, // default = true
  throwErrorOnCancelRequest: true, // default = true
  debug: false, // default = false

  // Concurrency & Queue
  maxConcurrentRequests: 5, // default = 5
  queueDelay: 100, // default = 100
  blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST, // default = not set
  maxRequestsToStore: 100, // default = 200

  // Retry strategy config
  retryableStatuses: [408, [500, 599]], // default = [408, 429, 500, 502, 503, 504]
  retryableMethods: ['get', 'head', 'options'], // default = ['get', 'head', 'options']
  backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL, // default = AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL
});
```

#### Important Options
- `mode ('automatic' | 'manual')`: How the manager handles retries by default.
- `retries (number)`: Maximum number of auto-retries.
- `maxConcurrentRequests (number)`: Limits concurrent requests; others are queued.
- `queueDelay (number)`: A small delay before dequeuing requests (in ms).
- `blockingQueueThreshold (AxiosRetryerRequestPriority)`: Priority threshold above which lower-priority requests are blocked.
- `throwErrorOnFailedRetries`: Whether to throw an error after all retries fail (default true).
- `throwErrorOnCancelRequest`: Whether to throw an error if a request is canceled (default true).
- `debug`: Enable to get verbose logs.
- `retryableStatuses`, `retryableMethods`, `backoffType`: Configure how/when requests should retry.
- `hooks`: Lifecycle hooks 

You can pass your own AxiosInstance if you want to share interceptors or custom config:

```typescript
import axios from 'axios';

const customAxios = axios.create({ baseURL: 'https://api.example.com' });

const manager = new RetryManager({
  mode: 'automatic',
  axiosInstance: customAxios,
  // ...
});
```

### Automatic vs. Manual Mode

#### Automatic Mode
- Retries happen automatically based on the retryStrategy logic (default or custom).
- Once retries are exhausted for a request, it is stored in the RequestStore.
- You can still manually retry them later if you want (e.g., `manager.retryFailedRequests()`).

#### Manual Mode
- Each request is attempted only once initially.
- Any failed request is stored in the RequestStore.
- You can call `manager.retryFailedRequests()` to bulk-retry them at a later time (useful for offline scenarios or user-driven retrigger).

### Retry Strategies

By default, axios-retryer uses a DefaultRetryStrategy that treats network errors, 408, 429, and 5xx status codes as retryable, plus an exponential backoff.

You can implement the RetryStrategy interface to customize when or how to retry:

```typescript
import type { AxiosError } from 'axios';
import { RetryStrategy } from 'axios-retryer';

export class CustomRetryStrategy implements RetryStrategy {
  getIsRetryable(error: AxiosError): boolean {
    // Only retry 5xx errors or no response (network error)
    const status = error.response?.status;
    const isServerError = status && status >= 500 && status < 600;
    return !error.response || isServerError;
  }

  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
    return this.getIsRetryable(error) && attempt <= maxRetries;
  }

  getDelay(attempt: number): number {
    // Simple linear backoff (1s, 2s, etc.)
    return attempt * 1000;
  }
}
```

Use it like:

```typescript
const manager = new RetryManager({
  mode: 'automatic',
  retries: 3,
  retryStrategy: new CustomRetryStrategy(),
});
```

### Lifecycle Events

The RetryManager provides a lightweight event system that allows you to subscribe to and unsubscribe from various 
hooks (events) tied to the retry lifecycle. This lets you monitor or modify behavior at runtime without needing to rely 
solely on constructor-time callbacks or configuration options.

#### Available Events

These events correspond to the hooks in RetryHooks:
-	`onRetryProcessStarted` - Triggered when the retry process begins.
-	`beforeRetry` - Triggered before each retry attempt. Receives (config: AxiosRequestConfig).
-	`afterRetry` - Triggered after a retry attempt. Receives (config: AxiosRequestConfig, success: boolean).
-	`onFailure` - Triggered for each failed retry attempt. Receives (config: AxiosRequestConfig).
-	`onRetryProcessFinished` - Triggered when all retries are completed. Receives (metrics: AxiosRetryerMetrics).
-	`onRequestRemovedFromStore` - Triggered when a request is removed from the store due to storage limits. Receives (request: AxiosRequestConfig).
-	`onCriticalRequestFailed` - Triggered when a critical request fails, as defined by blockingQueueThreshold in your RetryManagerOptions.
-	`onRequestCancelled` - Triggered when a request is cancelled. Receives (requestId: string).
- 	`onMetricsUpdated` - Triggered whenever metrics are updated. Receives (metrics: AxiosRetryerMetrics).
- 	`onAllCriticalRequestsResolved` - Triggered when all critical requests resolved.
- 	`onManualRetryProcessStarted` - Triggered when manual retry process begins.

#### Hooks (deprecated, use events instead)

```typescript
const manager = new RetryManager({
  mode: 'automatic',
  hooks: {
    onRetryProcessStarted: () => console.log('Retry process started'),
    beforeRetry: (config) => {
      console.log('Will retry:', config.url);
    },
    afterRetry: (config, success) => {
      console.log(`Retried ${config.url}, Success? ${success}`);
    },
    onFailure: (config) => {
      console.log('Final failure for:', config.url);
    },
    onRequestCancelled: (requestId: string) => {
      console.log('Request is cancelled:', requestId);
    },
    onMetricsUpdated: (metrics) => {
      console.log('Metrics updated. Metrics:', metrics);
    },
    onRetryProcessFinished: (metrics) => {
      console.log('All retry attempts done. Metrics:', metrics);
    },
  },
});
```

#### Events

You can subscribe/unsubscribe to/from any of these events at runtime using the on/off method:

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  retries: 3,
});

// Subscribing to multiple events
manager
  .on('onRetryProcessStarted', () => {
  console.log('Retry process started');
  })
  .on('afterRetry', (config, success) => {
    console.log(`Attempt for ${config.url}: success? ${success}`);
  })
  .on('onRetryProcessFinished', (metrics) => {
    console.log('Retry process finished with metrics:', metrics);
  });

const handler = (config, success) => {
  console.log('No longer interested in afterRetry');
};

// Subscribe
manager.on('afterRetry', handler);

// Unsubscribe
manager.off('afterRetry', handler);
```
Because each event has its own parameters, TypeScript will correctly infer the signature based on the event string. 
For example, `onFailure` expects `(config: AxiosRequestConfig)`, while `afterRetry` expects `(config: AxiosRequestConfig, success: boolean)`.

#### Why Use the Event System?
-	Observability: You can log, measure, or alert based on retry successes/failures without injecting logic all over your codebase.
-	Extensibility: Create plugins or extensions that hook into these events to modify behavior (e.g., dynamic backoff).
-	Simplicity: It’s more intuitive than hooking into low-level interceptors or custom code, especially for cross-cutting concerns like metrics.

### Canceling Requests

Each request has a unique `__requestId`. You can cancel in-flight requests individually:

```typescript
manager.cancelRequest('my-request-id');
```

Or you can cancel all ongoing requests:

```typescript
manager.cancelAllRequests();
```

In both cases, aborted requests are counted as canceled in the built-in metrics.

### Concurrency & Priority

axios-retryer supports concurrency control (`maxConcurrentRequests`) and a priority-based queue.

- `maxConcurrentRequests`: The maximum number of requests processed at once.
- `blockingQueueThreshold`: If set, any request with priority >= threshold will block lower-priority requests until it finishes.

Priority constants:
- `AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL = 4`
- `AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST = 3`
- `AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH = 2`
- `AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM = 1`
- `AXIOS_RETRYER_REQUEST_PRIORITIES.LOW = 0`

To assign a priority, simply include `__priority` in your request config:

```typescript
manager.axiosInstance.get('/some-url', {
  __priority: 3, // 'HIGHEST'
});
```

### Plugins

Plugins let you extend axios-retryer without modifying core code. A plugin is an object (or a class that implements RetryPlugin interface) with:

```typescript
{
  name: string;
  version: string;
  initialize: (manager: RetryManager) => {};
  onBeforeDestroyed: (manager: RetryManager) => {};
  hooks: RetryHooks;
}
```

- `name` is the plugin name.
- `version` is the plugin version.
- `initialize` is called when the plugin is registered, giving you access to the RetryManager.
- `onBeforeDestroyed` (optional) is called before the plugin is unregistered (unuse), giving you access to the RetryManager.
- `hooks` (optional) can implement any of the same lifecycle hooks as the manager's hooks object.

Example:

```typescript
export class OfflineRetryPlugin implements RetryPlugin {
  name = 'OfflineRetryPlugin';
  version = '1.0.0';

  private async handleOnline(manager: RetryManager) {
    //
  }

  initialize = (manager: RetryManager): void => {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', this.handleOnline.bind(this, manager));
    }
  };

  onBeforeDestroyed(manager: RetryManager) {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('online', this.handleOnline.bind(this, manager));
    }
  }
}

// Add the plugin
manager.use(new OfflineRetryPlugin);
// Remove the plugin (if needed)
manager.unuse('OfflineRetryPlugin');
```

### Out Of The Box Plugins

### TokenRefreshPlugin

The TokenRefreshPlugin is an extension for the Axios-Retryer library, designed to handle automatic token refresh when a request fails due to authentication issues (e.g., HTTP 401 Unauthorized responses). It intercepts failed requests, attempts to refresh the authentication token, and retries any pending requests once a new token is obtained.

Features:
•	Automatic Token Refresh: Detects expired tokens and attempts to refresh them before retrying requests.
•	Configurable Behavior: Supports customizable refresh logic, retry limits, and authentication headers.
•	Queueing Mechanism: Queues failed requests while refreshing the token to prevent multiple refresh attempts.
•	Timeout Handling: Enforces a maximum wait time for token refresh attempts.
•	Error Management: Clears queued requests and emits events if the refresh process fails.

This plugin is useful for applications that rely on token-based authentication, ensuring seamless user experience and uninterrupted API communication.

```typescript
import { TokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin'

manager.use(
  new TokenRefreshPlugin(
    async (axiosInstance) => {
      const refreshToken = lStorage.getParsedFromStorage(LOCAL_STORE_REFRESH_TOKEN);
      const { data } = await axiosInstance.post('/refresh-token', { refreshToken });
      return { token: data.AccessToken };
    },
    {
      authHeaderName: 'Authorization', //default value, optional
      refreshStatusCodes: [401], //default value, optional
      refreshTimeout: 15_000, //default value, optional
      retryOnRefreshFail: true, //default value, optional
      tokenPrefix: 'Bearer ', //default value, optional
      maxRefreshAttempts: 3, //default value, optional
    },
  ),
);
```
### CircuitBreakerPlugin

The **CircuitBreakerPlugin** is an extension for the **Axios-Retryer** library that provides a **fail-fast** mechanism to prevent excessive retries when a service is down. By monitoring consecutive failures, it dynamically transitions between states (`CLOSED`, `OPEN`, `HALF_OPEN`) to block requests, test for recovery, and restore normal operation when the service is healthy.

#### Features
- **Fail-Fast Behavior**: Automatically "trips" the circuit (moves to `OPEN` state) after a configurable number of consecutive failures, preventing unnecessary retries and reducing system strain.
- **State Management**: Implements `CLOSED`, `OPEN`, and `HALF_OPEN` states to intelligently manage API request flow based on failure trends.
- **Recovery Testing**: After a cooldown (`openTimeout`) period, it allows a limited number of test requests (`halfOpenMax`) in the `HALF_OPEN` state before deciding whether to reset or re-trip.
- **Configurable Failure Threshold**: Allows customization of the `failureThreshold` to define how many consecutive failures should cause the circuit to trip.
- **Resource Protection**: Prevents retry storms, helping maintain service stability when a backend is experiencing issues.

This plugin is particularly useful in distributed systems, microservices architectures, and scenarios where excessive failed requests could impact system performance and availability.

#### Usage Example
```typescript
import { CircuitBreakerPlugin } from 'axios-retryer/plugins/CircuitBreakerPlugin'

manager.use(
  new CircuitBreakerPlugin({
    failureThreshold: 5,   // Trip circuit after 5 consecutive failures
    openTimeout: 30_000,   // Remain open for 30s before allowing half-open test
    halfOpenMax: 1,        // Allow 1 test request in half-open state
  }),
);
```

By integrating this plugin, your application can avoid unnecessary retries during outages and improve overall resilience by dynamically adjusting request behavior based on service availability.

### CachingPlugin

The **CachingPlugin** is an extension for Axios‑Retryer that caches successful responses (by default, GET requests) to avoid sending identical requests repeatedly. It generates a unique cache key from the request’s method, URL, parameters, and (optionally) headers. Cached responses are returned immediately if they’re still fresh, based on a configurable time-to-revalidate (TTL). Additional options allow for periodic cleanup of stale entries and limiting the cache size.

#### Features:
•	Response Caching: Returns cached responses for identical requests.
•	Time-to-Revalidate: Only uses cached data if it’s younger than the specified TTL.
•	Periodic Cleanup & Size Limit: Automatically removes stale or excessive cache entries.
•	Selective Caching: Optionally cache only retried requests.

#### Configuration Options:
•	compareHeaders (boolean, default: false): Include headers in the cache key.
•	timeToRevalidate (number, default: 0): TTL for cache freshness (0 means never expires).
•	cacheMethods (string[], default: `[‘GET’]`): HTTP methods to cache.
•	cleanupInterval (number, default: 0): How often (ms) to run cache cleanup.
•	maxAge (number, default: 0): Maximum age (ms) for cached items.
•	maxItems (number, default: 1000): Maximum number of cached responses.
•	cacheOnlyRetriedRequests (boolean, default: false): Cache only requests that were retried.

```typescript
import { RetryManager } from 'axios-retryer';
import { CachingPlugin } from 'axios-retryer/plugins/CachingPlugin';

const retryManager = new RetryManager({
  axiosInstance: yourAxiosInstance,
  // other RetryManager options...
});

// Cache GET responses for 60 seconds; clean up every 30 seconds.
const cachingPlugin = new CachingPlugin({
  compareHeaders: false,
  timeToRevalidate: 60000, // cache responses for 60 seconds
  cacheMethods: ['GET'],
  cleanupInterval: 30000,   // run cleanup every 30 seconds
  maxAge: 120000,           // remove entries older than 2 minutes
  maxItems: 100,            // store up to 100 responses
  cacheOnlyRetriedRequests: false,
});

retryManager.use(cachingPlugin);

// Identical GET requests within 60s will return the cached response.
```

You can list attached plugins with `manager.listPlugins()`.

### Debug Mode

Set `debug: true` in your RetryManagerOptions to enable verbose logging:

```typescript
const manager = new RetryManager({
  mode: 'automatic',
  retries: 2,
  debug: true,
});
```

## API Reference

### class RetryManager
- Constructor: `new RetryManager(options: RetryManagerOptions)`
- `axiosInstance`: Returns the wrapped Axios instance.
- `retryFailedRequests()`: Manually retry all requests stored as failed.
- `cancelRequest(requestId: string)`: Cancel a specific ongoing request.
- `cancelAllRequests()`: Cancel all ongoing requests.
- `use(plugin: RetryPlugin)`: Register a plugin.
- `on(event, listener)`: Subscribe for an event with a listener.
- `off(event, listener)`: Unsubscribe from an event.
- `listPlugins()`: Retrieve a list of registered plugins.
- `getMetrics()`: Returns `{ totalRequests, successfulRetries, failedRetries, completelyFailedRequests, canceledRequests }`.

### interface RetryManagerOptions
- `throwErrorOnCancelRequest? (boolean)`
- `debug? (boolean)`
- `retryableStatuses? ((number | [number, number])[])`
- `retryableMethods? (string[])`
- `backoffType? (AxiosRetryerBackoffType)`
- `maxRequestsToStore? (number)`
- `maxConcurrentRequests? (number)`
- `queueDelay? (number)`
- `blockingQueueThreshold? (AxiosRetryerRequestPriority)`
- `hooks?  (RetryHooks)`

### interface RetryStrategy
- `getIsRetryable(error: AxiosError): boolean`
- `shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean`
- `getDelay(attempt: number, maxRetries: number): number`

### interface RetryHooks
- `onRetryProcessStarted?(): void`
- `beforeRetry?(config: AxiosRequestConfig): void`
- `afterRetry?(config: AxiosRequestConfig, success: boolean): void`
- `onFailure?(config: AxiosRequestConfig): void`
- `onRetryProcessFinished?(metrics: AxiosRetryerMetrics): void`
- `onCriticalRequestFailed?(): void`
- `onRequestRemovedFromStore?(request: AxiosRequestConfig): void`

## Examples

### 1. Automatic Retries with Default Strategy

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  mode: 'automatic',
  retries: 3,
});

manager.axiosInstance.get('https://httpbin.org/status/500')
  .then(response => console.log('Success:', response.data))
  .catch(error => console.error('Request failed after 3 retries:', error));
```

### 2. Manual Mode: Queue & Retry Later

```typescript
import { RetryManager, RETRY_MODES } from 'axios-retryer';

const manager = new RetryManager({
  mode: RETRY_MODES.MANUAL,
  retries: 2,
});

// Initial request fails, then we'll retry later
manager.axiosInstance.get('https://httpbin.org/status/500')
  .catch(error => {
    console.error('Initial request failed:', error);
  });

// At some point in the future...
manager.retryFailedRequests().then((responses) => {
  console.log('Retried responses:', responses);
  //set responses to the store
}).catch(err => {
  console.error('Error retrying failed requests:', err);
});
```

### 3. Priority & Concurrency Example

```typescript
import { RetryManager, AXIOS_RETRYER_REQUEST_PRIORITIES } from 'axios-retryer';

const manager = new RetryManager({
  mode: 'automatic',
  maxConcurrentRequests: 2,
  blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST,
  debug: true,
});

const axiosInstance = manager.axiosInstance;

// High priority
axiosInstance({
  url: 'https://example.com/api/high',
  method: 'GET',
  __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST,
})
  .then(() => console.log('High priority request succeeded'))
  .catch(() => console.log('High priority request failed'));

// Low priority
axiosInstance({
  url: 'https://example.com/api/low',
  method: 'GET',
  __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
})
  .then(() => console.log('Low priority request succeeded'))
  .catch(() => console.log('Low priority request failed'));
```

## Contributing

Contributions, issues, and feature requests are welcome! Please see the [Contributing](./CONTRIBUTING.md) guidelines for more details. Feel free to open issues if you have questions or suggestions.

## License

This project is licensed under the MIT License.

Enjoy more reliable Axios requests with axios-retryer!