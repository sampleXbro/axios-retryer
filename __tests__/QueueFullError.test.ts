// @ts-nocheck
import { QueueFullError } from '../src/core/errors/QueueFullError';
import type { AxiosRequestConfig } from 'axios';

describe('QueueFullError', () => {
  test('should create an error with the correct message', () => {
    const config: AxiosRequestConfig = {
      url: '/test',
      method: 'get'
    };
    
    const error = new QueueFullError(config);
    
    expect(error.message).toContain('Request queue is full');
    expect(error.message).toContain('maximum queue size');
  });
  
  test('should store the axios request config', () => {
    const config: AxiosRequestConfig = {
      url: '/test',
      method: 'get',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const error = new QueueFullError(config);
    
    expect(error.config).toBe(config);
  });
  
  test('should set the correct name and code properties', () => {
    const config: AxiosRequestConfig = {
      url: '/test',
      method: 'get'
    };
    
    const error = new QueueFullError(config);
    
    expect(error.name).toBe('QueueFullError');
    expect(error.code).toBe('EQUEUE_FULL');
  });
  
  test('should set a name that identifies it as a QueueFullError', () => {
    const config: AxiosRequestConfig = {
      url: '/test-url',
      method: 'post',
      data: { test: 'data' }
    };
    
    const error = new QueueFullError(config);
    const stringRepresentation = error.toString();
    
    expect(stringRepresentation).toContain('QueueFullError');
    expect(error.name).toBe('QueueFullError');
  });
  
  test('should handle undefined or partial config', () => {
    // With empty config
    const error1 = new QueueFullError({});
    expect(error1.message).toContain('Request queue is full');
    
    // With null config (should not throw)
    expect(() => {
      new QueueFullError(null);
    }).not.toThrow();
    
    // With incomplete config
    const partialConfig = { method: 'get' }; // No URL
    const error2 = new QueueFullError(partialConfig);
    expect(error2.message).toContain('Request queue is full');
  });
  
  test('should work with undefined config', () => {
    const error = new QueueFullError(undefined);
    expect(error.message).toContain('Request queue is full');
    expect(error.code).toBe('EQUEUE_FULL');
    expect(error.name).toBe('QueueFullError');
  });
  
  test('should expose error details through isAxiosError property', () => {
    const config: AxiosRequestConfig = {
      url: '/test',
      method: 'get'
    };
    
    const error = new QueueFullError(config);
    
    // AxiosError properties
    expect(error.isAxiosError).toBe(true);
  });
  
  test('should include stack trace', () => {
    const error = new QueueFullError({});
    expect(error.stack).toBeDefined();
  });
}); 