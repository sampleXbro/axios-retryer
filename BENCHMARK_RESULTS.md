# 📊 Benchmark Results

This document summarizes the current `axios-retryer` benchmark suite and the latest generated report in [benchmark/latest-benchmark-report.json](./benchmark/latest-benchmark-report.json).

The suite is scenario-based on purpose. It tries to answer questions real users care about:

- How much overhead does the retry manager add when everything is healthy?
- How well does it recover from transient `5xx` and `429` responses?
- What happens under queue contention, sustained load, and partial outages?
- Do caching, circuit breaking, and token refresh still behave correctly under concurrency?

## Current Run

- **Profile:** `standard`
- **Generated:** `2026-04-01T18:37:40.009Z`
- **Benchmarks passed:** `7/7`
- **Average benchmark duration:** `7463.41ms`
- **Average scenario success rate:** `88.36%`
- **Peak throughput observed:** `4300.7 req/sec`
- **Slowest p95 latency:** `652.75ms`

The aggregate success rate is not expected to be `100%` because some scenarios intentionally model outages or fail-fast protection behavior.

## Core RetryManager

These scenarios measure the core library without relying on external services.

| Scenario | Result |
|----------|--------|
| Healthy API Overhead | `2712.55 req/sec`, `p95 14.22ms`, `100%` success |
| Transient 5xx Recovery | `1023.22 req/sec`, `p95 57.15ms`, `100%` success |
| Rate Limit Recovery | `745.42 req/sec`, `p95 24.67ms`, `100%` success |
| Priority Queue Under Contention | `261.96 req/sec`, `p95 652.75ms`, `100%` success |

Highlights:

- Healthy-path overhead is effectively negligible in this run. The manager measured slightly faster than the plain Axios baseline in the same harness (`-1.14%` overhead in the report, which should be treated as benchmark noise rather than a guaranteed speedup).
- Transient failures recovered cleanly. The `5xx` scenario replayed `97` requests successfully with retry amplification of `1.19x`.
- Short `429` bursts recovered without destabilizing latency tails.
- Priority separation is visible under contention:
  - High-priority `p95`: `110.41ms`
  - Medium-priority `p95`: `270.57ms`
  - Low-priority `p95`: `668.36ms`

Memory summary from the core suite:

- Start heap: `6.41MB`
- End heap: `6.47MB`
- Growth across the memory cycle: `0.06MB`

## Stress Scenarios

These scenarios model burst traffic, sustained traffic, and partial upstream failure.

| Scenario | Result |
|----------|--------|
| Burst Capacity | `4300.7 req/sec`, `p95 13.71ms`, `100%` success |
| Sustained Load | `39.99 req/sec` for `45s`, `p95 48.71ms`, `100%` success |
| Outage And Recovery | `636.3 req/sec`, `p95 77.37ms`, `67.04%` success |

How to read the outage result:

- The outage scenario intentionally includes a period where the upstream is down.
- A `67.04%` success rate here does not mean the retry logic is randomly failing.
- It means the benchmark is measuring how the manager behaves when some requests are fundamentally unrecoverable during the outage window.

## Plugin Integration

These scenarios validate correctness and overhead when plugins are enabled together.

| Scenario | Result |
|----------|--------|
| Caching Plugin Effectiveness | `1578.93 req/sec`, `p95 14.26ms`, `100%` success |
| Circuit Breaker Protection | `60.78 req/sec`, `p95 10.87ms`, `35%` success |
| Token Refresh Storm | `1057.73 req/sec`, `p95 44.11ms`, `100%` success |
| Cache After Token Refresh | `2242.49 req/sec`, `p95 37.82ms`, `100%` success |

Important interpretation notes:

- The circuit-breaker scenario is supposed to fail fast once the upstream is known-bad. A `35%` success rate there reflects protective blocking, not a broken benchmark.
- The token refresh scenario triggered exactly `1` refresh call for a concurrent burst, which is the desired behavior.
- The cache-after-refresh scenario hit `100%` success with `1` refresh call and `100%` cache hit rate after warm auth.

## Standalone Plugin Checks

The benchmark suite also emits focused plugin runs:

- **Caching:** `1568.09 req/sec`, `p95 13.93ms`, `100%` success, `100%` hot-read hit rate
- **Circuit Breaker:** `60.49 req/sec`, `p95 11.47ms`, `35%` success, `20` requests blocked by circuit, `22` upstream calls avoided
- **Token Refresh:** `950.66 req/sec`, `p95 48.79ms`, `100%` success, `1` refresh call, replay amplification `1.35x`

## What These Results Suggest

`axios-retryer` is performing well on the workloads it is meant to help with:

- healthy-path overhead is low
- retry recovery for transient failures is strong
- priority queueing meaningfully separates urgent traffic from background work
- plugin coordination remains correct under concurrency
- timer and memory behavior are stable in this run

The biggest caveats are the ones already visible in the report:

- low-priority traffic can still see a large tail under queue contention
- outage success rates are bounded by the benchmarked outage window
- circuit-breaker scenarios should be interpreted as protection behavior, not raw availability

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
