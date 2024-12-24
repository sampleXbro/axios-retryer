# axios-retryer

A powerful library that enables automatic or manual retries for Axios requests with rich configuration, hooks, and custom strategies. Perfect for handling intermittent network issues or flaky endpoints without rewriting all your Axios logic.

## Table of Contents

- [Installation](#installation)
- [Features](#features)
- [Quick Example](#quick-example)
- [Usage](#usage)
    - [Creating a RetryManager](#creating-a-retrymanager)
    - [Automatic vs. Manual Mode](#automatic-vs-manual-mode)
    - [Retry Strategies](#retry-strategies)
    - [Hooks (Lifecycle Events)](#hooks-lifecycle-events)
    - [Canceling Requests](#canceling-requests)
    - [Debug Mode](#debug-mode)
- [API Reference](#api-reference)
- [Examples](#examples)
    - [Automatic Retries with Default Strategy](#1-automatic-retries-with-default-strategy)
    - [Manual Mode: Queue & Retry Later](#2-manual-mode-queue--retry-later)
    - [Using a Custom Request Store](#3-using-a-custom-request-store)
    - [Custom Backoff Strategy](#4-custom-backoff-strategy)
- [Contributing](#contributing)
- [License](#license)

## Installation

```bash
npm install axios-retryer
```

or

```bash
yarn add axios-retryer
```

## Features

- **Automatic or Manual Retry Modes**: Choose 'automatic' to retry network/server errors automatically or 'manual' to queue failed requests for later retry.
- **Configurable Retry Logic**: Provide your own RetryStrategy or use the built-in one.
- **Request Store**: Failed requests can be stored (by default, in memory). Implement a custom store to persist requests elsewhere (e.g., local storage, database, queue).
- **Hooks**: Tie into each stage (before retry, after retry, failure, all retries completed).
- **Cancellation**: Cancel individual requests or all ongoing requests at once.
- **TypeScript Support**: All types are included out of the box.

## Quick Example

Here is a short snippet showing how to instantiate the `RetryManager` for automatic retries:

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  mode: 'automatic',
  retries: 3,
  throwErrorOnFailedRetries: true, // (default=true) Throw error if all retries fail
});

// Use the internal Axios instance to make requests
manager.getAxiosInstance().get('https://jsonplaceholder.typicode.com/posts')
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
import { RetryManager } from 'axios-retryer';

const retryManager = new RetryManager({
  mode: 'automatic',
  retries: 2,
  throwErrorOnFailedRetries: true, // (default=true)
  throwErrorOnCancelRequest: true, // (default=true)
  // You can also pass hooks, custom strategy, request store, or debug flag
});
```

Available options (`RetryManagerOptions`):

- `mode` (`'automatic' | 'manual'`): Determines how retries occur.
- `retries?` (`number`, default: `3`): Max number of retry attempts for automatic mode.
- `retryStrategy?` (`RetryStrategy`): Custom logic for deciding if and when to retry.
- `requestStore?` (`RequestStore`): Where failed requests are stored; defaults to an in-memory store.
- `hooks?` (`RetryHooks`): Lifecycle hooks (e.g., `beforeRetry`, `afterRetry`, `onFailure`, `onAllRetriesCompleted`).
- `axiosInstance?` (`AxiosInstance`): Provide a pre-configured Axios instance; otherwise, a new one is created.
- `throwErrorOnFailedRetries?` (`boolean`, default: `true`): Whether to throw an error after all retries fail.
- `throwErrorOnCancelRequest?` (`boolean`, default: `true`): Whether to throw if a request is canceled.
- `debug?` (`boolean`, default: `false`): If true, logs debug messages about the retry process.

### Automatic vs. Manual Mode

#### Automatic (`mode: 'automatic'`):

- Requests are retried automatically according to your chosen `retryStrategy` and `retries` count.
- Once retries are exhausted, the request is stored in the `requestStore`.
- You can then manually retry them later with `.retryFailedRequests()` if desired.

#### Manual (`mode: 'manual'`):

- Requests are not retried automatically.
- Once a request fails, it’s stored in the `requestStore`.
- You can later call `.retryFailedRequests()` to attempt them again in bulk.

### Retry Strategies

By default, `axios-retryer` uses a `DefaultRetryStrategy`:

```typescript
export class DefaultRetryStrategy implements RetryStrategy {
  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
    const isNetworkError = !error.response;
    const isServerError = error.response && error.response.status >= 500 && error.response.status < 600;
    return ((isNetworkError || isServerError) && attempt <= maxRetries) || false;
  }

  getDelay(attempt: number) {
    return 1000 * 2 ** (attempt - 1); // Exponential backoff: 1s, 2s, 4s, ...
  }
}
```

If you want custom logic, just implement the `RetryStrategy` interface:

```typescript
import { RetryStrategy } from 'axios-retryer';
import type { AxiosError } from 'axios';

class CustomRetryStrategy implements RetryStrategy {
  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
    const isNetworkError = !error.response;
    const isServerError = error.response && error.response.status >= 500 && error.response.status < 600;
    return (isNetworkError || isServerError) && attempt <= maxRetries;
  }

  getDelay(attempt: number) {
    return 1000; //Linear backoff: 1s
  }
}

const manager = new RetryManager({
  mode: 'automatic',
  retries: 3,
  retryStrategy: new CustomRetryStrategy(),
});
```

### Hooks (Lifecycle Events)

You can subscribe to hooks that provide additional control over or insight into the retry flow:

```typescript
const retryManager = new RetryManager({
  mode: 'automatic',
  hooks: {
    beforeRetry: (config) => {
      console.log('Will retry this config:', config.url);
    },
    afterRetry: (config, success) => {
      console.log(`Attempt finished for ${config.url}. Success? ${success}`);
    },
    onFailure: (config) => {
      console.log(`Request has finally failed: ${config.url}`);
    },
    onAllRetriesCompleted: (failedRequests) => {
      console.log(`All retries completed. ${failedRequests} request(s) failed in total.`);
    },
  },
});
```

### Canceling Requests

Each request is assigned an internal `requestId`. You can cancel them either individually or all at once:

```typescript
const manager = new RetryManager({ mode: 'automatic' });
const axiosInstance = manager.getAxiosInstance();

axiosInstance.get('https://example.com/slow-endpoint')
  .catch(err => {
    if (err.message.includes('aborted')) {
      console.log('This request was canceled');
    }
  });

// Later, if we want to cancel all ongoing requests:
manager.cancelAllRequests();
```

You can also call `cancelRequest(requestId)` if you happen to know the exact `requestId`.

### Debug Mode

Set `debug: true` in the `RetryManagerOptions` to log detailed messages about retries, failures, store operations, etc. This can help troubleshoot issues during development.

```typescript
const manager = new RetryManager({
  mode: 'automatic',
  retries: 2,
  debug: true,
});
```

## API Reference

### RetryManager

- `constructor(options: RetryManagerOptions)`
- `.getAxiosInstance()`: Returns the underlying Axios instance.
- `.retryFailedRequests<T>()`: Manually retry all stored (failed) requests.
- `.cancelRequest(requestId: string)`: Cancel a specific in-progress request.
- `.cancelAllRequests()`: Cancel all in-progress requests.

### RequestStore

- `.add(request: AxiosRetryerRequestConfig)`
- `.remove(request: AxiosRetryerRequestConfig)`
- `.getAll()`
- `.clear()`

### RetryStrategy

- `.shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean`
- `.getDelay(attempt: number, maxRetries: number): number`

For a complete list of all exported types and classes, see the source code or your IDE’s intellisense (if using TypeScript).

## Examples

### 1. Automatic Retries with Default Strategy

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  mode: 'automatic',
  retries: 3,
});

manager.getAxiosInstance().get('https://httpbin.org/status/500')
  .then(response => console.log('Response:', response.data))
  .catch(error => console.error('Request failed after 3 retries:', error));
```

### 2. Manual Mode: Queue & Retry Later

```typescript
import { RetryManager } from 'axios-retryer';

const manager = new RetryManager({
  mode: 'manual',
  retries: 2,
});

manager.getAxiosInstance().get('https://httpbin.org/status/500')
  .catch(error => {
    console.error('Initial request failed:', error);
  });

manager.retryFailedRequests().then((responses) => {
  console.log('Retried responses:', responses);
}).catch(err => {
  console.error('Error retrying all failed requests:', err);
});
```

### 3. Using a Custom Request Store

```typescript
import { RetryManager, RequestStore, AxiosRetryerRequestConfig } from 'axios-retryer';

class LocalStorageRequestStore implements RequestStore {
  add(request: AxiosRetryerRequestConfig) {
    const items = this.getAll();
    items.push(request);
    localStorage.setItem('failedRequests', JSON.stringify(items));
  }
  remove(request: AxiosRetryerRequestConfig) {
    const items = this.getAll().filter((r) => r.url !== request.url);
    localStorage.setItem('failedRequests', JSON.stringify(items));
  }
  getAll(): AxiosRetryerRequestConfig[] {
    return JSON.parse(localStorage.getItem('failedRequests') || '[]');
  }
  clear() {
    localStorage.removeItem('failedRequests');
  }
}

const manager = new RetryManager({
  mode: 'manual',
  requestStore: new LocalStorageRequestStore(),
});
```

### 4. Custom Backoff Strategy

```typescript
import { RetryManager, RetryStrategy } from 'axios-retryer';
import type { AxiosError } from 'axios';

class CustomRetryStrategy implements RetryStrategy {
  shouldRetry(error: AxiosError, attempt: number, maxRetries: number): boolean {
    const isNetworkError = !error.response;
    const isServerError = error.response && error.response.status >= 500;
    return (isNetworkError || isServerError) && attempt <= maxRetries;
  }
  getDelay(attempt: number): number {
    return 1000; // Linear backoff: 1s
  }
}

const manager = new RetryManager({
  mode: 'automatic',
  retries: 4,
  retryStrategy: new CustomRetryStrategy(),
  debug: true,
});
```

## Contributing

Contributions, issues, and feature requests are welcome. Please see the [Contributing](./CONTRIBUTING.md) guidelines for more details! 
Feel free to check the issues page if you have any questions or suggestions.


## License

This project is licensed under the MIT License.

Enjoy reliable Axios requests with `axios-retryer`!
