# 📊 Benchmark Results

This document summarizes the current `axios-retryer` benchmark suite and the latest generated report in [benchmark/latest-benchmark-report.json](./benchmark/latest-benchmark-report.json).

The suite is scenario-based on purpose. It tries to answer questions real users care about:

- How much overhead does the retry manager add when everything is healthy?
- How well does it recover from transient `5xx` and `429` responses?
- What happens under queue contention, sustained load, and partial outages?
- Do caching, circuit breaking, and token refresh still behave correctly under concurrency?

## Current Run

- **Profile:** `standard`
- **Generated:** `2026-04-04T13:31:09.016Z`
- **Benchmarks passed:** `7/7`
- **Average benchmark duration:** `7685.4ms`
- **Average scenario success rate:** `88.36%`
- **Peak throughput observed:** `4131.85 req/sec`
- **Slowest p95 latency:** `663.41ms`

The aggregate success rate is not expected to be `100%` because some scenarios intentionally model outages or fail-fast protection behavior.

## Core RetryManager

These scenarios measure the core library without relying on external services.

| Scenario | Result |
|----------|--------|
| Healthy API Overhead | `2642.02 req/sec`, `p95 14.76ms`, `100%` success |
| Transient 5xx Recovery | `1013.58 req/sec`, `p95 57.71ms`, `100%` success |
| Rate Limit Recovery | `190.64 req/sec`, `p95 24.9ms`, `100%` success |
| Priority Queue Under Contention | `255.91 req/sec`, `p95 663.41ms`, `100%` success |

Highlights:

- Healthy-path overhead is effectively negligible in this run. The manager measured `0.59%` slower than the plain Axios baseline in the same harness, which is comfortably within the sort of noise you should expect from a local benchmark.
- Transient failures recovered cleanly with `100%` success in the `5xx` scenario.
- Short `429` bursts recovered without destabilizing latency tails.
- Priority separation is visible again under contention:
  - High-priority `p95`: `115.82ms`
  - Medium-priority `p95`: `277.91ms`
  - Low-priority `p95`: `679.71ms`
  The tradeoff is that low-priority work can still see a large tail when the queue is saturated.

Memory summary from the core suite:

- Start heap: `6.52MB`
- End heap: `6.58MB`
- Growth across the memory cycle: `0.07MB`

## Stress Scenarios

These scenarios model burst traffic, sustained traffic, and partial upstream failure.

| Scenario | Result |
|----------|--------|
| Burst Capacity | `4131.85 req/sec`, `p95 13.81ms`, `100%` success |
| Sustained Load | `39.92 req/sec` for `45s`, `p95 50.52ms`, `100%` success |
| Outage And Recovery | `626.33 req/sec`, `p95 78.41ms`, `67.04%` success |

How to read the outage result:

- The outage scenario intentionally includes a period where the upstream is down.
- A `67.04%` success rate here does not mean the retry logic is randomly failing.
- It means the benchmark is measuring how the manager behaves when some requests are fundamentally unrecoverable during the outage window.

## Plugin Integration

These scenarios validate correctness and overhead when plugins are enabled together.

| Scenario | Result |
|----------|--------|
| Caching Plugin Effectiveness | `1561.23 req/sec`, `p95 14.39ms`, `100%` success |
| Circuit Breaker Protection | `59.69 req/sec`, `p95 10.84ms`, `35%` success |
| Token Refresh Storm | `1005.69 req/sec`, `p95 45.81ms`, `100%` success |
| Cache After Token Refresh | `2623.64 req/sec`, `p95 38.24ms`, `100%` success |

Important interpretation notes:

- The circuit-breaker scenario is supposed to fail fast once the upstream is known-bad. A `35%` success rate there reflects protective blocking, not a broken benchmark.
- The token refresh scenarios now show the intended single-refresh fan-in behavior under concurrency, with `1` refresh call observed in both the standalone and combined plugin runs.
- The cache-after-refresh scenario demonstrates strong cache reuse after authentication warms up, with a `100%` post-auth cache hit rate in the latest run.

## Standalone Plugin Checks

The benchmark suite also emits focused plugin runs:

- **Caching:** `1555.62 req/sec`, `p95 14.46ms`, `100%` success, `100%` hot-read hit rate
- **Circuit Breaker:** `59.9 req/sec`, `p95 12.06ms`, `35%` success, `20` requests blocked by circuit, `22` upstream calls avoided
- **Token Refresh:** `956.73 req/sec`, `p95 49.84ms`, `100%` success, `1` refresh call, replay amplification `1.35x`

## What These Results Suggest

`axios-retryer` is performing well on the workloads it is meant to help with:

- healthy-path overhead is low
- retry recovery for transient failures is strong
- priority queueing now shows the intended high-to-low latency separation under contention
- token refresh fan-in behaves correctly under concurrent expired-token bursts
- plugin coordination remains covered by the combined benchmark suite and the integration tests in this repo
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
