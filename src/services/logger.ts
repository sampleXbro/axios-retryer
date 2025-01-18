export class RetryLogger {
  constructor(private enabled = false) {}

  log(message: string, data?: any) {
    if (this.enabled) {
      console.log(`[axios-retryer] ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  error(message: string, error: unknown) {
    if (this.enabled) {
      console.error(`[axios-retryer] ${message}`, error);
    }
  }

  warn(message: string, data?: unknown) {
    if (this.enabled) {
      console.warn(`[axios-retryer] ${message}`, data ? JSON.stringify(data) : '');
    }
  }
}
