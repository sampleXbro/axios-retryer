import { cloneValue } from '../src/utils/clone';

describe('cloneValue', () => {
  it('clones plain objects deeply', () => {
    const src = { a: 1, b: { c: [1, 2, 3] } };
    const out = cloneValue(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.b).not.toBe(src.b);
    expect(out.b.c).not.toBe(src.b.c);
  });

  it('preserves Date instance values', () => {
    const d = new Date(1_700_000_000_000);
    const out = cloneValue(d);
    // structuredClone() may return a Date from a different realm in Jest;
    // value equality is what callers care about.
    expect(out.getTime()).toBe(d.getTime());
    expect(out).not.toBe(d);
  });

  it('uses toJSON() when the property is a callable (in cloneFallback path)', () => {
    // structuredClone refuses to clone functions, which forces cloneFallback to run.
    // Without the hasToJson guard, a non-function toJSON could be invoked here.
    const src = {
      // Force structuredClone to throw by including a function value.
      fn: () => 1,
      toJSON(): { kind: string } {
        return { kind: 'serialized' };
      },
    };
    const out = cloneValue(src) as unknown as { kind: string };
    expect(out).toEqual({ kind: 'serialized' });
  });

  it('does NOT call toJSON when it is not a function (number, string, object, null)', () => {
    // Each src has `fn` to force the cloneFallback path.
    const cases: Array<Record<string, unknown>> = [
      { fn: () => 0, toJSON: 123, value: 1 },
      { fn: () => 0, toJSON: 'not a fn', value: 2 },
      { fn: () => 0, toJSON: { nested: true }, value: 3 },
      { fn: () => 0, toJSON: null, value: 4 },
    ];

    for (const src of cases) {
      // Without the guard, `typeof undefined === 'function'` is false but
      // `typeof 123 === 'function'` is also false — so the guard would not
      // matter for these cases at runtime. However we want to assert the
      // behavior contract: clone returns plain object equal to src.
      const out = cloneValue(src);
      expect(out.value).toEqual(src.value);
      expect(out.toJSON).toEqual(src.toJSON);
      expect(out).not.toBe(src);
    }
  });

  it('falls back when toJSON throws (in cloneFallback path)', () => {
    const src = {
      fn: () => 0,
      toJSON(): never {
        throw new Error('boom');
      },
      payload: { ok: true },
    };

    const out = cloneValue(src) as unknown as { payload: { ok: boolean } };
    expect(out.payload).toEqual({ ok: true });
  });

  it('handles cyclic objects without stack overflow', () => {
    type Cycle = { name: string; self?: Cycle };
    const src: Cycle = { name: 'root' };
    src.self = src;

    const out = cloneValue(src);
    expect(out.name).toBe('root');
    expect(out.self).toBe(out);
  });

  it('returns primitives unchanged', () => {
    expect(cloneValue(1)).toBe(1);
    expect(cloneValue('s')).toBe('s');
    expect(cloneValue(null)).toBe(null);
    expect(cloneValue(undefined)).toBe(undefined);
  });
});
