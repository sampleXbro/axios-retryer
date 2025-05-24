const axios = require('axios');
const { performance } = require('perf_hooks');
const { CircuitBreakerPlugin } = require('../dist/plugins/CircuitBreakerPlugin.cjs');
const { RetryManager } = require('../dist/index.cjs');

// Mock adapter for circuit breaker testing
function createMockAdapter() {
  return async function mockAdapter(config) {
    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5)); // 5-15ms
    
    // Generate random status codes - ~30% errors (500..599), ~70% success (200..299)
    const roll = Math.random();
    let status;
    if (roll < 0.7) {
      status = 200 + Math.floor(Math.random() * 100); // 200-299
    } else {
      status = 500 + Math.floor(Math.random() * 100); // 500-599
    }
    
    if (status >= 500) {
      const error = new Error(`Request failed with status code ${status}`);
      error.response = {
        data: { error: 'Server error' },
        status: status,
        statusText: 'Server Error',
        headers: {},
        config: config
      };
      error.config = config;
      throw error;
    }
    
    return {
      data: { success: true, status },
      status: status,
      statusText: 'OK',
      headers: {},
      config: config
    };
  };
}

// The total number of requests and concurrency limit can be tweaked.
const TOTAL_REQUESTS = 2000; // Reduced for faster benchmarking
const MAX_CONCURRENT = 100;

(async function main() {
  console.log(`Starting high-load test with ${TOTAL_REQUESTS} requests, max concurrency = ${MAX_CONCURRENT}...`);

  // 1. Create an Axios instance.
  const axiosInstance = axios.create({
    timeout: 5000,  // e.g., 5s timeout
  });
  
  // Use mock adapter for faster testing
  axiosInstance.defaults.adapter = createMockAdapter();

  // 2. Create a RetryManager for your plugin to attach to.
  const retryManager = new RetryManager({ axiosInstance });

  // 3. Create and configure the CircuitBreakerPlugin with low thresholds to see it trip often.
  const circuitBreaker = new CircuitBreakerPlugin({
    failureThreshold: 3,
    openTimeout: 200,  // 15s before half-open
    halfOpenMax: 1,      // Allow 1 request in half-open
  });

  // 4. Register the plugin.
  retryManager.use(circuitBreaker);

  // 5. Function to execute a single request with mock adapter
  async function makeRequest(index) {
    const url = `/api/test/${index}`;
    try {
      const response = await axiosInstance.get(url);
      return { index, success: true, status: response.status };
    } catch (err) {
      return { index, success: false, error: err.message };
    }
  }

  // 6. Queue-based concurrency control: we only allow MAX_CONCURRENT promises in flight at a time.
  //    We'll store all results in an array for final summary.
  const results = [];

  // We'll create an array of all request indexes, then consume them with concurrency limit.
  const tasks = Array.from({ length: TOTAL_REQUESTS }, (_, i) => i);

  console.time('HighLoadBenchmark');
  const startTime = performance.now();

  let inFlight = 0;
  let taskIndex = 0;

  // We wrap this in a promise so we can await until all tasks finish.
  await new Promise((resolve) => {
    function launchNext() {
      // If no tasks remain, check if all tasks are done.
      if (taskIndex >= tasks.length) {
        if (inFlight === 0) {
          resolve();
        }
        return;
      }

      // Otherwise, launch the next task.
      const currentIndex = taskIndex++;
      inFlight++;
      makeRequest(currentIndex)
        .then((res) => {
          results[currentIndex] = res;
        })
        .catch((err) => {
          results[currentIndex] = { index: currentIndex, success: false, error: String(err) };
        })
        .finally(() => {
          inFlight--;
          // Launch the next task in the queue.
          launchNext();
        });
    }

    // Launch initial batch of tasks up to MAX_CONCURRENT.
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      launchNext();
    }
  });

  console.timeEnd('HighLoadBenchmark');
  const durationMs = performance.now() - startTime;

  // Summarize results
  const successCount = results.filter((r) => r && r.success).length;
  const failureCount = results.filter((r) => r && !r.success).length;

  console.log(`Completed ${TOTAL_REQUESTS} requests in ${durationMs.toFixed(2)}ms`);
  console.log(`Success: ${successCount}, Failure: ${failureCount}`);
  console.log('Sample failures:', results.filter((r) => r && !r.success).slice(0, 5));
})();