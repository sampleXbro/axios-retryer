/**
 * Regression tests for critical and high severity bugs identified in the
 * senior architect review of axios-retryer.
 *
 * Each test is named after the issue it covers and is expected to FAIL before
 * the corresponding fix is applied.
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import type { AxiosRequestConfig } from 'axios';

import { RetryManager } from '../src';
import { QueueFullError } from '../src/core/errors';
import { RequestLifecycleManager } from '../src/core/RequestLifecycleManager';
import { RetryScheduler } from '../src/core/RetryScheduler';
import { RequestQueue } from '../src/core/requestQueue';
import { CircuitBreakerScopeManager } from '../src/plugins/CircuitBreakerPlugin/managers/CircuitBreakerScopeManager';
import {
  CIRCUIT_BREAKER_STATES,
  type CircuitBreakerScopeState,
  type CircuitBreakerStateAdapter,
} from '../src/plugins/CircuitBreakerPlugin/types';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';
import type { Logger, RetryStrategy } from '../src/types';
import { assignRequestMetadata, getRequestMetadata } from '../src/utils/requestMetadata';

// ─── CRITICAL #1 ─────────────────────────────────────────────────────────────
// QueueFullError code mismatch: 'EQUEUE_FULL' not in NON_RETRYABLE_INTERNAL_CODES
// Expected: queue-full rejection is NOT retried (fails immediately)
// Actual:   strategy.shouldRetry returns true (network-error path), burns all retries
// ─────────────────────────────────────────────────────────────────────────────

describe('CRITICAL #1 — QueueFullError must not trigger retries', () => {
  it('request rejected with QueueFullError is never retried', async () => {
    const instance = axios.create();
    const mock = new MockAdapter(instance);

    // Hang the first request to hold the single concurrent slot indefinitely.
    let releaseHold: () => void = () => {};
    mock.onGet('/hold').reply(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          releaseHold = () => resolve([200, {}]);
        }),
    );
    mock.onGet('/queued').reply(200);
    mock.onGet('/overflow').reply(200);

    const manager = new RetryManager({
      axiosInstance: instance,
      maxConcurrentRequests: 1,
      maxQueueSize: 1, // Only 1 request may wait
      retries: 3,
      queueDelay: 0,
      throwErrorOnFailedRetries: true,
    });

    let beforeRetryCount = 0;
    manager.on('beforeRetry', () => {
      beforeRetryCount++;
    });

    // Hold the single slot.
    const holdPromise = instance.get('/hold');
    await new Promise<void>((r) => setTimeout(r, 20));

    // Fill the queue to capacity (1 item).
    const queuedPromise = instance.get('/queued').catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 10));

    // This enqueue exceeds the queue size → QueueFullError.
    let caught: unknown;
    try {
      await instance.get('/overflow');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(QueueFullError);
    // Must fail immediately — zero retry attempts.
    expect(beforeRetryCount).toBe(0);

    releaseHold();
    await Promise.allSettled([holdPromise, queuedPromise]);
    manager.destroy();
    mock.restore();
  });
});

// ─── CRITICAL #2 ─────────────────────────────────────────────────────────────
// `extra` field silently dropped: missing from ALLOWED_METADATA_KEYS
// Expected: assignRequestMetadata(config, { extra: data }) preserves `extra`
// Actual:   isSafeMetadataKey('extra') returns false → value silently discarded
// ─────────────────────────────────────────────────────────────────────────────

describe('CRITICAL #2 — extra metadata field must be preserved', () => {
  it('assignRequestMetadata preserves the extra field', () => {
    const config = { url: '/test' };
    const payload = { id: 42, tag: 'trace' };

    assignRequestMetadata(config, { extra: payload });

    expect(getRequestMetadata(config)?.extra).toEqual(payload);
  });

  it('extra field is visible when set via per-request __axiosRetryer config', () => {
    const config = {
      url: '/test',
      __axiosRetryer: { extra: { source: 'unit-test' } },
    };
    // ensureRequestMetadata re-wraps user-provided plain objects through ALLOWED_METADATA_KEYS
    assignRequestMetadata(config, { requestId: 'r1' }); // trigger re-wrap
    expect(getRequestMetadata(config)?.extra).toEqual({ source: 'unit-test' });
  });
});

// ─── CRITICAL #3 ─────────────────────────────────────────────────────────────
// MetricsPlugin listener leak: anonymous listeners not unregistered on unuse()
// Expected: after manager.unuse('MetricsPlugin'), plugin state does not update
// Actual:   all 8+ anonymous listeners remain on the EventBus and keep firing
// ─────────────────────────────────────────────────────────────────────────────

describe('CRITICAL #3 — MetricsPlugin must remove all listeners on unuse', () => {
  it('metrics do not accumulate after the plugin is unused', async () => {
    const instance = axios.create();
    const mock = new MockAdapter(instance);
    mock.onGet('/test').reply(200);

    const manager = new RetryManager({ axiosInstance: instance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);

    // One request while the plugin is active.
    await instance.get('/test');
    expect(plugin.getMetrics().totalRequests).toBe(1);

    // Remove the plugin.
    manager.unuse('MetricsPlugin');

    // A second request — the plugin's listeners must not fire.
    await instance.get('/test');

    // totalRequests must still be 1 (the count from before unuse).
    expect(plugin.getMetrics().totalRequests).toBe(1);

    manager.destroy();
    mock.restore();
  });

  it('onMetricsUpdated is not emitted after the plugin is unused', async () => {
    const instance = axios.create();
    const mock = new MockAdapter(instance);
    mock.onGet('/test').reply(200);

    const manager = new RetryManager({ axiosInstance: instance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);
    manager.unuse('MetricsPlugin');

    let onMetricsUpdatedCalls = 0;
    manager.on('onMetricsUpdated' as never, () => {
      onMetricsUpdatedCalls++;
    });

    await instance.get('/test');

    expect(onMetricsUpdatedCalls).toBe(0);

    manager.destroy();
    mock.restore();
  });
});

// ─── HIGH #6 ──────────────────────────────────────────────────────────────────
// releaseAbortSignalLink called unconditionally in cancelAllRequests
// Expected: requests preserved via preservedQueuedRequestIds keep their
//           caller-AbortSignal forwarding intact.
// Actual:   the link was severed for preserved requests, so caller .abort()
//           no longer aborted the internal controller.
// ─────────────────────────────────────────────────────────────────────────────

describe('HIGH #6 — preserved queued requests must keep their caller AbortSignal link', () => {
  function buildLogger(): Logger {
    return { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  }

  function buildStrategy(): RetryStrategy {
    return {
      getIsRetryable: () => false,
      shouldRetry: () => false,
      getDelay: () => 0,
    };
  }

  it('caller AbortController still aborts preserved request controller after cancelAllRequests({ includeQueued: false })', () => {
    const logger = buildLogger();
    const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, logger });
    const scheduler = new RetryScheduler(logger, buildStrategy());
    const lifecycle = new RequestLifecycleManager({
      logger,
      requestQueue: queue,
      retryScheduler: scheduler,
      onRequestCancelled: () => {},
    });

    const callerController = new AbortController();
    const config: AxiosRequestConfig = { url: '/preserved', signal: callerController.signal };

    const begun = lifecycle.beginRequest(config);
    // Simulate a queued request we want to preserve through destroy().
    void queue.enqueue(config).catch(() => {});

    // Sanity check: link is alive before the operation.
    expect(begun.controller.signal.aborted).toBe(false);

    lifecycle.cancelAllRequests({
      includeQueued: false,
      preservedQueuedRequestIds: new Set([begun.requestId]),
    });

    // Preserved request was not aborted by the cancelAll call itself.
    expect(begun.controller.signal.aborted).toBe(false);

    // The caller's AbortController must still propagate to the internal controller.
    callerController.abort(new DOMException('cancelled by caller', 'AbortError'));
    expect(begun.controller.signal.aborted).toBe(true);

    queue.destroy();
    scheduler.destroy();
  });

  it('caller AbortController has NO effect on requests that were aborted by cancelAllRequests', () => {
    const logger = buildLogger();
    const queue = new RequestQueue({ maxConcurrent: 1, queueDelay: 0, logger });
    const scheduler = new RetryScheduler(logger, buildStrategy());
    const lifecycle = new RequestLifecycleManager({
      logger,
      requestQueue: queue,
      retryScheduler: scheduler,
      onRequestCancelled: () => {},
    });

    const callerController = new AbortController();
    const config: AxiosRequestConfig = { url: '/aborted', signal: callerController.signal };
    const begun = lifecycle.beginRequest(config);

    // Cancel everything (no preservation).
    lifecycle.cancelAllRequests();

    // Aborted directly by cancelAllRequests.
    expect(begun.controller.signal.aborted).toBe(true);

    // Caller signal can still fire — must be a no-op (link was correctly released).
    expect(() => callerController.abort()).not.toThrow();

    queue.destroy();
    scheduler.destroy();
  });
});

// ─── HIGH #4 ──────────────────────────────────────────────────────────────────
// onRetryScheduled fires AFTER the delay instead of before it
// Expected: onRetryScheduled fires immediately when the retry is scheduled
// Actual:   event fires only after waitForRetryDelay resolves (delay elapsed)
// ─────────────────────────────────────────────────────────────────────────────

describe('HIGH #4 — onRetryScheduled must fire before the retry delay elapses', () => {
  it('onRetryScheduled timestamp is before the retry delay has elapsed', async () => {
    const DELAY_MS = 400;
    const instance = axios.create();
    const mock = new MockAdapter(instance);
    mock.onGet('/test').replyOnce(503).onGet('/test').reply(200);

    const manager = new RetryManager({
      axiosInstance: instance,
      retries: 1,
      retryStrategy: {
        getIsRetryable: () => true,
        shouldRetry: (_err, attempt, max) => attempt <= max,
        getDelay: () => DELAY_MS,
      },
      queueDelay: 0,
    });

    const start = Date.now();
    let scheduledAt: number | null = null;

    manager.on('onRetryScheduled', () => {
      scheduledAt = Date.now();
    });

    await instance.get('/test');

    expect(scheduledAt).not.toBeNull();
    // With the fix the event fires before the delay runs, so elapsed < DELAY_MS.
    // With the bug the event fires after the delay, so elapsed ≥ DELAY_MS.
    // We use DELAY_MS * 0.5 as the threshold with ample margin.
    const elapsed = scheduledAt! - start;
    expect(elapsed).toBeLessThan(DELAY_MS * 0.5);

    manager.destroy();
    mock.restore();
  });
});

// ─── CRITICAL #9 (round 2) ────────────────────────────────────────────────────
// CircuitBreaker writeState/readState divergence on adapter set failure.
// When stateAdapter.set rejects but adapter.get succeeds, the local cache holds
// the new state (e.g. OPEN) while the adapter still holds the previous state
// (CLOSED). The next readState pulls the stale CLOSED from the adapter and
// overwrites the local cache — the circuit silently fails to trip in
// distributed deployments with flaky adapters.
// ─────────────────────────────────────────────────────────────────────────────

describe('CRITICAL (round 2) — CircuitBreaker scope state must not silently diverge from adapter on write failure', () => {
  function buildLogger(): Logger {
    return { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  }

  /**
   * Adapter where `get` always returns the last successfully-set value, but
   * `set` can be programmatically forced to reject. Models a Redis adapter
   * encountering a transient write outage while reads still succeed from a
   * replica.
   */
  function createAsymmetricAdapter(): CircuitBreakerStateAdapter & {
    forceSetFailure: (shouldFail: boolean) => void;
  } {
    const store = new Map<string, CircuitBreakerScopeState>();
    let setFails = false;
    return {
      forceSetFailure: (shouldFail: boolean) => {
        setFails = shouldFail;
      },
      get: (key) => store.get(key),
      set: async (key, state) => {
        if (setFails) {
          throw new Error('adapter set failed');
        }
        store.set(key, state);
      },
      delete: (key) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
  }

  it('after a failed adapter set, the local cache must not diverge from the adapter', async () => {
    const adapter = createAsymmetricAdapter();
    const scopeManager = new CircuitBreakerScopeManager({
      scope: 'host',
      stateAdapter: adapter,
      maxTrackedScopes: 100,
    });
    scopeManager.setLogger(buildLogger());

    const SCOPE = 'svc-a';

    // Seed adapter + cache with a known CLOSED state.
    await scopeManager.writeState(SCOPE, {
      ...scopeManager.createInitialState(),
      state: CIRCUIT_BREAKER_STATES.CLOSED,
    });

    // Lose adapter write capability.
    adapter.forceSetFailure(true);

    // Failure detected → plugin writes OPEN. The adapter rejects.
    await scopeManager.writeState(SCOPE, {
      ...scopeManager.createInitialState(),
      state: CIRCUIT_BREAKER_STATES.OPEN,
      failureCount: 5,
    });

    // The bug: the local cache eagerly stored OPEN before the adapter call,
    // and the failed adapter call did not roll it back. Cache says OPEN,
    // adapter still says CLOSED — divergence.
    //
    // Many CircuitBreakerPlugin code paths (e.g. getCircuitState, metrics
    // collection) read directly from `scopeStateCache` without going through
    // readState, so they see the ghost OPEN state until something else
    // overwrites the cache.
    const cachedStateRaw = scopeManager.scopeStateCache.get(SCOPE);
    const adapterState = await adapter.get(SCOPE);

    expect(cachedStateRaw?.state).toBe(adapterState?.state);
  });
});
