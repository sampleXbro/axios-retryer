type PropertyBag = Record<PropertyKey, unknown>;

function cloneArrayBufferView(value: ArrayBufferView): ArrayBufferView {
  const bufferConstructor =
    typeof globalThis !== 'undefined'
      ? (globalThis as { Buffer?: { isBuffer(value: unknown): boolean; from(value: ArrayBufferView): unknown } }).Buffer
      : undefined;

  if (bufferConstructor?.isBuffer(value)) {
    return bufferConstructor.from(value) as ArrayBufferView;
  }

  if (value instanceof DataView) {
    return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  const sliceableView = value as ArrayBufferView & { slice?: () => ArrayBufferView };
  if (typeof sliceableView.slice === 'function') {
    return sliceableView.slice();
  }

  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function cloneFallback<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return new URLSearchParams(value.toString()) as T;
  }

  if (typeof ArrayBuffer !== 'undefined') {
    if (value instanceof ArrayBuffer) {
      return value.slice(0) as T;
    }

    if (ArrayBuffer.isView(value)) {
      return cloneArrayBufferView(value) as T;
    }
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value.slice(0, value.size, value.type) as T;
  }

  const seenValue = seen.get(value as object);
  if (seenValue !== undefined) {
    return seenValue as T;
  }

  if (Array.isArray(value)) {
    const clonedArray: unknown[] = [];
    seen.set(value, clonedArray);

    value.forEach((entry, index) => {
      clonedArray[index] = cloneFallback(entry, seen);
    });

    return clonedArray as T;
  }

  if (value instanceof Map) {
    const clonedMap = new Map<unknown, unknown>();
    seen.set(value, clonedMap);

    value.forEach((entryValue, key) => {
      clonedMap.set(cloneFallback(key, seen), cloneFallback(entryValue, seen));
    });

    return clonedMap as T;
  }

  if (value instanceof Set) {
    const clonedSet = new Set<unknown>();
    seen.set(value, clonedSet);

    value.forEach((entryValue) => {
      clonedSet.add(cloneFallback(entryValue, seen));
    });

    return clonedSet as T;
  }

  const jsonValue = value as unknown as { toJSON?: () => unknown };
  let jsonSerializable: unknown = value;
  if (typeof jsonValue.toJSON === 'function') {
    try {
      jsonSerializable = jsonValue.toJSON();
    } catch {
      // toJSON threw — fall through to plain-object cloning below
    }
  }

  if (jsonSerializable !== value) {
    return cloneFallback(jsonSerializable as T, seen);
  }

  const prototype = Object.getPrototypeOf(value);
  const clonedObject = (prototype === null ? Object.create(null) : Object.create(prototype)) as PropertyBag;
  seen.set(value as object, clonedObject);

  Reflect.ownKeys(value as object).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (!descriptor?.enumerable) {
      return;
    }

    clonedObject[key] = cloneFallback((value as PropertyBag)[key], seen);
  });

  return clonedObject as T;
}

export function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (_error) {
      // Fall back to the compatibility clone below.
    }
  }

  return cloneFallback(value);
}
