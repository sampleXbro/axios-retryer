/* istanbul ignore file */
const { performance } = require('perf_hooks');

const { RetryManager, AXIOS_RETRYER_REQUEST_PRIORITIES, createRetryStrategy } = require('../dist/index.cjs.js');
const { MetricsPlugin } = require('../dist/plugins/MetricsPlugin.cjs.js');
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
  withPriority,
} = require('./_utils');

const BENCHMARK_NAME = 'metrics-plugin';
const SEED = 5501;

function latency(seed, key, attempt, baseMs, spreadMs) {
  return Math.max(1, Math.round(baseMs + deterministicUnit(seed, key, attempt) * spreadMs));
}

function createManager({ adapter, plugins = [], retries = 1, maxConcurrentRequests = 16 }) {
  const manager = new RetryManager({
    retries,
    maxConcurrentRequests,
    queueDelay: 0,
    debug: false,
    retryStrategy: createRetryStrategy({ getDelay: () => 20 }),
  });
  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;
  plugins.forEach((p) => manager.use(p));
  return manager;
}

// Compares throughput of a manager with vs without MetricsPlugin under identical workload.
async function runMetricsOverheadScenario(profile) {
  const requestCount = scaleCount(profile, 300);
  const concurrency = scaleCount(profile, 24);

  function makeAdapter() {
    return createAdapter(({ key, attempt }) => {
      if (Number(key.split('/').pop()) % 7 === 0 && attempt === 1) {
        return { latencyMs: latency(SEED, key, attempt, 5, 4), errorStatus: 503, errorMessage: 'Transient' };
      }
      return { latencyMs: latency(SEED, key, attempt, 5, 4), data: { ok: true } };
    });
  }

  const items = Array.from({ length: requestCount }, (_, i) => ({
    url: `/overhead/item/${i}`,
    priority: i % 4,
  }));

  // Baseline: no MetricsPlugin
  const baseHarness = makeAdapter();
  const baseManager = createManager({ adapter: baseHarness.adapter, maxConcurrentRequests: concurrency });
  const baseStart = performance.now();
  await measureRequests({
    items,
    concurrency,
    execute: (item) => baseManager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const baseThroughput = round((requestCount / (performance.now() - baseStart)) * 1000);
  baseManager.destroy();

  // With MetricsPlugin
  const metricsPlugin = new MetricsPlugin();
  const pluginHarness = makeAdapter();
  const pluginManager = createManager({
    adapter: pluginHarness.adapter,
    plugins: [metricsPlugin],
    maxConcurrentRequests: concurrency,
  });

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) => pluginManager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const pluginThroughput = round((requestCount / (finishedAt - startedAt)) * 1000);
  const snap = metricsPlugin.getMetrics();

  const scenario = createScenarioSummary({
    name: 'MetricsPlugin: Collection Overhead',
    description: 'Measures throughput delta introduced by MetricsPlugin under a mixed success/retry workload.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager: pluginManager,
    upstreamCalls: pluginHarness.stats.upstreamCalls,
    extras: {
      baselineThroughput: baseThroughput,
      pluginThroughput,
      overheadPct: baseThroughput > 0 ? round(((baseThroughput - pluginThroughput) / baseThroughput) * 100) : 0,
      totalRequests: snap.totalRequests,
      successfulRetries: snap.successfulRetries,
      errorTypesDistribution: snap.errorTypesDistribution,
    },
  });

  pluginManager.destroy();
  return scenario;
}

// Runs requests across all 5 priority tiers with differential retry rates to
// populate the priorityMetrics and requestCountsByPriority breakdown.
async function runPriorityMetricsScenario(profile) {
  const perTier = scaleCount(profile, 40, 10);
  const concurrency = scaleCount(profile, 20);
  const metricsPlugin = new MetricsPlugin();

  const harness = createAdapter(({ key, attempt }) => {
    if (key.includes('/high/') && attempt === 1 && deterministicUnit(SEED, key, attempt) < 0.4) {
      return { latencyMs: latency(SEED, key, attempt, 6, 4), errorStatus: 500, errorMessage: 'Error' };
    }
    if (key.includes('/low/') && attempt === 1 && deterministicUnit(SEED, key, attempt) < 0.6) {
      return { latencyMs: latency(SEED, key, attempt, 6, 4), errorStatus: 500, errorMessage: 'Error' };
    }
    return { latencyMs: latency(SEED, key, attempt, 6, 4), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [metricsPlugin],
    maxConcurrentRequests: concurrency,
  });

  const tiers = [
    { name: 'critical', priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
    { name: 'highest',  priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST },
    { name: 'high',     priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
    { name: 'medium',   priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
    { name: 'low',      priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
  ];

  const items = tiers.flatMap(({ name, priority }) =>
    Array.from({ length: perTier }, (_, i) => ({ url: `/priority/${name}/${i}`, priority }))
  );

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const snap = metricsPlugin.getMetrics();

  const scenario = createScenarioSummary({
    name: 'MetricsPlugin: Priority Breakdown',
    description: 'Exercises all 5 priority tiers (CRITICAL/HIGHEST/HIGH/MEDIUM/LOW) to populate priorityMetrics and requestCountsByPriority.',
    requestCount: items.length,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      totalRequests: snap.totalRequests,
      successfulRetries: snap.successfulRetries,
      failedRetries: snap.failedRetries,
      avgQueueWaitMs: snap.avgQueueWait,
      avgRetryDelayMs: snap.avgRetryDelay,
      errorTypesDistribution: snap.errorTypesDistribution,
      priorityMetrics: snap.priorityMetrics,
      requestCountsByPriority: snap.requestCountsByPriority,
    },
  });

  manager.destroy();
  return scenario;
}

// Counts onMetricsUpdated events during a mixed workload and verifies
// resetMetrics zeros all counters.
async function runMetricsEventsScenario(profile) {
  const requestCount = scaleCount(profile, 100);
  const concurrency = scaleCount(profile, 16);
  let updateCount = 0;
  const metricsPlugin = new MetricsPlugin();

  const harness = createAdapter(({ key, attempt }) => {
    if (attempt === 1 && deterministicUnit(SEED, key, attempt) < 0.25) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 502, errorMessage: 'Error' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [metricsPlugin],
    maxConcurrentRequests: concurrency,
  });

  // onMetricsUpdated is a plugin event — register via manager.on after use()
  manager.on('onMetricsUpdated', () => { updateCount += 1; });

  const items = Array.from({ length: requestCount }, (_, i) => ({
    url: `/events/item/${i}`,
    priority: i % 3,
  }));

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const snapshotBefore = metricsPlugin.getMetrics();
  metricsPlugin.resetMetrics();
  const snapshotAfter = metricsPlugin.getMetrics();

  const scenario = createScenarioSummary({
    name: 'MetricsPlugin: Events and resetMetrics',
    description: 'Counts onMetricsUpdated events during a mixed workload and verifies resetMetrics zeroes all counters.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      onMetricsUpdatedFired: updateCount,
      updatesPerRequest: requestCount > 0 ? round(updateCount / requestCount) : 0,
      snapshotTotalRequests: snapshotBefore.totalRequests,
      snapshotSuccessfulRetries: snapshotBefore.successfulRetries,
      afterResetTotalRequests: snapshotAfter.totalRequests,
      afterResetSuccessfulRetries: snapshotAfter.successfulRetries,
      afterResetErrorTypes: snapshotAfter.errorTypesDistribution,
    },
  });

  manager.destroy();
  return scenario;
}

async function main() {
  const profile = getProfile();

  printHeader('Metrics Plugin Benchmarks', `Profile: ${profile.name}`);

  const scenarios = [
    await runMetricsOverheadScenario(profile),
    await runPriorityMetricsScenario(profile),
    await runMetricsEventsScenario(profile),
  ];

  scenarios.forEach(printScenario);

  const summary = {
    profile: profile.name,
    avgSuccessRate: round(scenarios.reduce((sum, s) => sum + s.successRate, 0) / scenarios.length),
    avgThroughputPerSec: round(scenarios.reduce((sum, s) => sum + s.throughputPerSec, 0) / scenarios.length),
    metricsOverheadPct: scenarios[0].extras.overheadPct,
    onMetricsUpdatedFired: scenarios[2].extras.onMetricsUpdatedFired,
  };

  console.log('\nSummary');
  console.log('-------');
  console.log(`Average success rate: ${summary.avgSuccessRate}%`);
  console.log(`Average throughput: ${summary.avgThroughputPerSec} req/sec`);
  console.log(`MetricsPlugin overhead: ${summary.metricsOverheadPct}%`);
  console.log(`onMetricsUpdated events fired: ${summary.onMetricsUpdatedFired}`);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Metrics Plugin Benchmarks',
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
