/**
 * Targeted unit coverage for FailureWindow — the sliding-window failure-count
 * helper extracted from CircuitBreakerPlugin. Verifies that:
 *   - non-sliding-window mode is a pure no-op for cleanup,
 *   - sliding-window cleanup evicts old entries and decrements `failureCount`,
 *   - count/countSince honor the window boundary.
 */
import type { AxiosError } from 'axios';

import { FailureWindow } from '../src/plugins/CircuitBreakerPlugin/managers/FailureWindow';
import type { CircuitBreakerScopeState } from '../src/plugins/CircuitBreakerPlugin/types';
import { CIRCUIT_BREAKER_STATES } from '../src/plugins/CircuitBreakerPlugin/types';

function freshState(): CircuitBreakerScopeState {
  return {
    state: CIRCUIT_BREAKER_STATES.CLOSED,
    failureCount: 0,
    successCount: 0,
    halfOpenCount: 0,
    nextAttempt: 0,
    recentFailures: [],
  };
}

function makeError(status?: number, code?: string, url?: string): AxiosError {
  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: 'boom',
    config: url ? ({ url } as AxiosError['config']) : undefined,
    response: status ? ({ status } as AxiosError['response']) : undefined,
    code,
    toJSON: () => ({}),
  } as AxiosError;
}

describe('FailureWindow', () => {
  describe('rememberLast', () => {
    it('records status and code for the most recent failure', () => {
      const w = new FailureWindow({ useSlidingWindow: false, slidingWindowSize: 0 });
      const state = freshState();
      w.rememberLast(state, makeError(503, 'ECONNRESET'));
      expect(state.lastFailureStatus).toBe(503);
      expect(state.lastFailureCode).toBe('ECONNRESET');
    });

    it('clears status/code when error has none', () => {
      const w = new FailureWindow({ useSlidingWindow: false, slidingWindowSize: 0 });
      const state = freshState();
      state.lastFailureStatus = 500;
      state.lastFailureCode = 'OLD';
      w.rememberLast(state, makeError(undefined, undefined));
      expect(state.lastFailureStatus).toBeUndefined();
      expect(state.lastFailureCode).toBeUndefined();
    });
  });

  describe('non-sliding-window mode', () => {
    const w = new FailureWindow({ useSlidingWindow: false, slidingWindowSize: 100 });

    it('cleanup is a no-op', () => {
      const state = freshState();
      state.recentFailures.push({ timestamp: 0, url: 'x', status: 500, errorCode: 'X' });
      state.failureCount = 5;
      w.cleanup(state);
      expect(state.recentFailures.length).toBe(1);
      expect(state.failureCount).toBe(5);
    });

    it('count returns the raw counter', () => {
      const state = freshState();
      state.failureCount = 7;
      expect(w.count(state)).toBe(7);
    });
  });

  describe('sliding-window mode', () => {
    let w: FailureWindow;
    const WINDOW_MS = 1_000;

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-28T12:00:00.000Z'));
      w = new FailureWindow({ useSlidingWindow: true, slidingWindowSize: WINDOW_MS });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('add appends a failure record with current timestamp and increments count', () => {
      const state = freshState();
      w.add(state, makeError(500, 'X', '/foo'));
      expect(state.recentFailures.length).toBe(1);
      expect(state.recentFailures[0]).toMatchObject({ url: '/foo', status: 500, errorCode: 'X' });
      expect(state.failureCount).toBe(1);
    });

    it('uses "unknown" for missing url', () => {
      const state = freshState();
      w.add(state, makeError(503));
      expect(state.recentFailures[0].url).toBe('unknown');
    });

    it('cleanup evicts entries older than the window and decrements failureCount', () => {
      const state = freshState();
      // Three failures, evenly spaced.
      w.add(state, makeError(500));
      jest.advanceTimersByTime(400);
      w.add(state, makeError(500));
      jest.advanceTimersByTime(400);
      w.add(state, makeError(500));
      expect(state.recentFailures.length).toBe(3);
      expect(state.failureCount).toBe(3);

      // Advance past the window so the first entry should be evicted.
      jest.advanceTimersByTime(400);
      w.cleanup(state);
      expect(state.recentFailures.length).toBe(2);
      expect(state.failureCount).toBe(2);
    });

    it('failureCount cannot go below zero when state is already at 0', () => {
      const state = freshState();
      // Manually populate so failureCount is 0 but recentFailures has expired entries.
      state.recentFailures.push({ timestamp: Date.now() - 5_000, url: 'x' });
      state.failureCount = 0;
      w.cleanup(state);
      expect(state.failureCount).toBe(0);
    });

    it('count auto-cleans before reading', () => {
      const state = freshState();
      w.add(state, makeError(500));
      jest.advanceTimersByTime(WINDOW_MS + 100);
      w.add(state, makeError(500));
      // After advancing past the window, the first failure has expired.
      expect(w.count(state)).toBe(1);
    });

    it('countSince filters by an explicit timestamp boundary', () => {
      const state = freshState();
      const t0 = Date.now();
      w.add(state, makeError(500));
      jest.advanceTimersByTime(200);
      const cutoff = Date.now();
      w.add(state, makeError(500));
      // Both inside the sliding window, but only the second is at/after cutoff.
      expect(w.countSince(state, cutoff)).toBe(1);
      expect(w.countSince(state, t0)).toBe(2);
    });
  });
});
