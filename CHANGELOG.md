# Changelog

All notable changes to this project will be documented in this file.

## Next version - Unreleased

- No unreleased changes yet.

## 2.3.2 - 07.05.2026

Correctness pass closing four critical bugs and five architectural gaps surfaced by an external senior-architect review. **No breaking changes; no public API changes.**

### 🐛 Critical fixes

- **`QueueFullError` no longer triggers retries.** `NON_RETRYABLE_INTERNAL_CODES` listed `'QUEUE_FULL'` but `QueueFullError` actually carries the code `'EQUEUE_FULL'`. The mismatch meant queue-full rejections fell through to `strategy.shouldRetry()`, which treated them as retryable network errors (no `error.response`) and burned all `retries` attempts hitting the same full queue. Fixed by aligning the set entry with the canonical error code.
- **`extra` request metadata field is no longer silently dropped.** The documented public field `AxiosRetryerRequestMetadata.extra` was missing from the metadata key allowlist, so `assignRequestMetadata(config, { extra })` was a quiet no-op. Added `'extra'` to `ALLOWED_METADATA_KEYS`.
- **`MetricsPlugin` no longer leaks listeners on `unuse()`.** All nine event listeners registered in `initialize()` are now bound in the constructor and explicitly removed in `onBeforeDestroyed`. Calling `manager.unuse('MetricsPlugin')` previously left every handler live on the `EventBus`, double-counting metrics if the plugin was re-registered.
- **`CircuitBreakerScopeManager.writeState` no longer diverges from the state adapter on write failure.** The local cache used to be updated _before_ the adapter call with no rollback if the adapter rejected. With a distributed (Redis/etcd-style) adapter, a `set` failure left the cache holding the new state (e.g. `OPEN`) while the adapter still held the old state (`CLOSED`); the next `readState` overwrote the cache from the stale stored value and the circuit silently failed to trip. The cache is now snapshotted before the adapter call and restored on rejection so cache and adapter stay consistent.

### 🐛 Architectural fixes

- **`onRetryScheduled` now fires before the retry delay, not after.** `ErrorInterceptor.scheduleRetry` previously emitted the event _after_ awaiting `waitForRetryDelay`, so by the time plugins received it the delay had already elapsed. Plugins relying on the event to react during the delay window now have the full window to do so.
- **`MetricsPlugin` reads request metadata via the public utility.** Three direct `config.__axiosRetryer?.priority/.retryAttempt` accesses replaced with `getRequestMetadata(config)?.…`, restoring the architectural rule that plugins do not touch internal storage keys.
- **Caller `AbortSignal` link is preserved for queued requests held back during teardown.** `RequestLifecycleManager.cancelAllRequests` used to call `releaseAbortSignalLink(controller)` unconditionally before the preserve-check return, severing the caller's signal forwarding for requests we were _not_ aborting. The release call now lives inside the abort branch.
- **`PluginContext.triggerAndEmit` JSDoc corrected.** The interface and `EventBus` JSDoc claimed a "hooks vs listeners" distinction that does not exist in the implementation. `triggerAndEmit` is now documented accurately as an alias of `emit`, kept for backward compatibility with existing plugins; new code should prefer `emit`.

### 📦 Structure & maintainability

- **HTTP header parsing extracted to `src/utils/http.ts`.** `extractRetryAfterHeader`, `parseRetryAfterMs`, `normalizeRetryAfterValue`, and `MAX_RETRY_AFTER_MS` no longer live inside `RetryScheduler.ts` (which kept thin re-exports for backward compatibility with internal imports). `RetryDecisionEngine` now imports these utilities from their new home, removing an unrelated coupling between the scheduler and HTTP-spec parsing.

### 🧪 Testing

- New `__tests__/critical-and-high-fixes.test.ts` covers all nine fixes with regression tests written TDD-first (RED, then fix, then GREEN). Includes:
  - `QueueFullError` fails immediately with zero `beforeRetry` calls.
  - `extra` survives `assignRequestMetadata` and the per-request `__axiosRetryer` re-wrap path.
  - `MetricsPlugin` totalRequests does not increment after `unuse()`; `onMetricsUpdated` is no longer emitted post-unuse.
  - Caller `AbortController` still aborts a preserved request's internal controller after `cancelAllRequests({ includeQueued: false })`; the link is correctly _released_ for non-preserved requests.
  - `onRetryScheduled` fires before half the configured delay has elapsed.
  - `CircuitBreakerScopeManager` cache stays consistent with the adapter when `stateAdapter.set` rejects.
- Two pre-existing tests updated where they asserted the pre-fix wrong behavior: `RetryDecisionEngine.test.ts` (`'QUEUE_FULL'` → `'EQUEUE_FULL'`) and `RequestQueue.advanced-edge-cases.test.ts` (was implicitly relying on `QueueFullError` being retried to eventually succeed).
- Full suite: **1495 tests / 121 suites** all green.

## 2.3.1 - 28.04.2026

Production-readiness pass focused on observability, configurability, and modularity. **No breaking changes.**

### ✨ Features

- **`maxBackoffDelayMs` option** (`RetryManagerOptions`): cap any backoff strategy (`static`, `linear`, `exponential`) at a custom delay before jitter. Default `60_000` preserves the historical behavior; pass any positive integer to override. Threaded through `DefaultRetryStrategy` and `getBackoffDelay`.

### 🐛 Fixes

- **`RequestQueue.markComplete(requestId?)` is now idempotent.** When a `requestId` is provided, the call is a no-op if the slot has already been released. Prevents a race where both the response and error paths try to release the same in-flight slot and over-decrement the concurrency counter. Internal callers (`RetryManager.cancelRequest`, response/error interceptors, `releaseRequestTracking`) updated to pass the id.

### 📦 Structure & maintainability

- **CachingPlugin:** extracted `CleanupRunner` (periodic cleanup loop with timeout + auto-disable) and `InflightDedupe` (tracking-id, leader/follower state, served-from-cache) into `managers/`. Orchestrator file: 713 → 586 lines.
- **TokenRefreshPlugin:** extracted `RefreshExecutor` (per-attempt timeout + classified backoff retry loop) and `TeardownGuard` (sticky teardown error + listener fan-out) into `managers/`. Orchestrator file: 647 → 563 lines.
- **CircuitBreakerPlugin:** extracted `FailureWindow` (sliding-window failure list + cleanup + count) into `managers/`. Orchestrator file: 603 → 574 lines.

### 📦 Package shape

- **Sourcemaps no longer published.** Rollup builds (`dist/*.js`, `dist/plugins/*.js`) now ship without `.map` companions, and the matching map paths were removed from `package.json` `files`. Stack traces from inside the library will reference the bundled output rather than original TypeScript. Consumers who rely on map-aware error reporting can pin to `2.3.x` or earlier; this is a non-API consumer-visible change.

### 🔒 Tooling & quality gates

- **CI gates:** `publish.yml` now runs `pnpm typecheck && pnpm lint && pnpm build` before tests in both the CI and publish jobs (CI used to run only `pnpm test`). An informational `pnpm audit --prod --audit-level=high` step is added to surface advisories without blocking the build.
- **Coverage thresholds** ratcheted in `jest.config.cjs`: branches 75 → 90, functions 80 → 92, lines 85 → 95, statements 85 → 95. Aggregate coverage rose to **95.31% branches** / 95.10% functions / 99.02% statements (1486 tests across 120 suites). Branch target met by adding focused unit tests for `cloneFallback`, `FailureWindow`, `TeardownGuard`, `TokenRefreshPlugin/utils/headers`, `CircuitBreakerScopeManager` adapter-error paths, `InflightDedupe` undefined-config / missing-leader paths, `CleanupRunner` failure-disable, `AdaptiveTimeoutTracker` missing-url and scope-eviction paths, `CircuitBreakerScopeManager` scope variants and custom-scope throw-with-non-Error, `MetricsPlugin` metadata-absent fallbacks, `DebugSanitizationPlugin` sanitizers across array/null/primitive inputs, `TokenRefreshPlugin` failed-auth fast-fail and queue-overflow paths, `RequestLifecycleManager` plain-object correlation header fallback, and several other utility/orchestrator branches.
- **Lint:** `no-console` is now `error` in `src/`; the built-in `RetryLogger` keeps a per-file override. Stale `eslint-disable` directives removed.
- **`tsconfig.json`:** dropped `lib: ["DOM", "DOM.Iterable"]`. Library is Node-and-browser-agnostic; DOM types added type-checker noise without benefit. The build tsconfig was already DOM-free.
- **Dependabot:** added `.github/dependabot.yml` with grouped weekly npm + GitHub Actions updates. Major axios bumps are intentionally ignored (peer-dep range).

### 📚 Documentation

- **README:** new "Behavior notes" section documents the 5-minute `Retry-After` cap and the 60-second default backoff cap with the `maxBackoffDelayMs` override.
- **`scripts/update-readme-stats.cjs`:** new helper to refresh the test-suite stat line from a Jest run. Run `node scripts/update-readme-stats.cjs` (or `--check` in CI) before cutting a release.

### 🧪 Testing

- New `__tests__/p1-max-backoff-delay-ms.test.ts` covering option validation, strategy threading, and cap enforcement.
- New `__tests__/p1-request-queue-mark-complete-idempotent.test.ts` covering the `markComplete(requestId)` race fix.
- New `__tests__/p1-branch-coverage-fills.test.ts`, `__tests__/p2-branch-coverage-fills.test.ts`, and `__tests__/p3-branch-coverage-fills.test.ts` consolidate small branch-fill unit tests that push aggregate branch coverage above 95% without touching production code.

## 2.2.1 - 13.04.2026

### 📚 Documentation & website

- **Marketing homepage:** Responsive layout (mobile nav, fluid spacing, scrollable comparison table, tighter grids on narrow viewports).
- **Code samples:** Shiki code blocks no longer force page-wide horizontal scroll (`CodeBlock.astro`, global `pre.astro-code` rules); docs main column and home “Quick start” grid use `min-width: 0` so wide snippets scroll inside the block.

### 🔧 Tooling

- **MCP:** Canonical Playwright MCP entry in `.agentsmesh/mcp.json` (AgentsMesh `generate` → `.cursor/mcp.json`, `.mcp.json`, Codex config, etc.); `.gitignore` updated so `.cursor/mcp.json` can be tracked while other `.cursor/*` stays ignored.

## 2.2.0 - 12.04.2026

### 📦 Structure & maintainability

- **Public types:** Split the monolithic `src/types/index.ts` barrel into `common`, `events`, `metrics`, `options`, and `plugins` modules (package types entry continues to re-export the same public surface).
- **Core:** Refined `EventBus`, `RetryScheduler`, and `ErrorInterceptor` behavior and `RetryManager` glue.
- **CachingPlugin:** Reorganized into `configs/`, `errors/`, `storage/`, `types/`, and `utils/` with a smaller orchestrator; `InvalidCacheKeyError` lives under `errors/`.
- **CircuitBreakerPlugin:** Extracted adaptive timeout tracking, per-scope state, shared types, and option resolution/validation; centralized `excludeUrls` validation in `src/utils/validateExcludeUrls.ts`. Follow-up layout pass adds `configs/`, `errors/`, `managers/`, and `types/` with legacy top-level filenames kept as thin re-exports where needed.
- **DebugSanitizationPlugin, ManualRetryPlugin, MetricsPlugin, TokenRefreshPlugin:** Same modular pattern (`configs/`, `types/`, `utils/` and/or `errors/`, `managers/` for `MetricsCollector`) for smaller orchestrator classes and clearer boundaries. The `sanitize.ts` barrel re-exports `SanitizeOptions` (and related plugin option types) so existing type-only imports from that path keep working.

### 🐛 Fixes

- **Plugin event typing:** Default plugin event map uses `Record<never, never>` so `RetryManagerEvents` does not widen `keyof` incorrectly (restores `RetryEventListener` inference for core events such as `onRetryScheduled` and `beforeRetry`).
- **CachingPlugin:** `InvalidCacheKeyError` message for missing URLs matches the established contract expected by tests and docs.

### 📚 Documentation

- **Website:** New “Creating plugins” page (`docs/plugins/creating-plugins`) and plugins index / docs layout updates.
- **Agents:** Added `plugin-architecture` skill and synced `ts-library` skill content via AgentsMesh (including generated `AGENTS.md`).

### 🔧 Tooling

- **Repository tooling:** Updated the local AgentsMesh dependency to `^0.3.1` and removed checked-in `NODE_AUTH_TOKEN` wiring from `.npmrc` so npm publish credentials come from the environment instead of repository config.

### 🧪 Testing & benchmarks

- **Patch coverage:** Added `__tests__/codecov-patch-coverage.test.ts` to exercise core and plugin edge branches that commonly change together (`ErrorInterceptor`, `RequestQueue`, `ManualRetryPlugin`, `CircuitBreakerPlugin`, and `TokenRefreshPlugin`).
- **`validateExcludeUrls`:** Dedicated unit tests (`__tests__/validateExcludeUrls.test.ts`).
- **Benchmarks:** New `benchmark/public-api.js`, `pnpm benchmark:public-api`, inclusion in `benchmark:existing`, updates to `benchmark/run-all-benchmarks.js`, and refreshed `benchmark/latest-benchmark-report.json`.

## 2.1.6 - 10.04.2026

### ⚠️ Behavior changes

- **Queue teardown:** When the manager tears down, requests still **waiting in the queue** are rejected with **`QueueDestroyedError`**. Earlier **`2.0.x` / `2.1.x`** builds could surface **`QueueClearedError`** on that path. Handle **`QueueDestroyedError`** (or both) if you branch on `instanceof`.
- **`CircuitBreakerPlugin` default `host+url` scope without a resolvable host:** Relative URLs **no longer** share one internal **`__global__`** scope; keys use the **normalized path** (or `unknown`) so isolation matches host-resolved traffic. Circuit open/close timing may change; use an explicit `scope` callback if you need the old aggregation.

### 🐛 Bug fixes & robustness

- **`CircuitBreakerPlugin`:** Implements documented **`manualReset`**, **`resetMetrics`**, and **`getAdaptiveTimeoutMetrics`**; targeted distributed reset uses **`stateAdapter.delete()`**, full reset uses **`stateAdapter.clear()`**; adapter read/write failures fall back to in-memory state; **`shouldCountError`** and custom **`scope`** failures degrade safely (log + sensible defaults); adaptive timeouts activate only after the configured sample size is collected.
- **`RetryManager` destroy path:** **`RetryManagerDisposer`** captures queued request IDs, destroys the queue first, then **`cancelAllRequests({ includeQueued: false, preservedQueuedRequestIds })`** so teardown order matches rejection semantics.
- **`RequestQueue`:** Processing gates that throw no longer stall or crash dequeue; shared helper rejects waiting items for **`clear()`** and **`destroy()`**.
- **`ErrorInterceptor`:** Reads **`Retry-After`** in a header-shape-tolerant, case-insensitive way; skips automatic retries for internal queue/cancel outcomes (**`QUEUE_DESTROYED`**, **`QUEUE_CLEARED`**, **`QUEUE_FULL`**, **`REQUEST_CANCELED`**, **`EREQUEST_ABORTED`**).
- **`TokenRefreshPlugin`:** If **`customErrorDetector`** throws on a success response, the error is logged and the response is passed through (no body-triggered refresh).
- **`ManualRetryPlugin`:** Failed manual replays are not stored again (avoids recursive store loops).

### 📚 Documentation

- Circuit breaker plugin docs: ReDoS warning on **`excludeUrls`** patterns and behavior notes aligned with implementation.
- **Migration guide (`MIGRATION.md` + website):** Added **2.1.6** behavior notes to the existing **1.x → 2.0** guide (no separate migration doc).

### 🧪 Testing

- Added **14** P0 contract test modules (**305** tests) across core, queue, interceptors, strategies, plugins, concurrency, security, and real-world scenarios.
- Updated circuit breaker, regression, and integration tests for destroy ordering, scope keys, distributed reset, and interceptor edge cases.
- **`pnpm test:run`** no longer forces **`--runInBand`**, so Jest uses parallel workers and the full suite finishes much faster on multi-core machines.
- **`pnpm test:quick`** skips integration, performance, and **`package-contract`** tests for faster local feedback.
- **`pnpm test:ci`** runs the full suite with **`--runInBand`** when you need serial execution (e.g. reproducing order-dependent failures).

## 2.0.5 - 09.04.2026

### 📦 Packaging

- Added package contract regression coverage that installs the packed tarball into a clean consumer and verifies CommonJS plus TypeScript `NodeNext` / `Bundler` resolution for all public plugin entry points.

### 🔒 Security

- **Timing attack vulnerability:** Implemented constant-time string comparison (`safeStringEqual`) in TokenRefreshPlugin to prevent timing-oracle attacks when comparing failed auth header values.
- **Header injection:** Enhanced header sanitization to include Unicode line separators (`\u2028`, `\u2029`) in addition to existing CRLF and null character filtering.
- **Memory leaks in tracking:** Fixed memory leaks in CachingPlugin, EventBus, RetryManager, and RetryScheduler by using tracking IDs instead of config objects as Map keys. Config objects could retain large request payloads and prevent garbage collection.
- **ReDoS documentation:** Added security warning to CircuitBreakerPlugin `excludeUrls` option documenting the risk of catastrophically backtracking regex patterns that can block the event loop.
- **Unbounded memory growth in CircuitBreakerPlugin:** Added scope eviction when `maxTrackedScopes` is reached to prevent unbounded growth of the scope tracking map. Uses FIFO eviction on the oldest scope entries.
- **Race condition in CircuitBreakerPlugin state updates:** Implemented scope locking (`_withScopeLock`) to serialize async read-modify-write operations on circuit breaker state, preventing lost updates when using external state adapters.
- **Race condition in CachingPlugin cache operations:** Added cache locking to serialize async read-modify-write operations on cache entries, preventing lost updates and inconsistent cache state under concurrent access.
- **setTimeout safe integer overflow:** Added `MAX_BACKOFF_DELAY_MS` (60 seconds) to cap backoff delays before jitter is applied, preventing exponential backoff from exceeding setTimeout's safe integer range (~2^31 ms).

### 🧪 Testing

- Added regression tests for token masking in TokenRefreshPlugin events.
- Added tests for constant-time string comparison safety.
- Updated integration tests to verify tracking ID-based Map operations.

## 2.0.4 - 08.04.2026

### 📚 Documentation

- **Interactive sandbox on the docs site:** `/sandbox` page (shared docs sidebar + top bar) embeds the browser playground in an iframe; static bundle is served from `/playground/` so Astro’s `/sandbox/index.html` remains the docs page.
- **Website build & repo layout:** `website/site-base.mjs` centralizes the Pages `base` for both Astro and the Vite embed. `website/scripts/embed-sandbox.mjs` builds the library, runs the sandbox build in `sandbox/` with `SANDBOX_VITE_BASE`, and copies `sandbox/dist` → `website/public/playground/`. `website` scripts: `build` = embed + `astro build`; `embed-sandbox`; `dev:with-playground` = embed then `astro dev`. `sandbox/vite.config.ts` uses `SANDBOX_VITE_BASE` when set, else `/` for local `sandbox` dev. Sidebar nav (“Sandbox” under Getting Started) and the marketing homepage link to `/sandbox`.
- **CI & gitignore:** Deploy workflow builds the pnpm workspace, then website `SANDBOX_SKIP_LIB_BUILD=1 pnpm build`; path filters include `sandbox/**`, library roots, and the workspace lockfile. `website/.gitignore` lists `public/playground/`. Root `.gitignore` no longer ignores `sandbox/` so the playground sources are tracked.
- **Sandbox page copy:** explains what the in-browser playground is for and how to use it (sidebar, scenarios, color-coded log, open in new tab).
- **CodeSandbox removed from docs:** Quick Start “Try it live” links to the on-site sandbox; README uses a “Try it” link to the hosted sandbox instead of the CodeSandbox badge; dropped remaining CodeSandbox mentions (including the `sandbox/src/main.ts` file-dependency note).

### 🐛 Bug Fixes

- **Per-request `backoffType: STATIC` ignored after the first retry.** `AXIOS_RETRYER_BACKOFF_TYPES.STATIC` is numeric `0`; `getDelay` used `backoffType || this.backoffType`, so the override was treated as missing and the manager default (e.g. exponential) was used from the second retry onward. `getDelay` now uses nullish coalescing (`??`) so `0` is honored.

### 🧪 Testing

- Added `__tests__/integration/comprehensive-e2e.test.ts` for broad integration coverage (backoff, plugins, cancellation, circuit breaker, etc.).
- Tightened `DefaultRetryStrategy` tests for default vs explicit `STATIC` delay selection.

## 2.0.1 - 07.04.2026

### 📚 Documentation

- Documented chaining `createRetryer().use(a).use(b)` (and `new RetryManager<ComposedEvents>()`) so TypeScript merges plugin event maps; aligned README, migration guide, Events/Plugins/API reference pages, production guide, and MetricsPlugin examples with that pattern
- Regenerated `benchmark/latest-benchmark-report.json` (standard profile, `10/10` executables) and rewrote `BENCHMARK_RESULTS.md` for the full suite, including rollup peak vs HTTP-shaped throughput; synced README and site promo benchmark headline figures

### 🧪 Testing

- Added regression coverage for chained `.use()` merging multiple plugin event maps for `on()` typings

## 2.0.0 - 07.04.2026

> `1.5.4` was prepared but never published. The fixes and API cleanup planned for that release ship in `2.0.0`.

### ⚠️ Breaking Changes

- **Core sanitization options moved to `DebugSanitizationPlugin`.** The root `RetryManager` options no longer accept `enableSanitization` or `sanitizeOptions`; install the sanitization plugin explicitly when you need redacted debug logs.
- **Populated retry metrics now require `MetricsPlugin`.** `getMetrics()` still returns the full metrics shape, but live counters and `onMetricsUpdated` reporting are now opt-in to keep the core smaller.
- **`MetricsRecorder` was narrowed to a snapshot-oriented surface.** Implementations now provide `reset`, `buildDetailedMetrics`, and optional `emitMetricsUpdated` instead of the previous per-event recorder methods. Custom metrics integrations must be updated to match.
- **Root manual replay moved fully to `ManualRetryPlugin`.** `retryFailedRequests()`, `maxRequestsToStore`, `requestStore`, and `beforeManualRetry` are no longer part of the core manager surface in `2.0`.
- **`RetryManagerOptions.hooks` removed.** Register listeners with `retryer.on(...)` after construction (and after `use()` when you need plugin-typed events). The `RetryHooks` type is removed.
- **Legacy `plugin.hooks` support was removed.** Plugins must subscribe through `retryer.on(...)` inside `initialize()`.
- **`RequestDependencyPlugin` removed.** Dependency-style gating lives in the core: `blockingPriorityThreshold`, `cancelPendingOnDependencyFailure` (default `true`), and related events. Drop the separate plugin import and package export.
- **`onRetryProcessFinished` is now lifecycle-only.** It no longer carries a metrics payload; use `onMetricsUpdated` with `MetricsPlugin` when you need snapshots.
- **The browser bundle is now an optional local build.** Generate it with `pnpm build:browser` when you need a script-tag artifact.
- **`maxRefreshAttempts` now means the exact number of refresh attempts.** Previously the loop ran `maxRefreshAttempts + 1` times, so `maxRefreshAttempts: 3` silently produced 4 attempts. If you relied on the old (off-by-one) behavior, decrease your value by 1 (e.g. `3` → `2` to keep the same total attempts).
- **`CriticalRequestPlugin` removed.** Prefer built-in request priority (`CRITICAL` / `RequestPriority`) and queue `canProcess` customization for similar behavior.
- **`afterRetry` signature extended.** Handlers receive an optional third argument, `error`, when the retry attempt failed. Existing two-parameter listeners remain valid.
- **`onAllBlockingRequestsResolved` is success-only.** It fires only when every in-flight blocking request (at or above `blockingPriorityThreshold`) completes with a **successful** HTTP outcome and the internal blocker set becomes empty. It is **not** emitted when a blocker fails terminally, when the last blocker is **cancelled**, or when queued dependents are cleared after `onBlockingRequestFailed`. The queue gate still refreshes so work can proceed; listen to `onBlockingRequestFailed` / `onRequestCancelled` for non-success paths.

### ✨ Added

- **Core lifecycle and resource management** (`RequestLifecycleManager`, `RetryManagerDisposer`, `TimerManager`) to clarify teardown and timer ownership
- **Focused `tsconfig.build.json`** for production builds alongside root `tsconfig.json` for tooling and tests
- **Pipeline-oriented core structure:** dedicated Axios interceptors (`RequestInterceptor`, `ResponseInterceptor`, `ErrorInterceptor`) and `DependencyGatekeeper` for blocking-priority coordination (internal layout; public behavior is the options and events above)
- **Core observability events:** `onRequestQueued`, `onRequestDispatched`, `onRequestSucceeded`, `onRequestError` (terminal failure), `onRetryScheduled`, `onBlockingRequestFailed`, and `onAllBlockingRequestsResolved` (when `blockingPriorityThreshold` is set)
- **Request metadata `extra` field** on `AxiosRetryerRequestMetadata` for app-specific attachment without mutating Axios config shape
- **`TokenRefreshPlugin`:** refresh handler may resolve with `{ token: null }`, `{ token: undefined }`, or omit `token` to skip a refresh cycle without `onTokenRefreshed` / `onTokenRefreshFailed` or queue-wide `TokenRefreshFailedError` (documented on the plugin and events pages)
- **`RetryPlugin` phantom `_events` marker** for improved TypeScript inference of plugin event maps at `use()` call sites
- **Root package exports** for queue and terminal outcome event payloads (`AxiosRetryerRequestQueuedEvent`, `AxiosRetryerRequestDispatchedEvent`, `AxiosRetryerRequestSucceededEvent`, `AxiosRetryerRequestErrorEvent`)

### 🐛 Bug Fixes

- **Docs site (GitHub Pages):** fixed `withBase()` URL joining when `import.meta.env.BASE_URL` has no trailing slash, which produced broken links and asset paths such as `/axios-retryerdocs` on the deployed project site
- Fixed `TokenRefreshPlugin` replay flow so refreshed business requests go back through `RetryManager` instead of bypassing queueing, metrics, cancellation handling, and other plugins
- Fixed `TokenRefreshPlugin` teardown so request interceptors are ejected correctly and repeated `use/unuse` cycles do not leak behavior
- Fixed invalid `RetryManager` option handling so bad config now throws the intended validation error instead of failing during logger setup
- Fixed retry metrics initialization and empty-metrics snapshots so instances no longer share nested metric state and averages no longer return `NaN`
- Fixed failure accounting for `retries: 0` and terminal failure paths so production metrics are now internally consistent
- Fixed failed-request store eviction to remove the oldest stored request instead of the newest one
- Standardized library-thrown errors into named classes across core and plugin flows, including config validation, plugin registration, queue state, circuit-breaker fail-fast responses, cache key generation, and token refresh failures

### ⚡ Performance & Benchmarking

- Reworked the benchmark suite around deterministic, user-facing scenarios instead of noisy random demos
- Added structured benchmark reporting with `quick`, `standard`, and `full` profiles plus machine-readable rollup output
- Benchmarks now cover healthy-path overhead, transient failure recovery, rate limiting, queue contention, sustained load, outage recovery, caching effectiveness, circuit-breaker protection, and token-refresh storms
- Preserved runtime defaults for end users while explicitly benchmarking the low-latency queue configuration

### 🧪 Testing

- Added regression coverage for token refresh replay, interceptor cleanup, queue wait metrics, retry-disabled terminal failures, request store eviction, benchmark helper utilities, error standardization, auth and metadata safety, lifecycle teardown, caching storage adapters, dependency gatekeeping, and expanded event-surface typing tests
- Full suite validated at `67/67` test suites and `675/675` tests passing
- Release benchmark suite validated at `7/7` benchmarks passing

### 📚 Documentation

- Updated the README to reflect the current core-vs-plugin public API, per-plugin entry points, core blocking (`blockingPriorityThreshold`), metrics and sanitization plugins, token-refresh no-token opt-out, and current benchmark and test counts
- Added and refined the `1.x` → `2.0` migration guide (constructor `hooks` removal, `RequestDependencyPlugin` → core gating, metrics recorder shape, metrics vs manual-replay ordering, barrel deprecation notes)
- Refreshed `SECURITY.md` supported-version policy for `2.x` and manual-replay wording after root replay removal
- Refreshed `KNOWN_ISSUES.md` for `2.0` behavior, blocking-resolution semantics, and current test metadata
- Removed obsolete `PRODUCTION_READINESS.md`; use `README.md` and `BENCHMARK_RESULTS.md` for performance and validation context
- Added full documentation website (`website/`) built with Astro — covers all features, shipped plugins, guides, and API reference in detail
- Minimized `README.md` to a concise NPM landing page with a link to the documentation website
- Aligned agent manifests (`AGENTS.md`, `CLAUDE.md`) with the pipeline / interceptor architecture

## 1.5.2 - 27.05.2025

**🎯 MAJOR MILESTONE**: Comprehensive integration test suite added with 90%+ edge case and error scenario coverage

### Added benchmark results

### 🧪 **Testing & Quality Improvements**

- **MAJOR**: Added comprehensive integration test suite covering edge cases and error scenarios
  - 📊 **54 integration tests** across 4 test suites with **100% success rate**
  - 🎯 **90%+ coverage** of edge cases and error scenarios (up from 40-60%)
  - ⚡ **17 seconds** total test runtime - fast and reliable

### 🐛 **Bug Fixes**

- **Fixed Plugin Lifecycle Issues**: Resolved plugin cleanup hooks being called multiple times
  - ✅ Plugin `onBeforeDestroyed` hooks now called exactly once during destruction
  - 🔧 Improved plugin lifecycle management and test isolation

### 📈 **Code Quality**

- **Statement Coverage**: 67% (up significantly from previous versions)
- **Branch Coverage**: 57% (covers critical execution paths)
- **Function Coverage**: 68% (comprehensive API testing)
- **Integration Test Success Rate**: 100% (54/54 tests passing)

### 📚 **Documentation Updates**

- **Updated KNOWN_ISSUES.md**: Marked resolved issues and improved test coverage metrics
- **Enhanced Test Documentation**: Comprehensive integration test suite documentation

## 1.5.0 - 23.05.2025

- **Performance Improvements**:

  - 🚀 **MAJOR**: Replaced O(n²) priority queue with O(log n) binary heap implementation - **100x better scaling**
  - ⚡ **MAJOR**: Fixed timer accumulation and event loop congestion with comprehensive TimerManager
  - **Result**: Eliminates memory leaks and dramatically improves high-volume performance

- **Test Coverage & Validation**:

  - 📈 Improved test coverage: **89.39% statements** (up from ~63%), **370 total tests** passing
  - 🏁 Added comprehensive benchmark suite with 4 testing scenarios
  - 📊 Validated **232 req/sec** throughput, **0 memory leaks**, **100% plugin compatibility**

- **Production Readiness**:

  - 🔧 Fixed TokenRefreshPlugin registration issues - achieved **100% success rate**
  - 📚 Updated documentation with validated performance data and deployment guidance

- **API Enhancements**:
  - 🆕 Added timer management APIs: `getTimerStats()`, enhanced `destroy()` method
  - 📊 Enhanced metrics with `timerHealth` monitoring and health score

## 1.4.8 - 19.05.2025

- **Fixed RequestQueue.getWaiting Method**: Restored backward compatibility by ensuring `getWaiting()` returns a copy of the array, maintaining compatibility with code that modifies the returned array.
- **Memory Optimizations**: Improved memory efficiency in high-volume request handling with proper cleanup of completed requests and optimized queue operations.

## 1.4.7 - 14.04.2025

- **Fixed RequestQueue.isBusy Behavior**: Fixed a logical error in the `isBusy` getter that was returning the opposite of expected behavior. Now correctly returns `true` when there are waiting or in-progress requests.
- **Enhanced Test Coverage**: Added comprehensive test suites for RequestQueue and RetryManager:
  - Added advanced edge case tests for RequestQueue handling
  - Added tests for binary insertion with multiple items in different order
  - Added tests for cancellation handling in the middle of a queue
  - Added tests for critical request blocking scenarios
  - Added basic and integration tests for RetryManager
- **Added per-request caching options**: Added per-request caching configuration `__cachingOptions`, allowing users to override global caching settings for specific requests.

## 1.4.4 - 13.04.2025

- **Fixed CachingPlugin**: Fixed bugs in the CachingPlugin's `runCacheCleanup` method:
  - Fixed issue with maxItems enforcement where oldest items weren't properly removed
  - Improved TypeScript compatibility when iterating through cache entries
  - Fixed edge cases with expired items not being properly cleaned up
- **Improved Test Suite**: Fixed and improved tests for CachingPlugin to avoid timing issues and race conditions

## 1.4.2 - 09.04.2025

- **Tree-Shakeable React Hooks**: Removed temporarily

## 1.4.1 - 09.04.2025

- **Queue Size Limits**: Added the `maxQueueSize` option to limit the number of requests that can be queued. When the queue is full, new requests will be rejected with `QueueFullError`. Prevents memory issues during high load.
- **Sensitive Data Protection**: Added redaction support for tokens, passwords, and other sensitive information in logs and error reporting. This now lives on the sanitization plugin surface.
- **Enhanced CircuitBreakerPlugin**: Added advanced features to the CircuitBreaker including sliding window analysis, adaptive timeouts, URL exclusion patterns, configurable success thresholds, and detailed monitoring metrics for more sophisticated failure detection and recovery.
- **Tree-Shakeable React Hooks**: Made React hooks individually importable via subpaths (e.g., `import { useGet } from 'axios-retryer/react/hooks/useGet'`) to reduce bundle size through tree shaking.
- **Custom Error Detection for TokenRefreshPlugin**: Added support for detecting auth errors in 200 OK responses through customErrorDetector option, useful for GraphQL and other APIs that return errors in the response body rather than HTTP status codes.
- **Enhanced CachingPlugin Integration**: Updated `useAxiosRetryerMutation` to properly integrate with the CachingPlugin for fine-grained cache invalidation.
- **Improved Cache Invalidation**: Added specific cache key invalidation to CachingPlugin with both exact matching and pattern matching support.
- **Error Handling Improvements**: Added proper error handling and validation in React hooks for RetryManager dependencies.

## 1.3.3 - 20.02.2025

- Hooks are deprecated and will be removed in the next major version
- RetryManager refactored and optimized

## 1.3.2 - 13.02.2025

- Added `CircuitBraker` plugin, tests and benchmark for it
- Added `Caching` plugin, tests and benchmark for it
- Made all the plugins tree-shakeable
- Plugins can now initialize before and after the retry manager interceptors `manager.use(plugin: RetryPlugin, beforeRetryerInterceptors = true)`

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
