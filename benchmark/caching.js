/* istanbul ignore file */
const { performance } = require('perf_hooks');

const { RetryManager } = require('../dist/index.cjs.js');
const { CachingPlugin, InMemoryCacheStorage } = require('../dist/plugins/CachingPlugin.cjs.js');
const {
  createAdapter,
  emitResult,
  getProfile,
  measureRequests,
  nowIso,
  printHeader,
  round,
  scaleCount,
  silenceManager,
} = require('./_utils');

function createManager({ adapter, plugins = [] }) {
  const manager = new RetryManager({
    retries: 0,
    maxConcurrentRequests: 32,
    queueDelay: 0,
    debug: false,
  });

  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;
  plugins.forEach((plugin) => manager.use(plugin));

  return manager;
}

function makeInstantAdapter() {
  return createAdapter(() => ({ data: { ok: true } }));
}

async function populateCache(manager, urlPrefix, count) {
  const items = Array.from({ length: count }, (_, index) => ({
    url: `${urlPrefix}/${index}`,
  }));

  await measureRequests({
    items,
    concurrency: Math.min(32, count),
    execute: (item) => manager.axiosInstance.get(item.url),
  });
}

async function runLargeCacheCleanupScenario(profile) {
  const entryCount = scaleCount(profile, 500, 100);
  const storage = new InMemoryCacheStorage();
  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 50,
    maxItems: 0,
    storage,
  });
  const harness = makeInstantAdapter();
  const manager = createManager({ adapter: harness.adapter, plugins: [cachePlugin] });

  await populateCache(manager, '/cleanup/item', entryCount);

  const statsBefore = cachePlugin.getCacheStats();

  await new Promise((resolve) => setTimeout(resolve, 60));

  const startedAt = performance.now();
  const invalidated = await cachePlugin.invalidateCache(/^GET\|\/cleanup\/item\//);
  const durationMs = performance.now() - startedAt;

  const statsAfter = cachePlugin.getCacheStats();
  manager.destroy();

  return {
    name: 'Large-Cache Cleanup (Invalidation)',
    description: `Populates ${entryCount} stale entries then measures bulk invalidation via RegExp matcher.`,
    entryCount,
    invalidated,
    sizeBeforeCleanup: statsBefore.size,
    sizeAfterCleanup: statsAfter.size,
    cleanupDurationMs: round(durationMs),
    cleanupThroughput: durationMs > 0 ? round((invalidated / durationMs) * 1000) : 0,
    successRate: 100,
  };
}

async function runPatternInvalidationScenario(profile) {
  const totalEntries = scaleCount(profile, 200, 50);
  const prefixCount = 4;
  const perPrefix = Math.floor(totalEntries / prefixCount);

  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 0,
    maxItems: 0,
  });
  const harness = makeInstantAdapter();
  const manager = createManager({ adapter: harness.adapter, plugins: [cachePlugin] });

  for (let p = 0; p < prefixCount; p++) {
    await populateCache(manager, `/api/group-${p}/resource`, perPrefix);
  }

  const statsBefore = cachePlugin.getCacheStats();

  const startedAt = performance.now();
  const invalidated = await cachePlugin.invalidateCache({ prefix: 'GET|/api/group-0/' });
  const durationMs = performance.now() - startedAt;

  const statsAfter = cachePlugin.getCacheStats();
  manager.destroy();

  return {
    name: 'Pattern Invalidation',
    description: `Populates ${statsBefore.size} entries across ${prefixCount} URL groups, then invalidates one group by prefix.`,
    totalEntries: statsBefore.size,
    prefixGroups: prefixCount,
    invalidated,
    sizeBeforeInvalidation: statsBefore.size,
    sizeAfterInvalidation: statsAfter.size,
    invalidationDurationMs: round(durationMs),
    invalidationThroughput: durationMs > 0 ? round((invalidated / durationMs) * 1000) : 0,
    successRate: 100,
  };
}

async function runCacheHitThroughputScenario(profile) {
  const warmEntries = scaleCount(profile, 100, 20);
  const readCount = scaleCount(profile, 2000, 200);
  const concurrency = scaleCount(profile, 32, 8);

  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 0,
    maxItems: 0,
  });
  const harness = makeInstantAdapter();
  const manager = createManager({ adapter: harness.adapter, plugins: [cachePlugin] });

  await populateCache(manager, '/hit/item', warmEntries);

  const upstreamAfterWarm = harness.stats.upstreamCalls;

  const items = Array.from({ length: readCount }, (_, index) => ({
    url: `/hit/item/${index % warmEntries}`,
  }));

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const durationMs = performance.now() - startedAt;

  const upstreamDuringReads = harness.stats.upstreamCalls - upstreamAfterWarm;
  const hitRate = readCount > 0 ? round(((readCount - upstreamDuringReads) / readCount) * 100) : 0;
  const throughput = durationMs > 0 ? round((readCount / durationMs) * 1000) : 0;

  manager.destroy();

  return {
    name: 'Cache Hit Throughput',
    description: `Reads ${readCount} requests against ${warmEntries} warm cache entries at concurrency ${concurrency}. Measures hot-path read rate.`,
    warmEntries,
    readCount,
    concurrency,
    hitRate,
    upstreamCallsDuringReads: upstreamDuringReads,
    durationMs: round(durationMs),
    throughputPerSec: throughput,
    successRate: result.totals.successRate,
    latencyMs: result.totals.latency,
  };
}

async function runCustomStorageCleanupScenario(profile) {
  const entryCount = scaleCount(profile, 300, 60);

  const storage = new InMemoryCacheStorage();
  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 0,
    maxItems: 0,
    storage,
  });
  const harness = makeInstantAdapter();
  const manager = createManager({ adapter: harness.adapter, plugins: [cachePlugin] });

  await populateCache(manager, '/custom/item', entryCount);

  const statsBefore = cachePlugin.getCacheStats();

  const startedAt = performance.now();
  await cachePlugin.clearCache();
  const durationMs = performance.now() - startedAt;

  const statsAfter = cachePlugin.getCacheStats();
  manager.destroy();

  return {
    name: 'Custom Storage Adapter Cleanup',
    description: `Populates ${entryCount} entries into a custom InMemoryCacheStorage adapter then measures clearCache() performance.`,
    entryCount,
    sizeBeforeClear: statsBefore.size,
    sizeAfterClear: statsAfter.size,
    clearDurationMs: round(durationMs),
    clearThroughput: durationMs > 0 && statsBefore.size > 0
      ? round((statsBefore.size / durationMs) * 1000)
      : 0,
    successRate: 100,
  };
}

async function main() {
  const profile = getProfile();
  printHeader('Caching Workload Benchmarks', `Profile: ${profile.name}`);

  console.log('\nRunning scenarios...');

  const cleanup = await runLargeCacheCleanupScenario(profile);
  console.log(`\n- ${cleanup.name}`);
  console.log(`  ${cleanup.description}`);
  console.log(`  Invalidated ${cleanup.invalidated}/${cleanup.sizeBeforeCleanup} entries in ${cleanup.cleanupDurationMs}ms (${cleanup.cleanupThroughput} entries/sec)`);

  const patternInval = await runPatternInvalidationScenario(profile);
  console.log(`\n- ${patternInval.name}`);
  console.log(`  ${patternInval.description}`);
  console.log(`  Invalidated ${patternInval.invalidated} entries in ${patternInval.invalidationDurationMs}ms, ${patternInval.sizeAfterInvalidation} remaining`);

  const hitThroughput = await runCacheHitThroughputScenario(profile);
  console.log(`\n- ${hitThroughput.name}`);
  console.log(`  ${hitThroughput.description}`);
  console.log(`  Hit rate: ${hitThroughput.hitRate}%, throughput: ${hitThroughput.throughputPerSec} req/sec, p95: ${hitThroughput.latencyMs.p95Ms}ms`);

  const customStorage = await runCustomStorageCleanupScenario(profile);
  console.log(`\n- ${customStorage.name}`);
  console.log(`  ${customStorage.description}`);
  console.log(`  Cleared ${customStorage.sizeBeforeClear} entries in ${customStorage.clearDurationMs}ms (${customStorage.clearThroughput} entries/sec)`);

  emitResult({
    benchmark: 'caching',
    title: 'Caching Workload Benchmarks',
    generatedAt: nowIso(),
    profile: profile.name,
    scenarios: [cleanup, patternInval, hitThroughput, customStorage],
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
