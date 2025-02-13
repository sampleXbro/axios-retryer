'use strict';

const axios = require('axios');
const { performance } = require('perf_hooks');
const { CachingPlugin } = require('../dist/plugins/CachingPlugin.cjs');
const { RetryManager } = require('../dist/index.cjs');

// Total number of requests and concurrency limit.
const TOTAL_REQUESTS = 10000;
const MAX_CONCURRENT = 100;

(async function main() {
  console.log(
    `Starting caching plugin benchmark with ${TOTAL_REQUESTS} requests, max concurrency = ${MAX_CONCURRENT}...`
  );

  // 1. Create an Axios instance.
  const axiosInstance = axios.create({
    timeout: 5000, // 5s timeout
  });

  // 2. Create a RetryManager that the plugin will attach to.
  const retryManager = new RetryManager({ axiosInstance });

  // 3. Create and configure the CachingPlugin.
  // Use default options (timeToRevalidate = 0 so cached responses never expire)
  const cachingPlugin = new CachingPlugin();

  // 4. Register the caching plugin.
  retryManager.use(cachingPlugin);

  // 5. Function to execute requests.
  async function makeRequest(index) {
    const url = `https://httpbin.org/anything/${Math. floor(Math.random() * 10) + 1}`;
    try {
      const response = await axiosInstance.get(url);
      return { index, success: true, status: response.status };
    } catch (err) {
      return { index, success: false, error: err.message };
    }
  }

  // 6. Queue-based concurrency control.
  const results = [];
  const tasks = Array.from({ length: TOTAL_REQUESTS }, (_, i) => i);

  console.time('CachingPluginBenchmark');
  const startTime = performance.now();

  let inFlight = 0;
  let taskIndex = 0;

  await new Promise((resolve) => {
    function launchNext() {
      // If no tasks remain, check if all tasks have finished.
      if (taskIndex >= tasks.length) {
        if (inFlight === 0) {
          resolve();
        }
        return;
      }

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
          launchNext();
        });
    }

    // Launch the initial batch of tasks.
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      launchNext();
    }
  });

  console.timeEnd('CachingPluginBenchmark');
  const durationMs = performance.now() - startTime;

  // Summarize results.
  const successCount = results.filter((r) => r && r.success).length;
  const failureCount = results.filter((r) => r && !r.success).length;

  console.log(`Completed ${TOTAL_REQUESTS} requests in ${durationMs.toFixed(2)}ms`);
  console.log(`Success: ${successCount}, Failure: ${failureCount}`);

// Check the caching plugin's internal cache stats.
  const cacheStats = cachingPlugin.getCacheStats();
  console.log('Cache Stats:', cacheStats);
})();