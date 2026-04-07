import { calculateMemoryImpact, getMemoryUsage, tryGC } from './utils/memory-utils';

describe('memory utils', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as typeof globalThis & { gc?: () => void }).gc;
  });

  test('reads memory usage when process.memoryUsage is available', () => {
    const memoryUsageSpy = jest.spyOn(process, 'memoryUsage').mockReturnValue({
      arrayBuffers: 0,
      external: 0,
      heapTotal: 0,
      heapUsed: 8 * 1024 * 1024,
      rss: 0,
    });

    expect(getMemoryUsage()).toBe(8);
    expect(memoryUsageSpy).toHaveBeenCalled();
  });

  test('returns zero when memory usage cannot be read', () => {
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('unsupported');
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    expect(getMemoryUsage()).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('Warning: process.memoryUsage() not available');
  });

  test('runs global garbage collection when available', () => {
    const gcSpy = jest.fn();
    (global as typeof globalThis & { gc?: () => void }).gc = gcSpy;

    tryGC();

    expect(gcSpy).toHaveBeenCalled();
  });

  test('calculates memory deltas with zero-safe fallback', () => {
    expect(calculateMemoryImpact(0, 10)).toBe(0);
    expect(calculateMemoryImpact(10, 0)).toBe(0);
    expect(calculateMemoryImpact(10, 14)).toBe(4);
  });
});
