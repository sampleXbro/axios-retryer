const { performance } = require('perf_hooks');

const { RetryManager, createRetryStrategy } = require('../dist/index.cjs.js');
const {
  createAdapter,
  createScenarioSummary,
  deterministicUnit,
  emitResult,
  getProfile,
  measureRequests,
  nowIso,
  printHeader,
  printScenario,
  round,
  scaleCount,
  silenceManager,
  sleep,
  summarizeLatency,
} = require('./_utils');

const BENCHMARK_NAME = 'stress-testing';
const SEED = 3301;

function latency(seed, key, attempt, baseMs, spreadMs) {
  return Math.max(1, Math.round(baseMs + (deterministicUnit(seed, key, attempt) * spreadMs)));
}

function createManager({ adapter, retries = 2, maxConcurrentRequests = 32 }) {
  const manager = new RetryManager({
    retries,
    maxConcurrentRequests,
    queueDelay: 0,
    debug: false,
    retryStrategy: createRetryStrategy({
      getDelay: () => 20,
    }),
  });

  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;
  return manager;
}

async function burstScenario(profile) {
  const bursts = [
    scaleCount(profile, 120),
    scaleCount(profile, 300),
    scaleCount(profile, 600),
  ];
  const concurrency = scaleCount(profile, 48);
  const harness = createAdapter(({ key, attempt }) => {
    const requestId = Number(key.split('/').pop());
    const transientFailure = requestId % 9 === 0;

    if (transientFailure && attempt === 1) {
      return {
        latencyMs: latency(SEED, key, attempt, 7, 5),
        errorStatus: 503,
        errorMessage: 'Burst saturation',
      };
    }

    return {
      latencyMs: latency(SEED, key, attempt, 7, 5),
      data: { ok: true, requestId, attempt },
    };
  });
  const manager = createManager({
    adapter: harness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  const batches = [];
  const phases = [];
  const startedAt = performance.now();

  for (let burstIndex = 0; burstIndex < bursts.length; burstIndex += 1) {
    const requestCount = bursts[burstIndex];
    const items = Array.from({ length: requestCount }, (_, index) => ({
      url: `/burst/${burstIndex}-${index}`,
      priority: index % 4,
    }));
    const burstStart = performance.now();
    const batch = await measureRequests({
      items,
      concurrency,
      execute: (item) => manager.axiosInstance.get(item.url, { __priority: item.priority }),
    });
    const burstDuration = performance.now() - burstStart;

    batches.push(batch);
    phases.push({
      burst: burstIndex + 1,
      requestCount,
      throughputPerSec: round((requestCount / burstDuration) * 1000),
      successRate: batch.totals.successRate,
      p95Ms: batch.totals.latency.p95Ms,
    });
  }

  const finishedAt = performance.now();
  const merged = {
    samples: batches.flatMap((batch) => batch.samples),
    totals: {
      requestCount: phases.reduce((sum, phase) => sum + phase.requestCount, 0),
      successCount: batches.reduce((sum, batch) => sum + batch.totals.successCount, 0),
      failureCount: batches.reduce((sum, batch) => sum + batch.totals.failureCount, 0),
      successRate: round(
        (batches.reduce((sum, batch) => sum + batch.totals.successCount, 0) /
          phases.reduce((sum, phase) => sum + phase.requestCount, 0)) *
          100
      ),
      latency: summarizeLatency(batches.flatMap((batch) => batch.samples.map((sample) => sample.durationMs))),
    },
  };

  const scenario = createScenarioSummary({
    name: 'Burst Capacity',
    description: 'Measures how the manager behaves when concurrency ramps up in larger spikes with transient 503s.',
    requestCount: merged.totals.requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result: merged,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      phases,
    },
  });

  manager.destroy();
  return scenario;
}

async function sustainedScenario(profile) {
  const durationMs = profile.sustainedDurationMs;
  const batchSize = scaleCount(profile, 8);
  const intervalMs = 200;
  const concurrency = scaleCount(profile, 32);
  const harness = createAdapter(({ key, attempt }) => {
    const requestId = Number(key.split('/').pop());
    const shouldRetry = requestId % 11 === 0;

    if (shouldRetry && attempt === 1) {
      return {
        latencyMs: latency(SEED, key, attempt, 10, 7),
        errorStatus: 500,
        errorMessage: 'Transient sustained-load fault',
      };
    }

    return {
      latencyMs: latency(SEED, key, attempt, 10, 7),
      data: { ok: true, requestId, attempt },
    };
  });
  const manager = createManager({
    adapter: harness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  const samples = [];
  const snapshots = [];
  const inFlight = new Set();
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  let requestId = 0;

  while (performance.now() < deadline) {
    const loopStartedAt = performance.now();

    for (let index = 0; index < batchSize; index += 1) {
      requestId += 1;
      const promise = (async () => {
        const requestStartedAt = performance.now();

        try {
          await manager.axiosInstance.get(`/sustained/${requestId}`, {
            __priority: requestId % 3,
          });
          samples.push({
            ok: true,
            durationMs: performance.now() - requestStartedAt,
          });
        } catch (error) {
          samples.push({
            ok: false,
            durationMs: performance.now() - requestStartedAt,
            error,
          });
        }
      })()
        .finally(() => {
          inFlight.delete(promise);
        });

      inFlight.add(promise);
    }

    if (snapshots.length === 0 || performance.now() - startedAt > snapshots.length * 10000) {
      const metrics = manager.getMetrics();
      snapshots.push({
        elapsedMs: round(performance.now() - startedAt),
        totalRequests: metrics.totalRequests,
        avgQueueWaitMs: round(metrics.avgQueueWait),
        activeTimers: metrics.timerHealth.activeTimers,
        activeRetryTimers: metrics.timerHealth.activeRetryTimers,
        memoryMb: round(process.memoryUsage().heapUsed / 1024 / 1024),
      });
    }

    const elapsedThisLoop = performance.now() - loopStartedAt;
    if (elapsedThisLoop < intervalMs) {
      await sleep(intervalMs - elapsedThisLoop);
    }
  }

  await Promise.allSettled([...inFlight]);
  const finishedAt = performance.now();

  const result = {
    samples,
    totals: {
      requestCount: samples.length,
      successCount: samples.filter((sample) => sample.ok).length,
      failureCount: samples.filter((sample) => !sample.ok).length,
      successRate: samples.length ? round((samples.filter((sample) => sample.ok).length / samples.length) * 100) : 0,
      latency: summarizeLatency(samples.map((sample) => sample.durationMs)),
    },
  };

  const scenario = createScenarioSummary({
    name: 'Sustained Load',
    description: 'Sends a paced stream for a fixed duration to surface queue growth, timer pressure, and long-run throughput.',
    requestCount: result.totals.requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      durationMs,
      snapshots,
    },
  });

  manager.destroy();
  return scenario;
}

async function outageRecoveryScenario(profile) {
  const requestCount = scaleCount(profile, 540);
  const concurrency = scaleCount(profile, 24);
  const harness = createAdapter(({ key, attempt }) => {
    const requestId = Number(key.split('/').pop());

    if (requestId >= Math.floor(requestCount * 0.33) && requestId < Math.floor(requestCount * 0.66)) {
      return {
        latencyMs: latency(SEED, key, attempt, 8, 5),
        errorStatus: 503,
        errorMessage: 'Full outage',
      };
    }

    if (requestId >= Math.floor(requestCount * 0.66) && attempt === 1 && requestId % 2 === 0) {
      return {
        latencyMs: latency(SEED, key, attempt, 8, 5),
        errorStatus: 502,
        errorMessage: 'Partial recovery',
      };
    }

    return {
      latencyMs: latency(SEED, key, attempt, 8, 5),
      data: { ok: true, requestId, attempt },
    };
  });
  const manager = createManager({
    adapter: harness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });
  const items = Array.from({ length: requestCount }, (_, index) => ({
    url: `/recovery/${index}`,
    priority: index % 3,
  }));

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url, { __priority: item.priority }),
  });
  const finishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'Outage And Recovery',
    description: 'Runs healthy traffic into a hard outage and then a partial recovery window to show recovery cost and residual failures.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      terminalFailureRate: requestCount ? round((manager.getMetrics().completelyFailedRequests / requestCount) * 100) : 0,
    },
  });

  manager.destroy();
  return scenario;
}

async function main() {
  const profile = getProfile();

  printHeader('Stress Benchmarks', `Profile: ${profile.name}`);

  const scenarios = [
    await burstScenario(profile),
    await sustainedScenario(profile),
    await outageRecoveryScenario(profile),
  ];

  scenarios.forEach(printScenario);

  const summary = {
    profile: profile.name,
    peakThroughputPerSec: Math.max(...scenarios.map((scenario) => scenario.throughputPerSec)),
    slowestP95Ms: Math.max(...scenarios.map((scenario) => scenario.latencyMs.p95Ms)),
    avgSuccessRate: round(scenarios.reduce((sum, scenario) => sum + scenario.successRate, 0) / scenarios.length),
  };

  console.log('\nSummary');
  console.log('-------');
  console.log(`Peak throughput: ${summary.peakThroughputPerSec} req/sec`);
  console.log(`Slowest p95 latency: ${summary.slowestP95Ms}ms`);
  console.log(`Average success rate: ${summary.avgSuccessRate}%`);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Stress Benchmarks',
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
