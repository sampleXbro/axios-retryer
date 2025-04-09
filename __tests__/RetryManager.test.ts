// @ts-nocheck
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryHooks, RetryManager } from '../src';
import type { RetryManagerOptions } from '../src';
import axios from 'axios';

describe('RetryManager', () => {
  let mock: AxiosMockAdapter;
  let retryManager: RetryManager;

  const hooks: RetryHooks = {
    beforeRetry: jest.fn(),
    afterRetry: jest.fn(),
    onFailure: jest.fn(),
    onRetryProcessFinished: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 2,
      throwErrorOnFailedRetries: true,
      throwErrorOnCancelRequest: true,
    };

    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  test('should succeed on first try with no retries needed', async () => {
    mock.onGet('/success').reply(200, { data: 'ok' });

    const response = await retryManager.axiosInstance.get('/success');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: 'ok' });
  });

  test('should retry on failure and succeed on second attempt', async () => {
    let attempt = 0;
    mock.onGet('/retry-success').reply(() => {
      attempt++;
      if (attempt === 1) {
        return [500, 'Error'];
      }
      return [200, { data: 'recovered' }];
    });

    const response = await retryManager.axiosInstance.get('/retry-success');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: 'recovered' });
  });

  test('should exhaust retries and throw error', async () => {
    mock.onGet('/retry-fail').reply(500, 'Server Error');

    await expect(retryManager.axiosInstance.get('/retry-fail')).rejects.toThrow(
      'Request failed with status code 500',
    );
  });

  test('should abort and not retry if request is cancelled before retry', async () => {
    // Make first call fail
    mock.onGet('/cancel-before-retry').replyOnce(500, 'Error');
    // On second try, if it would ever happen, it would succeed
    mock.onGet('/cancel-before-retry').replyOnce(200, { data: 'should-not-reach' });

    const axiosInstance = retryManager.axiosInstance;
    const requestPromise = axiosInstance.get('/cancel-before-retry').catch((err) => {
      // We expect a cancellation error here
      expect(err.message).toMatch(/Request aborted/);
    });

    // Wait for the first attempt, then cancel all requests
    setTimeout(() => {
      // Extract active requests
      const activeRequests = (retryManager as any).activeRequests;
      // @ts-ignore
      const keys = Array.from(activeRequests.keys());
      if (keys.length > 0) {
        retryManager.cancelAllRequests();
      }
    }, 50);

    await requestPromise;
  });

  test('should store failed requests in manual mode for later retry', async () => {
    // Reinitialize in manual mode
    const options = {
      mode: 'manual' as const,
      retries: 1,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/store-fail').reply(500, 'Error');

    await expect(retryManager.axiosInstance.get('/store-fail')).rejects.toThrow();
    // The request should have been stored for manual retry
    const requestStore = (retryManager as any).requestStore;
    const storedRequests = requestStore.getAll();
    expect(storedRequests).toHaveLength(1);
    expect(storedRequests[0].url).toBe('/store-fail');
  });

  test('should manually retry failed requests', async () => {
    // With manual mode and failed request stored
    const options = {
      mode: 'manual' as const,
      retries: 1,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/manual-retry').reply(500, 'Error');
    await expect(retryManager.axiosInstance.get('/manual-retry')).rejects.toThrow();

    const requestStore = (retryManager as any).requestStore;
    const storedRequestsBefore = requestStore.getAll();
    expect(storedRequestsBefore).toHaveLength(1);

    // Now change mock for a successful retry
    mock.onGet('/manual-retry').reply(200, { data: 'second-chance' });

    const responses = await retryManager.retryFailedRequests();
    expect(responses).toHaveLength(1);
    expect(responses[0].data).toEqual({ data: 'second-chance' });

    const storedRequestsAfter = requestStore.getAll();
    expect(storedRequestsAfter).toHaveLength(0);
  });

  test('should throw an error after manual retry if requests are still failed', async () => {
    // Initialize RetryManager in manual mode with 1 retry
    const options = {
      mode: 'manual' as const,
      retries: 1,
    };
    const retryManager = new RetryManager(options);
    const mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // First request fails
    mock.onGet('/manual-retry').reply(500, 'Error');
    await expect(retryManager.axiosInstance.get('/manual-retry')).rejects.toThrow();

    // Verify that the failed request is stored
    const requestStore = (retryManager as any).requestStore;
    const storedRequestsBefore = requestStore.getAll();
    expect(storedRequestsBefore).toHaveLength(1);

    // Mock another failure for retry
    mock.onGet('/manual-retry').reply(500, 'Error again');

    // Attempt manual retry and expect it to throw
    await expect(retryManager.retryFailedRequests()).rejects.toThrow(/Request failed with status code 500/);

    // Verify that the failed request remains in the store
    const storedRequestsAfter = requestStore.getAll();
    expect(storedRequestsAfter).toHaveLength(1);
  });

  test('should throw error on cancel if throwErrorOnCancelRequest is true', async () => {
    const options = {
      mode: 'automatic' as const,
      retries: 1,
      throwErrorOnCancelRequest: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/cancel-silent').replyOnce(500, 'Error'); // triggers a retry

    const requestPromise = retryManager.axiosInstance.get('/cancel-silent');

    setTimeout(() => {
      retryManager.cancelAllRequests();
    }, 50);

    await requestPromise.catch((err) => {
      expect(err.message).toMatch(/Request aborted/);
    });
  });

  test('onFailure is called when all retries are exhausted', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      hooks,
      throwErrorOnFailedRetries: true,
      throwErrorOnCancelRequest: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Ensure the mock matches exactly the request you are making
    mock.onGet('/exhaust-retries').reply(500, 'Still failing');

    // Use .rejects to ensure we handle the failure
    await expect(retryManager.axiosInstance.get('/exhaust-retries')).rejects.toThrow(
      'Request failed with status code 500',
    );

    expect(hooks.onFailure).toHaveBeenCalledTimes(1);
  });

  test('onRetryProcessFinished is called after no more retries are pending', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      hooks,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/complete-all').reply(500, 'Fail');

    await retryManager
      .axiosInstance
      .get('/complete-all')
      .catch(() => {});

    // Now it always stores failed requests, so there should be 1 failed request
    expect(hooks.onRetryProcessFinished).toHaveBeenCalledTimes(1);

    // Also verify the request is stored
    const requestStore = (retryManager as any).requestStore;
    const stored = requestStore.getAll();
    expect(stored).toHaveLength(1);
  });

  test('manual mode: no automatic retries, failures go straight to store', async () => {
    const options: RetryManagerOptions = {
      mode: 'manual',
      retries: 2,
      hooks,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/manual-mode').reply(500, 'Fail Immediately');

    await retryManager
      .axiosInstance
      .get('/manual-mode')
      .catch(() => {});

    // Request is stored regardless of mode
    const requestStore = (retryManager as any).requestStore;
    const stored = requestStore.getAll();
    expect(stored).toHaveLength(1);

    // onFailure should always be called
    expect(hooks.onFailure).toHaveBeenCalledTimes(1);

    // No beforeRetry or afterRetry calls expected since no retries occurred
    expect(hooks.beforeRetry).toHaveBeenCalledTimes(0);
    expect(hooks.afterRetry).toHaveBeenCalledTimes(0);
  });

  test('throwErrorOnFailedRetries = true: returns a rejected promise without forcing error', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
    mock.onGet('/no-throw-fail').reply(500, 'Error');

    let err;
    try {
      await retryManager.axiosInstance.get('/no-throw-fail');
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect((err as any).message).toMatch(/Request failed/);

    // Verify that the request is stored
    const requestStore = (retryManager as any).requestStore;
    const stored = requestStore.getAll();
    expect(stored).toHaveLength(1);
  });

  test('cancelling after the first retry is scheduled but before it fires', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 2,
      hooks,
      throwErrorOnFailedRetries: true,
      throwErrorOnCancelRequest: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Always fail to trigger retries
    mock.onGet('/cancel-late').reply(500, 'Error');

    const requestPromise = retryManager
      .axiosInstance
      .get('/cancel-late')
      .catch((err) => {
        expect(err.message).toMatch(/Request aborted/);
      });

    // Cancel all ongoing requests after the retry is scheduled
    setTimeout(() => {
      retryManager.cancelAllRequests();
    }, 50);

    await requestPromise;

    const requestStore = (retryManager as any).requestStore;
    const stored = requestStore.getAll();
    expect(stored).toHaveLength(1);
  });

  test('Ensure afterRetry is called on a retry failure', async () => {
    const options: RetryManagerOptions = {
      mode: 'automatic',
      retries: 1,
      hooks,
      throwErrorOnFailedRetries: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    let callCount = 0;
    mock.onGet('/after-retry-fail').reply(() => {
      callCount++;
      // Always fail
      return [500, 'Fail'];
    });

    await retryManager
      .axiosInstance
      .get('/after-retry-fail')
      .catch(() => {});

    // afterRetry is called after a retry fails
    expect(hooks.afterRetry).toHaveBeenCalledTimes(1);
    // onFailure is always called now that retries are done
    expect(hooks.onFailure).toHaveBeenCalledTimes(1);

    const requestStore = (retryManager as any).requestStore;
    const stored = requestStore.getAll();
    expect(stored).toHaveLength(1);
  });

  test('should register a new plugin', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin = { name: 'TestPlugin', version: '1.0.0', initialize: jest.fn() };

    manager.use(plugin);

    expect(manager.listPlugins()).toEqual([{ name: 'TestPlugin', version: '1.0.0' }]);
    expect(plugin.initialize).toHaveBeenCalledWith(manager);
  });

  test('should throw an error when registering a duplicate plugin', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin = { name: 'DuplicatePlugin', version: '1.0.0', initialize: jest.fn() };

    manager.use(plugin);
    expect(() => manager.use(plugin)).toThrowError('Plugin "DuplicatePlugin" is already registered.');
  });

  test('should list all registered plugins', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin1 = { name: 'PluginOne', version: '1.0.0', initialize: jest.fn() };
    const plugin2 = { name: 'PluginTwo', version: '1.0.0', initialize: jest.fn() };

    manager.use(plugin1);
    manager.use(plugin2);

    const plugins = manager.listPlugins();
    expect(plugins).toEqual([
      { name: 'PluginOne', version: '1.0.0' },
      { name: 'PluginTwo', version: '1.0.0' },
    ]);
  });

  test('should trigger hooks for all registered plugins', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const plugin1 = {
      name: 'PluginOne',
      version: '1.0.0',
      initialize: jest.fn(),
      hooks: {
        beforeRetry: jest.fn(),
      },
    };
    const plugin2 = {
      name: 'PluginTwo',
      version: '1.0.0',
      initialize: jest.fn(),
      hooks: {
        beforeRetry: jest.fn(),
      },
    };

    manager.use(plugin1);
    manager.use(plugin2);

    const config = { url: 'http://example.com' };
    manager['triggerHook']('beforeRetry', config);

    expect(plugin1.hooks?.beforeRetry).toHaveBeenCalledWith(config);
    expect(plugin2.hooks?.beforeRetry).toHaveBeenCalledWith(config);
  });

  test('should handle errors in plugin hooks gracefully', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const faultyPlugin = {
      name: 'FaultyPlugin',
      version: '1.0.0',
      initialize: jest.fn(),
      hooks: {
        beforeRetry: jest.fn(() => {
          throw new Error('Test error');
        }),
      },
    };

    manager.use(faultyPlugin);

    const config = { url: 'http://example.com' };
    expect(() => manager['triggerHook']('beforeRetry', config)).not.toThrow();
  });

  test('should execute plugins in registration order', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const executionOrder: string[] = [];

    const plugin1 = {
      name: 'PluginOne',
      version: '1.0.0',
      initialize: jest.fn(),
      hooks: {
        beforeRetry: () => executionOrder.push('PluginOne'),
      },
    };

    const plugin2 = {
      name: 'PluginTwo',
      version: '1.0.0',
      initialize: jest.fn(),
      hooks: {
        beforeRetry: () => executionOrder.push('PluginTwo'),
      },
    };

    manager.use(plugin1);
    manager.use(plugin2);

    const config = { url: 'http://example.com' };
    manager['triggerHook']('beforeRetry', config);

    expect(executionOrder).toEqual(['PluginOne', 'PluginTwo']);
  });

  test('should cancel a specific request by ID', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const controller = new AbortController();
    const requestId = 'test-request-1';

    manager['activeRequests'].set(requestId, controller);
    manager.cancelRequest(requestId);

    expect(manager['activeRequests'].has(requestId)).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  test('should cancel all active requests', () => {
    const manager = new RetryManager({ mode: 'automatic' });
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    manager['activeRequests'].set('request-1', controller1);
    manager['activeRequests'].set('request-2', controller2);

    manager.cancelAllRequests();

    expect(manager['activeRequests'].size).toBe(0);
    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(true);
  });

  test('should trigger hooks in correct order', async () => {
    const hooksOrder: string[] = [];
    const hooks = {
      beforeRetry: () => hooksOrder.push('beforeRetry'),
      afterRetry: () => hooksOrder.push('afterRetry'),
      onFailure: () => hooksOrder.push('onFailure'),
    };

    const options: RetryManagerOptions = { retries: 1, mode: 'automatic', hooks };
    retryManager = new RetryManager({
      ...options,
      axiosInstance: axios.create({ baseURL: 'http://localhost' }), // Ensure baseURL is set
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/hooks-order').reply(500, 'Error'); // Mock the endpoint

    await expect(retryManager.axiosInstance.get('/hooks-order')).rejects.toThrow();
    expect(hooksOrder).toEqual(['beforeRetry', 'afterRetry', 'onFailure']);
  });

  test('single request', async () => {
    const options: RetryManagerOptions = { retries: 1, mode: 'automatic' };
    retryManager = new RetryManager({
      ...options,
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/fail1').reply(500, 'Error');
    await retryManager
      .axiosInstance
      .get('/fail1')
      .catch(() => {});
  });

  test('sequential requests', async () => {
    const options: RetryManagerOptions = { retries: 1, mode: 'automatic' };
    retryManager = new RetryManager({
      ...options,
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    mock.onGet('/fail1').reply(500, 'Error');
    mock.onGet('/fail2').reply(500, 'Error');

    await retryManager
      .axiosInstance
      .get('/fail1')
      .catch(() => {});
    await retryManager
      .axiosInstance
      .get('/fail2')
      .catch(() => {});
  });

  test('should store multiple concurrent failed requests', async () => {
    // Disable retries to isolate the test behavior
    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 0, // No retries
      axiosInstance: axios.create({ baseURL: 'http://localhost' }),
    });
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Mock the responses to always fail
    mock.onGet('/fail1').reply(500, 'Error 1');
    mock.onGet('/fail2').reply(500, 'Error 2');

    // Make concurrent requests
    await Promise.all([
      retryManager
        .axiosInstance
        .get('/fail1')
        .catch(() => {}),
      retryManager
        .axiosInstance
        .get('/fail2')
        .catch(() => {}),
    ]);

    // Check the request store
    const requestStore = (retryManager as any).requestStore;
    const storedRequests = requestStore.getAll();

    // Assertions
    expect(storedRequests).toHaveLength(2);
    expect(storedRequests[0].url).toBe('/fail1');
    expect(storedRequests[1].url).toBe('/fail2');
  }, 10000);

  test('should reject requests with QueueFullError when queue size limit is reached', async () => {
    // Create spies to monitor what's happening
    const consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    
    // Reinitialize with a max queue size of 2
    const options = {
      mode: 'automatic' as const,
      retries: 0, // No retries to keep test simple
      maxConcurrentRequests: 1,
      maxQueueSize: 2,
      queueDelay: 50, // Add delay to ensure requests are properly queued
      debug: true, // Enable debug mode to see what's happening
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);

    // Set up mock to use our manually controlled promise - ensuring requests stay pending
    mock.onGet(/\/test-queue-limit\/.*/).reply(() => {
      return new Promise(() => {
        setTimeout(() => {
          // This timeout will keep the request active during the test
          // We'll never actually resolve it because we don't call manualResolve
          console.log("Mock handler running, but not resolving");
        }, 10000);
      });
    });

    // Make our requests and track them
    console.log('Making first request - should be in process');
    retryManager.axiosInstance.get('/test-queue-limit/1').catch(e => e);
    
    // Wait long enough for first request to start processing
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('Making second request - should be queued (position 1)');
    retryManager.axiosInstance.get('/test-queue-limit/2').catch(e => e);
    
    // Wait to ensure second request is properly queued
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('Making third request - should be queued (position 2)');
    retryManager.axiosInstance.get('/test-queue-limit/3').catch(e => e);
    
    // Wait to ensure third request is properly queued
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check queue size using RequestQueue's internal method via the private field
    // Note: In a real application you should avoid accessing private fields
    const queueSize = retryManager['requestQueue'].getWaitingCount();
    console.log(`Current queue size: ${queueSize}`);
    expect(queueSize).toBe(2); // Verify queue actually has 2 items
    
    console.log('Making fourth request - should be rejected');
    // The 4th request should now be rejected with QueueFullError
    await expect(retryManager.axiosInstance.get('/test-queue-limit/4'))
      .rejects.toThrow('Request queue is full');
    
    // Clean up
    consoleDebugSpy.mockRestore();
    retryManager.cancelAllRequests();
  }, 5000); // Increase timeout for this test

  test('should sanitize sensitive information in requests by default', async () => {
    // Create a spy on console to capture log output
    const consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    
    // Create manager with debug enabled to ensure logs are produced
    const options = {
      mode: 'automatic' as const,
      debug: true,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
    
    // Setup mock response
    mock.onPost('/api/login').reply(200, { success: true });
    
    // Make request with sensitive data
    await retryManager.axiosInstance.post('/api/login', {
      username: 'testuser',
      password: 'secret123',
    }, {
      headers: {
        'Authorization': 'Bearer secret-token',
        'Content-Type': 'application/json',
      }
    });
    
    // Verify logs don't contain sensitive information
    const logCalls = consoleDebugSpy.mock.calls;
    const sensitiveDataInLogs = logCalls.some(call => 
      call.some(arg => 
        typeof arg === 'string' && (
          arg.includes('secret-token') || 
          arg.includes('secret123')
        )
      )
    );
    
    expect(sensitiveDataInLogs).toBe(false);
    
    // Restore console spy
    consoleDebugSpy.mockRestore();
  });

  test('should allow disabling sanitization when needed', async () => {
    // Create a spy on console to capture log output
    const consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    
    // Create manager with debug enabled and sanitization disabled
    const options = {
      mode: 'automatic' as const,
      debug: true,
      enableSanitization: false,
    };
    retryManager = new RetryManager(options);
    mock = new AxiosMockAdapter(retryManager.axiosInstance);
    
    // Setup a mock response that fails first then succeeds
    mock.onPost('/api/login').replyOnce(500, { error: 'Server error' })
                             .onPost('/api/login').reply(200, { success: true });
    
    // Request with sensitive data
    const sensitiveData = { 
      username: 'testuser', 
      password: 'secret123' 
    };
    const sensitiveHeaders = {
      'Authorization': 'Bearer secret-token',
      'Content-Type': 'application/json'
    };
    
    try {
      await retryManager.axiosInstance.post('/api/login', sensitiveData, {
        headers: sensitiveHeaders
      });
    } catch (e) {
      // Error is expected, we want to trigger error logs
    }
    
    // Allow time for all logs to be captured
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Merge all console output to search through
    const allLogCalls = [...consoleDebugSpy.mock.calls, ...consoleErrorSpy.mock.calls];
    
    // Convert logs to strings
    const logStrings = allLogCalls.map(call => 
      call.map(arg => 
        typeof arg === 'object' && arg !== null 
          ? JSON.stringify(arg) 
          : String(arg)
      ).join(' ')
    );
    
    // With sanitization disabled, sensitive data should appear in the logs
    // Check for specific sensitive values or keys
    const containsSensitiveData = logStrings.some(log => {
      // Look for sensitive values
      return (
        log.includes('secret123') || 
        log.includes('Bearer secret-token') ||
        // Or check if these keys exist with actual values (not asterisks)
        (log.includes('password') && !log.includes('********')) ||
        (log.includes('Authorization') && !log.includes('********'))
      );
    });
    
    expect(containsSensitiveData).toBe(true);
    
    // Restore console spies
    consoleDebugSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
