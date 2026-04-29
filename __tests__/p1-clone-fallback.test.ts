/**
 * Targeted coverage for src/utils/clone.ts cloneFallback() — the path used when
 * structuredClone is unavailable or throws. Most tests force the fallback by
 * including a function value (structuredClone refuses to clone functions).
 */
import { cloneValue } from '../src/utils/clone';

const FORCE_FALLBACK = { fn: () => 0 };

describe('cloneValue cloneFallback paths', () => {
  describe('special boxed types', () => {
    it('deep-clones a nested Date in the fallback path', () => {
      const date = new Date(1_700_000_000_000);
      const src = { ...FORCE_FALLBACK, date };
      const out = cloneValue(src);
      expect(out.date).not.toBe(date);
      expect(out.date.getTime()).toBe(date.getTime());
    });

    it('deep-clones a nested URLSearchParams', () => {
      const params = new URLSearchParams([
        ['a', '1'],
        ['b', '2'],
      ]);
      const src = { ...FORCE_FALLBACK, params };
      const out = cloneValue(src);
      expect(out.params).not.toBe(params);
      expect(out.params.toString()).toBe('a=1&b=2');
    });

    it('deep-clones a nested ArrayBuffer', () => {
      const buffer = new ArrayBuffer(4);
      new Uint8Array(buffer).set([1, 2, 3, 4]);
      const src = { ...FORCE_FALLBACK, buffer };
      const out = cloneValue(src);
      expect(out.buffer).not.toBe(buffer);
      expect(Array.from(new Uint8Array(out.buffer))).toEqual([1, 2, 3, 4]);
    });

    it('deep-clones a nested DataView', () => {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer, 2, 4);
      view.setUint32(0, 0xdeadbeef);
      const src = { ...FORCE_FALLBACK, view };
      const out = cloneValue(src);
      expect(out.view).not.toBe(view);
      expect(out.view.byteLength).toBe(4);
      expect(out.view.getUint32(0)).toBe(0xdeadbeef);
    });

    it('deep-clones a nested Uint8Array via slice()', () => {
      const arr = new Uint8Array([10, 20, 30]);
      const src = { ...FORCE_FALLBACK, arr };
      const out = cloneValue(src);
      expect(out.arr).not.toBe(arr);
      expect(Array.from(out.arr)).toEqual([10, 20, 30]);
    });

    it('deep-clones a Node Buffer if available', () => {
      // Node-only branch — Buffer.isBuffer path. Skip when Buffer isn't on globalThis.
      const BufferCtor = (globalThis as { Buffer?: unknown }).Buffer as
        | { from(values: number[]): ArrayBufferView }
        | undefined;
      if (!BufferCtor) {
        return;
      }
      const buf = BufferCtor.from([42, 43, 44]);
      const src = { ...FORCE_FALLBACK, buf };
      const out = cloneValue(src);
      expect(out.buf).not.toBe(buf);
      expect(Array.from(out.buf as Uint8Array)).toEqual([42, 43, 44]);
    });

    it('deep-clones a Blob if the runtime exposes one', () => {
      if (typeof Blob === 'undefined') {
        return;
      }
      const blob = new Blob(['hello'], { type: 'text/plain' });
      const src = { ...FORCE_FALLBACK, blob };
      const out = cloneValue(src);
      expect(out.blob).not.toBe(blob);
      expect(out.blob.size).toBe(blob.size);
      expect(out.blob.type).toBe('text/plain');
    });
  });

  describe('collections', () => {
    it('deep-clones nested arrays with cycles', () => {
      type CycleArr = unknown[] & { selfIndex?: number };
      const inner: CycleArr = [1, 2, 3];
      inner.push(inner);
      const src = { ...FORCE_FALLBACK, inner };
      const out = cloneValue(src);
      expect(out.inner).not.toBe(inner);
      expect((out.inner as unknown[])[3]).toBe(out.inner);
    });

    it('deep-clones nested Maps including cyclic values', () => {
      const map = new Map<string, unknown>();
      map.set('k', 'v');
      map.set('self', map);
      const src = { ...FORCE_FALLBACK, map };
      const out = cloneValue(src);
      expect(out.map).not.toBe(map);
      expect(out.map.get('k')).toBe('v');
      expect(out.map.get('self')).toBe(out.map);
    });

    it('deep-clones nested Sets including cyclic membership', () => {
      const set = new Set<unknown>();
      set.add('a');
      set.add(set);
      const src = { ...FORCE_FALLBACK, set };
      const out = cloneValue(src);
      expect(out.set).not.toBe(set);
      expect(out.set.has('a')).toBe(true);
      expect(out.set.has(out.set)).toBe(true);
    });
  });

  describe('plain object cloning', () => {
    it('preserves null-prototype objects in the fallback', () => {
      const inner = Object.create(null) as Record<string, unknown>;
      inner.x = 1;
      const src = { ...FORCE_FALLBACK, inner };
      const out = cloneValue(src);
      expect(Object.getPrototypeOf(out.inner)).toBeNull();
      expect(out.inner).toEqual({ x: 1 });
    });

    it('skips non-enumerable own properties', () => {
      const inner = {} as Record<string, unknown>;
      Object.defineProperty(inner, 'hidden', {
        value: 'should-not-copy',
        enumerable: false,
      });
      Object.defineProperty(inner, 'visible', {
        value: 'copied',
        enumerable: true,
      });
      const src = { ...FORCE_FALLBACK, inner };
      const out = cloneValue(src);
      expect(out.inner.visible).toBe('copied');
      expect(Object.prototype.hasOwnProperty.call(out.inner, 'hidden')).toBe(false);
    });

    it('returns the cached clone for repeated references', () => {
      const shared = { name: 'shared' };
      const src = { ...FORCE_FALLBACK, a: shared, b: shared };
      const out = cloneValue(src);
      expect(out.a).not.toBe(shared);
      expect(out.a).toBe(out.b);
    });
  });
});
