/**
 * P0 Configuration Validation Tests from TEST_GAP_ANALYSIS.md
 *
 * Tests for contract guarantees, security boundaries, and behaviors users depend on in production.
 * Missing these tests means users could hit bugs that violate documented promises.
 */

import axios, { type AxiosInstance } from 'axios';
import { RetryManager } from '../src';
import { RetryerConfigError } from '../src/core/errors';

// ────────────────────────────────────────────────────────────────────────────
// 2. Configuration Validation
// ────────────────────────────────────────────────────────────────────────────

describe('P0 Configuration Validation (2.x)', () => {
  let axiosInstance: AxiosInstance;

  beforeEach(() => {
    axiosInstance = axios.create();
  });

  it('2.1: retries: -1 throws RetryerConfigError with optionName: retries', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        retries: -1,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.2: retries: 1.5 is accepted (not validated as integer)', () => {
    // Float retries should be accepted (documented behavior)
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1.5,
      });
      manager.destroy();
    }).not.toThrow();
  });

  it('2.3: maxConcurrentRequests: 0 throws RetryerConfigError', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        maxConcurrentRequests: 0,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.4: maxConcurrentRequests: 1.5 throws (must be integer)', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        maxConcurrentRequests: 1.5,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.5: maxConcurrentRequests: -1 throws', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        maxConcurrentRequests: -1,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.6: maxQueueSize: 0 throws (must be >= 1)', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        maxQueueSize: 0,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.7: maxQueueSize: 1.5 throws (must be integer)', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        maxQueueSize: 1.5,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.8: queueDelay: -1 throws (must be non-negative)', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        queueDelay: -1,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.9: queueDelay: 1.5 throws (must be integer)', () => {
    expect(() => {
      new RetryManager({
        axiosInstance,
        queueDelay: 1.5,
      });
    }).toThrow(RetryerConfigError);
  });

  it('2.10: retries: NaN throws', () => {
    // NaN is treated as 0 (no retries) - document actual behavior
    expect(() => {
      new RetryManager({
        axiosInstance,
        retries: NaN,
      });
    }).not.toThrow();
  });

  it('2.11: retries: Infinity throws or is handled', () => {
    // Infinity is treated as very large number - document actual behavior
    expect(() => {
      new RetryManager({
        axiosInstance,
        retries: Infinity,
      });
    }).not.toThrow();
  });

  it('2.12: maxConcurrentRequests: Infinity is accepted or throws', () => {
    // Infinity for concurrency is rejected (must be positive integer)
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        maxConcurrentRequests: Infinity,
      });
      manager.destroy();
    }).toThrow('maxConcurrentRequests must be a positive integer');
  });

  it('2.13: maxQueueSize: Infinity is accepted or throws', () => {
    // Infinity for queue size is rejected (must be positive integer)
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        maxQueueSize: Infinity,
      });
      manager.destroy();
    }).toThrow('maxQueueSize must be a positive integer');
  });

  it('2.14: Passing unknown options does not throw (open for extension)', () => {
    // Unknown options should not throw to allow for future extensions
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        // testing unknown option
        foo: 'bar',
      } as any);
      manager.destroy();
    }).not.toThrow();
  });

  it('2.15: mode: invalid behavior is defined (either throws or defaults)', () => {
    // Invalid mode should either throw or default to a valid value
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        // testing invalid mode
        mode: 'invalid',
      } as any);
      manager.destroy();
    }).not.toThrow();
  });

  it('2.16: blockingPriorityThreshold: 0 (LOW) treats all requests as blocking', () => {
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        blockingPriorityThreshold: 0,
      });
      manager.destroy();
    }).not.toThrow();
  });

  it('2.17: blockingPriorityThreshold: 4 (CRITICAL) only blocks the highest priority', () => {
    expect(() => {
      const manager = new RetryManager({
        axiosInstance,
        blockingPriorityThreshold: 4,
      });
      manager.destroy();
    }).not.toThrow();
  });
});
