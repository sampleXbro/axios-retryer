const { performance } = require('perf_hooks');

const PROFILE_SETTINGS = {
  quick: {
    name: 'quick',
    scale: 0.35,
    sustainedDurationMs: 15000,
    memoryCycles: 3,
    warmupRuns: 1,
  },
  standard: {
    name: 'standard',
    scale: 1,
    sustainedDurationMs: 45000,
    memoryCycles: 5,
    warmupRuns: 1,
  },
  full: {
    name: 'full',
    scale: 1.75,
    sustainedDurationMs: 120000,
    memoryCycles: 8,
    warmupRuns: 2,
  },
};

const RESULT_PREFIX = 'BENCHMARK_RESULT ';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split('=');
    args[rawKey] = rawValue === undefined ? true : rawValue;
  }

  return args;
}

function getProfile(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const profileName = typeof args.profile === 'string' ? args.profile : process.env.BENCHMARK_PROFILE || 'standard';
  return PROFILE_SETTINGS[profileName] || PROFILE_SETTINGS.standard;
}

function scaleCount(profile, value, minimum = 1) {
  return Math.max(minimum, Math.round(value * profile.scale));
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deterministicUnit(seed, ...parts) {
  const input = [seed, ...parts].join('|');
  let hash = 2166136261;

  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeLatency(values) {
  if (!values.length) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  return {
    count: values.length,
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
    avgMs: round(average(values)),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  async function runner() {
    while (true) {
      const currentIndex = cursor++;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: width }, () => runner()));

  return results;
}

async function measureRequests({ items, concurrency, execute }) {
  const samples = await runWithConcurrency(items, concurrency, async (item, index) => {
    const startedAt = performance.now();

    try {
      const value = await execute(item, index);
      return {
        ok: true,
        durationMs: performance.now() - startedAt,
        value,
      };
    } catch (error) {
      return {
        ok: false,
        durationMs: performance.now() - startedAt,
        error,
      };
    }
  });

  const durations = samples.map((sample) => sample.durationMs);
  const successCount = samples.filter((sample) => sample.ok).length;

  return {
    samples,
    totals: {
      requestCount: samples.length,
      successCount,
      failureCount: samples.length - successCount,
      successRate: samples.length ? round((successCount / samples.length) * 100) : 0,
      latency: summarizeLatency(durations),
    },
  };
}

function createAdapter(handler) {
  const attemptsByKey = new Map();
  const stats = {
    upstreamCalls: 0,
    callsByKey: new Map(),
    statuses: new Map(),
  };

  async function adapter(config) {
    const key = config.url || 'unknown';
    const attempt = (attemptsByKey.get(key) || 0) + 1;
    attemptsByKey.set(key, attempt);
    stats.upstreamCalls += 1;
    stats.callsByKey.set(key, attempt);

    const outcome = await handler({
      key,
      attempt,
      config,
      stats,
    });

    const latencyMs = Math.max(0, outcome.latencyMs || 0);
    if (latencyMs) {
      await sleep(latencyMs);
    }

    const status = outcome.status || 200;
    stats.statuses.set(status, (stats.statuses.get(status) || 0) + 1);

    if (outcome.errorStatus) {
      const error = new Error(outcome.errorMessage || `Request failed with status code ${outcome.errorStatus}`);
      error.response = {
        data: outcome.errorData || { error: outcome.errorMessage || 'Simulated error' },
        status: outcome.errorStatus,
        statusText: outcome.errorStatusText || 'Error',
        headers: outcome.headers || {},
        config,
      };
      error.config = config;
      throw error;
    }

    return {
      data: outcome.data || { ok: true, key, attempt },
      status,
      statusText: outcome.statusText || 'OK',
      headers: outcome.headers || {},
      config,
    };
  }

  return { adapter, stats, attemptsByKey };
}

function getAttemptsForKey(stats, key) {
  return stats.callsByKey.get(key) || 0;
}

function bytesToMb(bytes) {
  return round(bytes / 1024 / 1024);
}

function silenceManager(manager) {
  const logger = typeof manager.getLogger === 'function' ? manager.getLogger() : null;
  if (!logger) {
    return;
  }

  logger.log = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  logger.debug = () => {};
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function createScenarioSummary({
  name,
  description,
  requestCount,
  concurrency,
  startedAt,
  finishedAt,
  result,
  manager,
  upstreamCalls,
  memoryDeltaBytes = 0,
  extras = {},
}) {
  const durationMs = finishedAt - startedAt;
  const throughput = durationMs > 0 ? round((requestCount / durationMs) * 1000) : 0;
  const metrics = manager.getMetrics();
  const timerStats = manager.getTimerStats();
  const timerHealth = metrics.timerHealth || {
    healthScore: timerStats.activeTimers + timerStats.activeRetryTimers * 2,
    activeTimers: timerStats.activeTimers,
    activeRetryTimers: timerStats.activeRetryTimers,
  };

  return {
    name,
    description,
    requestCount,
    concurrency,
    durationMs: round(durationMs),
    throughputPerSec: throughput,
    successCount: result.totals.successCount,
    failureCount: result.totals.failureCount,
    successRate: result.totals.successRate,
    latencyMs: result.totals.latency,
    upstreamCalls,
    upstreamCallsPerRequest: requestCount ? round(upstreamCalls / requestCount) : 0,
    retryMetrics: {
      successfulRetries: metrics.successfulRetries,
      failedRetries: metrics.failedRetries,
      completelyFailedRequests: metrics.completelyFailedRequests,
      avgQueueWaitMs: round(metrics.avgQueueWait),
      avgRetryDelayMs: round(metrics.avgRetryDelay),
    },
    timerHealth: {
      healthScore: round(timerHealth.healthScore || 0),
      activeTimers: timerHealth.activeTimers,
      activeRetryTimers: timerHealth.activeRetryTimers,
    },
    memoryDeltaMb: bytesToMb(memoryDeltaBytes),
    extras,
  };
}

function printHeader(title, subtitle) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
  if (subtitle) {
    console.log(subtitle);
  }
}

function printScenario(scenario) {
  console.log(`\n- ${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(
    `  ${scenario.successRate}% success, ${scenario.throughputPerSec} req/sec, p95 ${scenario.latencyMs.p95Ms}ms, upstream ${scenario.upstreamCalls}`
  );
}

function emitResult(result) {
  console.log(`\n${RESULT_PREFIX}${JSON.stringify(result)}`);
}

module.exports = {
  RESULT_PREFIX,
  PROFILE_SETTINGS,
  average,
  bytesToMb,
  createAdapter,
  createScenarioSummary,
  deterministicUnit,
  emitResult,
  getAttemptsForKey,
  parseArgs,
  getProfile,
  measureRequests,
  nowIso,
  percentile,
  printHeader,
  printScenario,
  round,
  runWithConcurrency,
  scaleCount,
  silenceManager,
  sleep,
  summarizeLatency,
};
