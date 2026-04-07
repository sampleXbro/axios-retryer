const { performance } = require('perf_hooks');

const { RetryManager, createRetryStrategy } = require('../dist/index.cjs.js');
const { CachingPlugin } = require('../dist/plugins/CachingPlugin.cjs.js');
const { CircuitBreakerPlugin } = require('../dist/plugins/CircuitBreakerPlugin.cjs.js');
const { TokenRefreshPlugin } = require('../dist/plugins/TokenRefreshPlugin.cjs.js');
const {
  createAdapter,
  createScenarioSummary,
  deterministicUnit,
  getProfile,
  measureRequests,
  round,
  scaleCount,
  silenceManager,
  sleep,
  summarizeLatency,
  withPriority,
} = require('./_utils');

const FAST_RETRY_DELAY_MS = 20;
const PLUGIN_SEED = 2401;

function latency(seed, key, attempt, baseMs, spreadMs) {
  return Math.max(1, Math.round(baseMs + (deterministicUnit(seed, key, attempt) * spreadMs)));
}

function buildRetryStrategy() {
  return createRetryStrategy({
    getDelay: () => FAST_RETRY_DELAY_MS,
  });
}

function createManager({ adapter, retries = 1, maxConcurrentRequests = 16, plugins = [] }) {
  const manager = new RetryManager({
    retries,
    maxConcurrentRequests,
    queueDelay: 0,
    debug: false,
    retryStrategy: buildRetryStrategy(),
  });

  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;
  plugins.forEach((plugin) => manager.use(plugin));

  return manager;
}

function mergeBatchTotals(batches) {
  const requestCount = batches.reduce((sum, batch) => sum + batch.totals.requestCount, 0);
  const successCount = batches.reduce((sum, batch) => sum + batch.totals.successCount, 0);
  const durations = batches.flatMap((batch) => batch.samples.map((sample) => sample.durationMs));

  return {
    samples: batches.flatMap((batch) => batch.samples),
    totals: {
      requestCount,
      successCount,
      failureCount: requestCount - successCount,
      successRate: requestCount ? round((successCount / requestCount) * 100) : 0,
      latency: summarizeLatency(durations),
    },
  };
}

async function runCacheScenario(profile = getProfile()) {
  const warmKeys = scaleCount(profile, 24);
  const hotLoopCount = scaleCount(profile, 180);
  const staleReadCount = scaleCount(profile, 36);
  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 2000,
    maxItems: 256,
  });
  const harness = createAdapter(({ key, attempt }) => ({
    latencyMs: latency(PLUGIN_SEED, key, attempt, 9, 6),
    data: {
      resource: key,
      fetchedAt: attempt,
    },
  }));
  const manager = createManager({
    adapter: harness.adapter,
    retries: 1,
    maxConcurrentRequests: scaleCount(profile, 18),
    plugins: [cachePlugin],
  });

  const warmupItems = Array.from({ length: warmKeys }, (_, index) => ({
    url: `/cache/resource/${index}`,
    priority: 1,
  }));
  const hotItems = Array.from({ length: hotLoopCount }, (_, index) => ({
    url: `/cache/resource/${index % warmKeys}`,
    priority: index % 2,
  }));
  const staleItems = Array.from({ length: staleReadCount }, (_, index) => ({
    url: `/cache/resource/${index % warmKeys}`,
    priority: 1,
  }));

  const startedAt = performance.now();
  const warmup = await measureRequests({
    items: warmupItems,
    concurrency: Math.min(12, warmupItems.length),
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const upstreamAfterWarmup = harness.stats.upstreamCalls;

  const hotReads = await measureRequests({
    items: hotItems,
    concurrency: Math.min(scaleCount(profile, 24), hotItems.length),
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const upstreamAfterHotReads = harness.stats.upstreamCalls;

  await sleep(110);

  const staleReads = await measureRequests({
    items: staleItems,
    concurrency: Math.min(10, staleItems.length),
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const combined = mergeBatchTotals([warmup, hotReads, staleReads]);
  const hotReadUpstreamCalls = upstreamAfterHotReads - upstreamAfterWarmup;
  const scenario = createScenarioSummary({
    name: 'Caching Plugin Effectiveness',
    description: 'Measures cold misses, warm-cache hits, and stale revalidation with deterministic repeated reads.',
    requestCount: combined.totals.requestCount,
    concurrency: scaleCount(profile, 24),
    startedAt,
    finishedAt,
    result: combined,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      warmupUpstreamCalls: upstreamAfterWarmup,
      hotReadHitRate: hotItems.length ? round((1 - hotReadUpstreamCalls / hotItems.length) * 100) : 0,
      staleRevalidationCalls: harness.stats.upstreamCalls - upstreamAfterHotReads,
      cacheStats: cachePlugin.getCacheStats(),
    },
  });

  manager.destroy();
  return scenario;
}

async function runCircuitBreakerScenario(profile = getProfile()) {
  const circuitBreaker = new CircuitBreakerPlugin({
    failureThreshold: 4,
    openTimeout: 500,
    halfOpenMax: 2,
    successThreshold: 2,
  });
  const harness = createAdapter(({ key, attempt }) => {
    if (key.startsWith('/circuit/outage')) {
      return {
        latencyMs: latency(PLUGIN_SEED, key, attempt, 7, 5),
        errorStatus: 503,
        errorMessage: 'Upstream outage',
      };
    }

    return {
      latencyMs: latency(PLUGIN_SEED, key, attempt, 6, 4),
      data: { ok: true, key, attempt },
    };
  });
  const manager = createManager({
    adapter: harness.adapter,
    retries: 0,
    maxConcurrentRequests: 24,
    plugins: [circuitBreaker],
  });

  const healthyItems = Array.from({ length: scaleCount(profile, 10, 4) }, (_, index) => ({
    url: `/circuit/healthy/${index}`,
    priority: 1,
  }));
  const tripItems = Array.from({ length: scaleCount(profile, 6, 5) }, (_, index) => ({
    url: `/circuit/outage/trip/${index}`,
    priority: 1,
  }));
  const blockedItems = Array.from({ length: scaleCount(profile, 20, 8) }, (_, index) => ({
    url: `/circuit/outage/blocked/${index}`,
    priority: 2,
  }));
  const recoveryItems = Array.from({ length: scaleCount(profile, 4, 2) }, (_, index) => ({
    url: `/circuit/recovery/${index}`,
    priority: 1,
  }));

  const startedAt = performance.now();
  const healthy = await measureRequests({
    items: healthyItems,
    concurrency: 4,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const trip = await measureRequests({
    items: tripItems,
    concurrency: 1,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const blocked = await measureRequests({
    items: blockedItems,
    concurrency: blockedItems.length,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });

  await sleep(550);

  const recovery = await measureRequests({
    items: recoveryItems,
    concurrency: 1,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const combined = mergeBatchTotals([healthy, trip, blocked, recovery]);
  const blockedByCircuit = blocked.samples.filter(
    (sample) => !sample.ok && String(sample.error && sample.error.message).includes('Circuit is open')
  ).length;
  const scenario = createScenarioSummary({
    name: 'Circuit Breaker Protection',
    description: 'Trips the breaker on an outage, measures fail-fast protection, then verifies half-open recovery.',
    requestCount: combined.totals.requestCount,
    concurrency: 6,
    startedAt,
    finishedAt,
    result: combined,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      blockedByCircuit,
      upstreamCallsAvoided: combined.totals.requestCount - harness.stats.upstreamCalls,
      finalState: circuitBreaker.getState(),
      breakerMetrics: circuitBreaker.getMetrics(),
    },
  });

  manager.destroy();
  return scenario;
}

async function runTokenRefreshScenario(profile = getProfile()) {
  let refreshCalls = 0;
  const tokenRefreshPlugin = new TokenRefreshPlugin(async (refreshAxios) => {
    refreshCalls += 1;
    const response = await refreshAxios.post('/auth/refresh');
    return { token: response.data.token };
  });
  const harness = createAdapter(({ key, attempt, config }) => {
    if (key === '/auth/refresh') {
      return {
        latencyMs: 20,
        data: { token: `refreshed-token-${refreshCalls}` },
      };
    }

    const authHeader = config.headers && (config.headers.Authorization || config.headers.authorization);
    const token = typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : '';

    if (!token.startsWith('refreshed-token-')) {
      return {
        latencyMs: latency(PLUGIN_SEED, key, attempt, 8, 5),
        errorStatus: 401,
        errorMessage: 'Token expired',
      };
    }

    return {
      latencyMs: latency(PLUGIN_SEED, key, attempt, 8, 5),
      data: { ok: true, tokenUsed: token, key },
    };
  });
  const requestCount = scaleCount(profile, 72);
  const manager = createManager({
    adapter: harness.adapter,
    retries: 1,
    maxConcurrentRequests: scaleCount(profile, 24),
    plugins: [tokenRefreshPlugin],
  });

  const items = Array.from({ length: requestCount }, (_, index) => ({
    url: `/auth/resource/${index}`,
    priority: index % 2,
    headers: {
      Authorization: 'Bearer expired-token',
    },
  }));

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency: Math.min(requestCount, scaleCount(profile, 24)),
    execute: (item) =>
      manager.axiosInstance.get(item.url, withPriority(item.priority, {
        headers: item.headers,
      })),
  });
  const finishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'Token Refresh Storm',
    description: 'Fires a burst of expired-token requests concurrently to verify refresh fan-in and replay reliability.',
    requestCount,
    concurrency: Math.min(requestCount, scaleCount(profile, 24)),
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      refreshCalls,
      replayAmplification: requestCount ? round(harness.stats.upstreamCalls / requestCount) : 0,
    },
  });

  manager.destroy();
  return scenario;
}

async function runCombinedPluginScenario(profile = getProfile()) {
  let refreshCalls = 0;
  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 2000,
    maxItems: 128,
  });
  const tokenRefreshPlugin = new TokenRefreshPlugin(async (refreshAxios) => {
    refreshCalls += 1;
    const response = await refreshAxios.post('/combined/auth/refresh');
    return { token: response.data.token };
  });
  const harness = createAdapter(({ key, attempt, config }) => {
    if (key === '/combined/auth/refresh') {
      return {
        latencyMs: 18,
        data: { token: `combined-token-${refreshCalls}` },
      };
    }

    const authHeader = config.headers && (config.headers.Authorization || config.headers.authorization);
    const token = typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : '';

    if (key.startsWith('/combined/resource/') && !token.startsWith('combined-token-')) {
      return {
        latencyMs: 8,
        errorStatus: 401,
        errorMessage: 'Combined auth expired',
      };
    }

    return {
      latencyMs: latency(PLUGIN_SEED, key, attempt, 7, 5),
      data: { ok: true, key, tokenUsed: token },
    };
  });
  const manager = createManager({
    adapter: harness.adapter,
    retries: 1,
    maxConcurrentRequests: scaleCount(profile, 18),
    plugins: [cachePlugin, tokenRefreshPlugin],
  });

  const authWarmItems = Array.from({ length: scaleCount(profile, 24) }, (_, index) => ({
    url: `/combined/resource/${index % 6}`,
    priority: index % 2,
    headers: { Authorization: 'Bearer expired-combined-token' },
  }));
  const cacheHotItems = Array.from({ length: scaleCount(profile, 90) }, (_, index) => ({
    url: `/combined/resource/${index % 6}`,
    priority: index % 3,
    headers: { Authorization: `Bearer combined-token-${Math.max(refreshCalls, 1)}` },
  }));

  const startedAt = performance.now();
  const authWarm = await measureRequests({
    items: authWarmItems,
    concurrency: Math.min(authWarmItems.length, 12),
    execute: (item) =>
      manager.axiosInstance.get(item.url, withPriority(item.priority, {
        headers: item.headers,
      })),
  });
  const upstreamAfterAuthWarm = harness.stats.upstreamCalls;

  const cacheHot = await measureRequests({
    items: cacheHotItems,
    concurrency: Math.min(cacheHotItems.length, 16),
    execute: (item) =>
      manager.axiosInstance.get(item.url, withPriority(item.priority, {
        headers: item.headers,
      })),
  });
  const upstreamAfterHotCache = harness.stats.upstreamCalls;
  const finishedAt = performance.now();

  const combined = mergeBatchTotals([authWarm, cacheHot]);
  const cacheHotUpstreamCalls = upstreamAfterHotCache - upstreamAfterAuthWarm;
  const scenario = createScenarioSummary({
    name: 'Cache After Token Refresh',
    description: 'Triggers a single token refresh under concurrency, then measures how warm cached reads reduce upstream traffic.',
    requestCount: combined.totals.requestCount,
    concurrency: 16,
    startedAt,
    finishedAt,
    result: combined,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      refreshCalls,
      cacheHitRateAfterWarmAuth: cacheHotItems.length ? round((1 - cacheHotUpstreamCalls / cacheHotItems.length) * 100) : 0,
      authWarmSuccessRate: authWarm.totals.successRate,
      cacheStats: cachePlugin.getCacheStats(),
    },
  });

  manager.destroy();
  return scenario;
}

module.exports = {
  runCacheScenario,
  runCircuitBreakerScenario,
  runCombinedPluginScenario,
  runTokenRefreshScenario,
};
