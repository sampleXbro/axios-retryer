## Purpose

This repository contains an npm library.  
All work must optimize for:

- small core public API
- intentional plugin public API
- predictable behavior
- excellent developer experience
- low bundle size
- readability over cleverness
- long-term maintainability
- type safety
- backward compatibility
- tree-shakeability
- minimal runtime overhead

The library must feel like it was built by an experienced library architect.

The library's design is intentionally modular:
- keep the root entry focused on the retry manager, shared types, and core primitives
- expose optional functionality through documented plugin entry points when that keeps the core smaller
- treat the root entry and each documented plugin subpath as part of the public API contract

---

## Core Principles

### 1. Prefer simple public APIs
- Expose as little surface area as possible.
- Every exported function, type, class, and option increases maintenance cost.
- Avoid adding new API unless it clearly solves a recurring problem.
- Prefer one strong primitive over many convenience wrappers.
- Prefer growing existing core primitives or documented plugins over adding brand-new top-level concepts.

### 2. Optimize for users of the library
- API names must be obvious.
- Defaults must be sensible.
- Errors must be actionable.
- Types must guide correct usage.
- Documentation should make examples unnecessary, but examples should still exist.

### 3. Keep implementation compact, not cryptic
- Code should be short because it is well-designed, not because readability was sacrificed.
- Avoid “smart” abstractions that hide control flow.
- Prefer direct code with clear data flow.
- Avoid unnecessary indirection, inheritance, and over-generalization.

### 4. Minimize bundle and runtime cost
- Every dependency must be justified.
- Prefer zero dependencies when practical.
- Avoid large transitive dependencies for trivial tasks.
- Avoid runtime allocations, repeated parsing, unnecessary cloning, and excessive abstractions in hot paths.
- Write code that tree-shakes well and avoids side effects.

### 5. TypeScript should improve design, not complicate it
- Use TypeScript to make APIs safer and clearer.
- Avoid type gymnastics unless they produce meaningful DX benefits.
- Prefer explicit public types.
- Keep internal types simple.
- Infer where helpful, annotate where clarity matters.

### 6. Stability matters more than novelty
- Do not churn public APIs.
- Preserve behavior unless there is a compelling reason to change it.
- If breaking change is necessary, make it deliberate, documented, and minimal.

---

## Library Architecture Rules

### Public API
- Keep the public API flat and intentional within each documented entry point.
- Export only from documented public entry points.
- Never leak internal helpers through public exports.
- Avoid deep import paths unless explicitly part of the design.
- In this repo, plugin subpaths are part of the design and must be treated as first-class public API.
- Public API must be reviewed as a product, not as a byproduct of implementation.

The intended public API shape for this repository is:
- a compact root entry for the core retry manager, shared constants, and shared public types
- optional plugin entry points for feature-specific behavior such as token refresh, caching, circuit breaking, manual retry, metrics, sanitization, and critical-request handling
- no undocumented deep imports into internal folders

### Module Design
- Each module should have one clear responsibility.
- Prefer small focused files, but do not split files so aggressively that navigation becomes painful.
- Avoid circular dependencies.
- Shared utilities must remain truly generic; otherwise keep them local.

### Abstractions
- Introduce abstraction only after a clear repeated pattern appears.
- Do not create interfaces or base classes “for future flexibility”.
- Prefer composition over inheritance.
- Remove abstractions that no longer earn their keep.

### State
- Prefer pure functions.
- Keep mutable state localized and explicit.
- Avoid hidden shared state.
- Avoid singleton behavior unless the library is explicitly designed around it.

### Configuration
- Keep config objects small.
- Prefer a few orthogonal options over many interacting flags.
- Avoid boolean explosions. If multiple booleans combine into unclear behavior, redesign the API.
- Validate invalid combinations early.

For this repository specifically:
- keep `RetryManager` options focused on core retry, queueing, and request-flow behavior
- move specialized behavior into plugin options instead of growing the core config indefinitely
- prefer per-request metadata only when the behavior is truly request-scoped

---

## Code Style

### General
- Write code for the next maintainer.
- Use descriptive names.
- Prefer early returns.
- Avoid deep nesting.
- Keep branches shallow and explicit.
- Keep functions focused.
- Eliminate dead code immediately.

### Readability
- The happy path should be obvious.
- Important logic should not be buried in helpers with vague names.
- Avoid long chains of transformations when simple intermediate variables improve clarity.
- Comments should explain why, not restate what the code already says.

### Function Design
- Prefer functions that:
    - do one thing
    - have few parameters
    - return predictable output
    - have minimal side effects
- If a function needs many parameters, consider a typed options object.
- If an options object grows too much, rethink the API.

### Error Handling
- Fail fast on invalid input when appropriate.
- Errors must be concise, specific, and useful.
- Never throw vague messages.
- Include what was wrong and what was expected.
- Avoid swallowing errors unless there is a documented reason.

### Async
- Use async only when necessary.
- Avoid unnecessary Promise wrapping.
- Preserve stack trace clarity.
- Handle concurrency intentionally, not accidentally.

---

## TypeScript Rules

### Public Types
- Public types are part of the API contract.
- Keep them stable, named, and export only what users need from the root or a documented plugin entry point.
- Prefer explicit return types on exported functions.
- Use `readonly` where immutability is intended.
- Prefer discriminated unions over loose object shapes for variant behavior.

For this repository specifically:
- avoid making plugin wiring details part of the root public surface unless users truly need them
- keep root-level types centered on core retry concepts; plugin-specific types should prefer plugin entry points

### Internal Types
- Keep internal typing pragmatic.
- Avoid excessively clever conditional or recursive types unless they materially improve safety or usability.
- Do not encode business logic into unreadable type machinery.

### Safety
- Avoid `any`.
- Use `unknown` when needed, then narrow properly.
- Use exhaustive checks for unions.
- Preserve soundness over convenience in library code.

---

## Performance Rules

- Measure before optimizing complex paths, but always avoid obvious inefficiencies.
- Avoid needless object creation in hot paths.
- Avoid repeated normalization/parsing when a value can be processed once.
- Prefer simple loops when performance-sensitive.
- Do not sacrifice API clarity for micro-optimizations unless justified.
- Keep cold paths readable and hot paths efficient.

---

## Bundle Size Rules

- New dependencies require strong justification.
- Prefer native platform features over packages.
- Avoid shipping debug-only logic in production builds.
- Ensure modules are side-effect free unless absolutely necessary.
- Design exports to support tree-shaking.
- Be careful with polyfills and helpers that inflate output.

---

## Dependency Policy

Before adding a dependency, ask:

1. Can this be implemented safely in a few lines?
2. Is the dependency mature and well-maintained?
3. Is its size acceptable?
4. Does it introduce transitive risk?
5. Is it needed at runtime, or only for development?

Rules:
- Prefer zero runtime dependencies.
- Small devDependencies are acceptable when they materially improve quality.
- Remove unused dependencies immediately.
- Do not add fashionable tooling without concrete benefit.

---

## Testing Philosophy

Tests must protect behavior, not implementation details.

### Required test coverage
Test:
- public API behavior
- edge cases
- invalid input
- boundary conditions
- type expectations where relevant
- error messages for important failure paths
- platform-sensitive behavior if applicable
- regression cases for previous bugs

### Testing style
- Prefer focused unit tests.
- Add integration tests for important end-to-end flows.
- Avoid brittle snapshot overuse.
- Avoid testing private helpers directly unless unavoidable.
- Each test should communicate intent clearly.

### What to prioritize
- correctness
- stability
- backwards compatibility
- no hidden breaking changes

---

## Documentation Rules

- Every exported root API and every documented plugin entry point should be documented.
- README must explain:
    - what problem the library solves
    - why use it
    - installation
    - quick start
    - core API
    - plugin architecture and when to reach for plugins
    - important caveats
    - examples
- Keep examples small and realistic.
- Do not document internals as if they were public API.
- Do not document plugin methods as if they exist on `RetryManager` unless they actually do.
- Changelog entries must be useful, not generic.

---

## Versioning and Compatibility

- Follow semver strictly.
- Treat type changes as potentially breaking if they affect users.
- Do not introduce breaking changes casually.
- Preserve old behavior unless there is a strong reason not to.
- When changing behavior, document migration clearly.

---

## Review Checklist

Before finalizing any change, verify:

### API
- Is the core public API still minimal?
- Is feature growth happening in the right place: core, existing plugin, new plugin, or nowhere?
- Is this the simplest shape that solves the problem?
- Are names precise and intuitive?
- Does this add unnecessary long-term maintenance burden?

### Implementation
- Is the code easy to follow?
- Can any abstraction be removed?
- Can any branch be simplified?
- Is there duplicated logic worth consolidating?
- Is there any hidden state or surprising behavior?

### Performance and size
- Any unnecessary dependency?
- Any avoidable allocation or repeated work?
- Any risk to tree-shaking or bundle size?
- Any side effects at import time?

### Types
- Are exported types clear and stable?
- Any unnecessary complexity in generics?
- Any `any` that should be removed?
- Are failure modes modeled safely?

### Tests and docs
- Are critical paths covered?
- Are edge cases covered?
- Does documentation match actual behavior?
- Would a new user understand how to use this without reading implementation?

---

## Preferred Implementation Heuristics

Prefer:
- pure functions
- explicit control flow
- narrow core APIs
- strong defaults
- small composable primitives
- side-effect-free modules
- predictable data structures
- plain objects over class hierarchies unless classes are clearly better
- concise code with obvious intent

Avoid:
- speculative abstraction
- deep inheritance
- magical behavior
- overloaded APIs with too many meanings
- hidden mutation
- dependency bloat
- premature generalization
- excessive config
- clever one-liners that reduce clarity
- exporting internals “just in case”
- moving plugin-specific behavior into the root API without a strong reason

---

## When asked to implement features

Always:
1. understand the public API impact first
2. decide whether the change belongs in the core API, an existing plugin, a new plugin, or nowhere
3. design the smallest viable API
4. preserve the documented root-vs-plugin boundary
5. implement with the simplest architecture that fits
6. add tests for behavior and edge cases
7. update docs if public behavior changes
8. check bundle-size and dependency impact
9. review for naming, readability, and long-term maintenance

When multiple valid designs exist, choose the one that:
- reduces root API surface
- reuses an existing plugin surface before creating a new one
- reduces mental overhead
- reduces maintenance burden
- keeps output and runtime small
- is easiest to explain in one paragraph

---

## Output Expectations for Code Changes

When generating code for this repository:
- produce production-quality code
- keep code compact but readable
- avoid placeholder architecture
- avoid unnecessary comments
- include tests when behavior changes
- preserve existing conventions
- do not refactor unrelated code unless it materially improves the task
- do not introduce large frameworks or patterns without necessity

The final result should feel:
- elegant
- restrained
- predictable
- fast
- lightweight
- maintainable
