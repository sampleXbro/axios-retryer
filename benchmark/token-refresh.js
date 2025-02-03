/**
 * benchmark.js
 *
 * This benchmark simulates high concurrency using the axios-retryer library with the
 * TokenRefreshPlugin. It sends a large number of requests concurrently to an endpoint
 * that initially responds with 401 Unauthorized. The TokenRefreshPlugin intercepts these
 * responses, triggers a simulated token refresh, updates the Axios instance's default
 * Authorization header, and retries the queued requests.
 */

const axios = require('axios');
const { RetryManager } = require('../dist/index.cjs');
const { TokenRefreshPlugin } = require('../dist/index.cjs');

// Custom adapter to simulate server responses.
// - Requests to '/auth/refresh' simulate the token refresh endpoint.
// - Other requests will return 401 Unauthorized unless the correct token is provided.
async function customAdapter(config) {
  // Simulate network latency (e.g., 10ms per request)
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Simulate token refresh endpoint.
  if (config.url === '/auth/refresh') {
    return {
      data: { token: 'new-token' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: config,
    };
  }

  // Check if the Authorization header contains the valid token.
  const authHeader = config.headers && config.headers['Authorization'];
  if (authHeader && authHeader.indexOf('new-token') !== -1) {
    // Return a successful API response.
    return {
      data: { message: 'Success' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: config,
    };
  } else {
    // Simulate a 401 Unauthorized error response.
    const errorResponse = {
      response: {
        data: { message: 'Unauthorized' },
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: config,
      },
      config: config,
    };
    return Promise.reject(errorResponse);
  }
}

async function runBenchmark() {
  // Create an Axios instance using the custom adapter.
  const axiosInstance = axios.create({
    baseURL: 'http://localhost', // Dummy URL; requests are handled by our adapter.
    adapter: customAdapter,
  });

  // Initialize the retry manager with the axios instance.
  const retryManager = new RetryManager({axiosInstance});

  // Define a token refresh handler that calls the simulated refresh endpoint.
  const refreshTokenHandler = async function (refreshAxios) {
    const response = await refreshAxios.post('/auth/refresh');
    return { token: response.data.token };
  };

  // Create and register the TokenRefreshPlugin.
  const tokenRefreshPlugin = new TokenRefreshPlugin(refreshTokenHandler);
  retryManager.use(tokenRefreshPlugin);

  // Define the total number of concurrent requests for the benchmark.
  const totalRequests = 1000;
  console.log(`Starting high load benchmark with ${totalRequests} requests...`);
  console.time('HighLoadBenchmark');

  // Fire off many concurrent requests.
  // All requests target '/some-endpoint', which will return 401 unless the valid token is set.
  const requestPromises = [];
  for (let i = 0; i < totalRequests; i++) {
    requestPromises.push(axiosInstance.get('/some-endpoint'));
  }

  try {
    const responses = await Promise.all(requestPromises);
    const successCount = responses.filter((res) => res.status === 200).length;
    console.log(`Successfully completed ${successCount} requests out of ${totalRequests}.`);
  } catch (error) {
    console.error('Error during high load benchmark:', error);
  }

  console.timeEnd('HighLoadBenchmark');
}

// Run the benchmark.
runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
});