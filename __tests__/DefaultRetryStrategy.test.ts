import { AxiosError } from 'axios';
import {DefaultRetryStrategy} from "../src/core/RetryStrategy";

describe('DefaultRetryStrategy', () => {
    let strategy: DefaultRetryStrategy;

    beforeEach(() => {
        strategy = new DefaultRetryStrategy();
    });

    describe('shouldRetry', () => {
        it('should retry on network errors', () => {
            const error = { response: undefined } as AxiosError;
            const attempt = 1;
            const maxRetries = 3;

            expect(strategy.shouldRetry(error, attempt, maxRetries)).toBe(true);
        });

        it('should retry on server errors (5xx)', () => {
            const error = { response: { status: 500 } } as AxiosError;
            const attempt = 1;
            const maxRetries = 3;

            expect(strategy.shouldRetry(error, attempt, maxRetries)).toBe(true);
        });

        it('should not retry on client errors (4xx)', () => {
            const error = { response: { status: 400 } } as AxiosError;
            const attempt = 1;
            const maxRetries = 3;

            expect(strategy.shouldRetry(error, attempt, maxRetries)).toBe(false);
        });

        it('should not retry if max retries exceeded', () => {
            const error = { response: { status: 500 } } as AxiosError;
            const attempt = 4; // Exceeds maxRetries
            const maxRetries = 3;

            expect(strategy.shouldRetry(error, attempt, maxRetries)).toBe(false);
        });

        it('should not retry on other scenarios', () => {
            const error = { response: { status: 200 } } as AxiosError; // Non-error response
            const attempt = 1;
            const maxRetries = 3;

            expect(strategy.shouldRetry(error, attempt, maxRetries)).toBe(false);
        });
    });

    describe('getDelay', () => {
        it('should return 1 second delay for the first attempt', () => {
            const attempt = 1;

            expect(strategy.getDelay(attempt)).toBe(1000); // 1s
        });

        it('should return 2 seconds delay for the second attempt', () => {
            const attempt = 2;

            expect(strategy.getDelay(attempt)).toBe(2000); // 2s
        });

        it('should return 4 seconds delay for the third attempt', () => {
            const attempt = 3;

            expect(strategy.getDelay(attempt)).toBe(4000); // 4s
        });

        it('should return exponential backoff delays for subsequent attempts', () => {
            const delays = [1000, 2000, 4000, 8000, 16000];
            delays.forEach((expectedDelay, attempt) => {
                expect(strategy.getDelay(attempt + 1)).toBe(expectedDelay);
            });
        });
    });
});