export class RetryLogger {
  constructor(private debugMode = false) {}

  // eslint-disable-next-line
  log(message: string, data?: any) {
    // eslint-disable-next-line no-console
    console.log(`[AXIOS_RETRYER] ${message}`, data ? JSON.stringify(data) : '');
  }

  error(message: string, error?: unknown) {
    console.error(`[AXIOS_RETRYER] ${message}`, error);
  }

  warn(message: string, data?: unknown) {
    console.warn(`[AXIOS_RETRYER] ${message}`, data ? JSON.stringify(data) : '');
  }

  debug(message: string, meta?: object) {
    if (this.debugMode) {
      // eslint-disable-next-line no-console
      console.debug(`[AXIOS_RETRYER] ${message}`, meta || '');
    }
  }
}
