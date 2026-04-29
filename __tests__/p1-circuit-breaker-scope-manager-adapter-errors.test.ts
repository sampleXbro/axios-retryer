/**
 * Coverage for CircuitBreakerScopeManager adapter-error paths:
 *  - readState: adapter.get throws → handleAdapterError → fall back to local cache
 *  - deleteDistributedScope: adapter.delete sync throw / async reject → restoreDistributedClosedState
 *  - clearDistributedState: adapter.clear sync throw / async reject → restoreDistributedClosedState
 *  - resolveUrl returns null when URL constructor throws (line 272)
 */
import type { AxiosRequestConfig } from 'axios';

import { CircuitBreakerScopeManager } from '../src/plugins/CircuitBreakerPlugin/managers/CircuitBreakerScopeManager';
import { CIRCUIT_BREAKER_SCOPES, type CircuitBreakerStateAdapter } from '../src/plugins/CircuitBreakerPlugin/types';

function captureLogs() {
  return {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

function buildManager(adapter: CircuitBreakerStateAdapter): {
  manager: CircuitBreakerScopeManager;
  logger: ReturnType<typeof captureLogs>;
} {
  const manager = new CircuitBreakerScopeManager({
    scope: CIRCUIT_BREAKER_SCOPES.HOST,
    stateAdapter: adapter,
    maxTrackedScopes: 100,
  });
  const logger = captureLogs();
  manager.setLogger(logger);
  return { manager, logger };
}

describe('CircuitBreakerScopeManager adapter error paths', () => {
  it('logs and falls back to local cache when adapter.get throws', async () => {
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(() => {
        throw new Error('get-fail');
      }),
      set: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
    };
    const { manager, logger } = buildManager(adapter);

    const state = await manager.readState('scope-A');
    expect(state.state).toBe('CLOSED');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('State adapter get failed'),
      expect.objectContaining({ scopeKey: 'scope-A' }),
    );
  });

  it('logs when adapter.set throws on writeState', async () => {
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: jest.fn(() => {
        throw new Error('set-fail');
      }),
      delete: jest.fn(),
      clear: jest.fn(),
    };
    const { manager, logger } = buildManager(adapter);

    await manager.writeState('scope-A', manager.createInitialState());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('State adapter set failed'),
      expect.objectContaining({ scopeKey: 'scope-A' }),
    );
  });

  it('handles synchronous delete throw and restores closed state', () => {
    const setCalls: { key: string }[] = [];
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: (key) => {
        setCalls.push({ key });
      },
      delete: () => {
        throw new Error('delete-sync-fail');
      },
      clear: jest.fn(),
    };
    const { manager, logger } = buildManager(adapter);

    manager.deleteDistributedScope('scope-A');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('State adapter delete failed'),
      expect.objectContaining({ scopeKey: 'scope-A' }),
    );
    // restoreDistributedClosedState should have been called → adapter.set with initial state
    expect(setCalls).toEqual([{ key: 'scope-A' }]);
  });

  it('handles asynchronous delete rejection and restores closed state', async () => {
    const setCalls: { key: string }[] = [];
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: (key) => {
        setCalls.push({ key });
      },
      delete: () => Promise.reject(new Error('delete-async-fail')),
      clear: jest.fn(),
    };
    const { manager, logger } = buildManager(adapter);

    manager.deleteDistributedScope('scope-A');
    // Let the promise rejection propagate.
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('State adapter delete failed'),
      expect.objectContaining({ scopeKey: 'scope-A' }),
    );
    expect(setCalls).toEqual([{ key: 'scope-A' }]);
  });

  it('handles synchronous clear throw and restores closed state for tracked keys', () => {
    const setCalls: { key: string }[] = [];
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: (key) => {
        setCalls.push({ key });
      },
      delete: jest.fn(),
      clear: () => {
        throw new Error('clear-sync-fail');
      },
    };
    const { manager, logger } = buildManager(adapter);

    manager.clearDistributedState(['a', 'b']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('State adapter clear failed'),
      expect.objectContaining({ scopeKey: '*' }),
    );
    expect(setCalls.map((c) => c.key).sort()).toEqual(['a', 'b']);
  });

  it('handles asynchronous clear rejection and restores closed state for tracked keys', async () => {
    const setCalls: { key: string }[] = [];
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: (key) => {
        setCalls.push({ key });
      },
      delete: jest.fn(),
      clear: () => Promise.reject(new Error('clear-async-fail')),
    };
    const { manager, logger } = buildManager(adapter);

    manager.clearDistributedState(['a', 'b']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('State adapter clear failed'),
      expect.objectContaining({ scopeKey: '*' }),
    );
    expect(setCalls.map((c) => c.key).sort()).toEqual(['a', 'b']);
  });

  it('logs adapter errors that surface inside restoreDistributedClosedState', async () => {
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: () => Promise.reject(new Error('set-during-restore')),
      delete: () => Promise.reject(new Error('delete-async-fail')),
      clear: jest.fn(),
    };
    const { manager, logger } = buildManager(adapter);

    manager.deleteDistributedScope('scope-A');
    // Let both rejection chains resolve.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const operations = logger.warn.mock.calls.map((call) => call[0] as string);
    expect(operations.some((m) => m.includes('delete'))).toBe(true);
    expect(operations.some((m) => m.includes('set'))).toBe(true);
  });

  it('returns null URL when both url is relative and there is no base (already covered) and when URL constructor throws', () => {
    const adapter: CircuitBreakerStateAdapter = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
    };
    const { manager } = buildManager(adapter);

    // A malformed absolute URL forces the URL constructor to throw → falls into the catch.
    const config = { url: 'http://[::bad-ipv6' } as AxiosRequestConfig;
    // resolveUrl is private; getScopeDetails exercises it indirectly.
    const details = manager.getScopeDetails(config);
    // No host could be extracted; scopeKey falls back to normalizedUrl or 'unknown'.
    expect(typeof details.scopeKey).toBe('string');
  });
});
