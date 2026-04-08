# axios-retryer sandbox

Browser playground for **manual** regression testing of the local package (`"axios-retryer": "file:.."`).

## Run

```bash
cd sandbox
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). Use the sidebar to switch between **Core** and **Plugins** demos. Each section’s log uses **color-coded rows** (left stripe + tint): scenario starts, core vs plugin events, outbound HTTP, results, tool dumps, and debug logger lines — see the legend above the log.

## What is covered

| Area | Section |
|------|---------|
| Retries, backoff overrides, `requestRetries`, network error | **Auto Retry & Backoff** |
| Priority queue, cancel one / all, `maxQueueSize` / `QueueFullError`, `extra` metadata | **Priority Queue & Concurrency** |
| `blockingPriorityThreshold`, `cancelPendingOnDependencyFailure` | **Blocking Requests** |
| `CachingPlugin`, stats, clear, prefix invalidation | **CachingPlugin** |
| `CircuitBreakerPlugin` | **CircuitBreakerPlugin** |
| `MetricsPlugin` + `manager.getMetrics()` shell | **MetricsPlugin** |
| `ManualRetryPlugin`, `RETRY_MODES.MANUAL` | **ManualRetryPlugin** |
| `createTokenRefreshPlugin`, parallel refresh, no-token skip | **TokenRefreshPlugin** |
| `DebugSanitizationPlugin` | **DebugSanitizationPlugin** |

Core sections wire **all** `CoreRetryEvents` (including `onRetryScheduled`, queue/dispatch/success/terminal, blocking events).

## Build check

```bash
npm run build
```
