//@ts-nocheck

const {
  average,
  bytesToMb,
  createAdapter,
  createScenarioSummary,
  deterministicUnit,
  emitResult,
  getAttemptsForKey,
  getProfile,
  measureRequests,
  nowIso,
  parseArgs,
  percentile,
  printHeader,
  printScenario,
  RESULT_PREFIX,
  runWithConcurrency,
  scaleCount,
  silenceManager,
  sleep,
  summarizeLatency,
} = require('../benchmark/_utils');

describe('benchmark utils', () => {
  it('produces deterministic pseudo-random values', () => {
    const first = deterministicUnit(42, 'resource', 1);
    const second = deterministicUnit(42, 'resource', 1);
    const different = deterministicUnit(42, 'resource', 2);

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(1);
  });

  it('summarizes latency samples with empty-safe defaults', () => {
    expect(summarizeLatency([])).toEqual({
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    });

    expect(summarizeLatency([10, 20, 30, 40])).toEqual({
      count: 4,
      minMs: 10,
      maxMs: 40,
      avgMs: 25,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
    });
  });

  it('parses benchmark profile arguments', () => {
    expect(parseArgs(['--profile=quick', '--include=stress-testing.js'])).toEqual({
      profile: 'quick',
      include: 'stress-testing.js',
    });

    expect(getProfile(['--profile=full']).name).toBe('full');
    expect(getProfile(['--profile=missing']).name).toBe('standard');
  });

  it('tracks upstream calls and retry attempts in adapters', async () => {
    const harness = createAdapter(({ key, attempt }) => {
      if (attempt === 1) {
        return {
          latencyMs: 0,
          errorStatus: 503,
          errorMessage: `fail ${key}`,
        };
      }

      return {
        latencyMs: 0,
        data: { ok: true, key, attempt },
      };
    });

    await expect(harness.adapter({ url: '/retry-me' })).rejects.toMatchObject({
      response: { status: 503 },
    });

    const response = await harness.adapter({ url: '/retry-me' });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true, key: '/retry-me', attempt: 2 });
    expect(harness.stats.upstreamCalls).toBe(2);
    expect(harness.stats.callsByKey.get('/retry-me')).toBe(2);
  });

  it('covers utility helpers for timing, math, and concurrency', async () => {
    expect(scaleCount({ scale: 0.4 }, 10, 3)).toBe(4);
    expect(scaleCount({ scale: 0.1 }, 10, 3)).toBe(3);
    expect(average([])).toBe(0);
    expect(average([10, 20, 30])).toBe(20);
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(bytesToMb(5 * 1024 * 1024)).toBe(5);
    expect(nowIso()).toMatch(/\d{4}-\d{2}-\d{2}T/);

    const before = Date.now();
    await sleep(0);
    expect(Date.now()).toBeGreaterThanOrEqual(before);

    const results = await runWithConcurrency([1, 2, 3], 2, async (value) => value * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it('measures requests and summarizes benchmark scenarios', async () => {
    const measured = await measureRequests({
      items: ['ok', 'fail'],
      concurrency: 2,
      execute: async (item) => {
        if (item === 'fail') {
          throw new Error('boom');
        }
        return item.toUpperCase();
      },
    });

    expect(measured.totals.requestCount).toBe(2);
    expect(measured.totals.successCount).toBe(1);
    expect(measured.totals.failureCount).toBe(1);
    expect(measured.totals.successRate).toBe(50);
    expect(measured.samples[1].ok).toBe(false);

    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    };
    const manager = {
      getLogger: () => logger,
      getMetrics: () => ({
        successfulRetries: 1,
        failedRetries: 2,
        completelyFailedRequests: 3,
        avgQueueWait: 1.234,
        avgRetryDelay: 2.345,
      }),
      getTimerStats: () => ({
        activeTimers: 2,
        activeRetryTimers: 1,
      }),
    };

    silenceManager(manager);
    expect(() => manager.getLogger().log('silenced')).not.toThrow();

    const summary = createScenarioSummary({
      name: 'scenario',
      description: 'summary test',
      requestCount: 2,
      concurrency: 1,
      startedAt: 100,
      finishedAt: 600,
      result: measured,
      manager,
      upstreamCalls: 3,
      memoryDeltaBytes: 1024 * 1024,
      extras: { mode: 'test' },
    });

    expect(summary.throughputPerSec).toBe(4);
    expect(summary.upstreamCallsPerRequest).toBe(1.5);
    expect(summary.memoryDeltaMb).toBe(1);
    expect(summary.retryMetrics).toEqual({
      successfulRetries: 1,
      failedRetries: 2,
      completelyFailedRequests: 3,
      avgQueueWaitMs: 1.23,
      avgRetryDelayMs: 2.35,
    });
    expect(summary.timerHealth).toEqual({
      healthScore: 4,
      activeTimers: 2,
      activeRetryTimers: 1,
    });
    expect(summary.extras).toEqual({ mode: 'test' });
  });

  it('prints benchmark output helpers', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    printHeader('Benchmarks', 'subtitle');
    printScenario({
      name: 'Scenario A',
      description: 'Does something',
      successRate: 100,
      throughputPerSec: 12,
      latencyMs: { p95Ms: 8 },
      upstreamCalls: 4,
    });
    emitResult({ ok: true });

    expect(consoleSpy).toHaveBeenCalledWith('\nBenchmarks');
    expect(consoleSpy).toHaveBeenCalledWith('subtitle');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(RESULT_PREFIX));
  });

  it('exposes helper accessors for adapter stats', async () => {
    const harness = createAdapter(async ({ key }) => ({
      latencyMs: 0,
      headers: { 'x-key': key },
      status: 201,
      statusText: 'Created',
    }));

    const response = await harness.adapter({ url: '/resource' });

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers).toEqual({ 'x-key': '/resource' });
    expect(getAttemptsForKey(harness.stats, '/resource')).toBe(1);
    expect(getAttemptsForKey(harness.stats, '/missing')).toBe(0);
  });
});
