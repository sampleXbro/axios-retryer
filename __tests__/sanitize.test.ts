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

      const sanitized = sanitizeData(data, { allowlistOnly: false });
      
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

      const sanitized = sanitizeData(data, { allowlistOnly: false });
      
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
        allowlistOnly: false,
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

    test('should redact payload values by default unless explicitly allowlisted', () => {
      const data = {
        username: 'testuser',
        password: 'secret123',
        profile: {
          displayName: 'Visible Name',
          token: 'secret-token',
        },
      };

      const sanitized = sanitizeData(data, {
        allowedFields: ['username', 'displayName'],
      });

      expect(sanitized).toEqual({
        username: 'testuser',
        password: '********',
        profile: {
          displayName: 'Visible Name',
          token: '********',
        },
      });
    });

    test('should not crash on circular references', () => {
      const data: any = { username: 'testuser', password: 'secret' };
      data.self = data; // circular reference

      // Should not throw
      const sanitized = sanitizeData(data);
      expect(sanitized).toBeDefined();
      expect(sanitized!.username).toBe('********');
      expect(sanitized!.password).toBe('********');
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

    test('should sanitize relative URLs and preserve hash fragments', () => {
      const url = '/api/session?token=secret123&normal=value#details';
      const sanitized = sanitizeUrl(url, { sanitizeUrlParams: true });

      expect(sanitized).toBe('/api/session?token=********&normal=value#details');
    });

    test('should respect sanitizeUrlParams when disabled', () => {
      const url = '/api/session?token=secret123&normal=value';
      const sanitized = sanitizeUrl(url, { sanitizeUrlParams: false });

      expect(sanitized).toBe('/api/session?token=secret123&normal=value');
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
