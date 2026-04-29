# Phase 1 + Phase 3 → 2.3.1

Scope confirmed by maintainer 2026-04-28. Non-breaking only. Behavioral
breaks (S1, R1, R3, R4, R5) are deferred to a future major.

## Phase 1 — non-breaking

- [ ] **A3** Drop `lib: ["DOM", "DOM.Iterable"]` from `tsconfig.build.json` (and core `tsconfig.json` if no DOM types are referenced).
- [ ] **S3** Add `.github/dependabot.yml` for npm + GitHub Actions weekly.
- [ ] **M1/M2** Add `pnpm typecheck && pnpm lint && pnpm build` steps to the `ci` job in `.github/workflows/publish.yml` and require them as a prerequisite to publish.
- [ ] **M6** Add an informational `pnpm audit --prod --audit-level=high` step (does not fail the build).
- [ ] **T1** Run `pnpm test:coverage` once, ratchet jest `coverageThreshold.global` to current measured floor (rounded down to the nearest whole percent).
- [ ] **D2** Add a "Plugin ordering" subsection to `website/src/pages/docs/plugins/caching.astro`.
- [ ] **D4** Document Retry-After cap (5 minutes, `MAX_RETRY_AFTER_MS`) in README.
- [ ] **D1** Add `scripts/update-readme-stats.cjs` that reads test counts from a Jest run and updates README badges. Wire into `package.json:scripts` (manual; not on every install).
- [ ] **R2 (additive)** Add optional `maxBackoffDelayMs` to `RetryManagerOptions`; thread through `DefaultRetryStrategy` → `getBackoffDelay`. Default `60_000` to preserve current behavior.
- [ ] **R6** Make `RequestQueue.markComplete(requestId?)` idempotent per requestId. Track released ids on `RequestLifecycleManager` to prevent double-decrement of inflight count.
- [ ] **O1** Auto-generate `correlationId` in `RequestInterceptor` (defaults to `requestId`; honors `X-Correlation-Id` header). Add to `ALLOWED_METADATA_KEYS` and to log meta in `ErrorInterceptor.buildErrorMeta`.
- [ ] **RL3 (opt-in)** Add `refreshHandlerTimeoutMs` to TokenRefreshPlugin options. Default `0` (off). When set and exceeded, reject the inflight refresh + drain queue with a typed error and reset `isRefreshing`.
- [ ] **RL6** Wrap each listener call in `EventBus.emit/triggerAndEmit` with try/catch + log; never let a listener throw across emission.
- [ ] **M5** Convert `no-console` from `warn` → `error` in src/ only (keep `warn` for tests).
- [x] **A4** Tried enabling `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. **Deferred** — surfaced 49 errors across CircuitBreaker / ManualRetry / TokenRefresh / Metrics; over the 30-error stop threshold. Revisit in a dedicated PR.

## Phase 3 — pure refactor (200-line rule)

- [ ] **A1a** Extract CachingPlugin (713 lines) → `CachingPlugin.ts` (orchestrator) + `managers/CleanupRunner.ts` + `managers/InflightDedupe.ts` + leave existing `utils/key.ts`. Each ≤ 250 lines.
- [ ] **A1b** Extract TokenRefreshPlugin (647 lines) → `TokenRefreshPlugin.ts` (orchestrator) + `managers/RefreshFlow.ts` + `managers/RefreshQueueController.ts`.
- [ ] **A1c** Extract CircuitBreakerPlugin (603 lines) → `CircuitBreakerPlugin.ts` (orchestrator) + `managers/ScopeStateUpdater.ts` (maybe more — see what's already in `managers/`).

## Release

- [ ] Bump `package.json` version `2.2.1 → 2.3.1`.
- [ ] Add CHANGELOG entry under `## 2.3.1` enumerating each item above.
- [ ] Final sweep: `pnpm typecheck && pnpm lint && pnpm test:quick && pnpm build`.

## Out of scope (will not be touched in this PR)

- Phase 2 / 3.0.0 behavior breaks: S1, R1, R3, R4, R5.
- Changesets / release automation (M3).
- Husky `pre-push` move of `pnpm build` (M4).
- README stat auto-injection in CI (only the script lands; wiring is later).

## Working rules

- One commit per item, conventional-commit format.
- Run `pnpm typecheck && pnpm test:quick` after each item before committing.
- If something exceeds the planned blast radius, STOP and re-plan, do not improvise.
