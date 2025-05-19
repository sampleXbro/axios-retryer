/**
 * Utilities for memory management in performance tests
 */

/**
 * Safe wrapper for process.memoryUsage, returns 0 if not available
 */
export function getMemoryUsage(): number {
  try {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      return process.memoryUsage().heapUsed / 1024 / 1024; // MB
    }
  } catch (e) {
    console.log('Warning: process.memoryUsage() not available');
  }
  return 0;
}

/**
 * Tries to run garbage collection if available
 */
export function tryGC(): void {
  try {
    // @ts-ignore - global.gc may not be defined in TypeScript
    if (typeof global !== 'undefined' && typeof global.gc === 'function') {
      // @ts-ignore
      global.gc();
    }
  } catch (e) {
    console.log('Warning: global.gc() not available');
  }
}

/**
 * Calculates memory impact safely
 */
export function calculateMemoryImpact(before: number, after: number): number {
  if (before === 0 || after === 0) {
    return 0; // Memory measurement not available
  }
  return after - before;
} 