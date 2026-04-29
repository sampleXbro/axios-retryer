/**
 * Lifecycle helper for promises that must reject when the plugin tears down.
 *
 * The TokenRefreshPlugin needs every in-flight refresh, sleep, and waiter to
 * fail fast when the plugin is destroyed (or is informed of an unrecoverable
 * error). TeardownGuard owns that small state machine: a sticky error, a set
 * of active waiters, and helpers to wrap an arbitrary promise so it races the
 * teardown signal.
 */
export class TeardownGuard {
  private teardownError: Error | null = null;
  private readonly listeners = new Set<(error: Error) => void>();

  public get error(): Error | null {
    return this.teardownError;
  }

  public ensureActive(): void {
    if (this.teardownError) {
      throw this.teardownError;
    }
  }

  /**
   * Wrap `promise` so it rejects with the teardown error when teardown fires.
   * If teardown has already fired, the wrapper rejects synchronously on the
   * next tick (Promise semantics).
   */
  public wrap<T>(promise: Promise<T>): Promise<T> {
    if (this.teardownError) {
      return Promise.reject(this.teardownError);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: T | PromiseLike<T>): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        reject(reason);
      };

      const rejectOnTeardown = (error: Error): void => {
        safeReject(error);
      };

      this.listeners.add(rejectOnTeardown);

      promise.then(safeResolve, safeReject).finally(() => {
        this.listeners.delete(rejectOnTeardown);
      });
    });
  }

  /**
   * Trigger teardown. Subsequent `wrap()` calls reject immediately. All
   * currently-active waiters are notified. `onAfter` runs once the listeners
   * have been notified — useful for plugin-specific cleanup (e.g. flushing the
   * pending refresh queue) that must happen after the wrapped promises settle.
   *
   * Idempotent: a second call with the same error is a no-op.
   */
  public dispose(error: Error, onAfter?: () => void): void {
    if (this.teardownError) {
      return;
    }
    this.teardownError = error;

    this.listeners.forEach((listener) => listener(error));
    this.listeners.clear();

    onAfter?.();
  }

  /** Reset the guard so a fresh plugin lifecycle can begin. */
  public reset(): void {
    this.teardownError = null;
    this.listeners.clear();
  }
}
