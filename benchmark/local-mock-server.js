const axios = require('axios');
const { performance } = require('perf_hooks');

const { RetryManager, createRetryStrategy } = require('../dist/index.cjs.js');
const {
  createAdapter,
  createScenarioSummary,
  deterministicUnit,
  emitResult,
  getAttemptsForKey,
  getProfile,
  measureRequests,
  nowIso,
  percentile,
  printHeader,
  printScenario,
  round,
  scaleCount,
  silenceManager,
} = require('./_utils');

const BENCHMARK_NAME = 'local-mock-server';
const SEED = 1401;
const FAST_RETRY_DELAY_MS = 20;

function latency(seed, key, attempt, baseMs, spreadMs) {
  return Math.max(1, Math.round(baseMs + (deterministicUnit(seed, key, attempt) * spreadMs)));
}

function buildRetryStrategy() {
  return createRetryStrategy({
    getDelay: () => FAST_RETRY_DELAY_MS,
  });
}

function createManager({ adapter, retries = 2, maxConcurrentRequests = 16 }) {
  const manager = new RetryManager({
    retries,
    maxConcurrentRequests,
    queueDelay: 0,
    debug: false,
    retryStrategy: buildRetryStrategy(),
  });

  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;

  return manager;
}

async function runAxiosBatch({ adapter, items, concurrency }) {
  const client = axios.create({ adapter });
  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) =>
      client.get(item.url, {
        headers: item.headers,
      }),
  });

  return {
    durationMs: performance.now() - startedAt,
    result,
  };
}

async function runManagerBatch({ manager, items, concurrency }) {
  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) =>
      manager.axiosInstance.get(item.url, {
        headers: item.headers,
        __priority: item.priority,
      }),
  });

  return {
    durationMs: performance.now() - startedAt,
    result,
  };
}

async function healthyPathScenario(profile) {
  const requestCount = scaleCount(profile, 600);
  const concurrency = scaleCount(profile, 32);
  const items = Array.from({ length: requestCount }, (_, index) => ({
    id: index,
    url: `/healthy/${index}`,
    priority: index % 3,
  }));

  const baselineHarness = createAdapter(({ key, attempt }) => ({
    latencyMs: latency(SEED, key, attempt, 8, 6),
    data: { ok: true, key, attempt },
  }));
  const managerHarness = createAdapter(({ key, attempt }) => ({
    latencyMs: latency(SEED, key, attempt, 8, 6),
    data: { ok: true, key, attempt },
  }));

  const baseline = await runAxiosBatch({
    adapter: baselineHarness.adapter,
    items,
    concurrency,
  });

  const manager = createManager({
    adapter: managerHarness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  const memoryBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const managed = await runManagerBatch({
    manager,
    items,
    concurrency,
  });
  const finishedAt = performance.now();
  const memoryAfter = process.memoryUsage().heapUsed;

  const scenario = createScenarioSummary({
    name: 'Healthy API Overhead',
    description: 'Measures RetryManager overhead against plain axios when every request succeeds on the first attempt.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result: managed.result,
    manager,
    upstreamCalls: managerHarness.stats.upstreamCalls,
    memoryDeltaBytes: memoryAfter - memoryBefore,
    extras: {
      baselineThroughputPerSec: round((requestCount / baseline.durationMs) * 1000),
      baselineP95Ms: baseline.result.totals.latency.p95Ms,
      managerOverheadPct: baseline.durationMs > 0 ? round(((managed.durationMs - baseline.durationMs) / baseline.durationMs) * 100) : 0,
    },
  });

  manager.destroy();
  return scenario;
}

async function transientFailureScenario(profile) {
  const requestCount = scaleCount(profile, 500);
  const concurrency = scaleCount(profile, 24);
  const flakySet = new Set(
    Array.from({ length: requestCount }, (_, index) => index).filter((index) => deterministicUnit(SEED, 'flaky', index) < 0.22)
  );
  const items = Array.from({ length: requestCount }, (_, index) => ({
    id: index,
    url: `/flaky/${index}`,
    priority: index % 3,
  }));
  const harness = createAdapter(({ key, attempt }) => {
    const requestId = Number(key.split('/').pop());
    const shouldFailFirstAttempt = flakySet.has(requestId);
    const latencyMs = latency(SEED, key, attempt, 10, 12);

    if (shouldFailFirstAttempt && attempt === 1) {
      return {
        latencyMs,
        errorStatus: 503,
        errorMessage: 'Transient upstream failure',
      };
    }

    return {
      latencyMs,
      data: { ok: true, key, attempt, recovered: shouldFailFirstAttempt },
    };
  });

  const manager = createManager({
    adapter: harness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  const startedAt = performance.now();
  const batch = await runManagerBatch({
    manager,
    items,
    concurrency,
  });
  const finishedAt = performance.now();

  const recoveredRequests = items.filter((item) => getAttemptsForKey(harness.stats, item.url) > 1).length;
  const scenario = createScenarioSummary({
    name: 'Transient 5xx Recovery',
    description: 'Simulates a flaky upstream where some requests fail once with 503 and should succeed on retry.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result: batch.result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      recoveredRequests,
      retryAmplification: requestCount ? round(harness.stats.upstreamCalls / requestCount) : 0,
    },
  });

  manager.destroy();
  return scenario;
}

async function rateLimitScenario(profile) {
  const requestCount = scaleCount(profile, 220);
  const concurrency = scaleCount(profile, 16);
  const rateLimitedSet = new Set(
    Array.from({ length: requestCount }, (_, index) => index).filter((index) => deterministicUnit(SEED, 'rate-limit', index) < 0.14)
  );
  const items = Array.from({ length: requestCount }, (_, index) => ({
    id: index,
    url: `/rate-limit/${index}`,
    priority: index % 2,
  }));
  const harness = createAdapter(({ key, attempt }) => {
    const requestId = Number(key.split('/').pop());
    const limited = rateLimitedSet.has(requestId);
    const latencyMs = latency(SEED, key, attempt, 14, 10);

    if (limited && attempt === 1) {
      return {
        latencyMs,
        errorStatus: 429,
        errorMessage: 'Rate limited',
        headers: { 'retry-after': '1' },
      };
    }

    return {
      latencyMs,
      data: { ok: true, key, attempt, limited },
    };
  });

  const manager = createManager({
    adapter: harness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  const startedAt = performance.now();
  const batch = await runManagerBatch({
    manager,
    items,
    concurrency,
  });
  const finishedAt = performance.now();

  const retriedRequests = items.filter((item) => getAttemptsForKey(harness.stats, item.url) > 1).length;
  const scenario = createScenarioSummary({
    name: 'Rate Limit Recovery',
    description: 'Simulates brief 429 responses to show recovery cost and tail latency under backoff.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result: batch.result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      retriedRequests,
      configuredRetryDelayMs: FAST_RETRY_DELAY_MS,
    },
  });

  manager.destroy();
  return scenario;
}

async function priorityScenario(profile) {
  const requestCount = scaleCount(profile, 180);
  const concurrency = Math.max(3, scaleCount(profile, 6));
  const items = [
    ...Array.from({ length: Math.floor(requestCount * 0.6) }, (_, index) => ({
      id: index,
      url: `/priority/low/${index}`,
      priority: 0,
      tier: 'low',
    })),
    ...Array.from({ length: Math.floor(requestCount * 0.25) }, (_, index) => ({
      id: index,
      url: `/priority/medium/${index}`,
      priority: 1,
      tier: 'medium',
    })),
    ...Array.from({ length: requestCount - Math.floor(requestCount * 0.85) }, (_, index) => ({
      id: index,
      url: `/priority/high/${index}`,
      priority: 3,
      tier: 'high',
    })),
  ];

  const harness = createAdapter(({ key, attempt }) => ({
    latencyMs: latency(SEED, key, attempt, 18, 8),
    data: { ok: true, key, attempt },
  }));

  const manager = createManager({
    adapter: harness.adapter,
    retries: 1,
    maxConcurrentRequests: concurrency,
  });

  const startedAt = performance.now();
  const batch = await measureRequests({
    items,
    concurrency: requestCount,
    execute: (item) =>
      manager.axiosInstance.get(item.url, {
        __priority: item.priority,
      }),
  });
  const finishedAt = performance.now();

  const latencyByTier = {
    high: [],
    medium: [],
    low: [],
  };

  batch.samples.forEach((sample, index) => {
    latencyByTier[items[index].tier].push(sample.durationMs);
  });

  const scenario = createScenarioSummary({
    name: 'Priority Queue Under Contention',
    description: 'Floods the queue with low-priority work before high-priority requests arrive, showing tail latency separation.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result: batch,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      latencyByTier: {
        high: {
          p50Ms: round(percentile(latencyByTier.high, 0.5)),
          p95Ms: round(percentile(latencyByTier.high, 0.95)),
        },
        medium: {
          p50Ms: round(percentile(latencyByTier.medium, 0.5)),
          p95Ms: round(percentile(latencyByTier.medium, 0.95)),
        },
        low: {
          p50Ms: round(percentile(latencyByTier.low, 0.5)),
          p95Ms: round(percentile(latencyByTier.low, 0.95)),
        },
      },
    },
  });

  manager.destroy();
  return scenario;
}

async function memoryStability(profile) {
  const cycles = profile.memoryCycles;
  const requestsPerCycle = scaleCount(profile, 120);
  const heapTotals = [];

  if (typeof global.gc === 'function') {
    global.gc();
  }

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const harness = createAdapter(({ key, attempt }) => ({
      latencyMs: latency(SEED, key, attempt, 5, 4),
      data: { ok: true },
    }));
    const manager = createManager({
      adapter: harness.adapter,
      retries: 1,
      maxConcurrentRequests: 20,
    });

    await runManagerBatch({
      manager,
      items: Array.from({ length: requestsPerCycle }, (_, index) => ({
        url: `/memory/${cycle}/${index}`,
        priority: index % 2,
      })),
      concurrency: 20,
    });

    manager.destroy();

    if (typeof global.gc === 'function') {
      global.gc();
    }

    heapTotals.push(process.memoryUsage().heapUsed);
  }

  return {
    cycles,
    requestsPerCycle,
    startHeapMb: round(heapTotals[0] / 1024 / 1024),
    endHeapMb: round(heapTotals[heapTotals.length - 1] / 1024 / 1024),
    totalGrowthMb: round((heapTotals[heapTotals.length - 1] - heapTotals[0]) / 1024 / 1024),
  };
}

async function main() {
  const profile = getProfile();

  printHeader('Core RetryManager Benchmarks', `Profile: ${profile.name}`);

  const scenarios = [];
  scenarios.push(await healthyPathScenario(profile));
  scenarios.push(await transientFailureScenario(profile));
  scenarios.push(await rateLimitScenario(profile));
  scenarios.push(await priorityScenario(profile));

  scenarios.forEach(printScenario);

  const memory = await memoryStability(profile);
  const summary = {
    profile: profile.name,
    avgThroughputPerSec: round(scenarios.reduce((sum, scenario) => sum + scenario.throughputPerSec, 0) / scenarios.length),
    slowestP95Ms: Math.max(...scenarios.map((scenario) => scenario.latencyMs.p95Ms)),
    highestSuccessRate: Math.max(...scenarios.map((scenario) => scenario.successRate)),
    memory,
  };

  console.log('\nSummary');
  console.log('-------');
  console.log(`Average throughput: ${summary.avgThroughputPerSec} req/sec`);
  console.log(`Slowest p95 latency: ${summary.slowestP95Ms}ms`);
  console.log(`Memory growth across ${memory.cycles} cycles: ${memory.totalGrowthMb}MB`);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Core RetryManager Benchmarks',
    generatedAt: nowIso(),
    profile: profile.name,
    scenarios,
    summary,
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
