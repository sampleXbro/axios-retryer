const { RetryManager } = require('../dist/index.cjs');
const { performance } = require('perf_hooks');

// Test 10K requests with mixed priorities
const manager = new RetryManager({ maxConcurrentRequests: 100 });
const start = performance.now();

Array.from({ length: 10000 }).forEach((_, i) => {
  const status = 200 + (i % 400); // 200-599 status codes
  manager.axiosInstance.get(`https://httpbin.org/status/${status}`, {
    __priority: i % 5
  }).catch(() => {});
});

manager.on('beforeRetry', () => {
  console.log(`CONCURRENT REQUESTS: ${manager.requestQueue.inProgressCount}`);
});

manager.on('onRetryProcessFinished', () => {
  const metrics = manager.getMetrics();
  console.log(`Processed 10K requests in ${performance.now() - start}ms, Metrics: ${JSON.stringify(metrics, null,2)}`);
  console.log(`Active requests: ${manager.activeRequests.size}, Requests store: ${manager.requestStore.getAll().length}`);
});