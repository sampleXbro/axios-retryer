//@ts-nocheck

const {
  createAdapter,
  deterministicUnit,
  getProfile,
  parseArgs,
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
});
