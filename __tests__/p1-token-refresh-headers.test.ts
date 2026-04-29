/**
 * Branch coverage for TokenRefreshPlugin/utils/headers helpers. The plugin has
 * to handle three header layouts (plain object, AxiosHeaders-like with get/set,
 * mixed) plus all the empty/falsy fall-throughs.
 */
import type { AxiosRequestConfig } from 'axios';

import {
  extractTokenFromAuthHeader,
  getHeader,
  hasHeader,
  safeStringEqual,
  sanitizeHeaderValue,
  setHeader,
} from '../src/plugins/TokenRefreshPlugin/utils/headers';

describe('TokenRefreshPlugin headers utils', () => {
  describe('hasHeader', () => {
    it('returns false when config has no headers at all', () => {
      expect(hasHeader({} as AxiosRequestConfig, 'authorization')).toBe(false);
    });

    it('respects an AxiosHeaders-like has() override', () => {
      const config = {
        headers: {
          has: (name: string) => name === 'Authorization',
        },
      } as unknown as AxiosRequestConfig;
      expect(hasHeader(config, 'Authorization')).toBe(true);
    });

    it('falls through has() === false to get() and direct lookups', () => {
      const config = {
        headers: {
          has: () => false,
          get: (name: string) => (name === 'Authorization' ? 'Bearer abc' : undefined),
        },
      } as unknown as AxiosRequestConfig;
      expect(hasHeader(config, 'Authorization')).toBe(true);
    });

    it('returns true on exact-key match for plain objects', () => {
      const config = { headers: { Authorization: 'Bearer xyz' } } as AxiosRequestConfig;
      expect(hasHeader(config, 'Authorization')).toBe(true);
    });

    it('returns true on lowercased-key fallback', () => {
      const config = { headers: { authorization: 'Bearer xyz' } } as AxiosRequestConfig;
      expect(hasHeader(config, 'Authorization')).toBe(true);
    });

    it('returns true on case-insensitive enumeration when neither direct nor lower match', () => {
      const config = { headers: { AuThOrIzAtIoN: 'Bearer xyz' } } as AxiosRequestConfig;
      expect(hasHeader(config, 'authorization')).toBe(true);
    });

    it('treats null/false/undefined values as missing', () => {
      const config = {
        headers: {
          Authorization: undefined,
          'x-api-key': null,
          cookie: false,
        },
      } as unknown as AxiosRequestConfig;
      expect(hasHeader(config, 'Authorization')).toBe(false);
      expect(hasHeader(config, 'x-api-key')).toBe(false);
      expect(hasHeader(config, 'cookie')).toBe(false);
    });
  });

  describe('getHeader', () => {
    it('returns null when there are no headers', () => {
      expect(getHeader({} as AxiosRequestConfig, 'Authorization')).toBeNull();
    });

    it('returns the value via the AxiosHeaders-like get() when present', () => {
      const config = {
        headers: { get: (name: string) => (name === 'Authorization' ? 'Bearer abc' : undefined) },
      } as unknown as AxiosRequestConfig;
      expect(getHeader(config, 'Authorization')).toBe('Bearer abc');
    });

    it('falls through get() returning non-string to direct lookup', () => {
      const config = {
        headers: {
          get: () => 42,
          Authorization: 'Bearer plain',
        },
      } as unknown as AxiosRequestConfig;
      expect(getHeader(config, 'Authorization')).toBe('Bearer plain');
    });

    it('returns the direct lowercase match', () => {
      const config = { headers: { authorization: 'Bearer lower' } } as AxiosRequestConfig;
      expect(getHeader(config, 'Authorization')).toBe('Bearer lower');
    });

    it('returns case-insensitive match by enumeration', () => {
      const config = { headers: { AuThOrIzAtIoN: 'Bearer mixed' } } as AxiosRequestConfig;
      expect(getHeader(config, 'authorization')).toBe('Bearer mixed');
    });

    it('returns null when nothing matches or the matched value is not a string', () => {
      const config = { headers: { Authorization: 42 } } as unknown as AxiosRequestConfig;
      expect(getHeader(config, 'Authorization')).toBeNull();
    });
  });

  describe('setHeader', () => {
    it('initializes the headers object when missing', () => {
      const config = {} as AxiosRequestConfig;
      setHeader(config, 'Authorization', 'Bearer xyz');
      expect(config.headers).toMatchObject({ Authorization: 'Bearer xyz' });
    });

    it('uses the AxiosHeaders-like set() when available', () => {
      const set = jest.fn();
      const config = { headers: { set } } as unknown as AxiosRequestConfig;
      setHeader(config, 'Authorization', 'Bearer xyz');
      expect(set).toHaveBeenCalledWith('Authorization', 'Bearer xyz');
    });

    it('writes directly when there is no set() method', () => {
      const config = { headers: {} } as AxiosRequestConfig;
      setHeader(config, 'Authorization', 'Bearer xyz');
      expect((config.headers as Record<string, unknown>)['Authorization']).toBe('Bearer xyz');
    });
  });

  describe('sanitizeHeaderValue', () => {
    it('strips CR/LF/NUL/separator characters', () => {
      expect(sanitizeHeaderValue('safe')).toBe('safe');
      expect(sanitizeHeaderValue('Bearer\r\nattacker')).toBe('Bearerattacker');
      expect(sanitizeHeaderValue('a b c\0d')).toBe('abcd');
    });
  });

  describe('safeStringEqual', () => {
    it('returns false for different lengths without comparing', () => {
      expect(safeStringEqual('abc', 'abcd')).toBe(false);
    });

    it('returns true for identical strings', () => {
      expect(safeStringEqual('Bearer abc', 'Bearer abc')).toBe(true);
    });

    it('returns false for same-length but different strings', () => {
      expect(safeStringEqual('Bearer abc', 'Bearer abd')).toBe(false);
    });

    it('returns true for empty strings', () => {
      expect(safeStringEqual('', '')).toBe(true);
    });
  });

  describe('extractTokenFromAuthHeader', () => {
    it('strips the prefix when it matches', () => {
      expect(extractTokenFromAuthHeader('Bearer abc.def', 'Bearer ')).toBe('abc.def');
    });

    it('returns the input unchanged when the prefix does not match', () => {
      expect(extractTokenFromAuthHeader('Token abc', 'Bearer ')).toBe('Token abc');
    });

    it('returns the input unchanged when prefix is empty', () => {
      expect(extractTokenFromAuthHeader('Bearer abc', '')).toBe('Bearer abc');
    });
  });
});
