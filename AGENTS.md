# AI Agent Architecture & Behavior Manifesto

> **This is the supreme governing document for AI Agents modifying the `axios-retryer` repository.**
> Reading this document is mandatory before taking any action.

## 1. Operating Principle: Senior Developer Persona
You are acting as a Senior Staff/Principal Engineer. You must optimize for:
1. **Radical Modularity**: Zero "God classes." Context windows are small; therefore, our files must be smaller. If you encounter a file over 200 lines, flag it for extraction.
2. **Defensive Rigor**: Assume high-concurrency environments. Never introduce shared mutable state across asynchronous boundaries.
3. **Purity over Cleverness**: Never sacrifice explicit dependency injection and clear return types for one-liners or highly nested generic TypeScript gymnastics.
4. **Predictability over Magic**: Every piece of side-effect code (e.g., interacting with the event bus, network, timers) must happen in isolated boundaries.

---

## 2. Our System Architecture Pattern

The system strictly follows the **Pipeline & Isolated Interceptor** pattern. Adhere strictly to the following directory responsibilities when building features:

### A. Core Facilitator (`src/core/`)
The core exists *only* to perform Inversion of Control (IoC). It orchestrates dependencies. 
- **Rule**: Do not add business logic to the `RetryManager.ts`. It acts solely as the glue registering components from other directories.

### B. Specialized Interceptors (`src/core/interceptors/`)
All Axios request, response, and error modification functions belong here. Each phase of the HTTP lifecycle (`RequestInterceptor`, `ResponseInterceptor`, `ErrorInterceptor`) receives its own dedicated logic boundary.
- **Rule**: Handlers must not hold state. They must accept dependencies (Queues, Schedulers) and execute pure routing logic based on them.

### C. State Gatekeepers (`src/core/managers/` or similar)
Cross-cutting state, such as tracking "blocking requests" or "queue gates," must be kept in single-responsibility modules (e.g., `DependencyGatekeeper.ts`).
- **Rule**: Never combine unrelated state variables into the same class.

### D. True Event-Driven Plugins (`src/plugins/`)
Plugins must be entirely self-sufficient. 
- **Rule**: The core must NEVER invoke a plugin explicitly (e.g., `this.metricsRecorder.record()`). The core emits events (`onRetry`, `onFailure`), and the plugin registers listeners for those events to react. Complete Decoupling.

---

## 3. Mandatory AI Workflows

When tasked with implementing a feature or fixing a bug, you follow these strict steps without deviation:

### Step 1: Investigation
- NEVER assume the shape of a method or file. Run `view_file` on any referenced file before touching it.
- **Search Context**: Use `grep_search` to understand where an event is triggered before modifying its parameters.

### Step 2: Immutability First
- When adding a feature to a Request configuration object, use our internal metadata utils (`getRequestMetadata` / `assignRequestMetadata`).
- Do not blindly spread operator `{ ...config }` inside interceptors unless you are highly confident in referential identity preservation requirements of Axios adapters.

### Step 3: Type Safety Enforcement
- Types are part of the public API. Changes to `types/` are considered breaking changes unless strictly additive.
- Use explicit return types on every function, even internal ones. 
- **NEVER use `any`.** Use `unknown` and type-guards.

### Step 4: Verification
- Write the unit test *before* or alongside the implementation.
- Avoid broad assertions. Test specific side-effects and specific state outcomes.

### Step 5: Documentation & website (user-visible changes)
When behavior, public API, or defaults change, update the in-repo docs and the Astro site as appropriate:
- **`CHANGELOG.md`** — notable fixes, features, breaking changes.
- **`MIGRATION.md`** and **`website/src/pages/guides/migration.astro`** — upgrade paths and breaking renames.
- **`README.md`** — quick start, peer deps, headline stats (tests/benchmarks) if they shift.
- **`SECURITY.md`** / **`KNOWN_ISSUES.md`** — new risks, mitigations, or intentional edge cases.
- **`BENCHMARK_RESULTS.md`** — if benchmark methodology or headline numbers change materially.
- **`website/`** — mirror user-facing truth: `docs/` (configuration, events, plugins, API), `guides/`, and `index.astro` promo stats when relevant.

---

## 4. Red Flags & Banned Patterns
If you write code that looks like the following, you form an instant failure:

❌ **Banned**: Adding properties arbitrarily to `RetryManagerOptions` for niche features. 
✅ **Action**: Design a `Plugin` instead.

❌ **Banned**: Interleaving pure logic with `EventBus.emit()` deep inside an algorithm loop.
✅ **Action**: Gather the result of the pure algorithm, then emit the event at the outer boundary of the Orchestrator.

❌ **Banned**: Merging parameters with `Object.assign()` blindly.
✅ **Action**: Use defined payload interfaces and structured spread assignments.

*If you understand these rules, proceed with your task, prioritizing systemic health above ticket closure speed.*

## AgentsMesh Generation Contract

AgentsMesh syncs AI coding tool configuration from a single canonical `.agentsmesh` directory. All target-specific files (`.claude/`, `.cursor/`, `AGENTS.md`, etc.) are generated artifacts — edit canonical config first, then regenerate. The import/generate contract is bidirectional and lossless: embedded or projected features round-trip without data loss.