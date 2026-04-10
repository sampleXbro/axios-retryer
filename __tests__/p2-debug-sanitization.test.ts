/**
 * P2 coverage for TEST_GAP_ANALYSIS.md §18 DebugSanitizationPlugin / sanitize helpers.
 * Complements __tests__/sanitize.test.ts and __tests__/DebugSanitizationPlugin.test.ts.
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import { DebugSanitizationPlugin } from '../src/plugins/DebugSanitizationPlugin';
import { sanitizeData, sanitizeHeaders, sanitizeUrl } from '../src/plugins/DebugSanitizationPlugin/sanitize';

describe('P2 DebugSanitizationPlugin & sanitize (§18)', () => {
  describe('§18.1 Headers', () => {
    it('18.1.1 Authorization header is redacted by default', () => {
      expect(
        sanitizeHeaders({
          Authorization: 'Bearer s',
          'Content-Type': 'application/json',
        }),
      ).toMatchObject({ Authorization: '********', 'Content-Type': 'application/json' });
    });

    it('18.1.2 custom sensitiveHeaders redacts additional names', () => {
      const out = sanitizeHeaders(
        { 'X-Custom-Secret': 'hide-me', Accept: 'application/json' },
        { sensitiveHeaders: ['X-Custom-Secret'] },
      );
      expect(out).toMatchObject({ 'X-Custom-Secret': '********', Accept: 'application/json' });
    });

    it('18.1.3 header matching is case-insensitive', () => {
      expect(sanitizeHeaders({ AUTHORIZATION: 'z', authorization: 'a' })).toMatchObject({
        AUTHORIZATION: '********',
        authorization: '********',
      });
    });

    it('18.1.4 Content-Type and Accept are not redacted by default', () => {
      const out = sanitizeHeaders({
        'Content-Type': 'text/plain',
        Accept: '*/*',
        'X-Api-Key': 'k',
      });
      expect(out).toMatchObject({
        'Content-Type': 'text/plain',
        Accept: '*/*',
        'X-Api-Key': '********',
      });
    });

    it('18.1.5 OBSERVED: sensitiveHeaders: [] still merges built-in sensitive list (Authorization redacted)', () => {
      const out = sanitizeHeaders({ Authorization: 'x', 'X-Plain': 'y' }, { sensitiveHeaders: [] });
      expect(out).toMatchObject({ Authorization: '********', 'X-Plain': 'y' });
    });
  });

  describe('§18.2 URL', () => {
    it('18.2.1 query param names matching sensitive keys are redacted (e.g. api_key)', () => {
      expect(sanitizeUrl('/r?api_key=secret&ok=1')).toBe('/r?api_key=********&ok=1');
    });

    it('18.2.2 path segments are not rewritten (only query string is sanitized)', () => {
      expect(sanitizeUrl('/users/alice/settings')).toBe('/users/alice/settings');
    });

    it('18.2.3 URL without query is unchanged', () => {
      expect(sanitizeUrl('/api/v1')).toBe('/api/v1');
    });
  });

  describe('§18.3 Body', () => {
    it('18.3.1 default sensitive field names in nested object are redacted', () => {
      const out = sanitizeData({ user: { name: 'a', password: 'p', token: 't' } }, { allowlistOnly: false });
      expect(out).toEqual({
        user: { name: 'a', password: '********', token: '********' },
      });
    });

    it('18.3.5 custom redactionChar is used (length remains 8 in current implementation)', () => {
      const out = sanitizeData({ secret: 'x' }, { allowlistOnly: false, redactionChar: 'X' });
      expect(out).toEqual({ secret: 'XXXXXXXX' });
    });
  });

  describe('§18.4 Plugin lifecycle', () => {
    it('18.4.1 after unuse(DebugSanitizationPlugin) sanitized request logs stop', async () => {
      const instance = axios.create();
      const manager = new RetryManager({ debug: true, axiosInstance: instance });
      const plugin = new DebugSanitizationPlugin();
      manager.use(plugin);
      const mock = new MockAdapter(instance);
      const debug = jest.spyOn(manager.getLogger(), 'debug').mockImplementation();

      mock.onGet('/a').reply(200);
      await instance.get('/a');
      expect(debug.mock.calls.some((c) => String(c[0]).includes('DebugSanitizationPlugin'))).toBe(true);

      debug.mockClear();
      expect(manager.unuse('DebugSanitizationPlugin')).toBe(true);
      mock.onGet('/b').reply(200);
      await instance.get('/b');
      expect(debug.mock.calls.some((c) => String(c[0]).includes('DebugSanitizationPlugin'))).toBe(false);

      mock.restore();
      manager.destroy();
    });

    it('18.4.2 debug: false — RetryLogger does not write console.debug (plugin still registers interceptors)', async () => {
      const instance = axios.create();
      const manager = new RetryManager({ debug: false, axiosInstance: instance }).use(new DebugSanitizationPlugin());
      const mock = new MockAdapter(instance);
      const consoleDebug = jest.spyOn(console, 'debug').mockImplementation();
      mock.onGet('/q').reply(200);
      await instance.get('/q');
      expect(consoleDebug).not.toHaveBeenCalled();
      consoleDebug.mockRestore();
      mock.restore();
      manager.destroy();
    });

    it('18.4.3 circular reference in body does not infinite-loop sanitizeData', () => {
      const data: Record<string, unknown> = { a: 1 };
      data.loop = data;
      expect(() => sanitizeData(data, { allowlistOnly: false })).not.toThrow();
      const out = sanitizeData(data, { allowlistOnly: false });
      expect(out).toBeDefined();
    });
  });
});
