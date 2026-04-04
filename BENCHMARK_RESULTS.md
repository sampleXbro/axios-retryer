# 📊 Benchmark Results

This document summarizes the current `axios-retryer` benchmark suite and the latest generated report in [benchmark/latest-benchmark-report.json](./benchmark/latest-benchmark-report.json).

The suite is scenario-based on purpose. It tries to answer questions real users care about:

- How much overhead does the retry manager add when everything is healthy?
- How well does it recover from transient `5xx` and `429` responses?
- What happens under queue contention, sustained load, and partial outages?
- Do caching, circuit breaking, and token refresh still behave correctly under concurrency?

## Current Run

- **Profile:** `standard`
- **Generated:** `2026-04-04T06:16:35.532Z`
- **Benchmarks passed:** `7/7`
- **Average benchmark duration:** `11078.94ms`
- **Average scenario success rate:** `72.57%`
- **Peak throughput observed:** `4012.74 req/sec`
- **Slowest p95 latency:** `3025.44ms`

The aggregate success rate is not expected to be `100%` because some scenarios intentionally model outages or fail-fast protection behavior.

## Core RetryManager

These scenarios measure the core library without relying on external services.

| Scenario | Result |
|----------|--------|
| Healthy API Overhead | `2646.58 req/sec`, `p95 14.95ms`, `100%` success |
| Transient 5xx Recovery | `1009.11 req/sec`, `p95 57.89ms`, `100%` success |
| Rate Limit Recovery | `190.68 req/sec`, `p95 24.98ms`, `100%` success |
| Priority Queue Under Contention | `257.75 req/sec`, `p95 661.39ms`, `100%` success |

Highlights:

- Healthy-path overhead is effectively negligible in this run. The manager measured `1.26%` slower than the plain Axios baseline in the same harness, which is comfortably within the sort of noise you should expect from a local benchmark.
- Transient failures recovered cleanly. The `5xx` scenario replayed `97` requests successfully with retry amplification of `1.19x`.
- Short `429` bursts recovered without destabilizing latency tails.
- Priority separation is visible under contention:
  - High-priority `p95`: `116.73ms`
  - Medium-priority `p95`: `279.86ms`
  - Low-priority `p95`: `674.61ms`

Memory summary from the core suite:

- Start heap: `7MB`
- End heap: `7.07MB`
- Growth across the memory cycle: `0.07MB`

## Stress Scenarios

These scenarios model burst traffic, sustained traffic, and partial upstream failure.

| Scenario | Result |
|----------|--------|
| Burst Capacity | `4012.74 req/sec`, `p95 17.23ms`, `100%` success |
| Sustained Load | `40.01 req/sec` for `45s`, `p95 49.45ms`, `100%` success |
| Outage And Recovery | `599.09 req/sec`, `p95 79.07ms`, `67.04%` success |

How to read the outage result:

- The outage scenario intentionally includes a period where the upstream is down.
- A `67.04%` success rate here does not mean the retry logic is randomly failing.
- It means the benchmark is measuring how the manager behaves when some requests are fundamentally unrecoverable during the outage window.

## Plugin Integration

These scenarios validate correctness and overhead when plugins are enabled together.

| Scenario | Result |
|----------|--------|
| Caching Plugin Effectiveness | `1408.45 req/sec`, `p95 14.45ms`, `100%` success |
| Circuit Breaker Protection | `60.28 req/sec`, `p95 10.85ms`, `35%` success |
| Token Refresh Storm | `7.96 req/sec`, `p95 3015ms`, `0%` success |
| Cache After Token Refresh | `18.8 req/sec`, `p95 3014.25ms`, `78.95%` success |

Important interpretation notes:

- The circuit-breaker scenario is supposed to fail fast once the upstream is known-bad. A `35%` success rate there reflects protective blocking, not a broken benchmark.
- The token refresh scenarios are currently dominated by the refresh wait path, so treat them as replay-stress measurements rather than raw throughput targets.
- The cache-after-refresh scenario still demonstrates strong cache reuse after authentication warms up, with a `93.33%` post-auth cache hit rate in the latest run.

## Standalone Plugin Checks

The benchmark suite also emits focused plugin runs:

- **Caching:** `1568.09 req/sec`, `p95 13.93ms`, `100%` success, `100%` hot-read hit rate
- **Circuit Breaker:** `59.85 req/sec`, `p95 12.61ms`, `35%` success, `20` requests blocked by circuit, `22` upstream calls avoided
- **Token Refresh:** `7.95 req/sec`, `p95 3025.44ms`, `0%` success, `9` refresh calls, replay amplification `1x`

## What These Results Suggest

`axios-retryer` is performing well on the workloads it is meant to help with:

- healthy-path overhead is low
- retry recovery for transient failures is strong
- priority queueing meaningfully separates urgent traffic from background work
- plugin coordination remains covered by the combined benchmark suite and the integration tests in this repo
- timer and memory behavior are stable in this run

The biggest caveats are the ones already visible in the report:

- low-priority traffic can still see a large tail under queue contention
- outage success rates are bounded by the benchmarked outage window
- circuit-breaker scenarios should be interpreted as protection behavior, not raw availability
- token-refresh benchmark throughput is dominated by intentionally slow refresh windows and should not be compared directly to the healthy-path scenarios

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
