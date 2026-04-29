import type { Logger } from '../../../types';
import { getErrorMeta } from '../utils';

export interface CleanupRunnerOptions {
  /** How often to run cleanup, in milliseconds. `<= 0` disables the runner. */
  intervalMs: number;
  /** Hard cap for a single cleanup invocation. Hung adapters bail out and count as a failure. */
  timeoutMs: number;
  /** Stop scheduling once this many consecutive failures (timeouts or thrown) accumulate. */
  disableAfterFailures: number;
  /** The cleanup body. Must reject (or hit the timeout) for failures to be counted. */
  runCleanup: () => Promise<void>;
  /** Lazy-resolved logger so the runner stays decoupled from PluginContext lifecycle. */
  getLogger: () => Logger | null | undefined;
}

/**
 * Owns the periodic cache-cleanup loop.
 *
 * Every interval, races the user-provided `runCleanup` against a timeout. On
 * success the failure counter resets. On timeout or thrown error the counter
 * increments; once it crosses `disableAfterFailures`, the runner stops itself
 * to keep a hung storage adapter from leaking pending promises.
 */
export class CleanupRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly options: CleanupRunnerOptions) {}

  public start(): void {
    if (this.timer || this.options.intervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => this.runOnce(), this.options.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  private runOnce(): void {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Cache cleanup exceeded ${this.options.timeoutMs} ms timeout`)),
        this.options.timeoutMs,
      );
    });

    void Promise.race([this.options.runCleanup(), timeout])
      .then(() => {
        this.consecutiveFailures = 0;
      })
      .catch((error: unknown) => {
        this.consecutiveFailures += 1;
        this.options.getLogger()?.warn('[CachingPlugin] Failed to run cache cleanup', {
          ...getErrorMeta(error),
          consecutiveFailures: this.consecutiveFailures,
        });
        if (this.consecutiveFailures >= this.options.disableAfterFailures) {
          this.options.getLogger()?.error('[CachingPlugin] Disabling cleanup after repeated failures', {
            consecutiveFailures: this.consecutiveFailures,
          });
          this.stop();
        }
      })
      .finally(() => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      });
  }
}
