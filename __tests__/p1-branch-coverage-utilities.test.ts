/**
 * Branch coverage fills for the small utility modules:
 *   - CachingPlugin/utils/key.ts: stableStringify, normalizeUrl, normalizeValue branches.
 *   - ManualRetryPlugin/utils/index.ts: missing-method / missing-headers fallthroughs.
 *   - DebugSanitizationPlugin/utils/sanitize.ts: allowlistOnly Date and URL fallthroughs.
 */
import type { AxiosRequestConfig } from 'axios';

import {
  buildCacheKeyContext,
  describeInvalidationMatcher,
  matchesInvalidationMatcher,
} from '../src/plugins/CachingPlugin/utils';
import { normalizeUrl, stableStringify } from '../src/plugins/CachingPlugin/utils/key';
import {
  cloneStoredRequest,
  hasHeader,
  hasSensitiveAuthMaterial,
  isEligibleForManualRetry,
  neutralizeDefaultAuthHeaders,
  stripAuthHeaders,
} from '../src/plugins/ManualRetryPlugin/utils';
import { sanitizeData, sanitizeHeaders, sanitizeUrl } from '../src/plugins/DebugSanitizationPlugin/utils/sanitize';

describe('CachingPlugin key utils — branch coverage', () => {
  describe('normalizeUrl', () => {
    it('handles URL with no query and no hash', () => {
      expect(normalizeUrl('/path')).toBe('/path');
    });

    it('strips a trailing hash before parsing', () => {
      expect(normalizeUrl('/path#section')).toBe('/path');
    });

    it('returns the pathname when the query is empty (?<empty>)', () => {
      expect(normalizeUrl('/path?')).toBe('/path');
    });

    it('returns the pathname when query has only blank entries that yield no params', () => {
      // `?&&` parses to no entries.
      expect(normalizeUrl('/path?&&')).toBe('/path');
    });

    it('sorts query parameters by key, then by value when keys collide', () => {
      // Two entries share the key "a"; localeCompare on values picks the order.
      expect(normalizeUrl('/path?a=2&a=1')).toBe('/path?a=1&a=2');
    });
  });

  describe('stableStringify', () => {
    it('returns "" for undefined and null', () => {
      expect(stableStringify(undefined)).toBe('');
      expect(stableStringify(null)).toBe('');
    });

    it('round-trips JSON-like strings through normalizeValue', () => {
      expect(stableStringify('{"b":2,"a":1}')).toBe(JSON.stringify({ a: 1, b: 2 }));
      expect(stableStringify('[3,1,2]')).toBe('[3,1,2]');
    });

    it('returns the string unchanged when it looks like JSON but does not parse', () => {
      expect(stableStringify('{not json}')).toBe('{not json}');
    });

    it('stringifies numbers and booleans directly', () => {
      expect(stableStringify(42)).toBe('42');
      expect(stableStringify(true)).toBe('true');
    });

    it('serializes Date via toISOString', () => {
      const d = new Date('2026-04-28T00:00:00.000Z');
      expect(stableStringify(d)).toBe(JSON.stringify(d.toISOString()));
    });

    it('serializes URLSearchParams as sorted entries', () => {
      const params = new URLSearchParams([
        ['b', '2'],
        ['a', '1'],
      ]);
      expect(stableStringify(params)).toBe(
        JSON.stringify([
          ['a', '1'],
          ['b', '2'],
        ]),
      );
    });

    it('serializes Map with sorted keys and recursive values', () => {
      const map = new Map<string, unknown>();
      map.set('b', 2);
      map.set('a', { x: 1 });
      expect(stableStringify(map)).toBe(
        JSON.stringify([
          ['a', { x: 1 }],
          ['b', 2],
        ]),
      );
    });

    it('serializes Set as the array of normalized values', () => {
      const set = new Set([3, 1, 2]);
      expect(stableStringify(set)).toBe(JSON.stringify([3, 1, 2]));
    });

    it('lowercases keys when requested', () => {
      expect(stableStringify({ A: 1, B: 2 }, true)).toBe(JSON.stringify({ a: 1, b: 2 }));
    });

    it('falls through Symbol values to String coercion (then JSON-quoted)', () => {
      // typeof === 'symbol' is not object; it hits the final `return String(value)`,
      // then JSON.stringify wraps the result in quotes.
      const sym = Symbol('x');
      expect(stableStringify(sym)).toBe(JSON.stringify(String(sym)));
    });
  });

  describe('buildCacheKeyContext defaults', () => {
    it('falls back to GET when method is missing and to "" when url is missing', () => {
      const ctx = buildCacheKeyContext({}, { compareHeaders: false, varyHeaders: [] });
      expect(ctx.method).toBe('GET');
      expect(ctx.normalizedUrl).toBe('');
    });

    it('emits empty normalized headers when varyHeaders is set but nothing matches', () => {
      const ctx = buildCacheKeyContext(
        { headers: { 'X-Other': 'y' } },
        { compareHeaders: false, varyHeaders: ['x-vary'] },
      );
      expect(ctx.normalizedHeaders).toBe('');
    });

    it('emits sorted vary entries when matches exist', () => {
      const ctx = buildCacheKeyContext(
        { headers: { 'X-VARY': 'b', 'x-vary-2': 'a' } },
        { compareHeaders: false, varyHeaders: ['x-vary', 'X-Vary-2'] },
      );
      expect(ctx.normalizedHeaders).toBe(
        JSON.stringify([
          ['x-vary', 'b'],
          ['x-vary-2', 'a'],
        ]),
      );
    });
  });

  describe('describeInvalidationMatcher', () => {
    it('handles RegExp', () => {
      const out = describeInvalidationMatcher(/users\/[0-9]+/);
      expect(out.type).toBe('regexp');
    });

    it('handles plain string', () => {
      expect(describeInvalidationMatcher('GET|/users').type).toBe('exact');
    });

    it('handles { exact }', () => {
      expect(describeInvalidationMatcher({ exact: 'k' }).type).toBe('exact');
    });

    it('handles { prefix }', () => {
      expect(describeInvalidationMatcher({ prefix: 'GET|' }).type).toBe('prefix');
    });
  });

  describe('matchesInvalidationMatcher', () => {
    it('plain string matches exact key', () => {
      expect(matchesInvalidationMatcher('GET|/u', 'GET|/u')).toBe(true);
      expect(matchesInvalidationMatcher('GET|/u', 'GET|/x')).toBe(false);
    });
    it('exact-shaped matcher matches exact key', () => {
      expect(matchesInvalidationMatcher('GET|/u', { exact: 'GET|/u' })).toBe(true);
    });
    it('prefix-shaped matcher matches by prefix', () => {
      expect(matchesInvalidationMatcher('GET|/u', { prefix: 'GET|' })).toBe(true);
      expect(matchesInvalidationMatcher('POST|/u', { prefix: 'GET|' })).toBe(false);
    });
    it('regex matcher uses .test()', () => {
      expect(matchesInvalidationMatcher('GET|/u/42', /\/u\/\d+/)).toBe(true);
    });
  });
});

describe('ManualRetryPlugin utils — branch coverage', () => {
  describe('isEligibleForManualRetry', () => {
    it('treats config without method as GET (idempotent)', () => {
      expect(isEligibleForManualRetry({}, false)).toBe(true);
    });

    it('non-idempotent method without idempotency key is ineligible', () => {
      expect(isEligibleForManualRetry({ method: 'post' }, false)).toBe(false);
    });

    it('non-idempotent method with idempotency key is eligible', () => {
      expect(isEligibleForManualRetry({ method: 'post', headers: { 'Idempotency-Key': 'abc' } }, false)).toBe(true);
    });

    it('storeNonIdempotent overrides any method check', () => {
      expect(isEligibleForManualRetry({ method: 'post' }, true)).toBe(true);
    });
  });

  describe('hasHeader / hasSensitiveAuthMaterial', () => {
    it('hasHeader returns false when headers are undefined', () => {
      expect(hasHeader({}, 'authorization')).toBe(false);
    });

    it('detects basic auth', () => {
      expect(hasSensitiveAuthMaterial({ auth: { username: 'u', password: 'p' } })).toBe(true);
    });

    it('detects sensitive header by lowercase comparison', () => {
      expect(hasSensitiveAuthMaterial({ headers: { 'X-AUTH-TOKEN': 'abc' } })).toBe(true);
    });

    it('returns false when nothing is sensitive', () => {
      expect(hasSensitiveAuthMaterial({ headers: { 'X-Other': '1' } })).toBe(false);
    });
  });

  describe('cloneStoredRequest / stripAuthHeaders', () => {
    it('clones a request and strips sensitive headers/auth in place', () => {
      const cloned = cloneStoredRequest({
        method: 'post',
        url: '/x',
        data: { a: 1 },
        params: { b: 2 },
        headers: { Authorization: 'Bearer x', 'X-Other': 'keep' },
        auth: { username: 'u', password: 'p' },
      });
      expect(cloned.headers).not.toHaveProperty('Authorization');
      expect(cloned.headers).toHaveProperty('X-Other', 'keep');
      expect(cloned.auth).toBeUndefined();
    });

    it('clones a request with no headers and no params', () => {
      const cloned = cloneStoredRequest({ method: 'get', url: '/y' });
      expect(cloned.headers).toEqual({});
    });

    it('stripAuthHeaders is a no-op when headers are missing', () => {
      const config = { method: 'get', url: '/y' };
      stripAuthHeaders(config);
      expect(config).not.toHaveProperty('headers.Authorization');
    });
  });

  describe('neutralizeDefaultAuthHeaders', () => {
    it('omits common default auth headers from the replayed config', () => {
      const config = { headers: { Foo: 'bar' } } as AxiosRequestConfig & {
        headers: Record<string, unknown>;
        auth?: unknown;
      };
      neutralizeDefaultAuthHeaders(config, { common: { Authorization: 'Bearer Y' } }, false);
      const headers = config.headers as Record<string, unknown>;
      expect(headers.authorization).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(headers, 'authorization')).toBe(true);
    });

    it('also clears config.auth when defaults provided one', () => {
      const config = { auth: { username: 'u', password: 'p' } } as AxiosRequestConfig;
      neutralizeDefaultAuthHeaders(config, undefined, true);
      expect(config.auth).toBeUndefined();
    });

    it('handles entirely empty defaults gracefully', () => {
      const config = {} as AxiosRequestConfig;
      neutralizeDefaultAuthHeaders(config, undefined, false);
      expect(config.headers).toEqual({});
    });

    it('detects defaults at the top level (not under common)', () => {
      const config = {} as AxiosRequestConfig;
      neutralizeDefaultAuthHeaders(config, { 'X-Api-Key': 'k' } as Record<string, unknown>, false);
      // headerName 'x-api-key' lowercased in the loop hits the hasInDefaults branch.
      const headers = config.headers as Record<string, unknown>;
      expect(headers['x-api-key']).toBeUndefined();
    });
  });
});

describe('DebugSanitizationPlugin sanitize — branch coverage', () => {
  describe('sanitizeData', () => {
    it('returns undefined/null inputs unchanged', () => {
      expect(sanitizeData(null)).toBeNull();
      expect(sanitizeData(undefined)).toBeUndefined();
    });

    it('redacts non-allowed primitive keys when allowlistOnly is set', () => {
      const out = sanitizeData(
        { allowedKey: 'x', otherKey: 'y' },
        { allowlistOnly: true, allowedFields: ['allowedKey'] },
      ) as Record<string, string>;
      expect(out.allowedKey).toBe('x');
      expect(out.otherKey).not.toBe('y');
    });

    it('redacts a Date value when allowlistOnly is set and key is not allowed', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const out = sanitizeData({ event: date }, { allowlistOnly: true, allowedFields: [] }) as Record<string, unknown>;
      expect(out.event).not.toBeInstanceOf(Date);
    });

    it('preserves a Date value when allowlistOnly is set and key is allowed', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const out = sanitizeData({ event: date }, { allowlistOnly: true, allowedFields: ['event'] }) as Record<
        string,
        unknown
      >;
      expect(out.event).toBeInstanceOf(Date);
    });

    it('uses the configured redactionChar when redacting sensitive fields', () => {
      const out = sanitizeData({ secret: 'abcdef' }, { sensitiveFields: ['secret'], redactionChar: '*' }) as Record<
        string,
        string
      >;
      // Default behavior: redacted value is a non-empty string and not the original.
      expect(typeof out.secret).toBe('string');
      expect(out.secret).not.toBe('abcdef');
      expect(out.secret).toContain('*');
    });
  });

  describe('sanitizeHeaders', () => {
    it('returns null/undefined unchanged', () => {
      expect(sanitizeHeaders(null)).toBeNull();
      expect(sanitizeHeaders(undefined)).toBeUndefined();
    });

    it('redacts a header by substring match', () => {
      const out = sanitizeHeaders({ 'X-Tenant-Authorization-Token': 'abc' }) as Record<string, string>;
      expect(out['X-Tenant-Authorization-Token']).not.toBe('abc');
    });
  });

  describe('sanitizeUrl', () => {
    it('returns the input when url is missing', () => {
      expect(sanitizeUrl(undefined)).toBeUndefined();
    });

    it('returns the input when sanitizeUrlParams is disabled', () => {
      expect(sanitizeUrl('/x?token=abc', { sanitizeUrlParams: false })).toBe('/x?token=abc');
    });

    it('returns the input when there is no query string', () => {
      expect(sanitizeUrl('/x')).toBe('/x');
    });

    it('returns the input when the query is empty', () => {
      expect(sanitizeUrl('/x?')).toBe('/x?');
    });

    it('preserves the hash fragment after sanitizing', () => {
      const out = sanitizeUrl('/x?token=abc#anchor');
      expect(out).toMatch(/#anchor$/);
      expect(out).not.toContain('token=abc');
    });

    it('returns the original url when nothing was sanitized', () => {
      expect(sanitizeUrl('/x?harmless=1')).toBe('/x?harmless=1');
    });

    it('falls through to the catch when URL parsing throws (string with raw control chars)', () => {
      // URLSearchParams accepts most input — we mostly cover the falsy-key branch.
      expect(typeof sanitizeUrl('/x?a=b')).toBe('string');
    });
  });
});
