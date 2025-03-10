//@ts-nocheck
import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { jest } from '@jest/globals';
import { RetryManager } from '../src';
import { CircuitBreakerPlugin } from '../src/plugins/CircuitBreakerPlugin';

describe('CircuitBreakerPlugin (Jest + axios-mock-adapter)', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;
  let manager: RetryManager;
  let plugin: CircuitBreakerPlugin;

  // A simple logger mock
  const fakeLogger = {
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
    info: jest.fn(),
  };

  beforeEach(() => {
    // Use Jest's fake timers so we can control time-based logic (e.g. openTimeout).
    jest.useFakeTimers();

    // Create a fresh Axios instance and mock adapter
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);

    // Minimal fake RetryManager that the plugin expects
    manager = {
      axiosInstance,
      getLogger: () => fakeLogger,
    } as unknown as RetryManager;

    // Create a plugin instance with lower thresholds/timeouts to simplify tests
    // IMPORTANT: Disable the enhanced features for these basic tests
    plugin = new CircuitBreakerPlugin({
      failureThreshold: 3, // trip after 3 failures
      openTimeout: 10000,  // 10 seconds before transitioning to HALF_OPEN
      halfOpenMax: 1,      // allow only 1 test request in HALF_OPEN
      useSlidingWindow: false, // disable for these tests
      adaptiveTimeout: false, // disable for these tests
    });

    // Initialize the plugin, which installs request/response interceptors
    plugin.initialize(manager);
  });

  afterEach(() => {
    // Restore real timers and reset mock calls between tests
    jest.useRealTimers();
    mock.reset();
    jest.clearAllMocks();
  });

  test('should process requests normally in CLOSED state and reset failure count on success', async () => {
    mock.onGet('/success').reply(200, { message: 'OK' });

    const response = await axiosInstance.get('/success');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ message: 'OK' });

    // In CLOSED state with no failures, the logger should not have error logs
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  test('should trip the circuit after reaching the failure threshold', async () => {
    // Return 500 for requests to /fail
    mock.onGet('/fail').reply(500);

    // Make 3 failing requests (threshold=3). Each should throw an error.
    for (let i = 0; i < 3; i++) {
      await expect(axiosInstance.get('/fail')).rejects.toThrow(/Request failed with status code 500/);
    }

    // The circuit should now be OPEN, so the next request is "fail-fast"
    await expect(axiosInstance.get('/fail')).rejects.toThrow(/Circuit is open/);

    // Check if an error log was made when the circuit tripped
    expect(fakeLogger.error).toHaveBeenCalled();
    const errorCalls = fakeLogger.error.mock.calls.map(call => call[0]);
    const trippedLog = errorCalls.find(msg => msg.includes('Circuit tripped: entering OPEN state'));
    expect(trippedLog).toBeDefined();
  });

  test('should transition to HALF_OPEN after openTimeout and reset on successful test request', async () => {
    // First, trip the circuit
    mock.onGet('/fail').reply(500);
    for (let i = 0; i < 3; i++) {
      await expect(axiosInstance.get('/fail')).rejects.toThrow(/500/);
    }

    // The circuit is now OPEN. Advance time by openTimeout => next request triggers HALF_OPEN
    jest.advanceTimersByTime(10000);

    // Now mock a successful response for the next request => should transition from HALF_OPEN to CLOSED
    mock.onGet('/test').reply(200, { message: 'Recovered' });
    const response = await axiosInstance.get('/test');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ message: 'Recovered' });

    // The plugin logs a debug message when resetting to CLOSED
    expect(fakeLogger.debug).toHaveBeenCalled();
    const debugCalls = fakeLogger.debug.mock.calls.map((call) => call[0]);
    const resetLog = debugCalls.find((msg: string) => msg.includes('Circuit reset: entering CLOSED state'));
    expect(resetLog).toBeDefined();
  });

  test('should remain OPEN if a test request in HALF_OPEN fails', async () => {
    // Trip the circuit
    mock.onGet('/fail').reply(500);
    for (let i = 0; i < 3; i++) {
      await expect(axiosInstance.get('/fail')).rejects.toThrow();
    }

    // Advance timer => next request is in HALF_OPEN
    jest.advanceTimersByTime(10000);

    // The next request fails => re-trip circuit to OPEN
    mock.onGet('/testFail').reply(500);
    await expect(axiosInstance.get('/testFail')).rejects.toThrow();

    // Circuit should remain OPEN => subsequent requests fail-fast
    await expect(axiosInstance.get('/anotherReq')).rejects.toThrow(/Circuit is open/);

    // Check if the plugin logged an error about re-tripping
    const errorCalls = fakeLogger.error.mock.calls.map(call => call[0]);
    expect(errorCalls.some(msg => msg.includes('Circuit tripped: entering OPEN state'))).toBe(true);
  });

  test('should respect the halfOpenMax limit', async () => {
    // Trip the circuit
    mock.onGet('/failAgain').reply(500);
    for (let i = 0; i < 3; i++) {
      await expect(axiosInstance.get('/failAgain')).rejects.toThrow();
    }

    // Move clock => next request is half-open
    jest.advanceTimersByTime(10000);

    // First half-open request => fails => circuit goes OPEN
    mock.onGet('/testFail').reply(500);
    await expect(axiosInstance.get('/testFail')).rejects.toThrow();

    // Because halfOpenMax=1, the next request should fail immediately
    mock.onGet('/exceedHalfOpen').reply(200); // even though "server" might respond 200, circuit is still OPEN
    await expect(axiosInstance.get('/exceedHalfOpen')).rejects.toThrow(/Circuit is open/);
  });

  test('should eject interceptors on onBeforeDestroyed', () => {
    // The plugin has stored request/response interceptor IDs
    // onBeforeDestroyed should eject them
    const requestEjectSpy = jest.spyOn(manager.axiosInstance.interceptors.request, 'eject');
    const responseEjectSpy = jest.spyOn(manager.axiosInstance.interceptors.response, 'eject');

    plugin.onBeforeDestroyed(manager);

    // The plugin's private fields store the IDs; check that these are used
    const requestId = (plugin as any)._requestInterceptorId;
    const responseId = (plugin as any)._responseInterceptorId;

    expect(requestEjectSpy).toHaveBeenCalledWith(requestId);
    expect(responseEjectSpy).toHaveBeenCalledWith(responseId);
  });
});