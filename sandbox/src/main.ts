/**
 * axios-retryer sandbox — interactive demos aligned with real wiring.
 *
 * Each section: isolated axios + axios-mock-adapter + createRetryer (+ plugins).
 * Covers: core retry/backoff, priority + cancel + queue cap, blocking gate, caching (+ invalidation),
 *   circuit breaker, metrics, manual replay, token refresh (+ no-token skip), debug sanitization.
 * UI pattern: Scenarios → Tools / session controls → Live state → Setup (config box).
 * Base URLs use http://{section}-demo for clarity in logs.
 *
 * Outside this repo: set `"axios-retryer": "^2.0.4"` (or your version) in package.json instead of `file:..`.
 */

import axios from 'axios';
import type { AxiosError, AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import {
  createRetryer,
  AXIOS_RETRYER_REQUEST_PRIORITIES as P,
  AXIOS_RETRYER_BACKOFF_TYPES as BACKOFF,
  RETRY_MODES,
  QueueFullError,
} from 'axios-retryer';
import type { AxiosRetryerRequestPriority, CoreRetryEvents, Logger, RetryManager } from 'axios-retryer';
import type { AxiosRequestConfig } from 'axios';
import { CachingPlugin } from 'axios-retryer/plugins/CachingPlugin';
import type { CachingPluginEvents } from 'axios-retryer/plugins/CachingPlugin';
import { CircuitBreakerPlugin, CIRCUIT_BREAKER_STATES } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import type { CircuitBreakerPluginEvents } from 'axios-retryer/plugins/CircuitBreakerPlugin';
import { DebugSanitizationPlugin } from 'axios-retryer/plugins/DebugSanitizationPlugin';
import { MetricsPlugin } from 'axios-retryer/plugins/MetricsPlugin';
import type { MetricsPluginEvents } from 'axios-retryer/plugins/MetricsPlugin';
import { ManualRetryPlugin } from 'axios-retryer/plugins/ManualRetryPlugin';
import type { ManualRetryPluginEvents } from 'axios-retryer/plugins/ManualRetryPlugin';
import { createTokenRefreshPlugin } from 'axios-retryer/plugins/TokenRefreshPlugin';
import type { TokenRefreshPluginEvents } from 'axios-retryer/plugins/TokenRefreshPlugin';

// ─── UI helpers ──────────────────────────────────────────────────────────────

type Level = 'info' | 'success' | 'error' | 'warn' | 'highlight' | 'critical' | 'dim';
/** Visual group for scanning the log (left accent + tint). */
type LogChannel = 'action' | 'event-core' | 'event-plugin' | 'http' | 'result' | 'tool' | 'library' | 'misc';
type RequestFactory<T = unknown> = () => Promise<T>;

function inferLogChannel(msg: string, level: Level): LogChannel {
  const t = msg.trimStart();
  if (msg.includes('↗ sent')) return 'http';
  if (t.startsWith('→')) return 'action';
  if (/^\s*event:/.test(msg)) {
    if (
      msg.includes('onCache') ||
      msg.includes('onCircuit') ||
      msg.includes('onToken') ||
      msg.includes('onManual') ||
      msg.includes('onRequestRemovedFromStore')
    ) {
      return 'event-plugin';
    }
    return 'event-core';
  }
  if (/^\s*[✓✗■]/.test(msg)) return 'result';
  if (t.includes('completion #')) return 'result';
  if (t.includes('cancelRequest') || t.includes('cancelAllRequests')) return 'action';
  if (
    msg.includes('──') ||
    msg.includes('getCacheStats:') ||
    msg.includes('manager.getMetrics()') ||
    msg.includes('invalidateCache removed') ||
    (t.startsWith('  total') && msg.includes('Requests')) ||
    t.startsWith('  successfulRetries:') ||
    t.startsWith('  failedRetries:') ||
    t.startsWith('  completelyFailed') ||
    t.startsWith('  cancelledRequests:') ||
    t.startsWith('  errorTypes.') ||
    t.startsWith('  avgQueueWait:') ||
    t.startsWith('  avgRetryDelay:') ||
    t.startsWith('  timerHealth.') ||
    t.startsWith('  by priority:') ||
    t.startsWith('    p=') ||
    t.startsWith('    scope=') ||
    t.startsWith('  getMetrics:')
  ) {
    return 'tool';
  }
  if (level === 'highlight') return 'action';
  return 'misc';
}

function log(id: string, msg: string, level: Level = 'info', channel?: LogChannel) {
  const el = document.getElementById(`log-${id}`);
  if (!el) return;
  el.querySelector('.log-empty')?.remove();
  const ch = channel ?? inferLogChannel(msg, level);
  const line = document.createElement('div');
  line.className = `log-line log-ch-${ch}`;
  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = new Date().toLocaleTimeString('en', { hour12: false });
  const text = document.createElement('span');
  text.className = `log-msg ${level}`;
  text.textContent = msg;
  line.append(ts, text);
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function clearLog(id: string) {
  const el = document.getElementById(`log-${id}`);
  if (el) {
    el.innerHTML = `<div class="log-empty">— log cleared —</div>`;
  }
}

function setInfoRow(id: string, key: string, value: string | number) {
  const el = document.getElementById(`val-${id}-${key}`);
  if (el) el.textContent = String(value);
}

function on(btnId: string, handler: () => void) {
  document.getElementById(btnId)?.addEventListener('click', handler);
}

function attachRequestLogger(id: string, axiosInstance: AxiosInstance, tag?: string): void {
  axiosInstance.interceptors.request.use((config) => {
    const method = (config.method ?? 'GET').toUpperCase();
    const suffix = tag ? ` [${tag}]` : '';
    log(id, `  ↗ sent${suffix}: ${method} ${config.url ?? '(unknown)'}`, 'dim', 'http');
    return config;
  });
}

/** Forwards RetryManager `logger` calls into the section log (same pattern as `debug: true` in production). */
function makeUiLogger(sectionId: string): Logger {
  const line = (level: Level, message: string, meta?: unknown) => {
    const extra = meta !== undefined ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
    log(sectionId, `  ${message}${extra}`, level, 'library');
  };
  return {
    log: (m, d) => line('dim', m, d),
    error: (m, e) => line('error', m, e),
    warn: (m, d) => line('warn', m, d),
    debug: (m, meta) => line('dim', m, meta),
  };
}

const RANDOM_DELAY_MIN_MS = 100;
const RANDOM_DELAY_MAX_MS = 700;

function getRandomDelayMs(): number {
  return Math.floor(Math.random() * (RANDOM_DELAY_MAX_MS - RANDOM_DELAY_MIN_MS + 1)) + RANDOM_DELAY_MIN_MS;
}

function withRandomDelay<T>(valueFactory: () => T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(valueFactory()), getRandomDelayMs());
  });
}

function getRandomNonCriticalPriority(): AxiosRetryerRequestPriority {
  const priorities = [P.LOW, P.MEDIUM, P.HIGH, P.HIGHEST] as const;
  const index = Math.floor(Math.random() * priorities.length);
  return priorities[index];
}

async function runMixedDispatch<T>(requestFactories: RequestFactory<T>[]): Promise<PromiseSettledResult<T>[]> {
  const settled: PromiseSettledResult<T>[] = [];
  let cursor = 0;

  const runParallelChunk = async (size: number) => {
    const chunk = requestFactories.slice(cursor, cursor + size);
    if (!chunk.length) return;
    const results = await Promise.allSettled(chunk.map((factory) => factory()));
    settled.push(...results);
    cursor += chunk.length;
  };

  // 1) First burst: 3 parallel
  await runParallelChunk(3);

  // 2) Then stream: 4 one-by-one
  for (let i = 0; i < 4 && cursor < requestFactories.length; i++) {
    settled.push(
      await requestFactories[cursor]().then(
        (value) => ({ status: 'fulfilled', value }) as PromiseFulfilledResult<T>,
        (reason) => ({ status: 'rejected', reason }) as PromiseRejectedResult,
      ),
    );
    cursor++;
  }

  // 3) Remaining requests: repeating parallel bursts of 3
  while (cursor < requestFactories.length) {
    await runParallelChunk(3);
  }

  return settled;
}

/** Prevents double-clicks from overlapping async scenarios (log a line if `onBusy` provided). */
function createBusyGuard(sectionId: string) {
  let busy = false;
  return async (work: () => Promise<void>) => {
    if (busy) {
      log(sectionId, '  (scenario already running — wait for it to finish)', 'warn', 'misc');
      return;
    }
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  };
}

type CoreQueued = Parameters<NonNullable<CoreRetryEvents['onRequestQueued']>>[0];
type CoreDispatched = Parameters<NonNullable<CoreRetryEvents['onRequestDispatched']>>[0];
type CoreSucceeded = Parameters<NonNullable<CoreRetryEvents['onRequestSucceeded']>>[0];
type CoreErrorEv = Parameters<NonNullable<CoreRetryEvents['onRequestError']>>[0];

/** Subscribes to every `CoreRetryEvents` handler (RetryManager public contract). */
function wireAllCoreRetryEvents<T extends object = object>(manager: RetryManager<T>, logId: string): void {
  const urlOf = (cfg: { url?: string }) => cfg.url ?? '(no url)';
  const ev = (msg: string, level: Level = 'dim') => log(logId, msg, level, 'event-core');
  manager.on('onRetryProcessStarted', () => ev('  event: onRetryProcessStarted'));
  //@ts-expect-error
  manager.on('beforeRetry', (cfg: AxiosRequestConfig) => ev(`  event: beforeRetry ${urlOf(cfg)}`));
  //@ts-expect-error
  manager.on('onRetryScheduled', (delayMs: number, cfg: AxiosRequestConfig) =>
    ev(`  event: onRetryScheduled delayMs=${delayMs} ${urlOf(cfg)}`),
  );
  //@ts-expect-error
  manager.on('afterRetry', (cfg: AxiosRequestConfig, success: boolean, err?: AxiosError) =>
    ev(`  event: afterRetry success=${success} ${urlOf(cfg)}${!success && err?.message ? ` err=${err.message}` : ''}`),
  );
  //@ts-expect-error
  manager.on('onFailure', (cfg: AxiosRequestConfig) => ev(`  event: onFailure ${urlOf(cfg)}`, 'warn'));
  //@ts-expect-error
  manager.on('onRequestQueued', (p: CoreQueued) =>
    ev(`  event: onRequestQueued ${p.requestId} pri=${p.priority} queueSize=${p.queueSize}`),
  );
  //@ts-expect-error
  manager.on('onRequestDispatched', (p: CoreDispatched) =>
    ev(`  event: onRequestDispatched ${p.requestId} waitMs=${p.queuedForMs}`),
  );
  //@ts-expect-error
  manager.on('onRequestSucceeded', (p: CoreSucceeded) =>
    ev(`  event: onRequestSucceeded ${urlOf(p.config)} status=${p.status} attempts=${p.attempts}`),
  );
  //@ts-expect-error
  manager.on('onRequestError', (payload: CoreErrorEv) =>
    ev(
      `  event: onRequestError ${urlOf(payload.config)} status=${payload.status ?? '—'} attempts=${payload.attempts} retryable=${payload.retryable}`,
    ),
  );
  manager.on('onRetryProcessFinished', () => ev('  event: onRetryProcessFinished'));
  //@ts-expect-error
  manager.on('onRequestCancelled', (id: string) => ev(`  event: onRequestCancelled ${id}`, 'warn'));
  //@ts-expect-error
  manager.on('onInternetConnectionError', (cfg: AxiosRequestConfig) =>
    ev(`  event: onInternetConnectionError ${urlOf(cfg)}`, 'error'),
  );
  //@ts-expect-error
  manager.on('onBlockingRequestFailed', (cfg: AxiosRequestConfig) =>
    ev(`  event: onBlockingRequestFailed ${urlOf(cfg)}`, 'error'),
  );
  manager.on('onAllBlockingRequestsResolved', () => ev('  event: onAllBlockingRequestsResolved', 'success'));
}

// ─── Section renderer ─────────────────────────────────────────────────────────

interface SectionDef {
  id: string;
  group: 'Core' | 'Plugins';
  title: string;
  desc: string;
  controls: string;
  setup: () => void;
}

const SECTIONS: SectionDef[] = [];

function section(def: SectionDef) {
  SECTIONS.push(def);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 1 · Auto Retry & Backoff
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'retry',
  group: 'Core',
  title: 'Auto Retry & Backoff',
  desc: 'createRetryer with retries + retryable status ranges. Each scenario fires 10 GETs through mixed dispatch (bursts + streaming) with random 100–700 ms “network” latency so retries are visible in the log.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn" id="b-retry-reset">Reset flaky counters (per-URL attempt state)</button>
      <button class="btn btn-primary" id="b-retry-flaky">Flaky: 2× 503 then 200 per URL</button>
      <button class="btn btn-danger" id="b-retry-exhaust">Exhaust: always 500 (all retries burn)</button>
      <button class="btn" id="b-retry-static">Per-request STATIC backoff</button>
      <button class="btn" id="b-retry-linear">Per-request LINEAR backoff</button>
      <button class="btn" id="b-retry-override">Per-request requestRetries: 1</button>
      <button class="btn" id="b-retry-offline">Single GET /offline (network error → onInternetConnectionError)</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Last run</span><span class="info-row-value" id="val-retry-summary">—</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">createRetryer({ retries: 3, backoffType: EXPONENTIAL, retryableStatuses: [429, [500,599]] })
All CoreRetryEvents wired (see log). Mock: /offline uses networkError(); other paths use withRandomDelay (100–700 ms)</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://retry-demo' });
    attachRequestLogger('retry', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('retry');

    const failCounts = new Map<string, number>();
    mock.onGet(/\/flaky\/\d+/).reply((cfg) =>
      withRandomDelay(() => {
        const key = cfg.url!;
        const n = (failCounts.get(key) ?? 0) + 1;
        failCounts.set(key, n);
        if (n <= 2) return [503, { error: 'unavailable', attempt: n }];
        failCounts.delete(key);
        return [200, { message: 'recovered after 2 failures' }];
      }),
    );
    mock
      .onGet(/\/(exhaust|static|override)\/\d+/)
      .reply(() => withRandomDelay(() => [500, { error: 'permanent failure' }]));
    mock.onGet('/offline').networkError();

    const manager = createRetryer({
      axiosInstance: ax,
      retries: 3,
      backoffType: BACKOFF.EXPONENTIAL,
      retryableStatuses: [429, [500, 599] as const],
    });
    wireAllCoreRetryEvents(manager, 'retry');

    const fire = async (path: string, label: string, opts?: object) => {
      log('retry', `→ ${label} — 10 GETs mixed dispatch`, 'highlight');
      let ok = 0;
      let fail = 0;
      await runMixedDispatch(
        Array.from({ length: 10 }, (_, i) => () => {
          const reqOptions = {
            ...(opts ?? {}),
            __axiosRetryer: {
              priority: getRandomNonCriticalPriority(),
              ...((opts as { __axiosRetryer?: Record<string, unknown> } | undefined)?.__axiosRetryer ?? {}),
            },
          };

          return manager.axiosInstance
            .get<{ message: string }>(`/${path}/${i + 1}`, reqOptions)
            .then((r) => {
              ok++;
              log('retry', `  ✓ /${path}/${i + 1}: ${r.data.message ?? 'ok'}`, 'success');
            })
            .catch(() => {
              fail++;
            });
        }),
      );
      setInfoRow('retry', 'summary', `${ok} ok / ${fail} fail`);
      log('retry', `■ done: ${ok} succeeded, ${fail} failed`, ok > 0 ? 'success' : 'error');
    };

    on('b-retry-reset', () => {
      failCounts.clear();
      setInfoRow('retry', 'summary', 'flaky map cleared');
      log('retry', '→ Flaky per-URL counters cleared', 'dim');
    });

    on('b-retry-flaky', () => guard(() => fire('flaky', 'Flaky (503×2 then 200)')));
    on('b-retry-exhaust', () => guard(() => fire('exhaust', 'Exhaust (always 500)')));
    on('b-retry-static', () =>
      guard(() => fire('static', 'Static backoff', { __axiosRetryer: { backoffType: BACKOFF.STATIC } })),
    );
    on('b-retry-linear', () =>
      guard(() => fire('exhaust', 'Linear backoff', { __axiosRetryer: { backoffType: BACKOFF.LINEAR } })),
    );
    on('b-retry-override', () =>
      guard(() => fire('override', 'Override retries=1', { __axiosRetryer: { requestRetries: 1 } })),
    );

    on('b-retry-offline', () =>
      guard(async () => {
        log('retry', '→ GET /offline (requestRetries: 0, expect onInternetConnectionError)', 'highlight');
        try {
          await manager.axiosInstance.get('/offline', { __axiosRetryer: { requestRetries: 0 } });
        } catch (e) {
          log('retry', `  → rejected: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        log('retry', '■ done', 'dim');
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 2 · Priority Queue & Concurrency
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'priority',
  group: 'Core',
  title: 'Priority Queue & Concurrency',
  desc: 'maxConcurrentRequests limits in-flight work; __axiosRetryer.priority orders the wait queue. Dispatch order follows priority; completion order can differ when responses use random delay.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-primary" id="b-priority-ten">10 GETs — fixed priority ladder (2 slots)</button>
      <button class="btn" id="b-priority-cancel-one">5 GETs — cancelRequest("priority-job-3") @ 250ms</button>
      <button class="btn" id="b-priority-cancel-all">10 GETs — cancelAllRequests() @ 1.5s</button>
      <button class="btn btn-danger" id="b-priority-queue-full">Queue full: maxQueueSize=3, 6 slow GETs at once (expect QueueFullError)</button>
      <button class="btn" id="b-priority-extra">1 GET with __axiosRetryer.extra (metadata passthrough)</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Concurrency cap</span><span class="info-row-value" id="val-priority-cap">2</span></div>
      <div class="info-row"><span class="info-row-label">Last run</span><span class="info-row-value" id="val-priority-summary">—</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">createRetryer({ retries: 0, maxConcurrentRequests: 2 }) — queue-full scenario uses a separate short-lived manager (maxConcurrentRequests: 1, maxQueueSize: 3, queueDelay: 0)
GET /queue/… — 200 after random 100–700 ms · all CoreRetryEvents wired
Dispatch order (expected): CRITICAL → HIGHEST → HIGH → MEDIUM → LOW (2 at a time)</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://priority-demo' });
    attachRequestLogger('priority', ax);
    const guard = createBusyGuard('priority');

    const manager = createRetryer({
      axiosInstance: ax,
      retries: 0,
      maxConcurrentRequests: 2,
    });
    wireAllCoreRetryEvents(manager, 'priority');

    const JOBS: Array<{ label: string; pri: AxiosRetryerRequestPriority; url: string }> = [
      { label: 'CRITICAL-A (4)', pri: P.CRITICAL, url: '/queue/critical-a' },
      { label: 'CRITICAL-B (4)', pri: P.CRITICAL, url: '/queue/critical-b' },
      { label: 'HIGHEST-A (3)', pri: P.HIGHEST, url: '/queue/highest-a' },
      { label: 'HIGHEST-B (3)', pri: P.HIGHEST, url: '/queue/highest-b' },
      { label: 'HIGH-A (2)', pri: P.HIGH, url: '/queue/high-a' },
      { label: 'HIGH-B (2)', pri: P.HIGH, url: '/queue/high-b' },
      { label: 'MEDIUM-A (1)', pri: P.MEDIUM, url: '/queue/medium-a' },
      { label: 'MEDIUM-B (1)', pri: P.MEDIUM, url: '/queue/medium-b' },
      { label: 'LOW-A (0)', pri: P.LOW, url: '/queue/low-a' },
      { label: 'LOW-B (0)', pri: P.LOW, url: '/queue/low-b' },
    ];

    const mock = new MockAdapter(ax);
    mock.onGet(/\/queue\/(.+)/).reply((cfg) => withRandomDelay(() => [200, { job: cfg.url }]));

    setInfoRow('priority', 'cap', 2);

    on('b-priority-cancel-one', () =>
      guard(async () => {
        log('priority', '→ 5 GETs — cancel priority-job-3 @ 250ms', 'highlight');
        const jobs = [1, 2, 3, 4, 5].map((n) => ({
          label: `JOB-${n}`,
          pri: n <= 2 ? P.HIGHEST : P.MEDIUM,
          url: `/queue/cancel-${n}`,
          requestId: `priority-job-${n}`,
        }));
        setTimeout(() => {
          manager.cancelRequest('priority-job-3');
          log('priority', '  cancelRequest("priority-job-3")', 'warn');
        }, 250);
        await Promise.allSettled(
          jobs.map(({ label, pri, url, requestId }) =>
            manager.axiosInstance
              .get(url, { __axiosRetryer: { priority: pri, requestId } })
              .then(() => log('priority', `  ✓ ${label}`, 'success'))
              .catch(() => log('priority', `  ✗ ${label}`, 'warn')),
          ),
        );
        setInfoRow('priority', 'summary', 'cancel-one demo');
        log('priority', '■ done', 'dim');
      }),
    );

    on('b-priority-ten', () =>
      guard(async () => {
        log('priority', '→ 10 GETs at once — 2 concurrent, random latency', 'highlight');
        let order = 0;
        await Promise.allSettled(
          JOBS.map(({ label, pri, url }) =>
            manager.axiosInstance
              .get(url, { __axiosRetryer: { priority: pri } })
              .then(() => {
                const n = ++order;
                const lvl = n <= 2 ? 'critical' : n <= 4 ? 'highlight' : n <= 6 ? 'warn' : 'info';
                log('priority', `  completion #${n}: ${label}`, lvl);
              })
              .catch(() => log('priority', `  ✗ ${label}`, 'error')),
          ),
        );
        setInfoRow('priority', 'summary', '10-job ladder');
        log('priority', '■ done', 'dim');
      }),
    );

    on('b-priority-extra', () =>
      guard(async () => {
        log('priority', '→ GET /queue/extra-test with __axiosRetryer.extra', 'highlight');
        await manager.axiosInstance
          .get('/queue/extra-test', {
            __axiosRetryer: { priority: P.MEDIUM, extra: { sandboxDemo: 'metadata-extra' } },
          })
          .then(() =>
            log('priority', '  ✓ extra metadata accepted (see types AxiosRetryerRequestMetadata.extra)', 'success'),
          )
          .catch((e: unknown) => log('priority', `  ✗ ${e instanceof Error ? e.message : String(e)}`, 'error'));
        setInfoRow('priority', 'summary', 'extra metadata');
        log('priority', '■ done', 'dim');
      }),
    );

    on('b-priority-queue-full', () =>
      guard(async () => {
        const axQ = axios.create({ baseURL: 'http://priority-queuefull' });
        const mockQ = new MockAdapter(axQ);
        mockQ.onGet(/\/slow\/\d+/).reply(() => new Promise((r) => setTimeout(() => r([200, { ok: true }]), 600)));
        const mgrQ = createRetryer({
          axiosInstance: axQ,
          retries: 0,
          maxConcurrentRequests: 1,
          maxQueueSize: 3,
          queueDelay: 0,
        });
        wireAllCoreRetryEvents(mgrQ, 'priority');
        log('priority', '→ 6 parallel slow GETs — waiting heap max 3 → expect ≥1 QueueFullError', 'highlight');
        const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => mgrQ.axiosInstance.get(`/slow/${n}`)));
        let full = 0;
        results.forEach((res, i) => {
          if (res.status === 'rejected' && res.reason instanceof QueueFullError) {
            full++;
            log('priority', `  ✗ /slow/${i + 1}: QueueFullError`, 'error');
          } else if (res.status === 'fulfilled') {
            log('priority', `  ✓ /slow/${i + 1}`, 'success');
          } else {
            log(
              'priority',
              `  ✗ /slow/${i + 1}: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`,
              'warn',
            );
          }
        });
        setInfoRow('priority', 'summary', `queue-full: QueueFullError×${full}`);
        mockQ.restore();
        log('priority', '■ done', 'dim');
      }),
    );

    on('b-priority-cancel-all', () =>
      guard(async () => {
        log('priority', '→ 10 GETs — cancelAllRequests @ 1.5s', 'highlight');
        const promises = JOBS.map(({ label, pri, url }) =>
          manager.axiosInstance
            .get(url, { __axiosRetryer: { priority: pri } })
            .then(() => log('priority', `  ✓ before cancel: ${label}`, 'success'))
            .catch(() => log('priority', `  ✗ ${label}`, 'warn')),
        );
        setTimeout(() => {
          manager.cancelAllRequests();
          log('priority', '  cancelAllRequests()', 'warn');
        }, 1500);
        await Promise.allSettled(promises);
        setInfoRow('priority', 'summary', 'cancel-all demo');
        log('priority', '■ done', 'dim');
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 3 · Blocking Requests
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'blocking',
  group: 'Core',
  title: 'Blocking Requests',
  desc: 'blockingPriorityThreshold ties lower-priority work to “gate” requests (e.g. CRITICAL). Until blocking work succeeds, dependents wait; if the gate fails and cancelPendingOnDependencyFailure is true, pending dependents are cancelled.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-primary" id="b-blocking-gate-ok">Gate OK: CRITICAL (1s) + 10× MEDIUM</button>
      <button class="btn btn-danger" id="b-blocking-gate-fail">Gate fails: CRITICAL → 500 + 10× MEDIUM cancelled</button>
      <button class="btn" id="b-blocking-medium-only">No gate: 10× MEDIUM only (3 slots)</button>
      <button class="btn" id="b-blocking-gate-fail-no-cancel">Isolated run: failing gate + cancelPendingOnDependencyFailure=false (MEDIUM may still run)</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Gate mode</span><span class="info-row-value" id="val-blocking-mode">—</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">createRetryer({ maxConcurrentRequests: 3, blockingPriorityThreshold: CRITICAL, cancelPendingOnDependencyFailure: true })
GET /gate/critical — resolves in 1s (200 or 500)
GET /gate/medium/:id — 200 after random 100–700 ms · all CoreRetryEvents wired
Note: onAllBlockingRequestsResolved fires only after all blocking requests succeed (not on gate failure/cancel)</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://blocking-demo' });
    attachRequestLogger('blocking', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('blocking');

    let gateFails = false;
    mock
      .onGet('/gate/critical')
      .reply(
        () =>
          new Promise((r) =>
            setTimeout(() => r(gateFails ? [500, { error: 'gate failed' }] : [200, { role: 'CRITICAL' }]), 1000),
          ),
      );
    mock
      .onGet(/\/gate\/medium\/\d+/)
      .reply(() => new Promise((r) => setTimeout(() => r([200, { role: 'MEDIUM' }]), getRandomDelayMs())));

    const manager = createRetryer({
      axiosInstance: ax,
      retries: 0,
      maxConcurrentRequests: 3,
      blockingPriorityThreshold: P.CRITICAL,
      cancelPendingOnDependencyFailure: true,
    });
    wireAllCoreRetryEvents(manager, 'blocking');

    const runMediums = (n = 10) =>
      Array.from({ length: n }, (_, i) =>
        manager.axiosInstance
          .get(`/gate/medium/${i + 1}`, {
            __axiosRetryer: { priority: P.MEDIUM, requestId: `blocking-medium-${i + 1}` },
          })
          .then(() => log('blocking', `  ✓ MEDIUM-${i + 1}`, 'success'))
          .catch(() => log('blocking', `  ✗ MEDIUM-${i + 1}`, 'warn')),
      );

    on('b-blocking-gate-ok', () =>
      guard(async () => {
        gateFails = false;
        setInfoRow('blocking', 'mode', 'CRITICAL + MEDIUM');
        log('blocking', '→ CRITICAL gate ~1s + 10 MEDIUM (queued behind gate)', 'highlight');
        await Promise.allSettled([
          manager.axiosInstance
            .get('/gate/critical', { __axiosRetryer: { priority: P.CRITICAL } })
            .then(() => log('blocking', '  ✓ CRITICAL done', 'critical'))
            .catch(() => log('blocking', '  ✗ CRITICAL', 'error')),
          ...runMediums(),
        ]);
        log('blocking', '■ done', 'dim');
      }),
    );

    on('b-blocking-gate-fail', () =>
      guard(async () => {
        gateFails = true;
        setInfoRow('blocking', 'mode', 'failing gate');
        log('blocking', '→ CRITICAL will 500 — MEDIUM dependents cancelled', 'highlight');
        await Promise.allSettled([
          manager.axiosInstance
            .get('/gate/critical', { __axiosRetryer: { priority: P.CRITICAL } })
            .catch(() => log('blocking', '  ✗ CRITICAL (expected)', 'error')),
          ...runMediums(),
        ]);
        log('blocking', '■ done', 'dim');
      }),
    );

    on('b-blocking-medium-only', () =>
      guard(async () => {
        setInfoRow('blocking', 'mode', 'MEDIUM only');
        log('blocking', '→ 10 MEDIUM — no CRITICAL gate', 'highlight');
        await Promise.allSettled(runMediums());
        log('blocking', '■ done', 'success');
      }),
    );

    on('b-blocking-gate-fail-no-cancel', () =>
      guard(async () => {
        const ax2 = axios.create({ baseURL: 'http://blocking-demo-nc' });
        const mock2 = new MockAdapter(ax2);
        mock2
          .onGet('/gate/critical')
          .reply(() => new Promise((r) => setTimeout(() => r([500, { error: 'gate failed' }]), 800)));
        mock2
          .onGet(/\/gate\/medium\/\d+/)
          .reply(() => new Promise((r) => setTimeout(() => r([200, { role: 'MEDIUM' }]), getRandomDelayMs())));
        const mgr2 = createRetryer({
          axiosInstance: ax2,
          retries: 0,
          maxConcurrentRequests: 3,
          blockingPriorityThreshold: P.CRITICAL,
          cancelPendingOnDependencyFailure: false,
        });
        wireAllCoreRetryEvents(mgr2, 'blocking');
        setInfoRow('blocking', 'mode', 'fail gate, no cancel deps');
        log('blocking', '→ Separate manager: CRITICAL 500, cancelPending=false — watch MEDIUM outcomes', 'highlight');
        await Promise.allSettled([
          mgr2.axiosInstance
            .get('/gate/critical', { __axiosRetryer: { priority: P.CRITICAL } })
            .catch(() => log('blocking', '  ✗ CRITICAL (expected)', 'error')),
          ...Array.from({ length: 6 }, (_, i) =>
            mgr2.axiosInstance
              .get(`/gate/medium/${i + 1}`, {
                __axiosRetryer: { priority: P.MEDIUM, requestId: `nc-medium-${i + 1}` },
              })
              .then(() => log('blocking', `  ✓ MEDIUM-${i + 1} (still ran after gate failure)`, 'success'))
              .catch(() => log('blocking', `  ✗ MEDIUM-${i + 1}`, 'warn')),
          ),
        ]);
        mock2.restore();
        log('blocking', '■ done (isolated mock destroyed)', 'dim');
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 4 · Response Caching
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'caching',
  group: 'Plugins',
  title: 'CachingPlugin — Response Caching',
  desc: 'manager.use(new CachingPlugin(…)) caches successful GET responses. Misses hit the mock (slow); repeats are served from memory. __cachingOptions.ttr controls stale revalidation.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-primary" id="b-caching-miss">10 GETs — cold cache (network ×10, mixed dispatch)</button>
      <button class="btn btn-success" id="b-caching-hit">Same 10 URLs — expect hits (no new fetches)</button>
      <button class="btn" id="b-caching-ttr">TTR 3s: fill, wait 4s, refetch all stale</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Tools</div>
      <button class="btn" id="b-caching-stats">Log getCacheStats()</button>
      <button class="btn btn-danger" id="b-caching-clear">clearCache()</button>
      <button class="btn" id="b-caching-invalidate-prefix">Warm cache → invalidateCache({ prefix }) → GET again (miss)</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Entries</span><span class="info-row-value" id="val-caching-size">—</span></div>
      <div class="info-row"><span class="info-row-label">Network fetches (mock counter)</span><span class="info-row-value" id="val-caching-fetches">0</span></div>
      <div class="info-row"><span class="info-row-label">Last run</span><span class="info-row-value" id="val-caching-summary">—</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">new CachingPlugin({ timeToRevalidate: 0 })  // no global TTL
createRetryer&lt;CachingPluginEvents&gt;({ retries: 0 }) + plugin · all CoreRetryEvents + cache plugin events wired
GET /cache/items/:id — increments mock fetch counter, random 100–700 ms</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://caching-demo' });
    attachRequestLogger('caching', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('caching');
    let fetchCount = 0;
    mock.onGet(/\/cache\/items\/\d+/).reply((cfg) =>
      withRandomDelay(() => {
        fetchCount++;
        setInfoRow('caching', 'fetches', fetchCount);
        const id = cfg.url?.split('/').pop();
        return [200, { id, fetchCount, ts: Date.now() }];
      }),
    );

    const cachingPlugin = new CachingPlugin({ timeToRevalidate: 0 });
    const manager = createRetryer<CachingPluginEvents>({ axiosInstance: ax, retries: 0 });
    wireAllCoreRetryEvents(manager, 'caching');
    manager.on('onCacheHit', (p) =>
      log('caching', `  event: onCacheHit ${p.config.url}  ageMs=${Math.round(p.ageMs)}`, 'dim'),
    );
    manager.on('onCacheMiss', (p) => log('caching', `  event: onCacheMiss ${p.config.url}  (${p.reason})`, 'dim'));
    manager.on('onCacheInvalidated', (p) =>
      log('caching', `  event: onCacheInvalidated  count=${p.count}  matcher=${p.matcher}`, 'dim'),
    );
    manager.use(cachingPlugin);

    const URLS = Array.from({ length: 10 }, (_, i) => `/cache/items/${i + 1}`);

    on('b-caching-miss', () =>
      guard(async () => {
        log('caching', '→ Cold run — 10 GETs (expect 10 mock fetches)', 'highlight');
        const t0 = Date.now();
        await runMixedDispatch(
          URLS.map(
            (url) => () =>
              manager.axiosInstance
                .get<{ id: string; fetchCount: number }>(url, {
                  __axiosRetryer: { priority: getRandomNonCriticalPriority() },
                })
                .then((r) => log('caching', `  ✓ ${url}  fetchCount=${r.data.fetchCount}`, 'success')),
          ),
        );
        setInfoRow('caching', 'size', cachingPlugin.getCacheStats().size);
        setInfoRow('caching', 'summary', `${Date.now() - t0} ms · fetches=${fetchCount}`);
        log('caching', `■ done — network fetches=${fetchCount}`, 'success');
      }),
    );

    on('b-caching-hit', () =>
      guard(async () => {
        const before = fetchCount;
        log('caching', '→ Repeat same URLs — expect cache hits only', 'highlight');
        const t0 = Date.now();
        await runMixedDispatch(
          URLS.map(
            (url) => () =>
              manager.axiosInstance
                .get<{ id: string; fetchCount: number }>(url, {
                  __axiosRetryer: { priority: getRandomNonCriticalPriority() },
                })
                .then((r) =>
                  log('caching', `  ✓ ${url}  fetchCount=${r.data.fetchCount} (cached snapshot)`, 'success'),
                ),
          ),
        );
        const delta = fetchCount - before;
        setInfoRow('caching', 'summary', `${Date.now() - t0} ms · new fetches=${delta}`);
        log('caching', `■ done — new mock fetches=${delta}`, delta === 0 ? 'success' : 'warn');
      }),
    );

    on('b-caching-ttr', () =>
      guard(async () => {
        log('caching', '→ TTR=3s fill, sleep 4s, refetch (stale)', 'highlight');
        cachingPlugin.clearCache();
        setInfoRow('caching', 'size', 0);
        const before = fetchCount;
        await runMixedDispatch(
          URLS.map(
            (url) => () =>
              manager.axiosInstance.get(url, {
                __cachingOptions: { ttr: 3000 },
                __axiosRetryer: { priority: getRandomNonCriticalPriority() },
              }),
          ),
        );
        log('caching', `  filled — +${fetchCount - before} fetches. Sleeping 4s…`, 'dim');
        await new Promise((r) => setTimeout(r, 4000));
        const before2 = fetchCount;
        await runMixedDispatch(
          URLS.map(
            (url) => () =>
              manager.axiosInstance.get(url, {
                __cachingOptions: { ttr: 3000 },
                __axiosRetryer: { priority: getRandomNonCriticalPriority() },
              }),
          ),
        );
        setInfoRow('caching', 'size', cachingPlugin.getCacheStats().size);
        setInfoRow('caching', 'summary', `stale refetch +${fetchCount - before2}`);
        log('caching', `■ done — stale pass fetches=${fetchCount - before2}`, 'success');
      }),
    );

    on('b-caching-stats', () => {
      const s = cachingPlugin.getCacheStats();
      log(
        'caching',
        `  getCacheStats: size=${s.size}  oldest≈${Math.round(s.oldestItemAge / 1000)}s  avg≈${Math.round(s.averageAge / 1000)}s`,
        'info',
      );
    });

    on('b-caching-clear', () => {
      cachingPlugin.clearCache();
      setInfoRow('caching', 'size', 0);
      log('caching', '→ clearCache()', 'warn');
    });

    on('b-caching-invalidate-prefix', () =>
      guard(async () => {
        const base = (ax.defaults.baseURL ?? '').replace(/\/$/, '');
        const sampleUrl = `${base}/cache/items/1`;
        const fullKey = cachingPlugin.buildCacheKey({ method: 'get', url: sampleUrl });
        const segs = fullKey.split('|');
        const normUrl = segs[1] ?? '';
        const urlDir = normUrl.replace(/\/[^/]+$/, '/');
        const prefix = `${segs[0]}|${urlDir}`;
        log(
          'caching',
          `→ Warm /cache/items/1, invalidateCache({ prefix: "${prefix.slice(0, 48)}…" }), refetch`,
          'highlight',
        );
        await manager.axiosInstance.get('/cache/items/1', {
          __axiosRetryer: { priority: P.MEDIUM },
        });
        const beforeInv = fetchCount;
        const n = cachingPlugin.invalidateCache({ prefix });
        log('caching', `  invalidateCache removed ${n} entries`, 'warn');
        await manager.axiosInstance.get('/cache/items/1', {
          __axiosRetryer: { priority: P.MEDIUM },
        });
        setInfoRow('caching', 'size', cachingPlugin.getCacheStats().size);
        setInfoRow('caching', 'summary', `fetches +${fetchCount - beforeInv}`);
        log(
          'caching',
          `■ done — expect +1 fetch after invalidation (fetches=${fetchCount})`,
          fetchCount > beforeInv ? 'success' : 'warn',
        );
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 5 · Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'circuit',
  group: 'Plugins',
  title: 'CircuitBreakerPlugin — Circuit Breaker',
  desc: 'Counts failures per scope; after failureThreshold, short-circuits further calls until openTimeout, then HALF_OPEN probe traffic. onCircuitStateChanged + badge mirror production dashboards.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-danger" id="b-circuit-trip">10× GET /cb/api — first 3 hit network, then OPEN fast-fail</button>
      <button class="btn" id="b-circuit-probe">Single probe while OPEN</button>
      <button class="btn btn-success" id="b-circuit-wait-half">Wait 8s (countdown) → expect HALF_OPEN</button>
      <button class="btn btn-success" id="b-circuit-recover">Mark upstream healthy + success probe → CLOSED</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Tools</div>
      <button class="btn" id="b-circuit-metrics">Log getMetrics()</button>
      <button class="btn" id="b-circuit-up-unhealthy">Mock: upstream unhealthy (500)</button>
      <button class="btn" id="b-circuit-up-healthy">Mock: upstream healthy (200)</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div id="circuit-state-badge" class="state-badge state-closed">CLOSED</div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">new CircuitBreakerPlugin({ failureThreshold: 3, openTimeout: 8000, halfOpenMax: 1, scope: 'url' })
createRetryer&lt;CircuitBreakerPluginEvents&gt;({ retries: 0 }) · all CoreRetryEvents + onCircuitStateChanged wired
GET /cb/api — 500 or 200 after random 100–700 ms when unhealthy/healthy</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://circuit-demo' });
    attachRequestLogger('circuit', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('circuit');

    let upstreamHealthy = false;
    mock
      .onGet('/cb/api')
      .reply(() => withRandomDelay(() => (upstreamHealthy ? [200, { ok: true }] : [500, { error: 'upstream down' }])));

    const cb = new CircuitBreakerPlugin({
      failureThreshold: 3,
      openTimeout: 8000,
      halfOpenMax: 1,
      scope: 'url',
    });

    const refreshBadge = () => {
      const s = cb.getState();
      const el = document.getElementById('circuit-state-badge');
      if (!el) return;
      el.textContent = s;
      el.className = `state-badge ${s === CIRCUIT_BREAKER_STATES.CLOSED ? 'state-closed' : s === CIRCUIT_BREAKER_STATES.OPEN ? 'state-open' : 'state-half'}`;
    };

    const manager = createRetryer<CircuitBreakerPluginEvents>({ axiosInstance: ax, retries: 0 });
    wireAllCoreRetryEvents(manager, 'circuit');
    manager.on('onCircuitStateChanged', (p) => {
      log('circuit', `  event: onCircuitStateChanged  ${p.scopeKey}  ${p.from}→${p.to}  (${p.reason})`, 'dim');
      refreshBadge();
    });
    manager.use(cb);

    on('b-circuit-up-unhealthy', () => {
      upstreamHealthy = false;
      log('circuit', '→ mock: /cb/api → 500', 'warn');
    });
    on('b-circuit-up-healthy', () => {
      upstreamHealthy = true;
      log('circuit', '→ mock: /cb/api → 200', 'success');
    });

    on('b-circuit-trip', () =>
      guard(async () => {
        upstreamHealthy = false;
        log('circuit', '→ Trip: 10 failing calls', 'highlight');
        for (let i = 1; i <= 10; i++) {
          try {
            await manager.axiosInstance.get('/cb/api');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const state = cb.getState();
            log('circuit', `  ✗ #${i}: ${state === 'OPEN' ? 'short-circuited (OPEN)' : msg}`, 'error');
            refreshBadge();
          }
        }
        log('circuit', `■ state=${cb.getState()}`, 'dim');
      }),
    );

    on('b-circuit-probe', () =>
      guard(async () => {
        log('circuit', '→ Single probe', 'highlight');
        try {
          await manager.axiosInstance.get('/cb/api');
          log('circuit', '  ✓ unexpected success', 'success');
        } catch (e) {
          log('circuit', `  ✗ ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        refreshBadge();
      }),
    );

    on('b-circuit-wait-half', () =>
      guard(async () => {
        const btn = document.getElementById('b-circuit-wait-half') as HTMLButtonElement | null;
        if (btn) btn.disabled = true;
        log('circuit', '→ Waiting 8s for openTimeout → HALF_OPEN…', 'warn');
        for (let s = 8; s > 0; s--) {
          await new Promise((r) => setTimeout(r, 1000));
          log('circuit', `  ${s - 1}s…`, 'dim');
        }
        refreshBadge();
        log('circuit', `■ now ${cb.getState()}`, cb.getState() === 'HALF_OPEN' ? 'warn' : 'info');
        if (btn) btn.disabled = false;
      }),
    );

    on('b-circuit-recover', () =>
      guard(async () => {
        upstreamHealthy = true;
        log('circuit', '→ Healthy upstream + probe GET', 'highlight');
        try {
          await manager.axiosInstance.get('/cb/api');
          log('circuit', '  ✓ probe OK', 'success');
        } catch (e) {
          log('circuit', `  ✗ ${e instanceof Error ? e.message : e}`, 'error');
        }
        refreshBadge();
        log('circuit', `■ state=${cb.getState()}`, cb.getState() === 'CLOSED' ? 'success' : 'warn');
      }),
    );

    on('b-circuit-metrics', () => {
      const m = cb.getMetrics();
      log(
        'circuit',
        `  getMetrics: state=${m.state}  failures=${m.failureCount}  halfOpen=${m.halfOpenCount}  nextAttemptIn=${m.nextAttemptIn}ms`,
        'info',
      );
      m.scopeMetrics.forEach((sm) =>
        log('circuit', `    scope="${sm.scopeKey}"  state=${sm.state}  failures=${sm.failureCount}`, 'dim'),
      );
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 6 · Metrics
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'metrics',
  group: 'Plugins',
  title: 'MetricsPlugin — Request Metrics',
  desc: 'MetricsPlugin aggregates attempts, retries, terminal failures, and cancellations. onMetricsUpdated drives UI counters; onRequestError logs terminal errors like you would ship to analytics.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-primary" id="b-metrics-workload">20 GETs mixed: 10 ok + 5 flaky (retry) + 5 always-500</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Tools</div>
      <button class="btn" id="b-metrics-detail">Log getMetrics() breakdown</button>
      <button class="btn" id="b-metrics-core-shell">Log manager.getMetrics() (core shell; live fields need MetricsPlugin)</button>
      <button class="btn btn-danger" id="b-metrics-reset">resetMetrics()</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Total requests</span><span class="info-row-value" id="val-metrics-total">0</span></div>
      <div class="info-row"><span class="info-row-label">Successful retries</span><span class="info-row-value" id="val-metrics-retries">0</span></div>
      <div class="info-row"><span class="info-row-label">Failed terminal</span><span class="info-row-value" id="val-metrics-failed">0</span></div>
      <div class="info-row"><span class="info-row-label">Cancelled</span><span class="info-row-value" id="val-metrics-cancelled">0</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">createRetryer&lt;MetricsPluginEvents&gt;({ retries: 2, retryableStatuses: [[500,599]] }) + new MetricsPlugin()
All CoreRetryEvents + onMetricsUpdated wired
GET /metrics/ok/:id — 200 · /metrics/flaky/:id — 500 unless global counter ≡ 0 (mod 3) · /metrics/fail/:id — always 500</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://metrics-demo' });
    attachRequestLogger('metrics', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('metrics');

    let flakyN = 0;
    mock.onGet(/\/metrics\/flaky\/\d+/).reply(() =>
      withRandomDelay(() => {
        flakyN++;
        if (flakyN % 3 !== 0) return [500, { error: 'fail' }];
        return [200, { ok: true }];
      }),
    );
    mock.onGet(/\/metrics\/ok\/\d+/).reply(() => withRandomDelay(() => [200, { ok: true }]));
    mock.onGet(/\/metrics\/fail\/\d+/).reply(() => withRandomDelay(() => [500, { error: 'always fails' }]));

    const metricsPlugin = new MetricsPlugin();
    const manager = createRetryer<MetricsPluginEvents>({
      axiosInstance: ax,
      retries: 2,
      retryableStatuses: [[500, 599] as const],
    });
    wireAllCoreRetryEvents(manager, 'metrics');
    manager.on('onMetricsUpdated', (m) => {
      setInfoRow('metrics', 'total', m.totalRequests);
      setInfoRow('metrics', 'retries', m.successfulRetries);
      setInfoRow('metrics', 'failed', m.completelyFailedRequests);
      setInfoRow('metrics', 'cancelled', m.canceledRequests);
    });
    manager.use(metricsPlugin);

    on('b-metrics-workload', () =>
      guard(async () => {
        log('metrics', '→ 20 GETs mixed dispatch', 'highlight');
        flakyN = 0;
        await runMixedDispatch([
          ...Array.from(
            { length: 10 },
            (_, i) => () =>
              manager.axiosInstance.get(`/metrics/ok/${i + 1}`, {
                __axiosRetryer: { priority: getRandomNonCriticalPriority() },
              }),
          ),
          ...Array.from(
            { length: 5 },
            (_, i) => () =>
              manager.axiosInstance.get(`/metrics/flaky/${i + 1}`, {
                __axiosRetryer: { priority: getRandomNonCriticalPriority() },
              }),
          ),
          ...Array.from(
            { length: 5 },
            (_, i) => () =>
              manager.axiosInstance
                .get(`/metrics/fail/${i + 1}`, { __axiosRetryer: { priority: getRandomNonCriticalPriority() } })
                .catch(() => null),
          ),
        ]);
        log('metrics', '■ done — open “Log getMetrics()” for breakdown', 'success');
      }),
    );

    on('b-metrics-core-shell', () => {
      const m = manager.getMetrics();
      log('metrics', `  manager.getMetrics(): totalRequests=${m.totalRequests} (plugin populates counters)`, 'info');
    });

    on('b-metrics-detail', () => {
      const m = metricsPlugin.getMetrics();
      log('metrics', '── getMetrics() ──', 'highlight');
      log('metrics', `  totalRequests: ${m.totalRequests}`, 'info');
      log('metrics', `  successfulRetries: ${m.successfulRetries}`, 'success');
      log('metrics', `  failedRetries: ${m.failedRetries}`, 'error');
      log('metrics', `  completelyFailed: ${m.completelyFailedRequests}`, 'error');
      log('metrics', `  cancelledRequests: ${m.canceledRequests}`, 'warn');
      log('metrics', `  errorTypes.network: ${m.errorTypesDistribution.network}`, 'info');
      log('metrics', `  errorTypes.server5xx: ${m.errorTypesDistribution.server5xx}`, 'info');
      log('metrics', `  avgQueueWait: ${m.avgQueueWait.toFixed(3)} s`, 'info');
      log('metrics', `  avgRetryDelay: ${m.avgRetryDelay.toFixed(3)} s`, 'info');
      log(
        'metrics',
        `  timerHealth.score: ${m.timerHealth.healthScore}`,
        m.timerHealth.healthScore < 10 ? 'success' : 'warn',
      );
      if (m.priorityMetrics.length) {
        log('metrics', '  by priority:', 'dim');
        m.priorityMetrics.forEach((pm) =>
          log(
            'metrics',
            `    p=${pm.priority}  total=${pm.total}  ok=${pm.successes}  fail=${pm.failures}  ${pm.successRate.toFixed(0)}%`,
            'dim',
          ),
        );
      }
    });

    on('b-metrics-reset', () => {
      metricsPlugin.resetMetrics();
      ['total', 'retries', 'failed', 'cancelled'].forEach((k) => setInfoRow('metrics', k, 0));
      log('metrics', '→ resetMetrics()', 'warn');
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 7 · Manual Retry Plugin
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'manual',
  group: 'Plugins',
  title: 'ManualRetryPlugin — Store & Replay',
  desc: 'RETRY_MODES.MANUAL turns off automatic retries; failures are eligible for ManualRetryPlugin’s store. When the user chooses, retryFailedRequests() replays stored GET configs (here: after “upstream” recovery).',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-primary" id="b-manual-capture">10 GETs while upstream 503 (mixed dispatch)</button>
      <button class="btn btn-success" id="b-manual-replay">Mark upstream OK + retryFailedRequests()</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Tools</div>
      <button class="btn" id="b-manual-list">List getStoredRequests() URLs</button>
      <button class="btn btn-danger" id="b-manual-clear">clearStoredRequests()</button>
      <button class="btn" id="b-manual-up-down">Mock: upstream 503</button>
      <button class="btn" id="b-manual-up-ok">Mock: upstream 200</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Stored count</span><span class="info-row-value" id="val-manual-stored">0</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">createRetryer&lt;ManualRetryPluginEvents&gt;({ mode: MANUAL, retries: 0 }) + new ManualRetryPlugin({ storeNonIdempotent: false, maxRequestsToStore: 2 })
All CoreRetryEvents + onManualRetryProcessStarted + onRequestRemovedFromStore (evictions when store > 2)
GET /manual/docs/:id — 503 or 200</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://manual-demo' });
    attachRequestLogger('manual', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('manual');

    let upstreamDown = true;
    mock
      .onGet(/\/manual\/docs\/\d+/)
      .reply(() =>
        withRandomDelay(() => (upstreamDown ? [503, { error: 'service unavailable' }] : [200, { data: 'restored' }])),
      );

    const manualRetry = new ManualRetryPlugin({ storeNonIdempotent: false, maxRequestsToStore: 2 });
    const manager = createRetryer<ManualRetryPluginEvents>({
      axiosInstance: ax,
      mode: RETRY_MODES.MANUAL,
      retries: 0,
    });
    wireAllCoreRetryEvents(manager, 'manual');
    manager.on('onManualRetryProcessStarted', () => log('manual', '  event: onManualRetryProcessStarted', 'highlight'));
    manager.on('onRequestRemovedFromStore', (cfg) =>
      log('manual', `  event: onRequestRemovedFromStore ${cfg.url}`, 'dim'),
    );
    manager.use(manualRetry);

    const syncStore = () => setInfoRow('manual', 'stored', manualRetry.getStoredRequests().length);

    on('b-manual-up-down', () => {
      upstreamDown = true;
      log('manual', '→ mock: 503', 'warn');
    });
    on('b-manual-up-ok', () => {
      upstreamDown = false;
      log('manual', '→ mock: 200', 'success');
    });

    on('b-manual-capture', () =>
      guard(async () => {
        upstreamDown = true;
        log('manual', '→ Capture: 10 failing GETs', 'highlight');
        await runMixedDispatch(
          Array.from(
            { length: 10 },
            (_, i) => () =>
              manager.axiosInstance
                .get(`/manual/docs/${i + 1}`, { __axiosRetryer: { priority: getRandomNonCriticalPriority() } })
                .catch(() => log('manual', `  ✗ /manual/docs/${i + 1}`, 'error')),
          ),
        );
        syncStore();
        log('manual', `■ stored=${manualRetry.getStoredRequests().length}`, 'info');
      }),
    );

    on('b-manual-list', () => {
      const reqs = manualRetry.getStoredRequests();
      log('manual', `→ ${reqs.length} stored`, 'info');
      reqs.forEach((cfg) => log('manual', `    • ${cfg.url}`, 'dim'));
      syncStore();
    });

    on('b-manual-replay', () =>
      guard(async () => {
        upstreamDown = false;
        log('manual', '→ retryFailedRequests()', 'highlight');
        try {
          const results = await manualRetry.retryFailedRequests<{ data: string }>();
          results.forEach((r) => log('manual', `  ✓ ${r.config.url} → ${JSON.stringify(r.data)}`, 'success'));
          if (results.length === 0) log('manual', '  (store empty)', 'warn');
        } catch (e) {
          log('manual', `  ✗ ${e instanceof Error ? e.message : e}`, 'error');
        }
        syncStore();
      }),
    );

    on('b-manual-clear', () => {
      manualRetry.clearStoredRequests();
      syncStore();
      log('manual', '→ clearStoredRequests()', 'warn');
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 8 · Token Refresh Plugin
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'token',
  group: 'Plugins',
  title: 'TokenRefreshPlugin — Token Refresh',
  desc: 'One axios instance + createTokenRefreshPlugin: the API only accepts the access token the mock “server” last issued via POST /oauth/token. A stale client header yields 401 once; the plugin refreshes, updates defaults, and retries. Parallel calls share a single refresh; concurrency limits show queue + in-plugin waiters.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn" id="b-token-reset">Reset demo (stale client token, counters, plugin)</button>
      <button class="btn btn-primary" id="b-token-sequential">8 GETs sequential (one refresh, then reuse)</button>
      <button class="btn btn-primary" id="b-token-parallel">8 GETs parallel (single refresh, concurrent 401s)</button>
      <button class="btn" id="b-token-mixed">12 GETs mixed dispatch (3 + stream + bursts)</button>
      <button class="btn btn-danger" id="b-token-parallel-broken">8 parallel + refresh endpoint errors</button>
      <button class="btn" id="b-token-cancel-mid">8 parallel, cancelAllRequests ~350ms in</button>
      <button class="btn" id="b-token-skip-refresh">No-token refresh (handler returns {}) — no onTokenRefreshed; 401 surfaces</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Session controls</div>
      <button class="btn" id="b-token-stale">Mark client token stale (no server rotation)</button>
      <button class="btn btn-danger" id="b-token-refresh-down">Refresh endpoint → 503</button>
      <button class="btn btn-success" id="b-token-refresh-up">Refresh endpoint healthy + new plugin</button>
      <button class="btn" id="b-token-cancel-now">cancelAllRequests()</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Client Bearer</span><span class="info-row-value" id="val-token-client">—</span></div>
      <div class="info-row"><span class="info-row-label">Server accepts</span><span class="info-row-value" id="val-token-server">—</span></div>
      <div class="info-row"><span class="info-row-label">POST /oauth/token calls</span><span class="info-row-value" id="val-token-refreshes">0</span></div>
      <div class="info-row"><span class="info-row-label">Last run</span><span class="info-row-value" id="val-token-summary">—</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup (matches typical app wiring)</div>
      <div class="config-box">createRetryer({ axiosInstance, retries: 0, maxConcurrentRequests: 4 }) — all CoreRetryEvents wired
createTokenRefreshPlugin(…) + onBeforeTokenRefresh / onTokenRefreshed / onTokenRefreshFailed
“No-token refresh” uses a temporary plugin whose callback resolves with no token (skip cycle per docs).
axios.defaults.headers.common['Authorization'] = 'Bearer …' · Mock GET /v1/items/:id vs server token; random 100–700 ms latency</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://token-demo' });
    attachRequestLogger('token', ax);
    const mock = new MockAdapter(ax);

    const CLIENT_STALE = 'STALE_CLIENT';
    let serverAcceptedToken: string | null = null;
    let refreshCallCount = 0;
    let refreshEndpointBroken = false;

    const authFrom = (cfg: { headers?: unknown }): string | null => {
      const h = cfg.headers as Record<string, string> | undefined;
      if (!h) return null;
      const v = h['Authorization'] ?? h['authorization'];
      return typeof v === 'string' ? v : null;
    };

    const syncInfoRows = () => {
      const client = ax.defaults.headers.common['Authorization'];
      setInfoRow('token', 'client', typeof client === 'string' ? client.replace(/^Bearer\s+/, '') : '—');
      setInfoRow('token', 'server', serverAcceptedToken ?? '—');
      setInfoRow('token', 'refreshes', refreshCallCount);
    };

    mock.onPost('/oauth/token').reply(() =>
      withRandomDelay(() => {
        if (refreshEndpointBroken) {
          return [503, { error: 'refresh unavailable' }];
        }
        refreshCallCount++;
        const next = `srv-${refreshCallCount}`;
        serverAcceptedToken = next;
        syncInfoRows();
        return [200, { access_token: next }];
      }),
    );

    mock.onGet(/\/v1\/items\/\d+/).reply((cfg) =>
      withRandomDelay(() => {
        const auth = authFrom(cfg);
        const need = serverAcceptedToken ? `Bearer ${serverAcceptedToken}` : null;
        if (!need || auth !== need) {
          return [401, { error: 'invalid_token' }];
        }
        const id = cfg.url?.split('/').pop();
        return [200, { item: id, ok: true }];
      }),
    );

    const makePlugin = () =>
      createTokenRefreshPlugin(
        async (http: AxiosInstance) => {
          const { data } = await http.post<{ access_token: string }>('/oauth/token');
          return { token: data.access_token };
        },
        {
          refreshStatusCodes: [401],
          authHeaderName: 'Authorization',
          tokenPrefix: 'Bearer ',
          maxRefreshAttempts: 2,
        },
      );

    const manager = createRetryer<TokenRefreshPluginEvents>({
      axiosInstance: ax,
      retries: 0,
      maxConcurrentRequests: 4,
    });
    wireAllCoreRetryEvents(manager, 'token');

    const wireEvents = () => {
      manager.on('onBeforeTokenRefresh', () => log('token', '  event: onBeforeTokenRefresh', 'warn'));
      manager.on('onTokenRefreshed', (tok: string) => {
        log('token', `  event: onTokenRefreshed → defaults updated (${tok})`, 'success');
        syncInfoRows();
      });
      manager.on('onTokenRefreshFailed', () => log('token', '  event: onTokenRefreshFailed', 'error'));
    };

    const reinstallPlugin = () => {
      manager.unuse('TokenRefreshPlugin');
      manager.use(makePlugin());
    };

    const resetDemo = () => {
      serverAcceptedToken = null;
      refreshCallCount = 0;
      refreshEndpointBroken = false;
      ax.defaults.headers.common['Authorization'] = `Bearer ${CLIENT_STALE}`;
      reinstallPlugin();
      syncInfoRows();
      setInfoRow('token', 'summary', '—');
      log('token', '→ Reset: client token is stale; server accepts nothing until a successful refresh.', 'highlight');
    };

    wireEvents();
    resetDemo();

    const guard = createBusyGuard('token');

    on('b-token-reset', () => {
      resetDemo();
    });

    on('b-token-sequential', () =>
      guard(async () => {
        log('token', '→ Sequential: 8× GET /v1/items/:id', 'highlight');
        let ok = 0;
        let fail = 0;
        for (let i = 1; i <= 8; i++) {
          try {
            const r = await manager.axiosInstance.get<{ item: string }>(`/v1/items/${i}`);
            ok++;
            log('token', `  ✓ #${i} item=${r.data.item}`, 'success');
          } catch (e) {
            fail++;
            log('token', `  ✗ #${i} ${e instanceof Error ? e.message : String(e)}`, 'error');
          }
        }
        setInfoRow('token', 'summary', `${ok} ok / ${fail} fail · refresh POSTs=${refreshCallCount}`);
        log('token', `■ done`, ok === 8 ? 'success' : 'warn');
      }),
    );

    on('b-token-parallel', () =>
      guard(async () => {
        log('token', '→ Parallel: 8× GET at once (maxConcurrentRequests=4)', 'highlight');
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            manager.axiosInstance.get(`/v1/items/${i + 1}`, {
              __axiosRetryer: { priority: getRandomNonCriticalPriority() },
            }),
          ),
        );
        let ok = 0;
        let fail = 0;
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            ok++;
            log('token', `  ✓ /items/${i + 1}`, 'success');
          } else {
            fail++;
            const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
            log('token', `  ✗ /items/${i + 1}: ${msg}`, 'error');
          }
        });
        setInfoRow('token', 'summary', `${ok} ok / ${fail} fail · refresh POSTs=${refreshCallCount}`);
        log('token', `■ done`, ok === 8 ? 'success' : 'warn');
      }),
    );

    on('b-token-mixed', () =>
      guard(async () => {
        log('token', '→ Mixed dispatch: 12 requests (pattern: 3 parallel, 4 sequential, rest by 3)', 'highlight');
        const factories = Array.from(
          { length: 12 },
          (_, i) => () =>
            manager.axiosInstance
              .get(`/v1/items/${i + 1}`, { __axiosRetryer: { priority: getRandomNonCriticalPriority() } })
              .then(() => {
                log('token', `  ✓ /items/${i + 1}`, 'success');
              })
              .catch((e: unknown) => {
                log('token', `  ✗ /items/${i + 1}: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }),
        );
        const settled = await runMixedDispatch(factories);
        const ok = settled.filter((s) => s.status === 'fulfilled').length;
        const fail = settled.length - ok;
        setInfoRow('token', 'summary', `${ok} ok / ${fail} fail · refresh POSTs=${refreshCallCount}`);
        log('token', `■ done`, fail === 0 ? 'success' : 'warn');
      }),
    );

    on('b-token-parallel-broken', () =>
      guard(async () => {
        serverAcceptedToken = null;
        refreshCallCount = 0;
        refreshEndpointBroken = true;
        ax.defaults.headers.common['Authorization'] = `Bearer ${CLIENT_STALE}`;
        reinstallPlugin();
        syncInfoRows();
        log('token', '→ Parallel with refresh returning 503 (expect Token refresh failed)', 'highlight');
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            manager.axiosInstance.get(`/v1/items/${i + 1}`, {
              __axiosRetryer: { priority: getRandomNonCriticalPriority() },
            }),
          ),
        );
        let fail = 0;
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            log('token', `  ✓ /items/${i + 1}`, 'success');
          } else {
            fail++;
            log(
              'token',
              `  ✗ /items/${i + 1}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              'error',
            );
          }
        });
        setInfoRow('token', 'summary', `${results.length - fail} ok / ${fail} fail`);
        log('token', '■ done — turn refresh back on and reset if you want a clean run', 'warn');
      }),
    );

    on('b-token-cancel-mid', () =>
      guard(async () => {
        serverAcceptedToken = null;
        refreshCallCount = 0;
        refreshEndpointBroken = false;
        ax.defaults.headers.common['Authorization'] = `Bearer ${CLIENT_STALE}`;
        reinstallPlugin();
        syncInfoRows();
        log('token', '→ 8 parallel + cancelAllRequests ~350ms (queued work may still complete)', 'highlight');
        const timer = setTimeout(() => {
          log('token', '  calling cancelAllRequests()', 'warn');
          manager.cancelAllRequests();
        }, 350);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            manager.axiosInstance.get(`/v1/items/${i + 1}`, {
              __axiosRetryer: { priority: getRandomNonCriticalPriority() },
            }),
          ),
        );
        clearTimeout(timer);
        let ok = 0;
        let fail = 0;
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            ok++;
            log('token', `  ✓ /items/${i + 1}`, 'success');
          } else {
            fail++;
            log(
              'token',
              `  ✗ /items/${i + 1}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              'warn',
            );
          }
        });
        setInfoRow('token', 'summary', `${ok} ok / ${fail} fail`);
        log('token', '■ done', 'dim');
      }),
    );

    on('b-token-stale', () => {
      ax.defaults.headers.common['Authorization'] = `Bearer ${CLIENT_STALE}`;
      syncInfoRows();
      log('token', '→ Client header set to stale token (next GETs should 401 → refresh if possible)', 'warn');
    });

    on('b-token-refresh-down', () => {
      refreshEndpointBroken = true;
      log('token', '→ Refresh endpoint will return 503', 'error');
    });

    on('b-token-refresh-up', () => {
      refreshEndpointBroken = false;
      reinstallPlugin();
      syncInfoRows();
      log('token', '→ Refresh endpoint healthy; plugin re-installed (clears refresh failure latch)', 'success');
    });

    on('b-token-cancel-now', () => {
      manager.cancelAllRequests();
      log('token', '→ cancelAllRequests()', 'warn');
    });

    on('b-token-skip-refresh', () =>
      guard(async () => {
        log(
          'token',
          '→ Skip refresh: handler returns {} — expect onBeforeTokenRefresh in log, no onTokenRefreshed / onTokenRefreshFailed',
          'highlight',
        );
        manager.unuse('TokenRefreshPlugin');
        manager.use(
          createTokenRefreshPlugin(async () => ({}), {
            refreshStatusCodes: [401],
            authHeaderName: 'Authorization',
            tokenPrefix: 'Bearer ',
            maxRefreshAttempts: 1,
          }),
        );
        try {
          await manager.axiosInstance.get('/v1/items/skip-1').catch((e: unknown) => {
            log('token', `  request rejected (expected): ${e instanceof Error ? e.message : String(e)}`, 'warn');
          });
        } finally {
          manager.unuse('TokenRefreshPlugin');
          reinstallPlugin();
          syncInfoRows();
        }
        log('token', '■ done — plugin restored to normal refresh', 'dim');
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO 9 · Debug sanitization
// ─────────────────────────────────────────────────────────────────────────────

section({
  id: 'sanitize',
  group: 'Plugins',
  title: 'DebugSanitizationPlugin — Redacted debug logs',
  desc: 'Opt-in debug: createRetryer({ debug: true, logger }) plus DebugSanitizationPlugin. The plugin emits sanitized request/error snapshots through the manager logger — compare with the raw ↗ sent line (interceptor) to see redaction.',
  controls: `
    <div class="control-group">
      <div class="control-group-label">Scenarios</div>
      <button class="btn btn-primary" id="b-sanitize-fire">GET /debug/secure — 401 body contains “password”</button>
    </div>
    <div class="control-group">
      <div class="control-group-label">Live state</div>
      <div class="info-row"><span class="info-row-label">Last fired</span><span class="info-row-value" id="val-sanitize-summary">—</span></div>
    </div>
    <div class="control-group">
      <div class="control-group-label">Setup</div>
      <div class="config-box">createRetryer({ retries: 0, debug: true, logger: makeUiLogger('sanitize') }) — all CoreRetryEvents wired
manager.use(new DebugSanitizationPlugin()) · Request carries Authorization + X-API-Key (redacted via logger.debug)</div>
    </div>`,
  setup() {
    const ax = axios.create({ baseURL: 'http://sanitize-demo' });
    attachRequestLogger('sanitize', ax);
    const mock = new MockAdapter(ax);
    const guard = createBusyGuard('sanitize');

    mock
      .onGet('/debug/secure')
      .reply(() => withRandomDelay(() => [401, { error: 'Unauthorized', password: 'should-not-leak' }]));

    const manager = createRetryer({
      axiosInstance: ax,
      retries: 0,
      debug: true,
      logger: makeUiLogger('sanitize'),
    });
    wireAllCoreRetryEvents(manager, 'sanitize');
    manager.use(new DebugSanitizationPlugin());

    on('b-sanitize-fire', () =>
      guard(async () => {
        log('sanitize', '→ GET /debug/secure (expect redacted debug lines + terminal 401)', 'highlight');
        await manager.axiosInstance
          .get('/debug/secure', {
            headers: {
              Authorization: 'Bearer real-user-token',
              'X-API-Key': 'sk_live_abcd1234',
            },
            __axiosRetryer: { requestId: 'sanitize-req-1' },
          })
          .catch(() => log('sanitize', '  ■ terminal error (expected) — inspect logger output above', 'dim'));
        setInfoRow('sanitize', 'summary', new Date().toLocaleTimeString('en', { hour12: false }));
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// App initialisation — render sections and wire tab nav
// ─────────────────────────────────────────────────────────────────────────────

function buildSection(def: SectionDef): HTMLElement {
  const el = document.createElement('div');
  el.className = 'section';
  el.id = `section-${def.id}`;
  el.innerHTML = `
    <div class="section-header">
      <div class="section-title">${def.title}</div>
      <div class="section-desc">${def.desc}</div>
    </div>
    <div class="section-body">
      <div class="controls">${def.controls}</div>
      <div class="log-pane">
        <div class="log-toolbar">
          <span class="log-toolbar-label">Output log</span>
          <div class="log-legend" aria-hidden="true">
            <span class="log-legend-item" data-ch="action">scenario</span>
            <span class="log-legend-item" data-ch="event-core">core events</span>
            <span class="log-legend-item" data-ch="event-plugin">plugin events</span>
            <span class="log-legend-item" data-ch="http">HTTP</span>
            <span class="log-legend-item" data-ch="result">result</span>
            <span class="log-legend-item" data-ch="tool">tools</span>
            <span class="log-legend-item" data-ch="library">debug logger</span>
            <span class="log-legend-item" data-ch="misc">other</span>
          </div>
          <button type="button" class="log-clear-btn log-clear-btn--toolbar" data-section="${def.id}" title="Clear output log">Clear log</button>
        </div>
        <div class="log-area" id="log-${def.id}">
          <div class="log-empty">— run an action to see output —</div>
        </div>
      </div>
    </div>`;
  return el;
}

function init() {
  const sidebar = document.getElementById('sidebar')!;
  const content = document.getElementById('content')!;

  const groups: Record<string, HTMLElement> = {};

  for (const def of SECTIONS) {
    // Sidebar
    if (!groups[def.group]) {
      const g = document.createElement('div');
      g.className = 'sidebar-group';
      g.innerHTML = `<div class="sidebar-group-label">${def.group}</div>`;
      sidebar.appendChild(g);
      groups[def.group] = g;
    }
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.dataset.section = def.id;
    item.textContent = def.title.split(' — ')[0];
    groups[def.group].appendChild(item);

    // Section
    const sectionEl = buildSection(def);
    content.appendChild(sectionEl);

    // Mount demo logic
    def.setup();
  }

  // Tab navigation
  function activate(id: string) {
    document.querySelectorAll<HTMLElement>('.sidebar-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.section === id);
    });
    document.querySelectorAll<HTMLElement>('.section').forEach((el) => {
      el.classList.toggle('active', el.id === `section-${id}`);
    });
  }

  sidebar.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-section]');
    if (item?.dataset.section) activate(item.dataset.section);
  });

  // Wire clear-log buttons (delegated to document since section is built before event wired)
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.log-clear-btn');
    if (btn?.dataset.section) clearLog(btn.dataset.section);
  });

  // Activate first section
  activate(SECTIONS[0].id);
}

init();
