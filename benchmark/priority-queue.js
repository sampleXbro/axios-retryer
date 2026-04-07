const { performance } = require('perf_hooks');

const { RetryManager, createRetryStrategy } = require('../dist/index.cjs.js');
const {
  createAdapter,
  deterministicUnit,
  emitResult,
  getProfile,
  measureRequests,
  nowIso,
  percentile,
  printHeader,
  round,
  scaleCount,
  silenceManager,
  withPriority,
} = require('./_utils');

const BENCHMARK_NAME = 'priority-queue';
const SEED = 4101;

function latency(key, attempt) {
  return Math.max(1, Math.round(18 + deterministicUnit(SEED, key, attempt) * 8));
}

async function main() {
  const profile = getProfile();
  const concurrency = Math.max(3, scaleCount(profile, 5));
  const requestCount = scaleCount(profile, 180);
  const lowCount = Math.floor(requestCount * 0.6);
  const mediumCount = Math.floor(requestCount * 0.25);
  const highCount = requestCount - lowCount - mediumCount;

  printHeader('Priority Queue Benchmark', `Profile: ${profile.name}`);

  const harness = createAdapter(({ key, attempt }) => ({
    latencyMs: latency(key, attempt),
    data: { ok: true, key, attempt },
  }));
  const manager = new RetryManager({
    retries: 1,
    maxConcurrentRequests: concurrency,
    queueDelay: 0,
    debug: false,
    retryStrategy: createRetryStrategy({
      getDelay: () => 15,
    }),
  });
  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = harness.adapter;

  const items = [
    ...Array.from({ length: lowCount }, (_, index) => ({
      url: `/priority/low/${index}`,
      priority: 0,
      tier: 'low',
    })),
    ...Array.from({ length: mediumCount }, (_, index) => ({
      url: `/priority/medium/${index}`,
      priority: 1,
      tier: 'medium',
    })),
    ...Array.from({ length: highCount }, (_, index) => ({
      url: `/priority/high/${index}`,
      priority: 3,
      tier: 'high',
    })),
  ];

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency: items.length,
    execute: (item) =>
      manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const latencyByTier = { high: [], medium: [], low: [] };
  result.samples.forEach((sample, index) => {
    latencyByTier[items[index].tier].push(sample.durationMs);
  });

  const summary = {
    benchmark: BENCHMARK_NAME,
    title: 'Priority Queue Benchmark',
    generatedAt: nowIso(),
    profile: profile.name,
    durationMs: round(finishedAt - startedAt),
    throughputPerSec: round((requestCount / (finishedAt - startedAt)) * 1000),
    successRate: result.totals.successRate,
    tiers: {
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
    queueWaitAvgMs: round(manager.getMetrics().avgQueueWait),
    upstreamCalls: harness.stats.upstreamCalls,
  };

  console.log(`High priority p95: ${summary.tiers.high.p95Ms}ms`);
  console.log(`Medium priority p95: ${summary.tiers.medium.p95Ms}ms`);
  console.log(`Low priority p95: ${summary.tiers.low.p95Ms}ms`);
  console.log(`Throughput: ${summary.throughputPerSec} req/sec`);

  manager.destroy();
  emitResult(summary);
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
