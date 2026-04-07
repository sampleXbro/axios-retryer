# Migrating from 1.x to 2.0

`axios-retryer` 2.0 makes the core-vs-plugin boundary explicit.

The main idea is simple:

- keep the root entry focused on retry management, queueing, events, and shared types
- move optional behavior like sanitization and populated metrics behind opt-in plugins
- keep plugin imports documented and tree-shakeable

If you are upgrading from any `1.x` release, use this checklist.

## Upgrade Checklist

1. Upgrade `axios` to `>= 1.7.4`.
2. Move sanitization config out of `createRetryer()` and into `DebugSanitizationPlugin`.
3. Install `MetricsPlugin` if you rely on populated `getMetrics()` data or `onMetricsUpdated`.
4. Prefer documented plugin imports from `axios-retryer/plugins` or per-plugin entry points.
5. Update any TypeScript code that listens to plugin-specific events so the manager type is widened through `use()` or an explicit generic.
6. Re-check `maxRefreshAttempts` if you use `TokenRefreshPlugin`.
7. Move any manual replay usage to `ManualRetryPlugin`. Root `retryFailedRequests()`, `maxRequestsToStore`, `requestStore`, and `beforeManualRetry` are removed in `2.0`.
8. If you used the browser bundle, build it locally with `npm run build:browser`.
9. Replace `hooks: { ... }` on `createRetryer()` with `retryer.on(...)` after construction (and after `use()` when you need plugin-typed events).
10. If you imported `RequestDependencyPlugin`, remove it and use `blockingPriorityThreshold` / `cancelPendingOnDependencyFailure` on `createRetryer()` instead.

## Breaking Changes

### Constructor `hooks` removed from `RetryManagerOptions`

In `1.x`, you could pass `hooks` into `createRetryer({ hooks: { ... } })`. In `2.0`, that option is removed — use the event API on the manager instance.

Before:

```typescript
import { createRetryer } from 'axios-retryer';

const retryer = createRetryer({
  hooks: {
    onFailure: (config) => console.log(config.url),
  },
});
```

After:

```typescript
import { createRetryer } from 'axios-retryer';

const retryer = createRetryer();
retryer.on('onFailure', (config) => {
  console.log(config.url);
});
```

### `RequestDependencyPlugin` removed

The published package no longer includes `RequestDependencyPlugin` or the `./plugins/RequestDependencyPlugin` export. Use core options `blockingPriorityThreshold` and `cancelPendingOnDependencyFailure`, and listen to `onBlockingRequestFailed` / `onAllBlockingRequestsResolved` / `onRequestCancelled` as needed. See the [concurrency guide](https://samplexbro.github.io/axios-retryer/guides/concurrency) and configuration docs.

### Custom `MetricsRecorder` implementations

If you registered a custom metrics recorder (uncommon), update it to the new `MetricsRecorder` shape: `reset`, `buildDetailedMetrics`, and optional `emitMetricsUpdated` only.

### Sanitization moved to a plugin

In `1.x`, sanitization lived on the core manager options. In `2.0`, it is an explicit plugin.

Before:

```typescript
import { createRetryer } from 'axios-retryer';

const retryer = createRetryer({
  debug: true,
  enableSanitization: true,
  sanitizeOptions: {
    sensitiveHeaders: ['X-API-Key'],
  },
});
```

After:

```typescript
import { createRetryer } from 'axios-retryer';
import { createDebugSanitizationPlugin } from 'axios-retryer/plugins';

const retryer = createRetryer({ debug: true });

retryer.use(
  createDebugSanitizationPlugin({
    sanitizeOptions: {
      sensitiveHeaders: ['X-API-Key'],
    },
  }),
);
```

### Metrics are now opt-in

The core manager still exposes `getMetrics()`, but the live counters now stay at their zero defaults unless you install `MetricsPlugin`.

Before:

```typescript
const retryer = createRetryer();

retryer.on('onMetricsUpdated', (metrics) => {
  console.log(metrics.successfulRetries);
});
```

`onRetryProcessFinished` remains a core lifecycle event, but it no longer carries a metrics payload. Use `onMetricsUpdated` when you need snapshots.

After:

```typescript
import { createRetryer } from 'axios-retryer';
import { createMetricsPlugin } from 'axios-retryer/plugins';

const retryer = createRetryer().use(createMetricsPlugin());

retryer.on('onMetricsUpdated', (metrics) => {
  console.log(metrics.successfulRetries);
});
```

### Manual replay moved to `ManualRetryPlugin`

In `1.x`, manual replay could be driven from the root manager. In `2.0`, that replay surface lives entirely on `ManualRetryPlugin`.

Before:

```typescript
import { createRetryer, RETRY_MODES } from 'axios-retryer';

const retryer = createRetryer({
  mode: RETRY_MODES.MANUAL,
  maxRequestsToStore: 100,
  hooks: {
    beforeManualRetry: (config) => config,
  },
});

const responses = await retryer.retryFailedRequests();
```

After:

```typescript
import { createRetryer, RETRY_MODES } from 'axios-retryer';
import { createManualRetryPlugin } from 'axios-retryer/plugins/ManualRetryPlugin';

const retryer = createRetryer({ mode: RETRY_MODES.MANUAL });
const manualRetry = createManualRetryPlugin({
  maxRequestsToStore: 100,
  beforeRetry: (config) => config,
});

retryer.use(manualRetry);

const responses = await manualRetry.retryFailedRequests();
```

### Plugin event typing is no longer implied on the root manager

In `1.x`, plugin-specific hook names were present on the shared hook type. In `2.0`, there is no `hooks` option — use `retryer.on(...)` after `use()` (or pass a generic to `createRetryer` for early core listeners only).

Before:

```typescript
import { createRetryer } from 'axios-retryer';

createRetryer({
  hooks: {
    onTokenRefreshed: (token) => {
      console.log(token);
    },
  },
});
```

After:

```typescript
import { createRetryer } from 'axios-retryer';
import { createTokenRefreshPlugin, type TokenRefreshPluginEvents } from 'axios-retryer/plugins/TokenRefreshPlugin';

const retryer = createRetryer();
const withRefresh = retryer.use(
  createTokenRefreshPlugin(async () => ({ token: 'fresh-token' })),
);

withRefresh.on('onTokenRefreshed', (token) => {
  console.log(token);
});
```

Optional: if you want the generic on the root manager before plugins attach, you can write `createRetryer<TokenRefreshPluginEvents>()` and still register plugin events only after `use()`.

### `maxRefreshAttempts` now means the exact number of refresh attempts

`1.x` effectively attempted refresh `maxRefreshAttempts + 1` times because of an off-by-one bug.

Before:

```typescript
createTokenRefreshPlugin(refreshFn, {
  maxRefreshAttempts: 3,
});
```

After:

```typescript
createTokenRefreshPlugin(refreshFn, {
  maxRefreshAttempts: 3,
});
```

The code looks the same, but the behavior is different:

- `1.x`: `3` meant `4` total attempts
- `2.0`: `3` means `3` total attempts

If you tuned this number around the old bug, lower it by `1` to preserve the previous total-attempt behavior.

### Browser bundle publishing changed

The browser bundle is no longer treated as a default published artifact in package metadata. Build it locally when you need a script-tag bundle:

```bash
npm run build:browser
```

## Import Guidance

These import styles are supported in `2.0`, but the per-plugin subpaths are the preferred documented path:

```typescript
import { createRetryer } from 'axios-retryer';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { createMetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';
```

```typescript
import { createTokenRefreshPlugin, createMetricsPlugin } from 'axios-retryer/plugins';
```

Use the barrel when convenience matters more than explicitness, and avoid deep internal imports from `src/` or undocumented paths.

## Legacy Plugin Hooks Removed

Plugins must subscribe through `retryer.on(...)` inside `initialize()`. The deprecated `plugin.hooks` field no longer runs in `2.0`.

```typescript
plugin.initialize = (retryer) => {
  retryer.on('beforeRetry', (config) => {
    console.log(config.url);
  });
};
```

## Caching Invalidation

`CachingPlugin.invalidateCache()` now prefers explicit exact-key or prefix matching instead of substring semantics.

Preferred direction:

```typescript
const cachePlugin = createCachePlugin();
const userKey = cachePlugin.buildCacheKey({ method: 'get', url: '/users/1' });

cachePlugin.invalidateCache({ exact: userKey });
cachePlugin.invalidateCache({ prefix: 'GET|/users/' });
```

## Typical End State

Most `1.x` applications end up looking like this after migration:

```typescript
import { createRetryer, RETRY_MODES } from 'axios-retryer';
import {
  createDebugSanitizationPlugin,
  createMetricsPlugin,
  createTokenRefreshPlugin,
} from 'axios-retryer/plugins';

const retryer = createRetryer({
  mode: RETRY_MODES.AUTOMATIC,
  retries: 3,
  debug: true,
});

retryer.use(createMetricsPlugin());
retryer.use(
  createDebugSanitizationPlugin({
    sanitizeOptions: {
      sensitiveHeaders: ['Authorization'],
    },
  }),
);
retryer.use(
  createTokenRefreshPlugin(async (axiosInstance) => {
    const { data } = await axiosInstance.post('/auth/refresh');
    return { token: data.accessToken };
  }),
);
```

## Notes

- `1.5.4` was prepared but not published. The fixes and API cleanup tracked for that release are included in `2.0.0`.
- **Dependency-style gating** (hold lower-priority work until blocking requests finish) is implemented in the core via `blockingPriorityThreshold` and `cancelPendingOnDependencyFailure`. There is no separate `RequestDependencyPlugin` in the published package; use the [concurrency guide](https://samplexbro.github.io/axios-retryer/guides/concurrency) and configuration docs.
- The dedicated plugin barrel `axios-retryer/plugins` is kept for compatibility but is deprecated. Prefer focused subpath imports (e.g. `axios-retryer/plugins/CachingPlugin`) for better tree-shaking.

## axios-retryer/plugins barrel — deprecation roadmap

**Measured bundle impact:** The `axios-retryer/plugins` barrel bundles all plugins unconditionally (~52.6 KB raw / ~13.8 KB gzip). Importing from subpaths (e.g. `axios-retryer/plugins/CachingPlugin`) allows bundlers to tree-shake unused plugins, reducing per-plugin cost to ~5–15 KB raw.

**Decision:** The barrel will be removed in the next major release (v3.0.0). Users should migrate to subpath imports now.

**Migration:** Replace:

```js
import { CachingPlugin, TokenRefreshPlugin } from 'axios-retryer/plugins';
```

With focused imports:

```js
import { CachingPlugin } from 'axios-retryer/plugins/CachingPlugin';
import { TokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
```
