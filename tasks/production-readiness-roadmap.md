# Production-Readiness Roadmap — Task Pack

**Audience:** A junior coding agent (low-tier model) executing tasks one at a time.
**Project:** `axios-retryer` v2.2.1.
**Goal:** Drive the library from grade B+ to grade A by closing concrete, well-bounded gaps identified in the production-readiness review dated 2026-04-28.

---

## How to use this document

1. **Work tasks in order.** Sprints 1 → 4. Inside a sprint, tasks are independent unless noted.
2. **One task = one PR.** Do not bundle.
3. **Each task is a contract.** It tells you exactly:
   - The file(s) to touch.
   - What the file currently contains (so you can recognize success).
   - The exact change to make.
   - The acceptance check (a command you run to prove success).
   - What you must NOT do.
4. **Stop and ask if reality contradicts the task description.** If the line numbers don't match, if the code doesn't look as described, if a test you didn't expect breaks — STOP. Re-read, then ask. Do not improvise.
5. **TDD where the task says "write a failing test first."** Otherwise just edit the code and re-run the existing tests.
6. **Always run before opening a PR:**
   ```
   pnpm typecheck && pnpm lint && pnpm test:quick
   ```

---

## Universal rules (apply to every task)

**You MUST:**

- Use `unknown` + a type-guard, never `any`. ESLint will fail on `any`.
- Add explicit return types to every new or edited function (`: void`, `: Promise<X>`, etc.).
- Keep edits minimal. Touch only what the task requires.
- Use existing helpers (`getRequestMetadata`, `assignRequestMetadata`, `setRequestMetadataValue`) when working with request metadata. Do not spread `{ ...config }` unless the task says to.
- Match existing code style (Prettier 3.4.2, printWidth 120, semicolons on, single quotes).
- Use conventional commit format: `fix(scope): …`, `feat(scope): …`, `refactor(scope): …`, `test(scope): …`, `chore(scope): …`.

**You MUST NOT:**

- Add a property to `RetryManagerOptions` for niche behavior. (Build a plugin instead — but that's out of scope of these tasks; if a task ends up needing a new top-level option, STOP and ask.)
- Add `EventBus.emit()` calls deep inside an algorithm. Collect events as values; emit at the boundary.
- Have the core invoke a plugin method directly. Plugins listen to events.
- Use `as any` or `as unknown as X` to force a cast. Use a type guard.
- Skip git hooks (`--no-verify`).
- Amend commits or force-push.
- Create new top-level documentation files (READMEs, summaries) unless the task explicitly says so.

**File-size rule:** No file over 200 lines. If a task makes a file cross 200 lines, the task description will tell you where to extract. Do not invent extractions on your own.

---

# SPRINT 1 — Quality gates and bounded resources

These are mechanical and high-impact. Do them first.

---

## Task 1.1 — Enable `no-floating-promises` ESLint rule

**Severity:** High. Floating promises are dangerous in a retry library.

**File:** `eslint.config.mjs`

**Current state (lines 9–34):**

```js
{
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': [...],
    '@typescript-eslint/no-unused-vars': [...],
    'no-unused-private-class-members': 'error',
    '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true, allowTypedFunctionExpressions: true }],
    '@typescript-eslint/no-require-imports': 'error',
    'no-console': 'warn',
  },
},
```

**Change:** Inside the `rules` block (the one that applies to all files, lines 10–33), add:

```js
'@typescript-eslint/no-floating-promises': 'error',
```

Place it after `'@typescript-eslint/no-explicit-any': 'error',`.

**Then run:**

```
pnpm lint
```

**Expected outcome:** Lint will likely report violations in `src/`. For each violation:

- If the promise is intentionally fire-and-forget, prefix it with `void`. Example: `void this.runCacheCleanup().catch(...)`.
- If the call should be awaited, await it.
- If unsure, STOP and report the file/line. Do not guess.

**Acceptance:**

- `pnpm lint` passes.
- `pnpm test:quick` passes.
- `pnpm typecheck` passes.

**Commit message:** `chore(lint): enable @typescript-eslint/no-floating-promises and fix violations`

---

## Task 1.2 — Add Jest coverage thresholds

**Severity:** High. We have ~1,000 tests but no gate stopping coverage from regressing.

**File:** `jest.config.cjs`

**Current state:**

```js
module.exports = {
  testEnvironment: 'node',
  verbose: false,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: './tsconfig.test.json' }] },
  coveragePathIgnorePatterns: [
    '<rootDir>/benchmark/',
    '<rootDir>/__tests__/performance/utils/',
    '<rootDir>/__tests__/helpers/',
  ],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['**/__tests__/**/*.test.ts'],
};
```

**Change:** Add a `coverageThreshold` block. Use intentionally conservative starting numbers — the goal is to catch regressions, not to force a coverage push right now.

```js
coverageThreshold: {
  global: {
    branches: 75,
    functions: 80,
    lines: 85,
    statements: 85,
  },
},
```

Place it directly after `coveragePathIgnorePatterns`.

**Then run:**

```
pnpm test:coverage
```

**Expected outcome:** All thresholds pass (current coverage is well above these floors). If any threshold fails, **lower that single threshold by 5 percentage points and try again** — do not raise it above current coverage. Report the final numbers in the PR description.

**Acceptance:**

- `pnpm test:coverage` exits 0.
- The numbers in `coverageThreshold.global` are at or below the current measured coverage.

**Commit message:** `test(coverage): enforce minimum coverage thresholds in jest config`

---

## Task 1.3 — Make tsconfig.build.json match source strictness

**Severity:** High. Source enforces `verbatimModuleSyntax: true`, build silently disables it.

**File:** `tsconfig.build.json`

**Current state:**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": [],
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "declaration": true,
    "declarationDir": "dist/types",
    "declarationMap": false,
    "outDir": "dist",
    "rootDir": "src",
    "target": "ES2019",
    "module": "ESNext",
    "moduleResolution": "Node",
    "sourceMap": false,
    "noEmit": false,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "__tests__"]
}
```

**Change two things:**

1. Set `"verbatimModuleSyntax": true`.
2. Drop DOM types from build lib: `"lib": ["ESNext"]`. (The browser bundle is built separately via `BUILD_BROWSER=true` env var; the default Node build does not need DOM.)

**Then run:**

```
pnpm build
```

**Expected outcome:** Build may report errors in `src/` about mixed type/value imports. For each error, change the import to use the `type` modifier inline:

```ts
// before
import { Foo, type Bar } from './x'; // already correct
import { Foo, Bar } from './x'; // becomes:
import { type Bar, Foo } from './x';
```

ESLint's `consistent-type-imports` rule with `fixStyle: 'inline-type-imports'` will auto-fix most of these:

```
pnpm lint:fix
```

If `pnpm build` complains about a missing DOM type (e.g. `Blob`, `Headers`, `AbortSignal`), STOP. Some of those may legitimately be needed. Report the file:line and ask before proceeding.

**Acceptance:**

- `pnpm build` exits 0.
- `pnpm typecheck` exits 0.
- `pnpm test:quick` exits 0.
- The bundled `dist/index.d.ts` no longer references `lib.dom.d.ts` types unnecessarily.

**Commit message:** `build(tsconfig): tighten build tsconfig — verbatimModuleSyntax and drop DOM lib`

---

## Task 1.4 — Cap the token-refresh queue

**Severity:** High (security + reliability). `SECURITY.md` already documents this risk.

**Files:**

- `src/plugins/TokenRefreshPlugin/configs/index.ts` (defaults)
- `src/plugins/TokenRefreshPlugin/types/index.ts` (option shape)
- `src/plugins/TokenRefreshPlugin/TokenRefreshPlugin.ts` (enforcement)
- `src/plugins/TokenRefreshPlugin/errors/` (new error class)

**Step 1 — write the failing test FIRST.**

Create `__tests__/p0-token-refresh-queue-cap.test.ts`. It should:

- Configure a `TokenRefreshPlugin` with `maxQueuedRequests: 3`.
- Issue 5 concurrent requests that all 401.
- Stub the token refresh handler so it never resolves (use a dangling promise).
- Assert that exactly 3 requests are pending and 2 reject with a `TokenRefreshQueueOverflowError`.

Use an existing token-refresh test as a template (`__tests__/TokenRefreshPlugin.test.ts`).

Run it — it must fail.

**Step 2 — add the error class.**

Create `src/plugins/TokenRefreshPlugin/errors/TokenRefreshQueueOverflowError.ts`:

```ts
import { AxiosRetryerError } from '../../../core/errors/AxiosRetryerError';

export class TokenRefreshQueueOverflowError extends AxiosRetryerError {
  public readonly code = 'TOKEN_REFRESH_QUEUE_OVERFLOW';

  constructor(public readonly queueSize: number) {
    super(`Token refresh queue overflowed: ${queueSize} requests pending.`);
    this.name = 'TokenRefreshQueueOverflowError';
  }
}
```

Re-export it from `src/plugins/TokenRefreshPlugin/errors/index.ts`.

**Step 3 — add the option.**

In `src/plugins/TokenRefreshPlugin/types/index.ts`, add to the options interface:

```ts
/**
 * Maximum number of requests that may queue while a token refresh is in flight.
 * Excess requests reject with TokenRefreshQueueOverflowError. Default: 500.
 */
maxQueuedRequests?: number;
```

**Step 4 — set the default.**

In `src/plugins/TokenRefreshPlugin/configs/index.ts`, add `maxQueuedRequests: 500` to the defaults object.

**Step 5 — enforce in the plugin.**

In `TokenRefreshPlugin.ts`, find the request-interceptor logic that pushes onto `refreshQueue`. Before pushing, check the size:

```ts
if (this.refreshQueue.length >= this._options.maxQueuedRequests) {
  return Promise.reject(new TokenRefreshQueueOverflowError(this.refreshQueue.length));
}
```

**Step 6 — re-run the test.** Must pass.

**Step 7 — update docs.**

- `SECURITY.md`: change the "queue not capped" caveat to describe the new default.
- `CHANGELOG.md`: add a `feat(token-refresh)` entry.
- `README.md`: if the README documents `TokenRefreshPlugin` options, list `maxQueuedRequests`.

**Acceptance:**

- `pnpm test:quick` passes (including new test).
- `pnpm typecheck && pnpm lint` pass.

**Commit message:** `feat(token-refresh): cap pending request queue with TokenRefreshQueueOverflowError`

---

## Task 1.5 — Wrap `runCacheCleanup` in a timeout

**Severity:** High. Currently a hung storage adapter accumulates pending promises forever.

**File:** `src/plugins/CachingPlugin/CachingPlugin.ts`

**Current state (lines 369–386):**

```ts
private startPeriodicCleanup(): void {
  if (this.cleanupTimer) return;
  this.cleanupTimer = setInterval(() => {
    void this.runCacheCleanup().catch((error: unknown) => {
      this.context.getLogger()?.warn('[CachingPlugin] Failed to run cache cleanup', getErrorMeta(error));
    });
  }, this.options.cleanupInterval);
}
```

**Change:**

1. Add a private constant near the top of the class: `private static readonly CACHE_CLEANUP_TIMEOUT_MS = 30_000;`.
2. Add a private counter field: `private cleanupConsecutiveFailures = 0;`.
3. Add a private constant: `private static readonly CACHE_CLEANUP_DISABLE_AFTER = 5;`.
4. Replace the body of `setInterval` callback so it:
   - Races `runCacheCleanup()` against a `setTimeout` rejection of `CACHE_CLEANUP_TIMEOUT_MS`.
   - On success, resets `cleanupConsecutiveFailures = 0`.
   - On failure, logs warn + increments counter; if counter ≥ `CACHE_CLEANUP_DISABLE_AFTER`, calls `this.stopPeriodicCleanup()` and logs error: `'[CachingPlugin] Disabling cleanup after repeated failures'`.

Pseudocode skeleton (write proper TypeScript):

```ts
this.cleanupTimer = setInterval(() => {
  const timeoutMs = CachingPlugin.CACHE_CLEANUP_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('cache cleanup timeout')), timeoutMs),
  );

  void Promise.race([this.runCacheCleanup(), timeout])
    .then(() => {
      this.cleanupConsecutiveFailures = 0;
    })
    .catch((error: unknown) => {
      this.cleanupConsecutiveFailures += 1;
      this.context.getLogger()?.warn('[CachingPlugin] Failed to run cache cleanup', getErrorMeta(error));
      if (this.cleanupConsecutiveFailures >= CachingPlugin.CACHE_CLEANUP_DISABLE_AFTER) {
        this.context.getLogger()?.error('[CachingPlugin] Disabling cleanup after repeated failures');
        this.stopPeriodicCleanup();
      }
    });
}, this.options.cleanupInterval);
```

**Step — write a test first** in `__tests__/p1-caching-plugin.test.ts` (or a new sibling file) that:

- Sets a small `cleanupInterval`.
- Stubs the storage adapter so `clear()` (or whatever cleanup calls) returns a never-resolving promise.
- Uses `jest.useFakeTimers()` to advance time.
- Asserts that after 5 consecutive timeouts, `cleanupTimer` is null.

**Acceptance:**

- New test passes.
- All existing tests pass.
- `pnpm typecheck && pnpm lint` pass.

**Commit message:** `fix(caching): timeout and auto-disable cache cleanup on repeated failures`

---

## Task 1.6 — Surface queue-gate exceptions

**Severity:** High. A throwing custom gate currently silently stalls the queue head.

**File:** `src/core/requestQueue.ts`

**Current state (lines 455–461):**

```ts
private evaluateGate(gate: (request: AxiosRequestConfig) => boolean, config: AxiosRequestConfig): boolean {
  try {
    return gate(config);
  } catch {
    return false;
  }
}
```

**Change:** Log the exception and emit an event so consumers can react.

```ts
private evaluateGate(gate: (request: AxiosRequestConfig) => boolean, config: AxiosRequestConfig): boolean {
  try {
    return gate(config);
  } catch (error) {
    this.logger.error('Queue gate threw; treating as not-ready', {
      requestId: getRequestMetadata(config)?.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
```

You may need to import `getRequestMetadata` if it isn't already imported. Check the top of the file first.

**Test:** Add a test in `__tests__/RequestQueue.advanced-edge-cases.test.ts` that:

- Registers a processing gate that throws.
- Enqueues a request.
- Asserts the logger received an `error`-level entry (mock the logger).

**Acceptance:**

- New test passes; existing queue tests still pass.
- `pnpm typecheck && pnpm lint` pass.

**Commit message:** `fix(queue): log queue-gate exceptions instead of silently dropping`

---

## Task 1.7 — Fix sliding-window failure-count drift in CircuitBreaker

**Severity:** High. `failureCount` increments forever even as recent failures expire from the sliding window.

**File:** `src/plugins/CircuitBreakerPlugin/CircuitBreakerPlugin.ts`

**Current state (lines 495–509):**

```ts
scopeState.failureCount++;
this._cleanupOldFailures(scopeState);
}

private _cleanupOldFailures(scopeState: CircuitBreakerScopeState): void {
  if (!this._options.useSlidingWindow) return;
  const windowStart = Date.now() - this._options.slidingWindowSize;
  scopeState.recentFailures = scopeState.recentFailures.filter((f) => f.timestamp >= windowStart);
}

private _getFailureCountInWindow(scopeState: CircuitBreakerScopeState): number {
  if (!this._options.useSlidingWindow) return scopeState.failureCount;
  this._cleanupOldFailures(scopeState);
  return scopeState.recentFailures.length;
}
```

**Change:** When sliding window is enabled, `_cleanupOldFailures` must also decrement `failureCount` to match the size of `recentFailures`.

```ts
private _cleanupOldFailures(scopeState: CircuitBreakerScopeState): void {
  if (!this._options.useSlidingWindow) return;
  const windowStart = Date.now() - this._options.slidingWindowSize;
  const before = scopeState.recentFailures.length;
  scopeState.recentFailures = scopeState.recentFailures.filter((f) => f.timestamp >= windowStart);
  const evicted = before - scopeState.recentFailures.length;
  if (evicted > 0) {
    scopeState.failureCount = Math.max(0, scopeState.failureCount - evicted);
  }
}
```

**Test:** In `__tests__/CircuitBreakerPluginEnhanced.test.ts` add a test that:

- Configures `useSlidingWindow: true, slidingWindowSize: 100` (ms).
- Triggers 3 errors, advances time past 100 ms, triggers 1 more error.
- Asserts `failureCount === 1` (not 4).

Use `jest.useFakeTimers({ now: <fixed> })` and `jest.advanceTimersByTime`.

**Acceptance:**

- New test passes.
- All existing CircuitBreaker tests still pass.

**Commit message:** `fix(circuit-breaker): decrement failureCount when sliding window evicts entries`

---

## Task 1.8 — Case-insensitive idempotency-header check

**Severity:** Medium. POST/PUT/PATCH retry should fire when the user provides `idempotency-key` in any case.

**File:** `src/core/strategies/DefaultRetryStrategy.ts`

**Current state (lines 113–120):**

```ts
if (
  (method === 'post' || method === 'put' || method === 'patch') &&
  this.idempotencyHeaders.some((header) => !!config.headers?.[header])
) {
  this.logger?.debug(`Retrying idempotent request with method ${method}`);
  return true;
}
```

**Change:** Compare lowercased keys.

```ts
if (method === 'post' || method === 'put' || method === 'patch') {
  const headerKeys = Object.keys(config.headers ?? {}).map((k) => k.toLowerCase());
  const idempotencyKeysLower = this.idempotencyHeaders.map((h) => h.toLowerCase());
  if (idempotencyKeysLower.some((needle) => headerKeys.includes(needle))) {
    this.logger?.debug(`Retrying idempotent request with method ${method}`);
    return true;
  }
}
```

Consider precomputing `idempotencyKeysLower` in the constructor (similar to `retryableMethodsLower` already used in the same file). If you do, store it as `private readonly idempotencyHeadersLower: string[]`.

**Test:** Add a case to `__tests__/DefaultRetryStrategy.test.ts`:

- Set headers `{ 'idempotency-key': 'abc' }` (lowercase) on a POST request.
- Assert `getIsRetryable` returns true.

**Acceptance:**

- New test passes; existing tests still pass.

**Commit message:** `fix(retry-strategy): match idempotency headers case-insensitively`

---

# SPRINT 2 — Architectural cleanup

These tasks bring oversized files back inside the 200-line rule. Each task extracts a single, named responsibility. Do them one at a time.

---

## Task 2.1 — Extract `PriorityHeap` from `requestQueue.ts`

**Severity:** High. `requestQueue.ts` is 462 lines.

**Source:** `src/core/requestQueue.ts` lines roughly 24–120 (the `PriorityHeap` class and its helpers).

**Step 1.** Create `src/core/utils/PriorityHeap.ts`. Copy the `PriorityHeap` class verbatim. Add the imports it needs.

**Step 2.** Add an explicit, exported public surface for `PriorityHeap` (its constructor, `push`, `pop`, `peek`, `clear`, `size`, plus whatever else `requestQueue.ts` uses). Mark internal helpers `private`.

**Step 3.** In `requestQueue.ts`, delete the inlined class and replace with `import { PriorityHeap } from './utils/PriorityHeap';`.

**Step 4.** Co-locate a unit test: `src/core/utils/PriorityHeap.test.ts`. Cover push order, pop order, peek, clear, size, and stable order for equal priorities.

**Step 5.** Verify file size: `wc -l src/core/requestQueue.ts` — should now be < 350. `wc -l src/core/utils/PriorityHeap.ts` — should be < 150.

**Acceptance:**

- Both new file under 200 lines.
- All existing tests pass.
- `pnpm typecheck && pnpm lint` pass.

**Do NOT:**

- Change the heap algorithm.
- Rename any method.
- Touch unrelated files.

**Commit message:** `refactor(queue): extract PriorityHeap to its own module`

---

## Task 2.2 — Extract `RetryDecisionEngine` from `ErrorInterceptor.ts`

**Severity:** High. `ErrorInterceptor.ts` is 257 lines and mixes pure decision logic with side effects.

**Goal:** Pull the pure question "given this error and metadata, what should we do?" into a stateless engine. The interceptor stays in charge of orchestration (logging, event emission, dispatch).

**Step 1.** Create `src/core/interceptors/RetryDecisionEngine.ts`.

Define an output type:

```ts
export type RetryDecision =
  | { kind: 'retry'; attempt: number; maxRetries: number; retryAfterMs: number }
  | { kind: 'no-retry'; retryable: boolean }
  | { kind: 'cancel' };
```

Export a pure function `decideRetry(input: { error: AxiosError; metadata: RequestMetadata; defaultMaxRetries: number; defaultMode: RetryMode; strategy: RetryStrategy; cancelledInQueue: boolean }): RetryDecision`.

Move the logic currently at `ErrorInterceptor.ts` lines 73–98 into this function. `decideRetry` must not call `emitEvent`, must not call the logger, must not touch the request queue. Pure inputs → output.

**Step 2.** In `ErrorInterceptor.handleError`, replace the inline decision logic with a single call to `decideRetry(...)`, then `switch` on `decision.kind` to drive the existing `scheduleRetry` / `handleNoRetriesAction` paths.

**Step 3.** Add unit tests at `src/core/interceptors/RetryDecisionEngine.test.ts` that exercise each branch with crafted inputs — no axios, no mocks of the manager.

**Step 4.** Verify file size: `wc -l src/core/interceptors/ErrorInterceptor.ts` should now be ≤ 200.

**Acceptance:**

- New decision-engine tests pass.
- All existing tests pass.
- ErrorInterceptor.ts ≤ 200 lines.

**Do NOT:**

- Move event emission into the decision engine.
- Move the `scheduleRetry` method.
- Change which events are emitted or in what order.

**Commit message:** `refactor(error-interceptor): extract pure RetryDecisionEngine`

---

## Task 2.3 — Replace untyped `emitEvent` callbacks with typed descriptors

**Severity:** High. `(event: string, ...args: unknown[]) => void` defeats the entire event-typing system.

**Files (callers and definitions):**

- `src/core/interceptors/ErrorInterceptor.ts` (`ErrorInterceptorOptions.emitEvent`, line 30)
- `src/core/interceptors/RequestInterceptor.ts`
- `src/core/interceptors/ResponseInterceptor.ts`
- `src/core/DependencyGatekeeper.ts`
- `src/core/RetryManager.ts` (where these callbacks are constructed, around lines 150–184)
- `src/types/events.ts` (event-name-to-payload map)

**Step 1.** In `src/types/events.ts`, find the existing `CoreRetryEvents` interface (or whatever maps event names to payload shapes). If it doesn't already exist as a strict map, build one. Then add:

```ts
export type CoreRetryEventName = keyof CoreRetryEvents;
export type CoreRetryEventPayload<K extends CoreRetryEventName> = CoreRetryEvents[K];
export type EmitCoreEvent = <K extends CoreRetryEventName>(event: K, ...args: CoreRetryEventPayload<K>) => void;
```

The exact names depend on what already exists — read `events.ts` first and reuse what's there.

**Step 2.** Replace every `emitEvent: (event: string, ...args: unknown[]) => void` with `emitEvent: EmitCoreEvent`.

**Step 3.** Fix any call sites where the wrong number/type of args is passed (the compiler will tell you).

**Step 4.** STOP if `pnpm typecheck` reports more than 30 errors. Report what you found and ask. We may need to refine the event map first.

**Acceptance:**

- `pnpm typecheck && pnpm lint && pnpm test:quick` all pass.
- No `as unknown` or `as any` added to make this compile.

**Commit message:** `refactor(events): type-safe event emission via EmitCoreEvent`

---

## Task 2.4 — Fix `ManualRetryPlugin` header-clearing pattern

**Severity:** Medium. `undefined as unknown as string` violates the type contract. Clearing a header should be `delete`.

**File:** `src/plugins/ManualRetryPlugin/utils/index.ts:97`

**Current state:**

```ts
config.headers[headerName] = undefined as unknown as string;
```

**Change:** Use the appropriate API. Inspect the surrounding code first — `config.headers` may be an `AxiosHeaders` instance or a plain object.

- If plain object: `delete config.headers[headerName];`
- If `AxiosHeaders`: `config.headers.delete(headerName);`
- Mixed/unknown: use a guard: `if (typeof (config.headers as { delete?: unknown }).delete === 'function') { (config.headers as AxiosHeaders).delete(headerName); } else { delete (config.headers as Record<string, unknown>)[headerName]; }`

Pick the simplest option that fits how the function is called.

**Test:** Look at existing tests for this util in `__tests__/`. Adjust if any explicitly check for `undefined` (they should check for absence instead).

**Acceptance:**

- All tests pass.
- No `as unknown as string` remaining in `src/plugins/ManualRetryPlugin/`.

**Commit message:** `fix(manual-retry): use delete for header clearing instead of unsafe cast`

---

## Task 2.5 — Tighten `clone.ts` `toJSON` type guard

**Severity:** Medium. Dual-cast hides a bug if `toJSON` is not a function.

**File:** `src/utils/clone.ts:90`

**Current state:**

```ts
const jsonValue = value as unknown as { toJSON?: () => unknown };
if (typeof jsonValue.toJSON === 'function') { ... }
```

**Change:** Use a real type guard. Add at the top of the file:

```ts
function hasToJson(value: unknown): value is { toJSON: () => unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function';
}
```

Replace the unsafe cast with `if (hasToJson(value)) { ... use value.toJSON() ... }`.

**Test:** Add to `__tests__/Utils.test.ts` a case where input has `toJSON: 123` (not a function). The clone should not crash and should fall through to other branches.

**Acceptance:**

- New test passes.
- Existing clone tests still pass.

**Commit message:** `fix(clone): use proper type guard for toJSON detection`

---

# SPRINT 3 — Observability and security hardening

---

## Task 3.1 — Propagate a `correlationId` through metadata and logs

**Severity:** Medium. Distributed tracing is impossible without a stable id across retry attempts.

**Files:**

- `src/utils/requestMetadata.ts` (add `correlationId` to allowed keys + interface)
- `src/types/options.ts` or wherever `RequestMetadata` is typed (add field)
- Every site that calls `logger.error/warn/debug/info` with a `requestId` field.

**Step 1.** In `requestMetadata.ts`, add `'correlationId'` to `ALLOWED_METADATA_KEYS`. Add the field to the metadata interface:

```ts
correlationId?: string;
```

**Step 2.** In the request-interceptor, after generating `requestId`, also generate (or read from a header) `correlationId`. If the user supplies `X-Correlation-Id` in the request headers, prefer that. Otherwise reuse `requestId`.

**Step 3.** Audit `src/core/interceptors/ErrorInterceptor.ts` (`buildErrorMeta` at lines 206–217). Add `correlationId` to the meta object.

**Step 4.** Same for any `logger.warn/debug/info` in `RetryScheduler.ts`, `RequestLifecycleManager.ts`, `requestQueue.ts`, `DependencyGatekeeper.ts`. Use ripgrep to find them.

**Step 5.** Add a unit test that asserts `correlationId` flows through to log calls (mock the logger and inspect calls).

**Acceptance:**

- All tests pass.
- A request that fails and retries logs the same `correlationId` on both attempts.

**Commit message:** `feat(observability): add correlationId to request metadata and all logs`

---

## Task 3.2 — Emit `onRetryTimerCancelled` event

**Severity:** Medium.

**Files:**

- `src/types/events.ts` — add the event name + payload to `CoreRetryEvents`.
- `src/core/RetryScheduler.ts` — accept an optional `emitEvent` callback in the constructor; call it from `cancelRetryTimer` and `cancelAllRetryTimers`.
- `src/core/RetryManager.ts` — wire the callback when constructing the scheduler.

**Step 1.** In `events.ts`, add:

```ts
onRetryTimerCancelled: [{ requestId: string; source: 'user' | 'system' }];
```

**Step 2.** Update `RetryScheduler` constructor:

```ts
constructor(
  private readonly logger: Logger,
  private readonly retryStrategy: RetryStrategy,
  private readonly emitEvent?: EmitCoreEvent,
) {}
```

**Step 3.** In `cancelRetryTimer`, after the existing log line, emit:

```ts
this.emitEvent?.('onRetryTimerCancelled', { requestId, source: 'user' });
```

In `cancelAllRetryTimers`, emit per-id with `source: 'system'`.

**Step 4.** In `RetryManager.ts` where `RetryScheduler` is constructed, pass the existing event-emitter callback.

**Step 5.** Test in `__tests__/p1-request-lifecycle-retry-scheduler.test.ts`.

**Acceptance:**

- New test passes; existing scheduler tests pass.
- The event appears in the public events typings (`pnpm typecheck` happy).

**Commit message:** `feat(events): emit onRetryTimerCancelled with source attribution`

---

## Task 3.3 — Default-redact auth headers in `ManualRetryPlugin.prepareRequestForStore`

**Severity:** Medium. Storing failed requests including `Authorization` is a security footgun.

**File:** `src/plugins/ManualRetryPlugin/ManualRetryPlugin.ts` (search for `prepareRequestForStore`).

**Step 1.** Read the current `prepareRequestForStore` default. It probably returns the config as-is.

**Step 2.** Replace the default with one that strips `authorization`, `cookie`, `proxy-authorization`, `x-api-key` (case-insensitive) from a _copy_ of the config headers before returning. Do not mutate the caller's config.

```ts
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);

function defaultPrepareRequestForStore(config: AxiosRequestConfig): AxiosRequestConfig {
  if (!config.headers) return config;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config.headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) cleaned[key] = value;
  }
  return { ...config, headers: cleaned as AxiosRequestConfig['headers'] };
}
```

**Step 3.** Document in the plugin's JSDoc and in `SECURITY.md` that auth headers are stripped by default and must be reattached by the user-supplied retry handler.

**Step 4.** Add a test in `__tests__/p1-manual-retry-metrics.test.ts` (or similar) that asserts a stored request does not contain `Authorization`.

**Acceptance:**

- New test passes.
- Existing tests pass — if any rely on the old "store everything" behavior, update them to opt out via a custom `prepareRequestForStore`.

**Commit message:** `fix(manual-retry): redact sensitive headers in default prepareRequestForStore`

---

## Task 3.4 — Document plugin order requirement for caching dedup

**Severity:** Medium (docs-only).

**File:** `README.md` and/or `website/src/pages/docs/plugins/caching.*` (whichever exists — check first).

**Change:** Add a "Plugin Ordering" subsection under the CachingPlugin docs:

> **Order matters.** `CachingPlugin` must be registered **after** any plugin that mutates `config` (e.g. `TokenRefreshPlugin`). Inflight deduplication uses the metadata `requestId` assigned by the core request interceptor; if a plugin spreads `config` before that id is set, two concurrent requests for the same resource may dedupe separately.

Also add a runtime warning in `CachingPlugin.ts` when the WeakMap fallback path triggers in non-test mode (look for an existing logger-based warn template).

**Acceptance:**

- README/website renders correctly.
- New warn message exercised by an existing test (or added).

**Commit message:** `docs(caching): document plugin order requirement and add runtime warning`

---

# SPRINT 4 — Polish

---

## Task 4.1 — Adopt `changesets` for releases

**Out of scope for a low-tier model.** This task requires npm credential scope and CI changes; skip and report to maintainer.

---

## Task 4.2 — Ship sourcemaps

**File:** `rollup.config.js` (line ~59 sets `sourcemap: false` globally).

**Change:** Set `sourcemap: true` for all output formats. Also update `package.json:files[]` to include `dist/**/*.js.map` and `dist/**/*.d.ts.map` (only if `.d.ts.map` files are produced — they aren't unless `declarationMap: true` is set; do not enable that here).

**Acceptance:**

- `pnpm build` produces `dist/index.cjs.js.map` and `dist/index.esm.js.map`.
- `npm pack --dry-run` shows the maps included.

**Commit message:** `build: ship sourcemaps for ESM and CJS bundles`

---

## Task 4.3 — Add `pre-push` hook running `pnpm test:quick`

**File:** `.husky/pre-push` (create).

**Content:**

```sh
pnpm test:quick
```

Make it executable: `chmod +x .husky/pre-push`.

**Optional companion:** Move `pnpm build` from `.husky/pre-commit` into `.husky/pre-push` so commits are fast and pushes still build. Only do this if maintainer signs off — STOP and ask before touching `pre-commit`.

**Acceptance:**

- `git push` (dry-run on a feature branch) runs the test command.
- `pnpm test:quick` exits 0.

**Commit message:** `chore(husky): add pre-push hook running test:quick`

---

## Task 4.4 — Emit `dist/.buildinfo.json`

**File:** `rollup.config.js` (post-build hook) or a small node script invoked from the `build` script in `package.json`.

**Content of `.buildinfo.json`:**

```json
{
  "version": "<from package.json>",
  "commit": "<from `git rev-parse HEAD`>",
  "builtAt": "<ISO 8601 timestamp>"
}
```

Use a tiny node script (`scripts/write-buildinfo.cjs`) and invoke it from `package.json:scripts.build`:

```
"build": "rm -rf dist && mkdir -p stats && rollup -c --bundleConfigAsCjs && node scripts/write-buildinfo.cjs"
```

The script must work even when not in a git repo (e.g. when installed from npm tarball) — fall back to commit `'unknown'`.

**Acceptance:**

- `pnpm build` produces `dist/.buildinfo.json`.
- Tarball includes it (`files[]` already covers `dist/**`).

**Commit message:** `build: emit dist/.buildinfo.json with version, commit, build timestamp`

---

# Done

When all sprints are complete:

- File sizes: `RetryManager.ts ≤ 250`, `requestQueue.ts ≤ 350`, `ErrorInterceptor.ts ≤ 200` (the 200-line target is aspirational here; some files are inherently larger but should be smaller than today).
- `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage` all gate the build.
- `no-floating-promises` and coverage thresholds enforce regression prevention.
- Token-refresh queue, cache cleanup, sliding-window state, and queue gates are all bounded and observable.
- Every emitted event is typed; every log line carries `correlationId`.
- Sensitive headers are redacted by default in stored manual-retry requests.

That gets the library to **A grade** as defined in the production-readiness review.
