export class RetryLogger {
    constructor(private enabled: boolean = false) {}

    log(message: string, data?: any) {
        if (this.enabled) {
            console.log(`%c[axios-retryer] %c${message}`, data ? JSON.stringify(data) : '');
        }
    }

    error(message: string, error: Error) {
        if (this.enabled) {
            console.error(`[axios-retryer] ${message}`, error);
        }
    }
}