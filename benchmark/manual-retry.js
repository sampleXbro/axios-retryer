/* istanbul ignore file */
const { performance } = require('perf_hooks');

const { RetryManager, RETRY_MODES, createRetryStrategy } = require('../dist/index.cjs.js');
const { ManualRetryPlugin } = require('../dist/plugins/ManualRetryPlugin.cjs.js');
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
  withPriority,
} = require('./_utils');

const BENCHMARK_NAME = 'manual-retry';
const SEED = 4401;

// retryFailedRequests() inserts Math.min(200 * i, 2000) ms between each replayed item.
// With N stored items the total replay delay is sum(200, 400, ..., min(200*N, 2000)).
// Keep this small so all profiles finish comfortably within their timeouts.
const MAX_REPLAY_ITEMS = 8;

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

// Terminal failures are captured, then replayed after the server recovers.
async function runStoreAndReplayScenario(profile) {
  const requestCount = scaleCount(profile, 40);
  const concurrency = scaleCount(profile, 12);
  const alwaysFailIds = new Set(
    Array.from({ length: requestCount }, (_, i) => i).filter(
      (i) => deterministicUnit(SEED, 'fail', i) < 0.3
    )
  );
  let serverHealthy = false;

  const manualRetry = new ManualRetryPlugin({
    maxRequestsToStore: MAX_REPLAY_ITEMS,
    manualRetryMaxAge: 60_000,
  });

  const harness = createAdapter(({ key, attempt }) => {
    const id = Number(key.split('/').pop());
    if (!serverHealthy && alwaysFailIds.has(id)) {
      return { latencyMs: latency(SEED, key, attempt, 6, 4), errorStatus: 503, errorMessage: 'Down' };
    }
    return { latencyMs: latency(SEED, key, attempt, 6, 4), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [manualRetry],
    retries: 1,
    maxConcurrentRequests: concurrency,
  });

  const items = Array.from({ length: requestCount }, (_, i) => ({
    url: `/replay/resource/${i}`,
    priority: i % 3,
  }));

  const startedAt = performance.now();
  const firstRun = await measureRequests({
    items,
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });

  const storedCount = manualRetry.getStoredRequests().length;
  serverHealthy = true;
  const replayed = await manualRetry.retryFailedRequests();
  const finishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'ManualRetry: Store and Replay',
    description: 'Terminal failures are captured by ManualRetryPlugin and replayed once the server recovers.',
    requestCount: requestCount + replayed.length,
    concurrency,
    startedAt,
    finishedAt,
    result: firstRun,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      firstRunFailures: firstRun.totals.failureCount,
      storedForReplay: storedCount,
      replayedCount: replayed.length,
      replaySuccessRate: storedCount > 0 ? round((replayed.length / storedCount) * 100) : 100,
    },
  });

  manager.destroy();
  return scenario;
}

// Stored failures older than manualRetryMaxAge are silently discarded at replay time.
async function runMaxAgeFilterScenario(profile) {
  const batchSize = scaleCount(profile, 30);
  const concurrency = scaleCount(profile, 10);
  const maxAge = 200;
  const failingIds = new Set(
    Array.from({ length: batchSize }, (_, i) => i).filter(
      (i) => deterministicUnit(SEED, 'age', i) < 0.4
    )
  );
  let phaseTwo = false;

  const manualRetry = new ManualRetryPlugin({
    maxRequestsToStore: MAX_REPLAY_ITEMS,
    manualRetryMaxAge: maxAge,
  });

  const harness = createAdapter(({ key, attempt }) => {
    const id = Number(key.split('/').pop());
    if (!phaseTwo && key.startsWith('/age/stale/') && failingIds.has(id)) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 500, errorMessage: 'Error' };
    }
    if (!phaseTwo && key.startsWith('/age/fresh/')) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 500, errorMessage: 'Error' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [manualRetry],
    retries: 1,
    maxConcurrentRequests: concurrency,
  });

  const startedAt = performance.now();

  await measureRequests({
    items: Array.from({ length: batchSize }, (_, i) => ({ url: `/age/stale/${i}` })),
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const storedAfterBatch1 = manualRetry.getStoredRequests().length;

  // Wait past maxAge so batch-1 failures expire at replay time
  await sleep(maxAge + 60);

  const freshCount = Math.min(MAX_REPLAY_ITEMS, Math.floor(batchSize * 0.3));
  await measureRequests({
    items: Array.from({ length: freshCount }, (_, i) => ({ url: `/age/fresh/${i}` })),
    concurrency: Math.min(8, freshCount),
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const storedBeforeReplay = manualRetry.getStoredRequests().length;

  phaseTwo = true;
  const replayed = await manualRetry.retryFailedRequests();
  const finishedAt = performance.now();

  const combinedResult = {
    samples: [],
    totals: {
      requestCount: storedBeforeReplay,
      successCount: replayed.length,
      failureCount: storedBeforeReplay - replayed.length,
      successRate: storedBeforeReplay > 0 ? round((replayed.length / storedBeforeReplay) * 100) : 0,
      latency: { count: 0, minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    },
  };

  const scenario = createScenarioSummary({
    name: 'ManualRetry: maxAge Expiry Filtering',
    description: 'Stored failures older than manualRetryMaxAge are discarded at replay, preventing stale request replays.',
    requestCount: batchSize + freshCount + replayed.length,
    concurrency,
    startedAt,
    finishedAt,
    result: combinedResult,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      storedAfterBatch1,
      discardedAgedOut: Math.max(0, storedAfterBatch1 - replayed.length),
      freshReplayed: replayed.length,
      storedBeforeReplay,
    },
  });

  manager.destroy();
  return scenario;
}

// storeAuthRequests:true stores auth-bearing failures with credentials stripped;
// rehydrateAuth re-attaches a fresh token at replay time.
async function runRehydrateAuthScenario(profile) {
  const requestCount = scaleCount(profile, 24);
  const concurrency = scaleCount(profile, 10);
  let currentToken = 'expired-token';

  const manualRetry = new ManualRetryPlugin({
    maxRequestsToStore: MAX_REPLAY_ITEMS,
    manualRetryMaxAge: 60_000,
    storeAuthRequests: true,
    rehydrateAuth: (config) => {
      config.headers = config.headers || {};
      config.headers['Authorization'] = `Bearer ${currentToken}`;
      return config;
    },
  });

  const harness = createAdapter(({ key, attempt, config }) => {
    const auth = String(config.headers?.Authorization || '').replace('Bearer ', '');
    if (!auth || auth === 'expired-token') {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 401, errorMessage: 'Unauthorized' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true, token: auth } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [manualRetry],
    retries: 1,
    maxConcurrentRequests: concurrency,
  });
  manager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer expired-token';

  const items = Array.from({ length: requestCount }, (_, i) => ({ url: `/rehydrate/resource/${i}` }));

  const startedAt = performance.now();
  const firstRun = await measureRequests({
    items,
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url),
  });

  const storedCount = manualRetry.getStoredRequests().length;
  currentToken = 'valid-token';
  const replayed = await manualRetry.retryFailedRequests();
  const finishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'ManualRetry: rehydrateAuth on Replay',
    description: 'Auth-bearing failures are stored with credentials stripped; rehydrateAuth injects fresh credentials at replay.',
    requestCount: requestCount + replayed.length,
    concurrency,
    startedAt,
    finishedAt,
    result: firstRun,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      firstRunSuccessRate: firstRun.totals.successRate,
      capturedWithStrippedAuth: storedCount,
      replayedWithFreshAuth: replayed.length,
      replaySuccessRate: storedCount > 0 ? round((replayed.length / storedCount) * 100) : 0,
    },
  });

  manager.destroy();
  return scenario;
}

// Per-request requestMode:manual bypasses auto-retry; failures are captured for
// programmatic replay while auto-mode requests proceed normally.
async function runManualModeScenario(profile) {
  const totalCount = scaleCount(profile, 40);
  const concurrency = scaleCount(profile, 12);
  const manualModeCount = Math.min(MAX_REPLAY_ITEMS, Math.floor(totalCount * 0.4));
  const autoModeCount = totalCount - manualModeCount;
  let serverDown = true;

  const manualRetry = new ManualRetryPlugin({
    maxRequestsToStore: MAX_REPLAY_ITEMS,
    manualRetryMaxAge: 60_000,
  });

  const harness = createAdapter(({ key, attempt }) => {
    if (serverDown && key.startsWith('/perreq/manual/')) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 503, errorMessage: 'Down' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [manualRetry],
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  const allItems = [
    ...Array.from({ length: manualModeCount }, (_, i) => ({
      url: `/perreq/manual/${i}`,
      mode: RETRY_MODES.MANUAL,
    })),
    ...Array.from({ length: autoModeCount }, (_, i) => ({
      url: `/perreq/auto/${i}`,
      mode: RETRY_MODES.AUTOMATIC,
    })),
  ];

  const startedAt = performance.now();
  const firstRun = await measureRequests({
    items: allItems,
    concurrency,
    execute: (item) =>
      manager.axiosInstance.get(item.url, {
        __axiosRetryer: { requestMode: item.mode, priority: 1 },
      }),
  });

  const capturedByPlugin = manualRetry.getStoredRequests().length;
  serverDown = false;
  const replayed = await manualRetry.retryFailedRequests();
  const finishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'ManualRetry: Per-request MANUAL Mode Capture',
    description: 'requestMode:manual per-request skips auto-retry; ManualRetryPlugin captures the failures for later replay.',
    requestCount: totalCount + replayed.length,
    concurrency,
    startedAt,
    finishedAt,
    result: firstRun,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      manualModeRequests: manualModeCount,
      autoModeRequests: autoModeCount,
      capturedByPlugin,
      replayedSuccessfully: replayed.length,
    },
  });

  manager.destroy();
  return scenario;
}

async function main() {
  const profile = getProfile();

  printHeader('Manual Retry Benchmarks', `Profile: ${profile.name}`);

  const scenarios = [
    await runStoreAndReplayScenario(profile),
    await runMaxAgeFilterScenario(profile),
    await runRehydrateAuthScenario(profile),
    await runManualModeScenario(profile),
  ];

  scenarios.forEach(printScenario);

  const totalReplayed = scenarios.reduce(
    (sum, s) =>
      sum +
      (s.extras.replayedCount ||
        s.extras.freshReplayed ||
        s.extras.replayedWithFreshAuth ||
        s.extras.replayedSuccessfully ||
        0),
    0
  );

  const summary = {
    profile: profile.name,
    avgSuccessRate: round(scenarios.reduce((sum, s) => sum + s.successRate, 0) / scenarios.length),
    avgThroughputPerSec: round(scenarios.reduce((sum, s) => sum + s.throughputPerSec, 0) / scenarios.length),
    totalReplayed,
  };

  console.log('\nSummary');
  console.log('-------');
  console.log(`Average success rate: ${summary.avgSuccessRate}%`);
  console.log(`Average throughput: ${summary.avgThroughputPerSec} req/sec`);
  console.log(`Total requests replayed via ManualRetryPlugin: ${summary.totalReplayed}`);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Manual Retry Benchmarks',
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
