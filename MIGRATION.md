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
7. If you used the browser bundle, build it locally with `npm run build:browser`.

## Breaking Changes

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

After:

```typescript
import { createRetryer } from 'axios-retryer';
import { createMetricsPlugin } from 'axios-retryer/plugins';

const retryer = createRetryer();
retryer.use(createMetricsPlugin());

retryer.on('onMetricsUpdated', (metrics) => {
  console.log(metrics.successfulRetries);
});
```

### Plugin event typing is no longer implied on the root manager

In `1.x`, plugin-specific hook names were present on the shared hook type. In `2.0`, plugin-specific events are attached through plugin-aware types.

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
import { createTokenRefreshPlugin, type TokenRefreshPluginEvents } from 'axios-retryer/plugins';

const retryer = createRetryer<TokenRefreshPluginEvents>({
  hooks: {
    onTokenRefreshed: (token) => {
      console.log(token);
    },
  },
});

const retryerWithTokenRefresh = retryer.use(
  createTokenRefreshPlugin(async () => ({ token: 'fresh-token' })),
);

retryerWithTokenRefresh.on('onTokenRefreshed', (token) => {
  console.log(token);
});
```

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

These import styles are supported in `2.0`:

```typescript
import { createRetryer } from 'axios-retryer';
import { createTokenRefreshPlugin, createMetricsPlugin } from 'axios-retryer/plugins';
```

```typescript
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import { createMetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';
```

Avoid deep internal imports from `src/` or undocumented paths.

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
- The dedicated plugin barrel `axios-retryer/plugins` is the easiest default import style, but per-plugin subpaths remain supported.
