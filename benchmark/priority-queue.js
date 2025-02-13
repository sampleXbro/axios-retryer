const { RetryManager } = require('../dist/index.cjs');
const { performance } = require('perf_hooks');

// Total number of requests to process
const totalRequests = 10000;
// Record the start time globally so that event handlers can use it
const start = performance.now();

// Initialize the retry manager with a maximum of 100 concurrent requests
const manager = new RetryManager({ maxConcurrentRequests: 100 });

// Event listener for when a retry is about to occur.
// This logs the current number of in-progress requests.
manager.on('beforeRetry', () => {
  console.log(`CONCURRENT REQUESTS: ${manager.requestQueue.inProgressCount}`);
});

// Event listener for when the entire retry process is finished.
// This logs aggregated metrics along with the elapsed time.
manager.on('onRetryProcessFinished', () => {
  const metrics = manager.getMetrics();
  console.log(
    `(Event) Processed ${totalRequests} requests in ${performance.now() - start}ms`
  );
  console.log(`Metrics: ${JSON.stringify(metrics, null, 2)}`);
  console.log(`Active requests: ${manager.activeRequests.size}`);
  console.log(`Requests store count: ${manager.requestStore.getAll().length}`);
});

// Main benchmark runner function
async function runBenchmark() {
  // Generate an array of promises representing each HTTP GET request.
  // Each request targets a URL that returns a status code between 200 and 599.
  const requests = Array.from({ length: totalRequests }).map((_, i) => {
    const status = 200 + (i % 400); // Cycles through status codes 200-599
    return manager.axiosInstance
      .get(`https://httpbin.org/status/${status}`, {
        __priority: i % 5 // Mixed priorities from 0 to 4
      })
      .catch((err) => {
        // Optionally log individual errors here if needed.
        // For now, simply return the error so Promise.all doesn't reject early.
        return err;
      });
  });

  // Wait until all requests have been processed.
  await Promise.all(requests);

  // Once done, compute and log the final metrics.
  const elapsedTime = performance.now() - start;
  console.log(`\nProcessed ${totalRequests} requests in ${elapsedTime.toFixed(2)}ms`);
}

// Run the benchmark and catch any unexpected errors.
runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
});