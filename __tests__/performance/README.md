# Performance Tests for axios-retryer

This directory contains performance tests for key aspects of the axios-retryer library. These tests help identify potential bottlenecks and measure the performance impact of different configurations.

## Test Categories

### 1. Priority Queue Performance

These tests evaluate the efficiency of the priority queue implementation, focusing on:
- Binary insertion performance with different priority patterns (random, ascending, descending)
- Queue scheduling efficiency with mixed priority distributions

**Key file:** `priority-queue-performance.test.ts`

**Note:** Due to memory constraints in some environments, this test is currently configured as documentation-only. The RequestQueue implementation has been optimized to address these memory issues.

### 2. Queue Delay Impact

These tests measure how different queue delay values affect:
- Request throughput under different delay configurations
- Retry performance and the impact of delays on retry efficiency

**Key file:** `queue-delay-impact.test.ts`

### 3. Request Store Performance

These tests analyze the memory and performance characteristics of the request store:
- Impact of different store sizes on memory usage and execution time
- Performance under high load with different store configurations

**Key file:** `request-store-performance.test.ts`

### 4. Sanitization Overhead

These tests measure the performance impact of data sanitization:
- Overhead of different sanitization configurations
- Scaling behavior of sanitization with increasing request volume

**Key file:** `sanitization-overhead.test.ts`

## Running Tests

```bash
# Run all performance tests
npm test -- __tests__/performance

# Run a specific performance test
npm test -- __tests__/performance/queue-delay-impact.test.ts
```

## Memory Optimizations

The RequestQueue implementation has been optimized to reduce memory usage:

1. **Resource Cleanup**: Added `clear()` and `destroy()` methods to properly clean up resources
2. **Reference Management**: Improved handling of request references
3. **Timer Management**: Better management of setTimeout references
4. **Binary Insertion Optimization**: Fast paths for common insertion patterns
5. **Reduced Array Copying**: Removed unnecessary array copying

## Interpreting Results

The performance tests primarily output metrics to the console, including:
- Execution times
- Memory usage (where available)
- Overhead percentages compared to baselines

These metrics should be used as relative comparisons rather than absolute benchmarks since they can vary significantly between environments.

## Notes for Test Environments

- Memory measurements may not be available in all environments
- Tests use relaxed assertions to avoid environment-specific failures
- Tests have extended timeouts (30-60s) to accommodate larger workloads
- Some tests adapt to available Node.js features (e.g., garbage collection)

## Analyzing Bottlenecks

When reviewing the test results, look for:
1. **Non-linear scaling** - Indicates potential algorithmic inefficiency
2. **Excessive memory usage** - May point to memory management issues
3. **Disproportionate overhead** - Features with unexpectedly high costs
4. **Priority inversion** - Cases where higher priority requests are delayed more than lower ones 