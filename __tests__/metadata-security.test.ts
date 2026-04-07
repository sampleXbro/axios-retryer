/**
 * T-015: Verify request metadata is not serializable, not prototype-pollutable,
 * and that internal-only fields are not reachable via the public type augmentation.
 */
import type { AxiosRequestConfig } from 'axios';
import { ensureRequestMetadata, getRequestMetadata, assignRequestMetadata, setRequestMetadataValue } from '../src/utils/requestMetadata';

describe('Request metadata security (T-015)', () => {
  describe('JSON serialization protection', () => {
    it('should not serialize __axiosRetryer metadata to JSON', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      const meta = ensureRequestMetadata(config);
      meta.requestId = 'abc';
      (meta as Record<string, unknown>)['retryAttempt'] = 2; // internal write, bypasses readonly

      const json = JSON.stringify(config);
      const parsed = JSON.parse(json);
      expect(parsed.__axiosRetryer).toBeUndefined();
    });

    it('should not include metadata in JSON.stringify of the config object', () => {
      const config: AxiosRequestConfig = { url: '/test', method: 'GET' };
      ensureRequestMetadata(config);
      setRequestMetadataValue(config, 'requestId', 'test-id');

      const serialized = JSON.stringify(config);
      expect(serialized).not.toContain('axiosRetryer');
      expect(serialized).not.toContain('requestId');
      expect(serialized).not.toContain('retryAttempt');
    });

    it('should preserve metadata object in memory even though it does not serialize', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      const meta = ensureRequestMetadata(config);
      meta.requestId = 'should-be-in-memory';

      const retrieved = getRequestMetadata(config);
      expect(retrieved?.requestId).toBe('should-be-in-memory');
    });
  });

  describe('Prototype pollution prevention', () => {
    it('should not pollute Object.prototype via __proto__ key injection', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      ensureRequestMetadata(config);

      // Attempt to inject via assignRequestMetadata with a hostile key
      assignRequestMetadata(config, {
        ['__proto__' as keyof object]: { polluted: true } as unknown,
      } as never);

      expect((Object.prototype as unknown as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it('should not pollute Object.prototype via constructor injection', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      ensureRequestMetadata(config);

      assignRequestMetadata(config, {
        ['constructor' as keyof object]: { prototype: { polluted: true } } as unknown,
      } as never);

      const freshObj = {} as { polluted?: unknown };
      expect(freshObj.polluted).toBeUndefined();
    });

    it('should ignore unknown keys not in the allowlist', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      const meta = ensureRequestMetadata(config);

      assignRequestMetadata(config, {
        ['unknownField' as keyof object]: 'danger' as unknown,
      } as never);

      expect((meta as Record<string, unknown>)['unknownField']).toBeUndefined();
    });

    it('should handle user-provided plain __axiosRetryer without prototype pollution', () => {
      const hostile = JSON.parse('{"__proto__": {"poisoned": true}}');
      const config: AxiosRequestConfig = { url: '/test', __axiosRetryer: hostile };

      // ensureRequestMetadata should safely re-wrap the user-provided object
      const meta = ensureRequestMetadata(config);
      // __proto__ should not be an own property of the metadata object
      expect(Object.prototype.hasOwnProperty.call(meta, '__proto__')).toBe(false);
      expect((Object.prototype as Record<string, unknown>)['poisoned']).toBeUndefined();
    });
  });

  describe('Metadata initialization and access', () => {
    it('should return the same metadata object on repeated calls', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      const meta1 = ensureRequestMetadata(config);
      const meta2 = ensureRequestMetadata(config);
      expect(meta1).toBe(meta2);
    });

    it('should return undefined for null config', () => {
      expect(getRequestMetadata(null)).toBeUndefined();
      expect(getRequestMetadata(undefined)).toBeUndefined();
    });

    it('should transfer user-provided values when re-wrapping a plain object', () => {
      const config: AxiosRequestConfig = {
        url: '/test',
        __axiosRetryer: { priority: 3, requestId: 'user-id' },
      };
      const meta = ensureRequestMetadata(config);
      expect(meta.priority).toBe(3);
      expect(meta.requestId).toBe('user-id');
    });

    it('setRequestMetadataValue should delete key when value is undefined', () => {
      const config: AxiosRequestConfig = { url: '/test' };
      setRequestMetadataValue(config, 'requestId', 'abc');
      expect(getRequestMetadata(config)?.requestId).toBe('abc');

      setRequestMetadataValue(config, 'requestId', undefined);
      expect(getRequestMetadata(config)?.requestId).toBeUndefined();
    });
  });
});
