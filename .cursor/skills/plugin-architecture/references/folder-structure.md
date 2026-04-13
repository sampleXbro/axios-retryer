# Folder Structure

## Required files

```text
YourPlugin/
  YourPlugin.ts
  index.ts
```

- `YourPlugin.ts` contains the class that implements `RetryPlugin<TPluginEvents>`.
- `index.ts` exports the class, public types, public errors, and optional `createYourPlugin(...)` factory.

## Standard folders

### `types/`

Use for:

- plugin options
- plugin events
- adapter contracts
- state records
- request-level metadata types

### `configs/`

Use for:

- default option resolution
- config normalization
- config validation

Keep all startup validation here so request-time code can assume valid configuration.

### `errors/`

Use for:

- plugin-specific error classes
- an `index.ts` barrel when there are one or more public errors

### `utils/`

Use for pure logic only:

- normalization
- key building
- matching
- payload shaping
- serialization
- cloning

Do not put timers, maps tracking live requests, or implicit state machines here.

## Optional folders

### `interceptors/`

Add when request/response/error logic becomes substantial. Suggested split:

```text
interceptors/
  RequestInterceptor.ts
  ResponseInterceptor.ts
  ErrorInterceptor.ts
```

Each file should expose small functions or classes with injected dependencies, not singleton state.

### `managers/`

Add when the plugin owns a stateful subsystem such as:

- scope tracking
- queue gating
- dedupe/inflight tracking
- token refresh coordination

### `storage/`

Add when the plugin supports pluggable persistence or adapters.

Examples:

- in-memory cache storage
- indexed/persistent cache adapters
- custom plugin-local state adapters

## Extraction thresholds

Extract from `YourPlugin.ts` when you see any of these:

- file exceeds roughly 200 lines
- more than one lifecycle phase is mixed together
- a helper needs its own tests
- stateful logic is hidden inside local closures
- config validation is interleaved with runtime handling
- `index.ts` starts doing anything except public exports/factory creation

## Recommended public API shape

```ts
export { YourPlugin } from './YourPlugin';
export { YourPluginError } from './errors';
export type { YourPluginEvents, YourPluginOptions } from './types';

import { YourPlugin, type YourPluginOptions } from './YourPlugin';

export function createYourPlugin(options?: YourPluginOptions): YourPlugin {
  return new YourPlugin(options);
}
```

Keep the public API small and predictable. Internal helpers should stay internal unless there is a real consumer-facing use case.
