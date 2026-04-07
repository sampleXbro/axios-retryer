# 📊 Benchmark Results

This document summarizes the current `axios-retryer` benchmark suite and the latest generated report in [benchmark/latest-benchmark-report.json](./benchmark/latest-benchmark-report.json).

The suite is scenario-based on purpose. It tries to answer questions real users care about:

- How much overhead does the retry manager add when everything is healthy?
- How well does it recover from transient `5xx` and `429` responses?
- What happens under queue contention, sustained load, and partial outages?
- Do caching, circuit breaking, token refresh, manual replay, metrics, and advanced plugin paths still behave correctly under concurrency?

## Current Run

- **Profile:** `standard`
- **Generated:** `2026-04-07T20:18:29.714Z`
- **Benchmark executables passed:** `10/10`
- **Average benchmark duration:** `7984.6ms`
- **Average scenario success rate:** `86.21%`
- **Peak throughput observed (rollup):** `48387.19 req/sec`
- **Slowest p95 latency:** `665.85ms`

The rollup **peak throughput** is the maximum over **every** scenario in the JSON report, including **in-memory cache hot-read** workloads (no real network). For HTTP-shaped work, use **Stress → Burst Capacity** (`4284.85 req/sec` in this run) or **Core → Healthy API Overhead** (`2150.26 req/sec`).

The aggregate success rate is not expected to be `100%` because some scenarios intentionally model outages, fail-fast protection, or expected failure slices (for example manual-replay and per-request override cases).

## Core RetryManager

These scenarios measure the core library without relying on external services.

| Scenario | Result |
|----------|--------|
| Healthy API Overhead | `2150.26 req/sec`, `p95 31.71ms`, `100%` success |
| Transient 5xx Recovery | `1017.17 req/sec`, `p95 57.53ms`, `100%` success |
| Rate Limit Recovery | `191.02 req/sec`, `p95 24.71ms`, `100%` success |
| Priority Queue Under Contention | `255.98 req/sec`, `p95 665.85ms`, `100%` success |

Highlights:

- **Healthy-path vs baseline:** In this run the harness reported plain Axios baseline `2594.06 req/sec` / `p95 14.87ms` vs RetryManager `2150.26 req/sec` / `p95 31.71ms` (`managerOverheadPct` `20.63` in the structured output). Local CPU noise, GC, and timer resolution dominate short runs — treat the ratio as **environment-sensitive**, not a fixed product constant.
- Transient failures recovered cleanly with `100%` success in the `5xx` scenario.
- Short `429` bursts recovered without destabilizing the primary latency band (`p95` stayed near `24.71ms` despite a long tail in `p99`).
- Priority separation under contention:
  - High-priority `p95`: `112.12ms`
  - Medium-priority `p95`: `276.85ms`
  - Low-priority `p95`: `678.51ms`  
  Low-priority work can still see a large tail when the queue is saturated.

Memory summary from the core suite:

- Start heap: `6.62MB`
- End heap: `6.71MB`
- Growth across the memory cycle: `0.09MB`

## Stress Scenarios

These scenarios model burst traffic, sustained traffic, and partial upstream failure.

| Scenario | Result |
|----------|--------|
| Burst Capacity | `4284.85 req/sec`, `p95 13.06ms`, `100%` success |
| Sustained Load | `39.92 req/sec` for `45s`, `p95 50.85ms`, `100%` success |
| Outage And Recovery | `615.87 req/sec`, `p95 79.15ms`, `67.04%` success |

How to read the outage result:

- The outage scenario intentionally includes a period where the upstream is down.
- A `67.04%` success rate here does not mean the retry logic is randomly failing.
- It means the benchmark is measuring how the manager behaves when some requests are fundamentally unrecoverable during the outage window.

## Plugin Integration

These scenarios validate correctness and overhead when plugins are enabled together.

| Scenario | Result |
|----------|--------|
| Caching Plugin Effectiveness | `1531.16 req/sec`, `p95 15.09ms`, `100%` success |
| Circuit Breaker Protection | `59.95 req/sec`, `p95 11.18ms`, `35%` success |
| Token Refresh Storm | `998.97 req/sec`, `p95 45.93ms`, `100%` success |
| Cache After Token Refresh | `982.95 req/sec`, `p95 39.83ms`, `100%` success |

Important interpretation notes:

- The circuit-breaker scenario is supposed to fail fast once the upstream is known-bad. A `35%` success rate there reflects protective blocking, not a broken benchmark.
- The token refresh scenarios show single-refresh fan-in (`refreshCalls: 1` in structured output for both storm and cache-after-refresh in this run).
- **Cache After Token Refresh** also records `cacheHitRateAfterWarmAuth` in JSON; it was `0` in this run (cache size `0` in extras) — the scenario still completed at `100%` request success; hit-rate specifics vary with timing and cache keys.

## Standalone Plugin & Focused Runs

| Executable | Notes |
|------------|--------|
| **Priority Queue** | `217.5 req/sec`, tier `p95` high `128.98ms` / medium `327.01ms` / low `801.29ms`, `100%` success |
| **Caching** | Includes **Cache Hit Throughput** `48387.19 req/sec`, `p95 1.1ms`, `100%` hot reads (in-memory; drives rollup peak) |
| **Circuit Breaker** | `59.68 req/sec`, `p95 11.57ms`, `35%` success, `20` blocked by circuit, `22` upstream calls avoided |
| **Token Refresh** | `906.89 req/sec`, `p95 51.96ms`, `100%` success, `1` refresh call, replay amplification `1.35x` |
| **Manual Retry** | Four scenarios (store/replay, maxAge, rehydrateAuth, per-request MANUAL); average success `63.75%` by design |
| **Metrics Plugin** | Collection overhead, priority breakdown, `onMetricsUpdated` + `resetMetrics`; avg `1367.28 req/sec` across scenarios |
| **Advanced Plugins** | Blocking gate, failure cascade, sanitization overhead, cache invalidation patterns, sliding-window breaker, GraphQL `customErrorDetector`, per-request overrides, `use`/`unuse` lifecycle |

## What These Results Suggest

`axios-retryer` remains strong on the workloads it targets:

- Transient retry recovery and rate-limit handling stay at `100%` success in their scenarios.
- Priority queueing shows high → low latency separation under contention.
- Token refresh fan-in stays at a single refresh cycle in concurrent storms.
- Plugin coordination is covered by integration, standalone, and advanced benchmark executables plus the repo test suite.

Caveats:

- Low-priority traffic can still see a large tail under queue contention.
- Outage success rates are bounded by the scripted outage window.
- Circuit-breaker scenarios measure **protection**, not raw availability.
- Rollup **peak req/sec** can be dominated by pure cache read throughput — compare HTTP-shaped rows when quoting “real request” performance.

## Running The Benchmarks

```bash
npm run benchmark
npm run benchmark:quick
npm run benchmark:full
```

Other useful commands:

```bash
npm run benchmark:local
npm run benchmark:stress
npm run benchmark:plugins
npm run benchmark:existing
```

All aggregate runs write the latest machine-readable report to:

- [benchmark/latest-benchmark-report.json](./benchmark/latest-benchmark-report.json)

## Notes

- Results are local and comparative, not universal guarantees.
- Throughput and latency will vary with CPU, Node.js version, Axios version, concurrency settings, and the shape of your upstream.
- If you care about production sizing, treat these numbers as a starting point and run the suite with your own workload assumptions.
