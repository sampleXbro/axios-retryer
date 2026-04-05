/* istanbul ignore file */
const { performance } = require('perf_hooks');

const {
  RetryManager,
  AXIOS_RETRYER_REQUEST_PRIORITIES,
  AXIOS_RETRYER_BACKOFF_TYPES,
  createRetryStrategy,
} = require('../dist/index.cjs.js');
const { CachingPlugin } = require('../dist/plugins/CachingPlugin.cjs.js');
const { CircuitBreakerPlugin } = require('../dist/plugins/CircuitBreakerPlugin.cjs.js');
const { TokenRefreshPlugin } = require('../dist/plugins/TokenRefreshPlugin.cjs.js');
const { RequestDependencyPlugin } = require('../dist/plugins/RequestDependencyPlugin.cjs.js');
const { DebugSanitizationPlugin } = require('../dist/plugins/DebugSanitizationPlugin.cjs.js');
const {
  createAdapter,
  createScenarioSummary,
  deterministicUnit,
  emitResult,
  getProfile,
  measureRequests,
  nowIso,
  percentile,
  printHeader,
  printScenario,
  round,
  scaleCount,
  silenceManager,
  sleep,
  withPriority,
} = require('./_utils');

const BENCHMARK_NAME = 'advanced-plugins';
const SEED = 6601;

function latency(seed, key, attempt, baseMs, spreadMs) {
  return Math.max(1, Math.round(baseMs + deterministicUnit(seed, key, attempt) * spreadMs));
}

function createManager({ adapter, plugins = [], retries = 1, maxConcurrentRequests = 16, throwOnCancel = true }) {
  const manager = new RetryManager({
    retries,
    maxConcurrentRequests,
    queueDelay: 0,
    debug: false,
    throwErrorOnCancelRequest: throwOnCancel,
    retryStrategy: createRetryStrategy({ getDelay: () => 20 }),
  });
  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;
  plugins.forEach((p) => manager.use(p));
  return manager;
}

// RequestDependencyPlugin: HIGHEST-priority requests act as blockers — lower-priority
// requests are held in the queue until all blocking requests complete.
//
// The blocker is submitted first, then after a brief microtask yield (to let the request
// interceptor populate blockingRequestIds), dependents are submitted. This replicates
// real usage where blocking requests are in-flight before their dependents arrive.
async function runDependencyGatingScenario(profile) {
  const dependentCount = scaleCount(profile, 20, 8);
  const blockerLatencyMs = 120;

  const depPlugin = new RequestDependencyPlugin({
    blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST,
    cancelPendingOnDependencyFailure: false,
  });

  const harness = createAdapter(({ key, attempt }) => {
    if (key.startsWith('/dep/blocker/')) {
      return { latencyMs: blockerLatencyMs, data: { ok: true, blocker: true } };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [depPlugin],
    retries: 0,
    maxConcurrentRequests: dependentCount + 2,
  });

  const dependentItems = Array.from({ length: dependentCount }, (_, i) => ({
    url: `/dep/dependent/${i}`,
    priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
  }));

  const startedAt = performance.now();

  // Submit blocker first so its request interceptor populates blockingRequestIds before
  // dependents are enqueued — this is the gate activation window.
  const blockerT0 = performance.now();
  const blockerPromise = manager.axiosInstance.get('/dep/blocker/0', withPriority(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST));
  await sleep(5); // let the request interceptor fire and set blockingRequestIds

  const peakBlockingCount = depPlugin.getActiveBlockingRequestCount();

  // Submit dependents — they should now be held in queue by the gate
  const depT0 = performance.now();
  const depPromises = dependentItems.map((item) => {
    const t = performance.now();
    return manager.axiosInstance
      .get(item.url, withPriority(item.priority))
      .then(() => ({ ok: true, durationMs: performance.now() - t }))
      .catch(() => ({ ok: false, durationMs: performance.now() - t }));
  });

  const blockerResult = await blockerPromise
    .then(() => ({ ok: true, durationMs: performance.now() - blockerT0 }))
    .catch(() => ({ ok: false, durationMs: performance.now() - blockerT0 }));

  const depResults = await Promise.all(depPromises);
  const finishedAt = performance.now();

  const dependentDurations = depResults.map((r) => r.durationMs);
  const allSamples = [blockerResult, ...depResults];
  const result = {
    samples: allSamples,
    totals: {
      requestCount: allSamples.length,
      successCount: allSamples.filter((s) => s.ok).length,
      failureCount: allSamples.filter((s) => !s.ok).length,
      successRate: round((allSamples.filter((s) => s.ok).length / allSamples.length) * 100),
      latency: {
        count: allSamples.length,
        minMs: round(Math.min(...allSamples.map((s) => s.durationMs))),
        maxMs: round(Math.max(...allSamples.map((s) => s.durationMs))),
        avgMs: round(allSamples.reduce((s, r) => s + r.durationMs, 0) / allSamples.length),
        p50Ms: round(percentile(allSamples.map((s) => s.durationMs), 0.5)),
        p95Ms: round(percentile(allSamples.map((s) => s.durationMs), 0.95)),
        p99Ms: round(percentile(allSamples.map((s) => s.durationMs), 0.99)),
      },
    },
  };

  // Dependents should have waited for the blocker — their durations measured from
  // submission time should each reflect the remaining blocker time + their own latency.
  const depStartOffsetMs = depT0 - blockerT0;
  const expectedMinDepDuration = blockerLatencyMs - depStartOffsetMs;
  const gatingEffective = dependentDurations.every((d) => d >= expectedMinDepDuration * 0.7);

  const scenario = createScenarioSummary({
    name: 'RequestDependencyPlugin: Blocker Gating',
    description: 'HIGHEST-priority blocker holds MEDIUM dependents in queue; dependents start only after blocker completes.',
    requestCount: 1 + dependentCount,
    concurrency: dependentCount,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      blockerLatencyMs: round(blockerResult.durationMs),
      dependentP50Ms: round(percentile(dependentDurations, 0.5)),
      dependentP95Ms: round(percentile(dependentDurations, 0.95)),
      peakBlockingCount,
      gatingEffective,
    },
  });

  manager.destroy();
  return scenario;
}

// When a blocking request fails terminally with cancelPendingOnDependencyFailure:true,
// queued dependents are cancelled via cancelQueuedRequests() and onBlockingRequestFailed fires.
async function runDependencyFailureCascadeScenario(profile) {
  const dependentCount = scaleCount(profile, 16, 6);
  let blockingFailedFired = 0;
  let allResolvedFired = 0;

  const depPlugin = new RequestDependencyPlugin({
    blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST,
    cancelPendingOnDependencyFailure: true,
  });

  // Blocker takes long enough for dependents to queue up before it fails
  const harness = createAdapter(({ key }) => {
    if (key.startsWith('/cascade/blocker/')) {
      return { latencyMs: 150, errorStatus: 503, errorMessage: 'Blocker failed' };
    }
    return { latencyMs: latency(SEED, key, 1, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [depPlugin],
    retries: 0,
    maxConcurrentRequests: dependentCount + 2,
    throwOnCancel: false,
  });

  manager.on('onBlockingRequestFailed', () => { blockingFailedFired += 1; });
  manager.on('onAllBlockingRequestsResolved', () => { allResolvedFired += 1; });

  const startedAt = performance.now();

  // Submit blocker first, then wait for gate to activate before submitting dependents
  const blockerPromise = manager.axiosInstance
    .get('/cascade/blocker/0', withPriority(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST))
    .catch(() => null);
  await sleep(5); // gate is now active

  const depPromises = Array.from({ length: dependentCount }, (_, i) => {
    const t = performance.now();
    return manager.axiosInstance
      .get(`/cascade/dependent/${i}`, withPriority(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM))
      .then(() => ({ ok: true, durationMs: performance.now() - t }))
      .catch(() => ({ ok: false, durationMs: performance.now() - t }));
  });

  await blockerPromise;
  const depResults = await Promise.all(depPromises);
  const finishedAt = performance.now();

  const cancelledDependents = depResults.filter((r) => !r.ok).length;
  const allSamples = depResults;
  const result = {
    samples: allSamples,
    totals: {
      requestCount: allSamples.length,
      successCount: allSamples.filter((s) => s.ok).length,
      failureCount: cancelledDependents,
      successRate: round((allSamples.filter((s) => s.ok).length / allSamples.length) * 100),
      latency: {
        count: allSamples.length,
        minMs: round(Math.min(...allSamples.map((s) => s.durationMs))),
        maxMs: round(Math.max(...allSamples.map((s) => s.durationMs))),
        avgMs: round(allSamples.reduce((s, r) => s + r.durationMs, 0) / allSamples.length),
        p50Ms: round(percentile(allSamples.map((s) => s.durationMs), 0.5)),
        p95Ms: round(percentile(allSamples.map((s) => s.durationMs), 0.95)),
        p99Ms: round(percentile(allSamples.map((s) => s.durationMs), 0.99)),
      },
    },
  };

  const scenario = createScenarioSummary({
    name: 'RequestDependencyPlugin: Failure Cascade',
    description: 'Blocker failure triggers cancelQueuedRequests() on dependents; onBlockingRequestFailed event fires.',
    requestCount: 1 + dependentCount,
    concurrency: dependentCount,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      dependentCount,
      cancelledDependents,
      blockingFailedEventFired: blockingFailedFired,
      allResolvedEventFired: allResolvedFired,
      cascadeEffective: cancelledDependents > 0,
    },
  });

  manager.destroy();
  return scenario;
}

// DebugSanitizationPlugin: measures the sanitization overhead against a bare manager.
// sanitizeUrl + sanitizeHeaders run on every request and error interceptor call.
async function runSanitizationOverheadScenario(profile) {
  const requestCount = scaleCount(profile, 200);
  const concurrency = scaleCount(profile, 20);

  const sensitiveHeaders = {
    Authorization: 'Bearer secret-token',
    'X-Api-Key': 'api-key-value',
    'X-Custom-Secret': 'custom-secret',
  };

  function makeAdapter() {
    return createAdapter(({ key, attempt }) => {
      if (Number(key.split('/').pop()) % 8 === 0 && attempt === 1) {
        return { latencyMs: latency(SEED, key, attempt, 4, 3), errorStatus: 500, errorMessage: 'Error' };
      }
      return { latencyMs: latency(SEED, key, attempt, 4, 3), data: { ok: true } };
    });
  }

  const items = Array.from({ length: requestCount }, (_, i) => ({
    url: `/sanitize/item/${i}`,
    priority: i % 3,
  }));

  // Baseline: no DebugSanitizationPlugin
  const baseHarness = makeAdapter();
  const baseManager = createManager({ adapter: baseHarness.adapter, maxConcurrentRequests: concurrency });
  const baseStart = performance.now();
  await measureRequests({
    items,
    concurrency,
    execute: (item) =>
      baseManager.axiosInstance.get(item.url, withPriority(item.priority, { headers: sensitiveHeaders })),
  });
  const baseThroughput = round((requestCount / (performance.now() - baseStart)) * 1000);
  baseManager.destroy();

  // With DebugSanitizationPlugin (custom sensitive headers + body sanitization)
  const debugPlugin = new DebugSanitizationPlugin({
    sanitizeOptions: {
      sensitiveHeaders: ['x-custom-secret'],
    },
  });
  const pluginHarness = makeAdapter();
  const pluginManager = createManager({
    adapter: pluginHarness.adapter,
    plugins: [debugPlugin],
    maxConcurrentRequests: concurrency,
  });

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency,
    execute: (item) =>
      pluginManager.axiosInstance.get(item.url, withPriority(item.priority, { headers: sensitiveHeaders })),
  });
  const finishedAt = performance.now();

  const pluginThroughput = round((requestCount / (finishedAt - startedAt)) * 1000);

  const scenario = createScenarioSummary({
    name: 'DebugSanitizationPlugin: Sanitization Overhead',
    description: 'Measures throughput delta from sanitizeUrl + sanitizeHeaders running on every request and error interceptor.',
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
    },
  });

  pluginManager.destroy();
  return scenario;
}

// CachingPlugin.invalidateCache() with exact key, prefix string, and RegExp matching.
async function runCacheInvalidationScenario(profile) {
  const keyCount = scaleCount(profile, 30, 12);
  const hotReads = scaleCount(profile, 120);
  const group1Count = Math.floor(keyCount / 2);

  const cachePlugin = new CachingPlugin({
    timeToRevalidate: 30_000,
    maxItems: keyCount * 2,
  });

  const harness = createAdapter(({ key, attempt }) => ({
    latencyMs: latency(SEED, key, attempt, 6, 4),
    data: { ok: true, key },
  }));

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [cachePlugin],
    retries: 0,
    maxConcurrentRequests: 20,
  });

  // Warm the cache — all keys populated
  const warmItems = [
    ...Array.from({ length: group1Count }, (_, i) => ({ url: `/inval/group1/${i}` })),
    ...Array.from({ length: keyCount - group1Count }, (_, i) => ({ url: `/inval/group2/${i}` })),
  ];
  await measureRequests({
    items: warmItems,
    concurrency: Math.min(20, warmItems.length),
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const upstreamAfterWarm = harness.stats.upstreamCalls;

  // Hot reads — should all hit cache (zero upstream)
  const hotItems = Array.from({ length: hotReads }, (_, i) => ({
    url: warmItems[i % warmItems.length].url,
  }));
  await measureRequests({
    items: hotItems,
    concurrency: Math.min(20, hotItems.length),
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const upstreamAfterHot = harness.stats.upstreamCalls;
  const preInvalidationHitRate = round((1 - (upstreamAfterHot - upstreamAfterWarm) / hotItems.length) * 100);

  // Invalidate group1 via {prefix} matcher — derive the key prefix from a known entry
  const sampleKey1 = cachePlugin.buildCacheKey({ url: '/inval/group1/0', method: 'get' });
  const group1Prefix = sampleKey1.slice(0, sampleKey1.indexOf('/inval/group1/') + '/inval/group1/'.length);
  const invalidatedByPrefix = await cachePlugin.invalidateCache({ prefix: group1Prefix });

  // Invalidate group2/0 via {exact} matcher — build the canonical key directly
  const exactKey0 = cachePlugin.buildCacheKey({ url: '/inval/group2/0', method: 'get' });
  await cachePlugin.invalidateCache({ exact: exactKey0 });

  // Invalidate remaining group2 entries via RegExp
  const invalidatedByRegexp = await cachePlugin.invalidateCache(/\/inval\/group2\/[1-9]/);

  const statsAfterInval = cachePlugin.getCacheStats();
  const upstreamAfterInval = harness.stats.upstreamCalls;

  // Re-read everything — previously invalidated keys will miss cache
  const startedAt = performance.now();
  const result = await measureRequests({
    items: warmItems,
    concurrency: Math.min(20, warmItems.length),
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const finishedAt = performance.now();

  const upstreamAfterReread = harness.stats.upstreamCalls;
  const remissCount = upstreamAfterReread - upstreamAfterInval;

  const scenario = createScenarioSummary({
    name: 'CachingPlugin: invalidateCache (prefix + exact + RegExp)',
    description: 'Warms cache, reads hot data, then invalidates via prefix, exact key, and RegExp; measures re-miss rate.',
    requestCount: hotReads + warmItems.length,
    concurrency: 20,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      preInvalidationHitRate,
      invalidatedByPrefix,
      invalidatedByRegexp,
      cacheStatsAfterInvalidation: statsAfterInval,
      remissesAfterInvalidation: remissCount,
      remissRate: round((remissCount / warmItems.length) * 100),
    },
  });

  manager.destroy();
  return scenario;
}

// CircuitBreaker with useSlidingWindow:true — failures older than the window don't
// count toward the threshold, allowing the circuit to self-heal without openTimeout.
async function runSlidingWindowScenario(profile) {
  const windowMs = 800;
  const failureThreshold = 4;
  const circuitBreaker = new CircuitBreakerPlugin({
    failureThreshold,
    openTimeout: 60_000, // Long — won't reset via timeout during benchmark
    halfOpenMax: 2,
    successThreshold: 2,
    useSlidingWindow: true,
    slidingWindowSize: windowMs,
  });

  const harness = createAdapter(({ key, attempt }) => {
    if (key.startsWith('/sliding/fail/')) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 503, errorMessage: 'Failure' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [circuitBreaker],
    retries: 0,
    maxConcurrentRequests: 8,
  });

  const startedAt = performance.now();

  // Phase 1: send failureThreshold-1 failures (just below trip threshold)
  const subThresholdCount = failureThreshold - 1;
  await measureRequests({
    items: Array.from({ length: subThresholdCount }, (_, i) => ({ url: `/sliding/fail/${i}` })),
    concurrency: subThresholdCount,
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const stateAfterPhase1 = circuitBreaker.getState();

  // Phase 2: wait for the sliding window to expire
  await sleep(windowMs + 100);

  // Phase 3: send failureThreshold-1 more failures — should still be below threshold
  // because phase-1 failures have dropped out of the window
  await measureRequests({
    items: Array.from({ length: subThresholdCount }, (_, i) => ({ url: `/sliding/fail/${subThresholdCount + i}` })),
    concurrency: subThresholdCount,
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const stateAfterPhase3 = circuitBreaker.getState();

  // Phase 4: healthy requests — circuit should still be CLOSED
  const healthyItems = Array.from({ length: scaleCount(profile, 20, 8) }, (_, i) => ({
    url: `/sliding/healthy/${i}`,
  }));
  const healthyResult = await measureRequests({
    items: healthyItems,
    concurrency: Math.min(8, healthyItems.length),
    execute: (item) => manager.axiosInstance.get(item.url),
  });
  const finishedAt = performance.now();

  const combined = {
    samples: healthyResult.samples,
    totals: healthyResult.totals,
  };

  const scenario = createScenarioSummary({
    name: 'CircuitBreaker: Sliding Window Self-Healing',
    description: 'Failures outside the sliding window expire without tripping the circuit; proves old failures do not accumulate.',
    requestCount: subThresholdCount * 2 + healthyItems.length,
    concurrency: 8,
    startedAt,
    finishedAt,
    result: combined,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      slidingWindowMs: windowMs,
      failureThreshold,
      stateAfterSubThresholdFailures: stateAfterPhase1,
      stateAfterWindowExpiry: stateAfterPhase3,
      finalState: circuitBreaker.getState(),
      circuitNeverTripped: stateAfterPhase1 === 'CLOSED' && stateAfterPhase3 === 'CLOSED',
    },
  });

  manager.destroy();
  return scenario;
}

// TokenRefreshPlugin customErrorDetector: detects auth errors embedded in 200 OK bodies
// (e.g., GraphQL APIs) and triggers the same refresh flow as a 401 status code.
async function runCustomErrorDetectorScenario(profile) {
  let refreshCalls = 0;
  const tokenRefreshPlugin = new TokenRefreshPlugin(
    async (refreshAxios) => {
      refreshCalls += 1;
      const response = await refreshAxios.post('/graphql/auth/refresh');
      return { token: response.data.token };
    },
    {
      refreshStatusCodes: [401],
      customErrorDetector: (data) =>
        Array.isArray(data && data.errors) &&
        data.errors.some((e) => e && e.extensions && e.extensions.code === 'UNAUTHENTICATED'),
    }
  );

  const requestCount = scaleCount(profile, 60);

  const harness = createAdapter(({ key, attempt, config }) => {
    if (key === '/graphql/auth/refresh') {
      return { latencyMs: 15, data: { token: `gql-token-${refreshCalls}` } };
    }

    const auth = String(config.headers?.Authorization || '').replace('Bearer ', '');
    if (!auth.startsWith('gql-token-')) {
      return {
        latencyMs: latency(SEED, key, attempt, 7, 4),
        data: {
          data: null,
          errors: [{ message: 'Not authenticated', extensions: { code: 'UNAUTHENTICATED' } }],
        },
      };
    }

    return {
      latencyMs: latency(SEED, key, attempt, 7, 4),
      data: { data: { result: 'ok' }, errors: null },
    };
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [tokenRefreshPlugin],
    retries: 1,
    maxConcurrentRequests: scaleCount(profile, 20),
  });

  manager.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer stale-token';

  const items = Array.from({ length: requestCount }, (_, i) => ({
    url: `/graphql/resource/${i}`,
    priority: i % 2,
  }));

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency: Math.min(requestCount, scaleCount(profile, 20)),
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'TokenRefreshPlugin: customErrorDetector (200 body auth error)',
    description: 'Detects UNAUTHENTICATED errors in 200 OK GraphQL responses and triggers a single token refresh cycle.',
    requestCount,
    concurrency: scaleCount(profile, 20),
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      refreshCalls,
      replayAmplification: requestCount > 0 ? round(harness.stats.upstreamCalls / requestCount) : 0,
      onlyOneRefreshCycle: refreshCalls === 1,
    },
  });

  manager.destroy();
  return scenario;
}

// Per-request __axiosRetryer overrides: requestRetries and backoffType per-request
// allow individual requests to deviate from manager-level configuration.
async function runPerRequestOverridesScenario(profile) {
  const requestCount = scaleCount(profile, 120);
  const concurrency = scaleCount(profile, 16);
  const groupSize = Math.floor(requestCount / 3);

  const harness = createAdapter(({ key, attempt }) => {
    // All requests in this scenario fail on attempt 1, succeed on attempt 2+
    if (attempt === 1) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 500, errorMessage: 'Error' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  // Manager has retries:3 as default, but per-request overrides take precedence
  const manager = createManager({
    adapter: harness.adapter,
    retries: 3,
    maxConcurrentRequests: concurrency,
  });

  // Group A: requestRetries:0 — fail immediately, no retry budget
  // Group B: requestRetries:2 — normal retry budget
  // Group C: backoffType:STATIC — use static 20ms delay regardless of manager default
  const allItems = [
    ...Array.from({ length: groupSize }, (_, i) => ({
      url: `/overrides/no-retry/${i}`,
      overrides: { requestRetries: 0, priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
    })),
    ...Array.from({ length: groupSize }, (_, i) => ({
      url: `/overrides/normal-retry/${i}`,
      overrides: { requestRetries: 2, priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM },
    })),
    ...Array.from({ length: groupSize }, (_, i) => ({
      url: `/overrides/static-backoff/${i}`,
      overrides: { requestRetries: 2, backoffType: AXIOS_RETRYER_BACKOFF_TYPES.STATIC, priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
    })),
  ];

  const startedAt = performance.now();
  const result = await measureRequests({
    items: allItems,
    concurrency,
    execute: (item) =>
      manager.axiosInstance.get(item.url, { __axiosRetryer: item.overrides }),
  });
  const finishedAt = performance.now();

  const noRetryFailures = result.samples.slice(0, groupSize).filter((s) => !s.ok).length;
  const normalRetrySuccesses = result.samples.slice(groupSize, groupSize * 2).filter((s) => s.ok).length;
  const staticBackoffSuccesses = result.samples.slice(groupSize * 2).filter((s) => s.ok).length;

  const scenario = createScenarioSummary({
    name: 'Per-request Overrides: requestRetries + backoffType',
    description: 'requestRetries:0 prevents any retry; requestRetries:2 allows recovery; backoffType per-request overrides manager default.',
    requestCount: allItems.length,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      groupSize,
      noRetryGroupFailures: noRetryFailures,
      normalRetryGroupSuccesses: normalRetrySuccesses,
      staticBackoffGroupSuccesses: staticBackoffSuccesses,
      noRetryFailureRate: round((noRetryFailures / groupSize) * 100),
      normalRetrySuccessRate: round((normalRetrySuccesses / groupSize) * 100),
    },
  });

  manager.destroy();
  return scenario;
}

// Exercises the full event listener API (on/off) and plugin lifecycle (use/unuse/listPlugins).
async function runEventListenerAndPluginLifecycleScenario(profile) {
  const requestCount = scaleCount(profile, 80);
  const concurrency = scaleCount(profile, 12);

  let beforeRetryCount = 0;
  let afterRetryCount = 0;
  let onFailureCount = 0;

  const beforeRetryListener = () => { beforeRetryCount += 1; };
  const afterRetryListener = () => { afterRetryCount += 1; };
  const onFailureListener = () => { onFailureCount += 1; };

  const harness = createAdapter(({ key, attempt }) => {
    if (attempt === 1 && deterministicUnit(SEED, key, attempt) < 0.3) {
      return { latencyMs: latency(SEED, key, attempt, 5, 3), errorStatus: 503, errorMessage: 'Transient' };
    }
    return { latencyMs: latency(SEED, key, attempt, 5, 3), data: { ok: true } };
  });

  const manager = createManager({
    adapter: harness.adapter,
    retries: 2,
    maxConcurrentRequests: concurrency,
  });

  // Register event listeners
  manager.on('beforeRetry', beforeRetryListener);
  manager.on('afterRetry', afterRetryListener);
  manager.on('onFailure', onFailureListener);

  const items = Array.from({ length: requestCount }, (_, i) => ({
    url: `/lifecycle/item/${i}`,
    priority: i % 3,
  }));

  const startedAt = performance.now();

  // Phase 1: run with listeners active
  const half = Math.floor(requestCount / 2);
  await measureRequests({
    items: items.slice(0, half),
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const countsWhileListening = { beforeRetryCount, afterRetryCount, onFailureCount };

  // Unsubscribe listeners mid-run
  manager.off('beforeRetry', beforeRetryListener);
  manager.off('afterRetry', afterRetryListener);
  manager.off('onFailure', onFailureListener);

  // Phase 2: run without listeners — counts must not increase
  const beforeCountSnapshot = beforeRetryCount;
  const result = await measureRequests({
    items: items.slice(half),
    concurrency,
    execute: (item) => manager.axiosInstance.get(item.url, withPriority(item.priority)),
  });
  const finishedAt = performance.now();

  const listensStoppedCorrectly = beforeRetryCount === beforeCountSnapshot;

  // Plugin lifecycle: use/unuse/listPlugins
  const cachePlugin = new CachingPlugin({ timeToRevalidate: 5000, maxItems: 50 });
  manager.use(cachePlugin);
  const pluginsAfterUse = manager.listPlugins();
  manager.unuse('CachingPlugin');
  const pluginsAfterUnuse = manager.listPlugins();

  const scenario = createScenarioSummary({
    name: 'Event Listeners + Plugin Lifecycle (use/unuse/listPlugins)',
    description: 'Registers on/off event listeners mid-run and exercises use/unuse/listPlugins for runtime plugin management.',
    requestCount,
    concurrency,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      beforeRetryWhileListening: countsWhileListening.beforeRetryCount,
      afterRetryWhileListening: countsWhileListening.afterRetryCount,
      onFailureWhileListening: countsWhileListening.onFailureCount,
      listenersStoppedCorrectly: listensStoppedCorrectly,
      pluginsAfterUse: pluginsAfterUse.map((p) => p.name),
      pluginsAfterUnuse: pluginsAfterUnuse.map((p) => p.name),
      pluginCountAfterUse: pluginsAfterUse.length,
      pluginCountAfterUnuse: pluginsAfterUnuse.length,
    },
  });

  manager.destroy();
  return scenario;
}

async function main() {
  const profile = getProfile();

  printHeader('Advanced Plugins Benchmarks', `Profile: ${profile.name}`);

  const scenarios = [
    await runDependencyGatingScenario(profile),
    await runDependencyFailureCascadeScenario(profile),
    await runSanitizationOverheadScenario(profile),
    await runCacheInvalidationScenario(profile),
    await runSlidingWindowScenario(profile),
    await runCustomErrorDetectorScenario(profile),
    await runPerRequestOverridesScenario(profile),
    await runEventListenerAndPluginLifecycleScenario(profile),
  ];

  scenarios.forEach(printScenario);

  const summary = {
    profile: profile.name,
    avgSuccessRate: round(scenarios.reduce((sum, s) => sum + s.successRate, 0) / scenarios.length),
    avgThroughputPerSec: round(scenarios.reduce((sum, s) => sum + s.throughputPerSec, 0) / scenarios.length),
    gatingEffective: scenarios[0].extras.gatingEffective,
    circuitNeverTripped: scenarios[4].extras.circuitNeverTripped,
    singleRefreshCycle: scenarios[5].extras.onlyOneRefreshCycle,
  };

  console.log('\nSummary');
  console.log('-------');
  console.log(`Average success rate: ${summary.avgSuccessRate}%`);
  console.log(`Average throughput: ${summary.avgThroughputPerSec} req/sec`);
  console.log(`Dependency gating effective: ${summary.gatingEffective}`);
  console.log(`Sliding window — circuit never tripped: ${summary.circuitNeverTripped}`);
  console.log(`GraphQL customErrorDetector — single refresh cycle: ${summary.singleRefreshCycle}`);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Advanced Plugins Benchmarks',
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
