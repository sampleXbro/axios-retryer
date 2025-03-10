import { sanitizeData, sanitizeHeaders, sanitizeUrl } from '../src/utils/sanitize';

describe('Sanitization utilities', () => {
  describe('sanitizeHeaders', () => {
    test('should redact sensitive headers', () => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
        'X-Api-Key': 'secret-api-key',
        'Custom-Header': 'normal-value',
      };

      const sanitized = sanitizeHeaders(headers);
      
      expect(sanitized).toEqual({
        'Content-Type': 'application/json',
        'Authorization': '********',
        'X-Api-Key': '********',
        'Custom-Header': 'normal-value',
      });
    });

    test('should handle custom sensitive headers', () => {
      const headers = {
        'Content-Type': 'application/json',
        'My-Custom-Token': 'secret123',
      };

      const sanitized = sanitizeHeaders(headers, {
        sensitiveHeaders: ['My-Custom-Token'],
      });
      
      expect(sanitized).toEqual({
        'Content-Type': 'application/json',
        'My-Custom-Token': '********',
      });
    });

    test('should handle null or undefined headers', () => {
      expect(sanitizeHeaders(null)).toBeNull();
      expect(sanitizeHeaders(undefined)).toBeUndefined();
    });
  });

  describe('sanitizeData', () => {
    test('should redact sensitive fields in request data', () => {
      const data = {
        username: 'testuser',
        password: 'secret123',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        nestedObject: {
          apiKey: 'nested-api-key',
          normal: 'normal-value',
        },
      };

      const sanitized = sanitizeData(data);
      
      expect(sanitized).toEqual({
        username: 'testuser',
        password: '********',
        token: '********',
        nestedObject: {
          apiKey: '********',
          normal: 'normal-value',
        },
      });
    });

    test('should handle arrays of objects', () => {
      const data = {
        items: [
          { id: 1, token: 'token1' },
          { id: 2, token: 'token2' },
        ],
      };

      const sanitized = sanitizeData(data);
      
      expect(sanitized).toEqual({
        items: [
          { id: 1, token: '********' },
          { id: 2, token: '********' },
        ],
      });
    });

    test('should handle custom sensitive fields', () => {
      const data = {
        username: 'testuser',
        myCustomSecret: 'very-secret',
      };

      const sanitized = sanitizeData(data, {
        sensitiveFields: ['myCustomSecret'],
      });
      
      expect(sanitized).toEqual({
        username: 'testuser',
        myCustomSecret: '********',
      });
    });

    test('should handle null or undefined data', () => {
      expect(sanitizeData(null)).toBeNull();
      expect(sanitizeData(undefined)).toBeUndefined();
    });
  });

  describe('sanitizeUrl', () => {
    test('should redact sensitive query parameters', () => {
      const url = 'https://example.com/api?token=secret123&normal=value';
      const sanitized = sanitizeUrl(url, {sanitizeUrlParams: true});
      
      expect(sanitized).toBe('https://example.com/api?token=********&normal=value');
    });

    test('should handle URLs without query parameters', () => {
      const url = 'https://example.com/api';
      const sanitized = sanitizeUrl(url, {sanitizeUrlParams: true});
      
      expect(sanitized).toBe('https://example.com/api');
    });

    test('should handle non-valid URLs', () => {
      const url = 'not-a-valid-url';
      const sanitized = sanitizeUrl(url, {sanitizeUrlParams: true});
      
      // For invalid URLs, we just return the original
      expect(sanitized).toBe('not-a-valid-url');
    });

    test('should handle null or undefined URLs', () => {
      expect(sanitizeUrl(null as any)).toBeNull();
      expect(sanitizeUrl(undefined)).toBeUndefined();
    });
  });
}); 