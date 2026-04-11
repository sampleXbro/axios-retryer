/* istanbul ignore file */
const { performance } = require('perf_hooks');

const rootApi = require('../dist/index.cjs.js');
const pluginBarrelApi = require('../dist/plugins/index.cjs.js');
const cachingApi = require('../dist/plugins/CachingPlugin.cjs.js');
const circuitBreakerApi = require('../dist/plugins/CircuitBreakerPlugin.cjs.js');
const debugSanitizationApi = require('../dist/plugins/DebugSanitizationPlugin.cjs.js');
const manualRetryApi = require('../dist/plugins/ManualRetryPlugin.cjs.js');
const metricsApi = require('../dist/plugins/MetricsPlugin.cjs.js');
const tokenRefreshApi = require('../dist/plugins/TokenRefreshPlugin.cjs.js');
const {
  createAdapter,
  createScenarioSummary,
  emitResult,
  getProfile,
  measureRequests,
  nowIso,
  printHeader,
  printScenario,
  round,
  scaleCount,
  silenceManager,
  summarizeLatency,
  withPriority,
} = require('./_utils');

const BENCHMARK_NAME = 'public-api';

const ROOT_RUNTIME_EXPORTS = [
  'RETRY_MODES',
  'AXIOS_RETRYER_HTTP_METHODS',
  'AXIOS_RETRYER_REQUEST_PRIORITIES',
  'AXIOS_RETRYER_BACKOFF_TYPES',
  'RetryManager',
  'AxiosRetryerError',
  'PluginRegistrationError',
  'QueueClearedError',
  'QueueDestroyedError',
  'QueueFullError',
  'QueuedRequestCanceledError',
  'RequestAbortedError',
  'RetryerConfigError',
  'DefaultRetryStrategy',
  'createRetryer',
  'createRetryStrategy',
];

const CACHING_RUNTIME_EXPORTS = [
  'CachingPlugin',
  'InvalidCacheKeyError',
  'InMemoryCacheStorage',
  'createCachePlugin',
];

const CIRCUIT_BREAKER_RUNTIME_EXPORTS = [
  'CircuitBreakerPlugin',
  'CircuitBreakerStateError',
  'CIRCUIT_BREAKER_SCOPES',
  'CIRCUIT_BREAKER_STATES',
  'InMemoryCircuitBreakerStateAdapter',
  'createCircuitBreaker',
];

const DEBUG_SANITIZATION_RUNTIME_EXPORTS = [
  'DebugSanitizationPlugin',
  'createDebugSanitizationPlugin',
];

const MANUAL_RETRY_RUNTIME_EXPORTS = [
  'ManualRetryPlugin',
  'createManualRetryPlugin',
];

const METRICS_RUNTIME_EXPORTS = [
  'MetricsPlugin',
  'MetricsCollector',
  'createMetricsPlugin',
];

const TOKEN_REFRESH_RUNTIME_EXPORTS = [
  'TokenRefreshPlugin',
  'MissingTokenRefreshHandlerError',
  'TokenRefreshAbortError',
  'TokenRefreshFailedError',
  'TokenRefreshTimeoutError',
  'createTokenRefreshPlugin',
];

const PLUGIN_BARREL_RUNTIME_EXPORTS = Array.from(
  new Set([
    ...CACHING_RUNTIME_EXPORTS,
    ...CIRCUIT_BREAKER_RUNTIME_EXPORTS,
    ...DEBUG_SANITIZATION_RUNTIME_EXPORTS,
    ...MANUAL_RETRY_RUNTIME_EXPORTS,
    ...METRICS_RUNTIME_EXPORTS,
    ...TOKEN_REFRESH_RUNTIME_EXPORTS,
  ]),
).sort();

function assertRuntimeExports(moduleLabel, moduleExports, expectedExports) {
  const missingExports = expectedExports.filter((exportName) => !(exportName in moduleExports));
  if (missingExports.length > 0) {
    throw new Error(`${moduleLabel} is missing runtime exports: ${missingExports.join(', ')}`);
  }

  return expectedExports.slice().sort();
}

function createManager({ adapter, plugins = [], options = {}, placements = [] }) {
  const manager = rootApi.createRetryer({
    mode: rootApi.RETRY_MODES.AUTOMATIC,
    retries: 0,
    maxConcurrentRequests: 8,
    queueDelay: 0,
    debug: false,
    ...options,
  });

  silenceManager(manager);
  manager.axiosInstance.defaults.adapter = adapter;
  plugins.forEach((plugin, index) => {
    const placement = placements[index];
    if (placement === undefined) {
      manager.use(plugin);
      return;
    }

    manager.use(plugin, placement);
  });

  return manager;
}

function createMetricsState() {
  return {
    totalRequests: 0,
    successfulRetries: 0,
    failedRetries: 0,
    completelyFailedRequests: 0,
    canceledRequests: 0,
    completelyFailedCriticalRequests: 0,
    errorTypes: {
      network: 0,
      server5xx: 0,
      client4xx: 0,
      cancelled: 0,
    },
    retryAttemptsDistribution: {},
    retryPrioritiesDistribution: {},
    requestCountsByPriority: {},
    queueWaitDuration: 0,
    retryDelayDuration: 0,
  };
}

function mergeResults(batches) {
  const samples = batches.flatMap((batch) => batch.samples);
  const successCount = samples.filter((sample) => sample.ok).length;

  return {
    samples,
    totals: {
      requestCount: samples.length,
      successCount,
      failureCount: samples.length - successCount,
      successRate: samples.length ? round((successCount / samples.length) * 100) : 0,
      latency: summarizeLatency(samples.map((sample) => sample.durationMs)),
    },
  };
}

function getSampleConfig(url = '/public-api/sample') {
  return {
    url,
    method: rootApi.AXIOS_RETRYER_HTTP_METHODS.GET,
    headers: {},
  };
}

function exerciseRootErrorExports() {
  const sampleConfig = getSampleConfig();
  const exportedErrors = [
    ['AxiosRetryerError', new rootApi.AxiosRetryerError('Root benchmark error', 'EROOT_BENCHMARK')],
    [
      'PluginRegistrationError',
      new rootApi.PluginRegistrationError(
        'Plugin already registered',
        'EPLUGIN_ALREADY_REGISTERED',
        'PublicApiPlugin',
        '1.0.0',
      ),
    ],
    ['QueueClearedError', new rootApi.QueueClearedError(sampleConfig)],
    ['QueueDestroyedError', new rootApi.QueueDestroyedError(sampleConfig)],
    ['QueueFullError', new rootApi.QueueFullError(sampleConfig)],
    ['QueuedRequestCanceledError', new rootApi.QueuedRequestCanceledError('queued-request-1', sampleConfig)],
    ['RequestAbortedError', new rootApi.RequestAbortedError('aborted-request-1')],
    ['RetryerConfigError', new rootApi.RetryerConfigError('Invalid configuration', 'retries', -1)],
  ];

  exportedErrors.forEach(([, error]) => {
    if (!(error instanceof Error)) {
      throw new Error('Expected public root export to be an Error instance');
    }
  });

  return exportedErrors.map(([exportName]) => exportName);
}

function exerciseMetricsCollectorExport() {
  const metricsState = createMetricsState();
  const collector = new metricsApi.MetricsCollector(() => metricsState);

  collector.recordRequestStart(rootApi.AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
  collector.recordRetryAttempt(1, rootApi.AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
  collector.recordRetrySuccess(rootApi.AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
  collector.recordRetryDelay(15);
  collector.recordQueueWait(5);
  collector.recordTerminalFailure(false);
  collector.recordCancellation(true);

  return collector.buildDetailedMetrics({
    activeTimers: 0,
    activeRetryTimers: 0,
  });
}

function exerciseTokenRefreshErrorExports() {
  const exportedErrors = [
    ['MissingTokenRefreshHandlerError', new tokenRefreshApi.MissingTokenRefreshHandlerError()],
    ['TokenRefreshAbortError', new tokenRefreshApi.TokenRefreshAbortError()],
    ['TokenRefreshFailedError', new tokenRefreshApi.TokenRefreshFailedError()],
    ['TokenRefreshTimeoutError', new tokenRefreshApi.TokenRefreshTimeoutError()],
  ];

  exportedErrors.forEach(([, error]) => {
    if (!(error instanceof Error)) {
      throw new Error('Expected token refresh public export to be an Error instance');
    }
  });

  return exportedErrors.map(([exportName]) => exportName);
}

async function runRootRuntimeApiScenario(profile) {
  const coveredRootExports = assertRuntimeExports('root entrypoint', rootApi, ROOT_RUNTIME_EXPORTS);
  const coveredRootErrors = exerciseRootErrorExports();

  const defaultStrategy = new rootApi.DefaultRetryStrategy(
    undefined,
    undefined,
    rootApi.AXIOS_RETRYER_BACKOFF_TYPES.LINEAR,
  );
  const customStrategy = rootApi.createRetryStrategy({
    isRetryable: (error) => (error.response?.status ?? 0) >= 500,
    shouldRetry: (_error, attempt, maxRetries) => attempt < maxRetries,
    getDelay: (attempt) => attempt * 7,
  });
  const axiosErrorLike = {
    response: { status: 503 },
    config: getSampleConfig('/root/retry'),
  };

  const strategySnapshot = {
    defaultRetryable: defaultStrategy.getIsRetryable(axiosErrorLike),
    defaultShouldRetry: defaultStrategy.shouldRetry(axiosErrorLike, 1, 2),
    defaultDelay: defaultStrategy.getDelay(1, 2, rootApi.AXIOS_RETRYER_BACKOFF_TYPES.STATIC),
    customRetryable: customStrategy.getIsRetryable(axiosErrorLike),
    customShouldRetry: customStrategy.shouldRetry(axiosErrorLike, 1, 2),
    customDelay: customStrategy.getDelay(2, 3, rootApi.AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL),
  };

  const managerViaClass = new rootApi.RetryManager({
    mode: rootApi.RETRY_MODES.MANUAL,
    retries: 0,
    maxConcurrentRequests: 2,
    queueDelay: 0,
    debug: false,
  });
  silenceManager(managerViaClass);
  managerViaClass.destroy();

  const harness = createAdapter(({ key, attempt }) => {
    if (key === '/root/retry' && attempt === 1) {
      return {
        latencyMs: 4,
        errorStatus: 503,
        errorMessage: 'Transient root benchmark error',
      };
    }

    return {
      latencyMs: 3,
      data: { ok: true, key, attempt },
    };
  });

  const manager = createManager({
    adapter: harness.adapter,
    options: {
      retries: 1,
      backoffType: rootApi.AXIOS_RETRYER_BACKOFF_TYPES.EXPONENTIAL,
      retryStrategy: customStrategy,
      maxConcurrentRequests: Math.max(3, scaleCount(profile, 6, 3)),
    },
  });

  let publicEventCount = 0;
  const publicListener = () => {
    publicEventCount += 1;
  };

  manager.on('onRetryProcessStarted', publicListener);
  manager.emit('onRetryProcessStarted');
  manager.triggerAndEmit('onRetryProcessStarted');
  const removedListener = manager.off('onRetryProcessStarted', publicListener);

  manager.cancelRequest('root-nonexistent-request');
  manager.cancelQueuedRequests();
  manager.cancelAllRequests();

  const requestCount = scaleCount(profile, 12, 6);
  const priorities = Object.values(rootApi.AXIOS_RETRYER_REQUEST_PRIORITIES);
  const items = Array.from({ length: requestCount }, (_, index) => ({
    url: index % 4 === 0 ? '/root/retry' : `/root/ok/${index}`,
    priority: priorities[index % priorities.length],
  }));

  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency: items.length,
    execute: (item) =>
      manager.axiosInstance.request({
        url: item.url,
        method: rootApi.AXIOS_RETRYER_HTTP_METHODS.GET,
        ...withPriority(item.priority),
      }),
  });
  const finishedAt = performance.now();

  const metricsBeforeReset = manager.getMetrics();
  manager.resetMetrics();
  const metricsAfterReset = manager.getMetrics();
  const pluginsBeforeDestroy = manager.listPlugins();

  const scenario = createScenarioSummary({
    name: 'Root Runtime Public API',
    description:
      'Exercises root runtime exports, manager methods, retry strategy factories, constants, and public error classes.',
    requestCount: result.totals.requestCount,
    concurrency: items.length,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      coveredRootExports,
      coveredRootErrors,
      strategySnapshot,
      publicEventCount,
      removedListener,
      pluginsBeforeDestroy,
      metricsBeforeReset,
      metricsAfterReset,
      retryModeValues: Object.values(rootApi.RETRY_MODES),
      requestPriorityValues: priorities,
      backoffTypeValues: Object.values(rootApi.AXIOS_RETRYER_BACKOFF_TYPES),
      methodValuesUsed: [rootApi.AXIOS_RETRYER_HTTP_METHODS.GET],
      loggerAvailable: typeof manager.getLogger() === 'object',
      axiosInstanceAvailable: Boolean(manager.axiosInstance),
    },
  });

  manager.destroy();
  return scenario;
}

async function runPluginFactoryRuntimeScenario(profile) {
  const coveredPluginExports = {
    CachingPlugin: assertRuntimeExports('CachingPlugin entrypoint', cachingApi, CACHING_RUNTIME_EXPORTS),
    CircuitBreakerPlugin: assertRuntimeExports(
      'CircuitBreakerPlugin entrypoint',
      circuitBreakerApi,
      CIRCUIT_BREAKER_RUNTIME_EXPORTS,
    ),
    DebugSanitizationPlugin: assertRuntimeExports(
      'DebugSanitizationPlugin entrypoint',
      debugSanitizationApi,
      DEBUG_SANITIZATION_RUNTIME_EXPORTS,
    ),
    ManualRetryPlugin: assertRuntimeExports(
      'ManualRetryPlugin entrypoint',
      manualRetryApi,
      MANUAL_RETRY_RUNTIME_EXPORTS,
    ),
    MetricsPlugin: assertRuntimeExports('MetricsPlugin entrypoint', metricsApi, METRICS_RUNTIME_EXPORTS),
    TokenRefreshPlugin: assertRuntimeExports(
      'TokenRefreshPlugin entrypoint',
      tokenRefreshApi,
      TOKEN_REFRESH_RUNTIME_EXPORTS,
    ),
  };

  const metricsCollectorSnapshot = exerciseMetricsCollectorExport();
  const tokenRefreshErrorsCovered = exerciseTokenRefreshErrorExports();

  const storage = new cachingApi.InMemoryCacheStorage();
  const stateAdapter = new circuitBreakerApi.InMemoryCircuitBreakerStateAdapter();
  const cachePlugin = cachingApi.createCachePlugin({
    timeToRevalidate: 0,
    maxItems: 0,
    storage,
    cacheMethods: [rootApi.AXIOS_RETRYER_HTTP_METHODS.GET],
  });
  const debugPlugin = debugSanitizationApi.createDebugSanitizationPlugin({
    sanitizeOptions: { sensitiveHeaders: ['authorization'] },
  });
  const metricsPlugin = metricsApi.createMetricsPlugin();

  const cacheHarness = createAdapter(({ key, attempt }) => ({
    latencyMs: 2,
    data: { ok: true, key, attempt },
  }));
  const cacheManager = createManager({
    adapter: cacheHarness.adapter,
    plugins: [cachePlugin, debugPlugin, metricsPlugin],
    options: {
      retries: 0,
      maxConcurrentRequests: Math.max(2, scaleCount(profile, 4, 2)),
    },
  });

  const sharedCacheItems = [
    { url: '/cache/public/1' },
    { url: '/cache/public/2' },
  ];
  const scenarioStartedAt = performance.now();
  const cacheCold = await measureRequests({
    items: sharedCacheItems,
    concurrency: sharedCacheItems.length,
    execute: (item) =>
      cacheManager.axiosInstance.request({
        url: item.url,
        method: rootApi.AXIOS_RETRYER_HTTP_METHODS.GET,
      }),
  });
  const cacheHot = await measureRequests({
    items: sharedCacheItems,
    concurrency: sharedCacheItems.length,
    execute: (item) =>
      cacheManager.axiosInstance.request({
        url: item.url,
        method: rootApi.AXIOS_RETRYER_HTTP_METHODS.GET,
      }),
  });
  const cacheKey = cachePlugin.buildCacheKey({
    url: '/cache/public/1',
    method: rootApi.AXIOS_RETRYER_HTTP_METHODS.GET,
  });
  let invalidCacheKeyErrorName = null;
  try {
    cachePlugin.buildCacheKey({
      method: rootApi.AXIOS_RETRYER_HTTP_METHODS.GET,
    });
  } catch (error) {
    invalidCacheKeyErrorName = error instanceof cachingApi.InvalidCacheKeyError ? error.name : 'UnexpectedError';
  }
  const cacheStatsBeforeInvalidation = cachePlugin.getCacheStats();
  const invalidatedCacheEntries = await Promise.resolve(cachePlugin.invalidateCache({ exact: cacheKey }));
  await Promise.resolve(cachePlugin.clearCache());
  const cacheStatsAfterClear = cachePlugin.getCacheStats();

  let manualHealthy = false;
  const manualRetryPlugin = manualRetryApi.createManualRetryPlugin({
    maxRequestsToStore: 4,
    manualRetryMaxAge: 60_000,
  });
  const manualHarness = createAdapter(({ key, attempt }) => {
    if (!manualHealthy) {
      return {
        latencyMs: 3,
        errorStatus: 503,
        errorMessage: `Manual retry failure for ${key}`,
      };
    }

    return {
      latencyMs: 3,
      data: { ok: true, key, attempt },
    };
  });
  const manualManager = createManager({
    adapter: manualHarness.adapter,
    plugins: [manualRetryPlugin],
    options: {
      retries: 0,
      maxConcurrentRequests: 2,
    },
  });
  const manualFailureBatch = await measureRequests({
    items: [{ url: '/manual/failure/1' }],
    concurrency: 1,
    execute: (item) => manualManager.axiosInstance.get(item.url),
  });
  const storedBeforeReplay = manualRetryPlugin.getStoredRequests().length;
  manualHealthy = true;
  const replayedResponses = await manualRetryPlugin.retryFailedRequests();
  manualRetryPlugin.clearStoredRequests();
  const storedAfterClear = manualRetryPlugin.getStoredRequests().length;

  const circuitBreakerPlugin = circuitBreakerApi.createCircuitBreaker({
    failureThreshold: 2,
    openTimeout: 50,
    halfOpenMax: 1,
    successThreshold: 1,
    stateAdapter,
  });
  const circuitHarness = createAdapter(({ key, attempt }) => {
    if (key === '/circuit/outage') {
      return {
        latencyMs: 2,
        errorStatus: 503,
        errorMessage: `Circuit failure ${attempt}`,
      };
    }

    return {
      latencyMs: 2,
      data: { ok: true, key, attempt },
    };
  });
  const circuitManager = createManager({
    adapter: circuitHarness.adapter,
    plugins: [circuitBreakerPlugin],
    options: {
      retries: 0,
      maxConcurrentRequests: 2,
    },
  });
  const circuitTripBatch = await measureRequests({
    items: [{ url: '/circuit/outage' }, { url: '/circuit/outage' }],
    concurrency: 1,
    execute: (item) => circuitManager.axiosInstance.get(item.url),
  });
  const circuitBlockedBatch = await measureRequests({
    items: [{ url: '/circuit/outage' }],
    concurrency: 1,
    execute: (item) => circuitManager.axiosInstance.get(item.url),
  });
  const circuitStateBeforeReset = circuitBreakerPlugin.getState();
  const circuitMetricsBeforeReset = circuitBreakerPlugin.getMetrics();
  const circuitOpenErrors = circuitBlockedBatch.samples.filter(
    (sample) => !sample.ok && sample.error instanceof circuitBreakerApi.CircuitBreakerStateError,
  ).length;
  circuitBreakerPlugin.resetMetrics();
  const circuitMetricsAfterReset = circuitBreakerPlugin.getMetrics();
  circuitBreakerPlugin.manualReset();
  const circuitStateAfterReset = circuitBreakerPlugin.getState();
  const adaptiveTimeoutMetrics = circuitBreakerPlugin.getAdaptiveTimeoutMetrics();

  let refreshCalls = 0;
  const tokenRefreshPlugin = tokenRefreshApi.createTokenRefreshPlugin(
    async (refreshAxios) => {
      refreshCalls += 1;
      const response = await refreshAxios.post('/auth/refresh');
      return { token: response.data.token };
    },
    {
      authHeaderName: 'Authorization',
      tokenPrefix: 'Bearer ',
    },
  );
  const tokenHarness = createAdapter(({ key, config }) => {
    if (key === '/auth/refresh') {
      return {
        latencyMs: 2,
        data: { token: 'fresh-token' },
      };
    }

    const authHeader = String(config.headers?.Authorization || '');
    if (authHeader !== 'Bearer fresh-token') {
      return {
        latencyMs: 2,
        errorStatus: 401,
        errorMessage: 'Unauthorized',
      };
    }

    return {
      latencyMs: 2,
      data: { ok: true, authHeader },
    };
  });
  const tokenManager = createManager({
    adapter: tokenHarness.adapter,
    plugins: [tokenRefreshPlugin],
    options: {
      retries: 0,
      maxConcurrentRequests: 2,
    },
  });
  tokenManager.axiosInstance.defaults.headers.common.Authorization = 'Bearer expired-token';
  const tokenBatch = await measureRequests({
    items: [{ url: '/token/resource/1' }, { url: '/token/resource/2' }],
    concurrency: 2,
    execute: (item) => tokenManager.axiosInstance.get(item.url),
  });

  const combinedResult = mergeResults([
    cacheCold,
    cacheHot,
    manualFailureBatch,
    circuitTripBatch,
    circuitBlockedBatch,
    tokenBatch,
  ]);
  const scenarioFinishedAt = performance.now();

  const scenario = createScenarioSummary({
    name: 'Dedicated Plugin Public API',
    description:
      'Exercises public plugin factories, adapters, errors, and class methods from the documented dedicated plugin entrypoints.',
    requestCount: combinedResult.totals.requestCount,
    concurrency: Math.max(
      sharedCacheItems.length,
      2,
      Math.max(2, scaleCount(profile, 4, 2)),
    ),
    startedAt: scenarioStartedAt,
    finishedAt: scenarioFinishedAt,
    result: combinedResult,
    manager: cacheManager,
    upstreamCalls:
      cacheHarness.stats.upstreamCalls +
      manualHarness.stats.upstreamCalls +
      circuitHarness.stats.upstreamCalls +
      tokenHarness.stats.upstreamCalls,
    extras: {
      coveredPluginExports,
      invalidCacheKeyErrorName,
      cacheKey,
      cacheStatsBeforeInvalidation,
      cacheStatsAfterClear,
      invalidatedCacheEntries,
      storedBeforeReplay,
      replayedCount: replayedResponses.length,
      storedAfterClear,
      circuitStateBeforeReset,
      circuitStateAfterReset,
      circuitMetricsBeforeReset,
      circuitMetricsAfterReset,
      circuitOpenErrors,
      adaptiveTimeoutMetrics,
      refreshCalls,
      tokenRefreshErrorsCovered,
      metricsCollectorSnapshot,
      stateAdapterType: 'InMemoryCircuitBreakerStateAdapter',
      storageType: 'InMemoryCacheStorage',
    },
  });

  cacheManager.destroy();
  manualManager.destroy();
  circuitManager.destroy();
  tokenManager.destroy();
  return scenario;
}

async function runPluginBarrelRuntimeScenario(profile) {
  const coveredBarrelExports = assertRuntimeExports(
    'plugins barrel entrypoint',
    pluginBarrelApi,
    PLUGIN_BARREL_RUNTIME_EXPORTS,
  );

  const harness = createAdapter(({ key }) => ({
    latencyMs: 2,
    data: { ok: true, key },
  }));
  const metricsPlugin = pluginBarrelApi.createMetricsPlugin();
  const debugPlugin = pluginBarrelApi.createDebugSanitizationPlugin({
    sanitizeOptions: { allowedFields: ['ok'], allowlistOnly: true },
  });
  const cachePlugin = pluginBarrelApi.createCachePlugin({
    timeToRevalidate: 0,
    maxItems: 0,
  });
  const tokenPlugin = pluginBarrelApi.createTokenRefreshPlugin(async () => ({ token: 'barrel-token' }));
  const manualPlugin = pluginBarrelApi.createManualRetryPlugin({
    maxRequestsToStore: 2,
  });
  const circuitPlugin = pluginBarrelApi.createCircuitBreaker({
    failureThreshold: 2,
  });

  const manager = createManager({
    adapter: harness.adapter,
    plugins: [metricsPlugin, debugPlugin, cachePlugin, tokenPlugin, manualPlugin, circuitPlugin],
    placements: [undefined, false, undefined, undefined, undefined, undefined],
    options: {
      retries: 0,
      maxConcurrentRequests: Math.max(2, scaleCount(profile, 4, 2)),
    },
  });

  const items = [{ url: '/barrel/1' }, { url: '/barrel/1' }, { url: '/barrel/2' }];
  const startedAt = performance.now();
  const result = await measureRequests({
    items,
    concurrency: items.length,
    execute: (item, index) =>
      manager.axiosInstance.get(
        item.url,
        withPriority(index % 2 === 0 ? rootApi.AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH : rootApi.AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM),
      ),
  });
  const finishedAt = performance.now();

  const listedPlugins = manager.listPlugins();
  const removedDebugPlugin = manager.unuse('DebugSanitizationPlugin');
  const listedPluginsAfterUnuse = manager.listPlugins();
  const barrelErrorExports = [
    ['InvalidCacheKeyError', new pluginBarrelApi.InvalidCacheKeyError()],
    [
      'CircuitBreakerStateError',
      new pluginBarrelApi.CircuitBreakerStateError(
        'Barrel circuit open',
        pluginBarrelApi.CIRCUIT_BREAKER_STATES.OPEN,
        getSampleConfig('/barrel/error'),
      ),
    ],
    ['MissingTokenRefreshHandlerError', new pluginBarrelApi.MissingTokenRefreshHandlerError()],
    ['TokenRefreshAbortError', new pluginBarrelApi.TokenRefreshAbortError()],
    ['TokenRefreshFailedError', new pluginBarrelApi.TokenRefreshFailedError()],
    ['TokenRefreshTimeoutError', new pluginBarrelApi.TokenRefreshTimeoutError()],
  ];
  barrelErrorExports.forEach(([, error]) => {
    if (!(error instanceof Error)) {
      throw new Error('Expected barrel error export to be an Error instance');
    }
  });

  const scenario = createScenarioSummary({
    name: 'Plugin Barrel Runtime API',
    description:
      'Uses the deprecated plugins barrel as a consumer would, covering barrel-exported factories, classes, errors, listPlugins, and unuse().',
    requestCount: result.totals.requestCount,
    concurrency: items.length,
    startedAt,
    finishedAt,
    result,
    manager,
    upstreamCalls: harness.stats.upstreamCalls,
    extras: {
      coveredBarrelExports,
      listedPlugins,
      removedDebugPlugin,
      listedPluginsAfterUnuse,
      barrelErrorNames: barrelErrorExports.map(([exportName]) => exportName),
      barrelFactoryNames: [
        metricsPlugin.name,
        debugPlugin.name,
        cachePlugin.name,
        tokenPlugin.name,
        manualPlugin.name,
        circuitPlugin.name,
      ],
    },
  });

  manager.destroy();
  return scenario;
}

async function main() {
  const profile = getProfile();
  printHeader('Public API Runtime Benchmark', `Profile: ${profile.name}`);

  const scenarios = [
    await runRootRuntimeApiScenario(profile),
    await runPluginFactoryRuntimeScenario(profile),
    await runPluginBarrelRuntimeScenario(profile),
  ];

  scenarios.forEach(printScenario);

  emitResult({
    benchmark: BENCHMARK_NAME,
    title: 'Public API Runtime Benchmark',
    generatedAt: nowIso(),
    profile: profile.name,
    scenarios,
  });
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
