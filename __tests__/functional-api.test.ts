// @ts-nocheck
import { createRetryer, createRetryStrategy, RetryManager } from '../src';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

describe('Functional API', () => {
  describe('createRetryer', () => {
    test('should create a RetryManager instance with default options', () => {
      const retryer = createRetryer();
      expect(retryer).toBeInstanceOf(RetryManager);
    });
    
    test('should create a RetryManager instance with custom options', () => {
      const retryer = createRetryer({
        retries: 5,
        debug: true,
        maxConcurrentRequests: 10
      });
      
      expect(retryer).toBeInstanceOf(RetryManager);
      expect(retryer['retries']).toBe(5);
      expect(retryer['debug']).toBe(true);
      expect(retryer['requestQueue']['maxConcurrent']).toBe(10);
    });
    
    test('should create a RetryManager with a custom axios instance', () => {
      const customAxios = axios.create({
        baseURL: 'https://example.com'
      });
      
      const retryer = createRetryer({
        axiosInstance: customAxios
      });
      
      expect(retryer.axiosInstance).toBe(customAxios);
    });
  });
  
  describe('createRetryStrategy', () => {
    test('should create a strategy with default behaviors when no config provided', () => {
      const strategy = createRetryStrategy();
      
      // Test with a network error
      const networkError = new Error('Network Error');
      networkError.isAxiosError = true;
      
      // Should be retryable
      expect(strategy.getIsRetryable(networkError)).toBe(true);
      
      // Should retry if within max retries
      expect(strategy.shouldRetry(networkError, 1, 3)).toBe(true);
      expect(strategy.shouldRetry(networkError, 3, 3)).toBe(true);
      expect(strategy.shouldRetry(networkError, 4, 3)).toBe(false);
      
      // Should return a number for delay
      expect(typeof strategy.getDelay(1, 3)).toBe('number');
    });
    
    test('should create a strategy with custom isRetryable function', () => {
      const customIsRetryable = jest.fn().mockImplementation(error => {
        return error.status === 503;
      });
      
      const strategy = createRetryStrategy({
        isRetryable: customIsRetryable
      });
      
      const serviceUnavailableError = {
        isAxiosError: true,
        status: 503
      };
      
      const badRequestError = {
        isAxiosError: true,
        status: 400
      };
      
      expect(strategy.getIsRetryable(serviceUnavailableError)).toBe(true);
      expect(strategy.getIsRetryable(badRequestError)).toBe(false);
      expect(customIsRetryable).toHaveBeenCalledTimes(2);
    });
    
    test('should create a strategy with custom shouldRetry function', () => {
      const customShouldRetry = jest.fn().mockImplementation((error, attempt, maxRetries) => {
        // Only retry on network errors, max 2 attempts
        return error.message === 'Network Error' && attempt <= 2;
      });
      
      const strategy = createRetryStrategy({
        shouldRetry: customShouldRetry
      });
      
      const networkError = {
        isAxiosError: true,
        message: 'Network Error'
      };
      
      expect(strategy.shouldRetry(networkError, 1, 5)).toBe(true);
      expect(strategy.shouldRetry(networkError, 2, 5)).toBe(true);
      expect(strategy.shouldRetry(networkError, 3, 5)).toBe(false);
      expect(customShouldRetry).toHaveBeenCalledTimes(3);
    });
    
    test('should create a strategy with custom getDelay function', () => {
      const customGetDelay = jest.fn().mockImplementation((attempt) => {
        return attempt * 500; // Linear backoff with 500ms increments
      });
      
      const strategy = createRetryStrategy({
        getDelay: customGetDelay
      });
      
      expect(strategy.getDelay(1, 3)).toBe(500);
      expect(strategy.getDelay(2, 3)).toBe(1000);
      expect(strategy.getDelay(3, 3)).toBe(1500);
      expect(customGetDelay).toHaveBeenCalledTimes(3);
    });
    
    test('should work with real axios requests', async () => {
      // Create a custom strategy that counts retries
      const retryCounter = { count: 0 };
      const strategy = createRetryStrategy({
        shouldRetry: (error, attempt, maxRetries) => {
          retryCounter.count++;
          return attempt <= maxRetries;
        }
      });
      
      // Create retryer with custom strategy
      const retryer = createRetryer({
        retries: 2,
        retryStrategy: strategy
      });
      
      // Setup mock
      const mock = new MockAdapter(retryer.axiosInstance);
      mock.onGet('/test-retry').replyOnce(500);
      mock.onGet('/test-retry').replyOnce(500);
      mock.onGet('/test-retry').reply(200, { success: true });
      
      // Make request
      const response = await retryer.axiosInstance.get('/test-retry');
      
      expect(response.data.success).toBe(true);
      expect(retryCounter.count).toBe(2); // 2 retries
      
      mock.restore();
    });
  });
}); 