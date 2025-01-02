export class RetryLogger {
    constructor(private enabled: boolean = false) {}

    log(message: string, data?: any) {
        if (this.enabled) {
            console.log(`[axios-retryer] ${message}`, data ? JSON.stringify(data) : '');
        }
    }

    error(message: string, error: Error) {
        if (this.enabled) {
            console.error(`[axios-retryer] ${message}`, error);
        }
    }
}