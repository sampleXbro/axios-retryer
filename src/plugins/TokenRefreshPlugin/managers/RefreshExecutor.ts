import type { AxiosInstance } from 'axios';

import type { Logger } from '../../../types';
import type { TimerManager } from '../../../core/TimerManager';
import {
  createRetryableRefreshError,
  MissingTokenRefreshHandlerError,
  shouldRetryRefreshError,
  shouldStopRefreshRetries,
  toTokenRefreshError,
} from '../errors';
import type { TokenRefreshHandler, TokenRefreshResult } from '../types';
import type { TeardownGuard } from './TeardownGuard';

export interface RefreshExecutorOptions {
  pluginName: string;
  refreshAxios: AxiosInstance;
  refreshToken: TokenRefreshHandler | undefined;
  timerManager: TimerManager;
  teardown: TeardownGuard;
  maxRefreshAttempts: number;
  refreshTimeout: number;
  retryOnRefreshFail: boolean;
  maxRefreshBackoffMs: number;
  getLogger: () => Logger | null | undefined;
  onRefreshSuccess: (token: string) => void;
}

/**
 * Owns the retry loop that drives the configured refresh handler.
 *
 * Each attempt is wrapped in a hard timeout. Failures are classified as
 * stop / non-retryable / retryable; retryable failures back off (1s, 2s, 4s…)
 * up to `maxRefreshBackoffMs`. Success notifies the caller via `onRefreshSuccess`.
 *
 * Returns `null` when the handler resolves with no token (a documented opt-out)
 * and throws the last error when all attempts are exhausted.
 */
export class RefreshExecutor {
  constructor(private readonly options: RefreshExecutorOptions) {}

  public async run(): Promise<string | null> {
    const { teardown, refreshToken, pluginName, getLogger } = this.options;
    teardown.ensureActive();
    if (!refreshToken) {
      throw new MissingTokenRefreshHandlerError();
    }

    const logger = getLogger();
    const { maxRefreshAttempts, refreshTimeout, retryOnRefreshFail, maxRefreshBackoffMs } = this.options;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRefreshAttempts; attempt++) {
      teardown.ensureActive();
      logger?.debug(`[${pluginName}] Refresh attempt ${attempt}/${maxRefreshAttempts}`);

      try {
        const refreshPromise = new Promise<TokenRefreshResult>((resolve, reject) => {
          const { cancel: cancelTimeout } = this.options.timerManager.createTimeout(
            () => reject(createRetryableRefreshError('Token refresh timeout')),
            refreshTimeout,
          );
          refreshToken(this.options.refreshAxios)
            .then((res) => {
              cancelTimeout();
              resolve(res);
            })
            .catch((err) => {
              cancelTimeout();
              reject(err);
            });
        });
        const { token } = await teardown.wrap(refreshPromise);
        teardown.ensureActive();
        if (token == null) {
          logger?.debug(`[${pluginName}] Refresh handler returned no token; skipping refresh`);
          return null;
        }
        this.options.onRefreshSuccess(token);
        logger?.debug(`[${pluginName}] Token successfully refreshed`);
        return token;
      } catch (error) {
        lastError = toTokenRefreshError(error);
        if (shouldStopRefreshRetries(error)) {
          logger?.debug(`[${pluginName}] Refresh retries aborted by refresh handler`, {
            attempt,
            reason: lastError.message,
          });
          break;
        }
        if (!shouldRetryRefreshError(error)) {
          logger?.debug(`[${pluginName}] Refresh retries stopped after a terminal refresh error`, {
            attempt,
            reason: lastError.message,
          });
          break;
        }
        if (!retryOnRefreshFail) {
          break;
        }
        if (attempt < maxRefreshAttempts) {
          const backoffMs = Math.min(1000 * 2 ** (attempt - 1), maxRefreshBackoffMs);
          logger?.debug(`[${pluginName}] Refresh attempt failed, retrying in ${backoffMs}ms...`);
          const { promise: backoffPromise } = this.options.timerManager.createSleep(backoffMs);
          await teardown.wrap(backoffPromise);
          continue;
        }
        break;
      }
    }
    throw lastError;
  }
}
