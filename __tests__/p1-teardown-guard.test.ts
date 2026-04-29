/**
 * Targeted unit coverage for TeardownGuard — the lifecycle helper extracted
 * from TokenRefreshPlugin. Verifies the sticky-error semantics, listener
 * fan-out on dispose, and the wrap() race semantics for both already-settled
 * and active waiters.
 */
import { TeardownGuard } from '../src/plugins/TokenRefreshPlugin/managers/TeardownGuard';

describe('TeardownGuard', () => {
  describe('ensureActive', () => {
    it('does nothing while the guard is active', () => {
      const guard = new TeardownGuard();
      expect(() => guard.ensureActive()).not.toThrow();
    });

    it('throws the dispose error after dispose()', () => {
      const guard = new TeardownGuard();
      const err = new Error('teardown');
      guard.dispose(err);
      expect(() => guard.ensureActive()).toThrow(err);
    });
  });

  describe('wrap', () => {
    it('forwards the wrapped promise resolution', async () => {
      const guard = new TeardownGuard();
      await expect(guard.wrap(Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it('forwards the wrapped promise rejection', async () => {
      const guard = new TeardownGuard();
      const reason = new Error('inner');
      await expect(guard.wrap(Promise.reject(reason))).rejects.toBe(reason);
    });

    it('rejects synchronously with the dispose error if the guard is already torn down', async () => {
      const guard = new TeardownGuard();
      const teardownError = new Error('already-down');
      guard.dispose(teardownError);
      await expect(guard.wrap(Promise.resolve('never'))).rejects.toBe(teardownError);
    });

    it('rejects an in-flight wrap() with the dispose error when teardown fires', async () => {
      const guard = new TeardownGuard();
      let resolveLater!: (value: string) => void;
      const dangling = new Promise<string>((resolve) => {
        resolveLater = resolve;
      });
      const wrapped = guard.wrap(dangling);
      const teardownError = new Error('mid-flight');
      // Trigger teardown before the inner promise settles.
      guard.dispose(teardownError);
      await expect(wrapped).rejects.toBe(teardownError);
      // Resolving the inner after teardown is harmless.
      resolveLater('late');
    });

    it('does not double-settle when teardown fires after the inner already resolved', async () => {
      const guard = new TeardownGuard();
      const wrapped = guard.wrap(Promise.resolve('done'));
      const result = await wrapped;
      expect(result).toBe('done');
      // dispose afterwards is a no-op for the already-settled wrapper.
      guard.dispose(new Error('late'));
      await expect(wrapped).resolves.toBe('done');
    });
  });

  describe('dispose', () => {
    it('runs the onAfter hook exactly once after notifying listeners', () => {
      const guard = new TeardownGuard();
      const onAfter = jest.fn();
      guard.dispose(new Error('x'), onAfter);
      expect(onAfter).toHaveBeenCalledTimes(1);
      // Subsequent dispose() is idempotent.
      guard.dispose(new Error('y'), onAfter);
      expect(onAfter).toHaveBeenCalledTimes(1);
    });

    it('exposes the dispose error via .error', () => {
      const guard = new TeardownGuard();
      expect(guard.error).toBeNull();
      const err = new Error('e');
      guard.dispose(err);
      expect(guard.error).toBe(err);
    });
  });

  describe('reset', () => {
    it('clears the dispose error so wrap() works again', async () => {
      const guard = new TeardownGuard();
      guard.dispose(new Error('first'));
      guard.reset();
      expect(guard.error).toBeNull();
      await expect(guard.wrap(Promise.resolve('back'))).resolves.toBe('back');
    });

    it('forgets active listeners on reset', async () => {
      const guard = new TeardownGuard();
      let resolveLater!: (value: string) => void;
      const dangling = new Promise<string>((resolve) => {
        resolveLater = resolve;
      });
      const wrapped = guard.wrap(dangling);
      guard.reset();
      // After reset, dispose should NOT propagate to the previously-wrapped waiter.
      guard.dispose(new Error('post-reset'));
      resolveLater('survives');
      await expect(wrapped).resolves.toBe('survives');
    });
  });
});
