<div align="center">
  <img src="assets/axios-retryer-logo.png" alt="axios-retryer logo" />
  <h1>axios-retryer</h1>
  <p><strong>Smart and Reliable Retry Management for Axios</strong></p>
  
  [![npm version](https://img.shields.io/npm/v/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer?target=_blank)
  [![npm downloads](https://img.shields.io/npm/dm/axios-retryer.svg)](https://www.npmjs.com/package/axios-retryer?target=_blank)
  [![codecov](https://codecov.io/github/sampleXbro/axios-retryer/graph/badge.svg?token=BRQB5DJVLK)](https://codecov.io/github/sampleXbro/axios-retryer?target=_blank)
  [![Known Vulnerabilities](https://snyk.io/test/github/sampleXbro/axios-retryer/badge.svg)](https://snyk.io/test/github/sampleXbro/axios-retryer?target=_blank)
  ![Build](https://github.com/sampleXbro/axios-retryer/actions/workflows/publish.yml/badge.svg?target=_blank)
  [![Gzipped Size](https://img.shields.io/bundlephobia/minzip/axios-retryer)](https://bundlephobia.com/package/axios-retryer?target=_blank)
  
  <!-- Performance & Reliability Badges -->
  ![Performance](https://img.shields.io/badge/Performance-232%20req%2Fsec-brightgreen)
  ![Stress Tested](https://img.shields.io/badge/Stress%20Tested-15K%2B%20requests-success)
  ![Memory Safe](https://img.shields.io/badge/Memory-Zero%20Leaks-brightgreen)
</div>

<hr />

<p align="center">
  <b>A powerful retry management system for Axios with prioritization, concurrency control, and extensible plugins.</b>
</p>

<p align="center">
  <a href="#-installation">Installation</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-key-features">Features</a> •
  <a href="#-plugins">Plugins</a> •
  <a href="#-examples">Examples</a> •
  <a href="#-api-reference">API</a>
</p>

## 🤔 Why axios-retryer?

When developing applications that communicate with APIs, you'll inevitably face these challenges:

- **Reliability**: APIs can fail intermittently due to network issues or service problems
- **Authentication**: Token expiration requires refresh flows and request reprocessing
- **Performance**: Sending too many concurrent requests can overload servers
- **Debugging**: Understanding what happened when requests fail is difficult

**axios-retryer** solves these problems with a powerful yet easy-to-use API that hooks directly into axios. Unlike other solutions that just retry on failure, axios-retryer provides:

- 🔄 **Intelligent retries** with customizable strategies
- 🔑 **Built-in token refresh** handling
- 🚦 **Request prioritization** and traffic control
- 📊 **Detailed metrics** for monitoring and debugging
- 🧩 **Plugin architecture** for extending functionality

It's the complete solution for making your API communication robust, efficient, and maintainable.

## 📊 Comparison with Other Libraries

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
| Bundle Size                     | ✅ 6.4KB minzipped (with all plugins)                | ✅ ~2KB minzipped               | ✅ ~2KB minzipped              |
| Token Refresh                   | ✅ Built-in plugin                                   | ❌ Manual implementation        | ❌ Manual implementation       |
| Circuit Breaking                | ✅ Built-in plugin                                   | ❌ No                           | ❌ No                          |
| Request Caching                 | ✅ Built-in plugin                                   | ❌ No                           | ❌ No                          |
| TypeScript Support              | ✅ Full types                                        | ⚠️ Basic                       | ⚠️ Basic                      |
| Observability                   | ✅ Rich metrics and events                           | ❌ Minimal                      | ❌ Minimal                     |
| Multiple Backoff Strategies     | ✅ Linear, exponential, decorrelated jitter, custom  | ⚠️ Limited options             | ⚠️ Limited options            |

## 📦 Installation

```bash
# Using npm
npm install axios-retryer

# Using yarn
yarn add axios-retryer

# Using pnpm
pnpm add axios-retryer
```

## ⚡ Quick Start

```typescript
// Import the library
import { createRetryer } from 'axios-retryer';

// Create a retry manager with sensible defaults
const retryer = createRetryer({
  retries: 3,
  debug: false
});

// Use it just like regular axios!
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

<details>
<summary>📑 <b>Detailed Table of Contents</b></summary>

- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Key Features](#-key-features)
- [Class-based vs Functional API](#-class-based-vs-functional-api)
- [Configuration Options](#-configuration-options)
- [Automatic vs Manual Mode](#-automatic-vs-manual-mode)
- [Events & Hooks](#-events--hooks)
- [Plugins](#-plugins)
  - [TokenRefreshPlugin](#tokenrefreshplugin)
  - [CircuitBreakerPlugin](#circuitbreakerplugin)
  - [CachingPlugin](#cachingplugin)
- [Bundle Size Optimization](#-bundle-size-optimization)
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
- [Migration Guide](#-migration-guide)
- [Compatibility](#-compatibility)
- [Contributing](#-contributing)
- [License](#-license)

</details>

## 🔑 Key Features

- **Dual Retry Modes**: Choose between automatic retries based on error types or manual queue-and-retry.
- **Priority Queue**: Assign different priorities (CRITICAL to LOW) to ensure important requests go first.
- **Concurrency Control**: Limit the number of concurrent requests to prevent overwhelming servers.
- **Rich Event System**: Subscribe to lifecycle events for monitoring and customization.
- **Plugin Architecture**: Extend functionality with plugins like token refresh, circuit breaking, and caching.
- **Queue Size Limits**: Prevent memory issues during high traffic with configurable queue limits.
- **Sensitive Data Protection**: Automatically redact tokens and passwords in logs and storage.
- **Cancellation Support**: Cancel individual requests or all ongoing requests at once.
- **Comprehensive Metrics**: Track detailed statistics about retry attempts and outcomes.
- **Debug Mode**: Get detailed logs about the retry process when needed.
- **Tree-Shakable**: Only include what you need for optimal bundle size.

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
  isRetryable: (error) => error.response?.status >= 500,
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
  AXIOS_RETRYER_BACKOFF_TYPES,
  AXIOS_RETRYER_REQUEST_PRIORITIES 
} from 'axios-retryer';

const retryer = createRetryer({
  // Core settings
  mode: RETRY_MODES.AUTOMATIC,              // 'automatic' or 'manual'
  retries: 3,                               // Maximum retry attempts
  debug: false,                             // Enable detailed logging
  
  // Concurrency settings
  maxConcurrentRequests: 5,                 // Limit parallel requests
  queueDelay: 100,                          // ms delay between dequeued requests
  blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, // Priority threshold
  maxRequestsToStore: 100,                  // Max requests in memory store
  
  // Retry behavior
  retryableStatuses: [408, 429, [500, 599]], // Status codes to retry
  retryableMethods: ['get', 'head', 'options'], // Methods to retry
  backoffType: AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL, // Delay type
  
  // Security
  enableSanitization: true,                 // Redact sensitive data
  
  // Error handling
  throwErrorOnFailedRetries: true,          // Throw after all retries fail
  throwErrorOnCancelRequest: true           // Throw when requests are canceled
});
```

## 🔄 Automatic vs Manual Mode

### Automatic Mode (Default)

Requests are automatically retried based on the retry strategy:

```typescript
const retryer = createRetryer({ mode: 'automatic', retries: 3 });

// Will automatically retry up to 3 times on failure
retryer.axiosInstance.get('/api/data');
```

### Manual Mode

Failed requests are stored for manual retry later:

```typescript
const retryer = createRetryer({ mode: 'manual' });

// Initial request - no automatic retries
retryer.axiosInstance.get('/api/data')
  .catch(() => console.log('Request failed'));

// Later - perhaps when back online or after user action
retryer.retryFailedRequests()
  .then(responses => console.log('Retried successfully:', responses));
```

## 🔔 Events

Subscribe to events to monitor and react to the retry process:

```typescript
const retryer = createRetryer();

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
  .on('onRetryProcessFinished', (metrics) => {
    console.log('All retries completed, metrics:', metrics);
  })
  .on('onMetricsUpdated', (metrics) => {
    updateDashboard(metrics); // Update UI with latest metrics
  });

// Unsubscribe when needed
const handler = () => console.log('Retry finished');
retryer.on('onRetryProcessFinished', handler);
retryer.off('onRetryProcessFinished', handler);
```

## 🧩 Plugins

Extend functionality with the plugin system:

```typescript
import { createRetryer } from 'axios-retryer';
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
    cacheMethods: ['GET'],     // HTTP methods to cache
    cleanupInterval: 300000,   // Cleanup every 5 minutes
    maxItems: 100,             // Maximum cache entries
    compareHeaders: false,     // Whether to include headers in cache key
    cacheOnlyRetriedRequests: false // Whether to cache only retry attempts
  })
);
```

### TokenRefreshPlugin

Automatically refreshes authentication tokens when requests fail with 401:

```typescript
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';

retryer.use(
  createTokenRefreshPlugin(
    // Function that performs the refresh
    async (axiosInstance) => {
      const refreshToken = localStorage.getItem('refreshToken');
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
        // For GraphQL and APIs that return errors in success responses
        return response?.errors?.some(err => 
          err.extensions?.code === 'UNAUTHENTICATED' || 
          err.message?.includes('token expired')
        );
      }
    }
  )
);
```

The `customErrorDetector` option allows detecting authentication errors in responses with 200 status codes, which is common in GraphQL APIs and some REST APIs that return errors in the response body rather than through HTTP status codes.

### CircuitBreakerPlugin

Prevents overwhelming failing services by temporarily blocking requests:

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

Caches responses to reduce network traffic and improve performance:

```typescript
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';

const cachePlugin = createCachePlugin({
  timeToRevalidate: 60000,   // Cache lifetime in ms (1 minute)
  cacheMethods: ['GET'],     // HTTP methods to cache
  cleanupInterval: 300000,   // Cleanup every 5 minutes
  maxItems: 100,             // Maximum cache entries
  compareHeaders: false,     // Whether to include headers in cache key
  cacheOnlyRetriedRequests: false // Whether to cache only retry attempts
});

// Register the plugin
retryer.use(cachePlugin);

// Later, you can:

// 1. Invalidate specific cache entries by key pattern
cachePlugin.invalidateCache('/api/users');  // Invalidates exact or partial matches

// 2. Clear the entire cache
cachePlugin.clearCache();

// 3. Get cache statistics
const stats = cachePlugin.getCacheStats();
console.log(`Cache size: ${stats.size}, Average age: ${stats.averageAge}ms`);
```

#### Per-Request Cache Configuration

You can override global caching settings on a per-request basis:

```typescript
// Force cache a request that would normally not be cached
axiosInstance.post('/api/items', data, {
  __cachingOptions: {
    cache: true, // Override global settings to force caching
    ttr: 30000   // Custom 30-second TTR for this request
  }
});

// Disable caching for a specific request
axiosInstance.get('/api/time-sensitive-data', {
  __cachingOptions: {
    cache: false // Skip caching for this request
  }
});

// Set a custom TTR while using default caching rules
axiosInstance.get('/api/semi-static-data', {
  __cachingOptions: {
    ttr: 300000 // This request's cache will live for 5 minutes
  }
});
```

The CachingPlugin provides smart cache invalidation:

- **Precise Invalidation**: Invalidate specific cache entries by exact key or pattern
- **Bulk Invalidation**: Clear multiple related cache entries at once
- **Cache Statistics**: Monitor cache size and performance
- **Per-Request Control**: Override global cache settings for individual requests

This plugin is particularly useful for:
- Caching frequently accessed, rarely changed data
- Improving perceived performance in user interfaces
- Reducing server load and network traffic
- Working offline with previously cached data

## 📦 Bundle Size Optimization

Axios-Retryer is designed with bundle size efficiency in mind:

- **Tree-Shaking Support**: The library supports modern tree-shaking techniques, allowing bundlers to eliminate unused code from your final bundle.

- **Modular Plugin System**: Plugins are imported separately from the core library, ensuring you only pay for what you use:

```typescript
// Core functionality only
import { RetryManager } from 'axios-retryer';

// Import a plugin only when needed
import { TokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { CircuitBreakerPlugin } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import { CachingPlugin } from 'axios-retryer/plugins/CachingPlugin';
```

- **Bundle Analysis**: Curious about bundle size impact? Check the analysis:
  - Core library (gzipped): ~8KB
  - Each plugin adds 2-7KB gzipped
  
- **Bundle Options**:
  - **ES Modules**: Best for modern applications with bundlers (Webpack, Rollup, etc.)
  - **CommonJS**: For Node.js environments and older applications
  - **UMD Browser Bundle**: Pre-built with all features for direct browser use
  
When building for production, ensure your bundler (like Webpack or Rollup) is configured to use the ES modules version for optimal tree-shaking.

## 🌐 Environment Support

Axios-retryer works seamlessly in both Node.js and browser environments:

### Node.js Support

- **Full compatibility** with all Node.js versions that support Axios
- **CommonJS format** for traditional Node.js applications
- **ESM format** for Node.js with ES modules support
- **Optimized server handling** of retries, concurrency, and priorities
- **Seamless integration** with Node.js HTTP clients and server-side rendering frameworks

### Browser Support

- **Modern browsers** fully supported (Chrome, Firefox, Safari, Edge)
- **UMD bundle** available for direct browser usage via CDN or script tag
- **ESM bundle** for modern bundlers and browsers with ES module support
- **Respects browser constraints** like connection limits and concurrent requests
- **Works with service workers** and offline-first applications

### Hybrid Applications

For applications that run in both Node.js and browser (like SSR frameworks):
- **Environment detection** to optimize for each platform
- **Consistent API** across environments
- **Safe usage** with isomorphic applications

## 🔬 Advanced Topics

### Plugin Management Best Practices

To get the most out of the plugin system and avoid common pitfalls:

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

const retryer = createRetryer({
  maxConcurrentRequests: 3,
  blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH
});

// Critical auth request (blocks lower priority requests)
retryer.axiosInstance.post('/auth/login', credentials, {
  __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL // 4
});

// Important user data (blocks medium/low priority)
retryer.axiosInstance.get('/api/user-profile', {
  __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH // 2
});

// Background analytics (processed last)
retryer.axiosInstance.post('/api/analytics', eventData, {
  __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW // 0
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

Protect sensitive information in logs and error reporting:

```typescript
const retryer = createRetryer({
  enableSanitization: true,
  sanitizeOptions: {
    // Add custom sensitive headers to redact
    sensitiveHeaders: ['X-API-Key', 'Session-Token'],
    
    // Add custom sensitive fields to redact in bodies
    sensitiveFields: ['password', 'creditCard', 'ssn'],
    
    // Change the redaction character
    redactionChar: '#',
    
    // Control what gets sanitized
    sanitizeRequestData: true,
    sanitizeResponseData: true,
    sanitizeUrlParams: true,
  }
});
```

### Handling Queue Overflow

Manage high traffic scenarios:

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

const retryer = createRetryer({
  mode: RETRY_MODES.MANUAL
});

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
      const results = await retryer.retryFailedRequests();
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
  AXIOS_RETRYER_REQUEST_PRIORITIES 
} from 'axios-retryer';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { createCircuitBreaker } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import { createCachePlugin } from 'axios-retryer/plugins/CachingPlugin';
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
  blockingQueueThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
  
  // Status codes and methods to retry
  retryableStatuses: [408, 429, [500, 599]],
  retryableMethods: ['get', 'head', 'options', 'put']
});

// Add token refresh capabilities
api.use(
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
  .on('onRetryProcessFinished', (metrics) => {
    logEvent('api_retry_finished', metrics);
  })
  .on('onTokenRefreshed', () => {
    logEvent('token_refreshed');
  });

// Export API functions with different priorities
export const apiService = {
  fetchCriticalData: () => 
    api.axiosInstance.get('/critical-endpoint', {
      __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL
    }),
    
  fetchUserProfile: (userId) => 
    api.axiosInstance.get(`/users/${userId}`, {
      __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH
    }),
    
  updateUserData: (userId, data) => 
    api.axiosInstance.put(`/users/${userId}`, data, {
      __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH
    }),
    
  fetchRecommendations: () => 
    api.axiosInstance.get('/recommendations', {
      __priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW
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
- Set a reasonable `maxRequestsToStore` to limit how many requests are kept in memory
- Ensure you're using `enableSanitization: true` to prevent storing sensitive data

#### Performance issues
- Reduce `maxConcurrentRequests` to prevent overwhelming your backend
- Use the CachingPlugin to avoid redundant requests
- Make sure you have proper priority settings for important requests

#### Timer accumulation issues ⚡ **NEW**
- Monitor timer health with `getTimerStats()` and check `timerHealth.healthScore` in metrics
- Use `destroy()` method when done with RetryManager to prevent timer leaks
- If you see high timer counts, check for proper request cancellation
- Consider reducing retry delays if you have many concurrent failing requests

### Debugging Tips

When debugging, enable debug mode for detailed logs:

```typescript
const retryer = createRetryer({ debug: true });
```

You can also monitor metrics in real-time:

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

### Migrating from axios-retry or other libraries

If you're currently using another retry library, here's how to migrate to axios-retryer:

#### From axios-retry

```typescript
// Before (with axios-retry)
import axios from 'axios';
import axiosRetry from 'axios-retry';

const client = axios.create();
axiosRetry(client, { 
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay
});

client.get('/api/data').then(/* ... */);

// After (with axios-retryer)
import { createRetryer } from 'axios-retryer';

const retryer = createRetryer({
  retries: 3,
  backoffType: 'exponential'
});

retryer.axiosInstance.get('/api/data').then(/* ... */);
```

## 🔄 Compatibility

axios-retryer is compatible with:

| Environment | Support |
|-------------|---------|
| Node.js     | ✅ v12+ |
| Browsers    | ✅ Modern browsers (ES6+) |
| React       | ✅ All versions |
| React Native | ✅ All versions |
| Vue         | ✅ All versions |
| Angular     | ✅ All versions |
| TypeScript  | ✅ v4.0+ |

### Bundle Size Impact

| Component | Size (minified + gzipped) |
|-----------|-------------|
| Complete library (with all plugins) | 6.4KB |
| Core library only | ~4KB |
| Individual plugins | ~0.7-1.2KB each |

## 📘 API Reference

### Core Functions
- `createRetryer(options?: RetryManagerOptions)`: Creates a retry manager instance
- `createRetryStrategy(config: RetryStrategyConfig)`: Creates a custom retry strategy

### Plugin Factories
- `createTokenRefreshPlugin(refreshFn, options?)`: Creates a token refresh plugin
- `createCircuitBreaker(options)`: Creates a circuit breaker plugin
- `createCachePlugin(options?)`: Creates a response caching plugin

### Plugin Methods
- **CachingPlugin**:
  - `clearCache()`: Clears all cached responses
  - `invalidateCache(keyPattern)`: Invalidates specific cache entries by key pattern
  - `getCacheStats()`: Returns statistics about the cache (size, age, etc.)
- **CircuitBreakerPlugin**:
  - `reset()`: Manually resets the circuit breaker to closed state
  - `getState()`: Returns the current state of the circuit breaker
- **TokenRefreshPlugin**:
  - `refreshToken()`: Manually triggers a token refresh
  - `isRefreshing()`: Checks if a token refresh is in progress

### RetryManager Class

The main class for managing retries with comprehensive timer management:

#### Core Properties
- `axiosInstance`: The wrapped axios instance to use for requests

#### Request Management Methods
- `retryFailedRequests()`: Manually retry all failed requests stored in the request store
- `cancelRequest(requestId: string)`: Cancel a specific request by ID (includes timer cleanup)
- `cancelAllRequests()`: Cancel all ongoing requests and timers

#### Timer Management Methods ⚡ **NEW**
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
- `use(plugin: RetryPlugin, beforeRetryerInterceptors?: boolean)`: Register a plugin
- `unuse(pluginName: string)`: Unregister a plugin by name
- `listPlugins()`: Get list of registered plugins with their names and versions

#### Event Management
- `on(event: EventName, listener: Function)`: Subscribe to an event
- `off(event: EventName, listener: Function)`: Unsubscribe from an event

#### Metrics & Monitoring
- `getMetrics()`: Get comprehensive retry statistics including timer health
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
- `onMetricsUpdated`: When metrics are updated
- `onTokenRefreshed`: When a token is refreshed (TokenRefreshPlugin)
- `onRequestCancelled`: When a request is cancelled
- `onInternetConnectionError`: When a network error occurs
- `onCriticalRequestFailed`: When a critical priority request fails
- `onAllCriticalRequestsResolved`: When all critical requests complete
- `onManualRetryProcessStarted`: When manual retry process begins

### Timer Health Monitoring ⚡ **NEW**

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

### Performance Optimizations ⚡ **NEW**

Recent performance improvements include:

- **Binary Heap Priority Queue**: O(log n) vs O(n²) for large queues (100x better scaling)
- **Timer Management**: Prevents timer accumulation and event loop congestion
- **Memory-Aware Processing**: Smart queue management prevents memory exhaustion

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