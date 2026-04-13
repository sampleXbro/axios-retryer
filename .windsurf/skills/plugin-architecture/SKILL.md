---
name: plugin-architecture
description: "Use when creating, refactoring, or reviewing axios-retryer plugins. Enforces the repo's single recommended plugin architecture: top-level orchestrator class, focused folders for types/configs/errors/utils, optional stateful managers or storage adapters, explicit event-driven boundaries, and test-first extraction when files grow."
---

# Plugin Architecture

Use this skill for any new plugin, major plugin refactor, or review of plugin structure in `axios-retryer`.

## Goal

Follow one consistent plugin shape across the repo:

```text
src/plugins/YourPlugin/
  YourPlugin.ts
  index.ts
  types/
    index.ts
  configs/
    index.ts
  errors/
    YourPluginError.ts
    index.ts
  utils/
    *.ts
    index.ts
  managers/
    *.ts
  storage/
    *.ts
  interceptors/
    RequestInterceptor.ts
    ResponseInterceptor.ts
    ErrorInterceptor.ts
```

Only keep folders that the plugin actually needs. Do not create placeholder folders.

## Current Plugin Contract

Read `src/types/plugins.ts` before writing plugin code. The current public plugin contract is:

- `RetryPlugin<TPluginEvents>` requires `name`, `version`, `initialize(context)`, and optional `onBeforeDestroyed(context)`.
- Plugins should declare `readonly _events?: Readonly<TPluginEvents>` for TypeScript event inference.
- `initialize` receives `PluginContext<TPluginEvents>`, which is the only supported bridge into manager behavior.

### Current `PluginContext` surface

- `axiosInstance`
- `getLogger()`
- `on(...)`
- `off(...)`
- `emit(...)`
- `triggerAndEmit(...)`
- `cancelRequest(requestId)`
- `cancelAllRequests()`
- `cancelQueuedRequests()`
- `registerQueueGate(name, canProcess)`
- `unregisterQueueGate(name)`
- `refreshQueue()`
- `registerMetricsRecorder(recorder | null)`
- `getTimerStats()`
- `releaseRequestTracking(config)`

Use these methods as they exist today. Do not invent new plugin-manager touchpoints when the current context already supports the behavior.

## Architecture Rules

1. `YourPlugin.ts` is the orchestrator only.
   Keep `initialize`, teardown, interceptor registration, event wiring, and public methods here.
   If the file starts accumulating parsing, normalization, validation, sorting, mutation, or adapter logic, extract it.

2. `index.ts` is public API only.
   Export the plugin class, factory, public types, and public errors.
   Do not place logic in the entrypoint.

3. `types/` owns contracts.
   Plugin options, events, adapter interfaces, storage entries, and request metadata types live here.
   Public types are additive only unless the user explicitly wants a breaking change.

4. `configs/` owns defaults and validation.
   Resolve defaults in one place.
   Throw config errors there, not deep inside request flow.

5. `errors/` owns plugin-specific error classes.
   Every custom error gets its own file when there is more than one.

6. `utils/` is pure logic only.
   Put stateless helpers here: key building, normalization, cloning, matching, fingerprints, payload shaping.
   No hidden shared mutable state.

7. `managers/` or `storage/` own plugin-local state.
   If the plugin needs durable or cross-request state, isolate it behind a named boundary with a narrow interface.
   Do not hide stateful behavior inside generic utils.

8. `interceptors/` split lifecycle phases when complexity grows.
   If a plugin has meaningful request/response/error logic, move each phase into dedicated files instead of keeping them inline.

## Behavioral Rules

- Plugins are self-sufficient and event-driven.
- The core should not call plugin business methods directly.
- Prefer emitting plugin events through `context.triggerAndEmit(...)` at the outer boundary.
- Use `context.emit(...)` only when you explicitly need listener notification without hook execution.
- Queue-blocking plugins should use `registerQueueGate(...)` and `refreshQueue()` instead of ad hoc shared state in the core.
- Metrics-producing plugins should integrate through `registerMetricsRecorder(...)` instead of direct manager mutation.
- Keep side effects near the boundary and keep internal helpers deterministic.
- Never use `any`.
- Add explicit return types on extracted functions.
- If a file crosses roughly 200 lines, extract a focused collaborator.

## Implementation Workflow

1. Read the plugin contract in `src/types/plugins.ts`.
2. Inspect at least one existing plugin before creating a new one.
3. Map the plugin behavior onto the existing `PluginContext` methods before adding code.
4. Define public plugin events and options in `types/`.
5. Add config defaults and validation in `configs/`.
6. Put orchestration in `YourPlugin.ts`.
7. Extract pure helper logic into `utils/`.
8. Extract stateful collaborators into `managers/`, `storage/`, or `interceptors/` if needed.
9. Export only the intended public surface from `index.ts`.
10. Add or update focused unit tests alongside the implementation.
11. If the plugin changes public behavior, update website docs.

## Read Before Coding

- For concrete folder layout and extraction thresholds, read [.windsurf/skills/plugin-architecture/references/folder-structure.md](.windsurf/skills/plugin-architecture/references/folder-structure.md).

Load only that reference when you are actively designing or restructuring a plugin.