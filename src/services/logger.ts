import type { Logger } from '../types';

export class RetryLogger implements Logger {
  constructor(private debugMode = false) {}

  log(message: string, data?: unknown): void {
    // eslint-disable-next-line no-console
    console.log(`[AXIOS_RETRYER] ${message}`, ...(data !== undefined ? [data] : []));
  }

  error(message: string, error?: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`[AXIOS_RETRYER] ${message}`, ...(error !== undefined ? [error] : []));
  }

  warn(message: string, data?: unknown): void {
    // eslint-disable-next-line no-console
    console.warn(`[AXIOS_RETRYER] ${message}`, ...(data !== undefined ? [data] : []));
  }

  debug(message: string, meta?: unknown): void {
    if (this.debugMode) {
      // eslint-disable-next-line no-console
      console.debug(`[AXIOS_RETRYER] ${message}`, ...(meta !== undefined ? [meta] : []));
    }
  }
}
