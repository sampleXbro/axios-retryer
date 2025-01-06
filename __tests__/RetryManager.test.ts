// @ts-nocheck
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src';
import type { RetryManagerOptions } from '../src';

describe('RetryManager', () => {
    let mock: AxiosMockAdapter;
    let retryManager: RetryManager;

    const hooks = {
        beforeRetry: jest.fn(),
        afterRetry: jest.fn(),
        onFailure: jest.fn(),
        onAllRetriesCompleted: jest.fn(),
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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());
    });

    afterEach(() => {
        mock.restore();
    });

    test('should succeed on first try with no retries needed', async () => {
        mock.onGet('/success').reply(200, { data: 'ok' });

        const response = await retryManager.getAxiosInstance().get('/success');
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

        const response = await retryManager.getAxiosInstance().get('/retry-success');
        expect(response.status).toBe(200);
        expect(response.data).toEqual({ data: 'recovered' });
    });

    test('should exhaust retries and throw error', async () => {
        mock.onGet('/retry-fail').reply(500, 'Server Error');

        await expect(retryManager.getAxiosInstance().get('/retry-fail'))
            .rejects
            .toThrow('Request failed with status code 500');
    });

    test('should abort and not retry if request is cancelled before retry', async () => {
        // Make first call fail
        mock.onGet('/cancel-before-retry').replyOnce(500, 'Error');
        // On second try, if it would ever happen, it would succeed
        mock.onGet('/cancel-before-retry').replyOnce(200, { data: 'should-not-reach' });

        const axiosInstance = retryManager.getAxiosInstance();
        const requestPromise = axiosInstance.get('/cancel-before-retry')
            .catch((err) => {
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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        mock.onGet('/store-fail').reply(500, 'Error');

        await expect(retryManager.getAxiosInstance().get('/store-fail')).rejects.toThrow();
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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        mock.onGet('/manual-retry').reply(500, 'Error');
        await expect(retryManager.getAxiosInstance().get('/manual-retry')).rejects.toThrow();

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

    test('should throw error on cancel if throwErrorOnCancelRequest is true', async () => {
        const options = {
            mode: 'automatic' as const,
            retries: 1,
            throwErrorOnCancelRequest: true,
        };
        retryManager = new RetryManager(options);
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        mock.onGet('/cancel-silent').replyOnce(500, 'Error'); // triggers a retry

        const requestPromise = retryManager.getAxiosInstance().get('/cancel-silent');

        setTimeout(() => {
            retryManager.cancelAllRequests();
        }, 50);

        await requestPromise.catch((err) => {
            expect(err.message).toMatch(/Request/);
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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        // Ensure the mock matches exactly the request you are making
        mock.onGet('/exhaust-retries').reply(500, 'Still failing');

        // Use .rejects to ensure we handle the failure
        await expect(
            retryManager.getAxiosInstance().get('/exhaust-retries')
        ).rejects.toThrow('Request failed with status code 500');

        expect(hooks.onFailure).toHaveBeenCalledTimes(1);
    });

    test('onAllRetriesCompleted is called after no more retries are pending', async () => {
        const options: RetryManagerOptions = {
            mode: 'automatic',
            retries: 1,
            hooks,
            throwErrorOnFailedRetries: true,
        };
        retryManager = new RetryManager(options);
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        mock.onGet('/complete-all').reply(500, 'Fail');

        await retryManager.getAxiosInstance().get('/complete-all').catch(() => {});

        // Now it always stores failed requests, so there should be 1 failed request
        expect(hooks.onAllRetriesCompleted).toHaveBeenCalledTimes(1);
        expect(hooks.onAllRetriesCompleted).toHaveBeenCalledWith(1);

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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        mock.onGet('/manual-mode').reply(500, 'Fail Immediately');

        await retryManager.getAxiosInstance().get('/manual-mode').catch(() => {});

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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());
        mock.onGet('/no-throw-fail').reply(500, 'Error');

        let err;
        try {
            await retryManager.getAxiosInstance().get('/no-throw-fail');
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
        };
        retryManager = new RetryManager(options);
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        // Always fail to trigger retries
        mock.onGet('/cancel-late').reply(500, 'Error');

        const requestPromise = retryManager.getAxiosInstance().get('/cancel-late').catch((err) => {
            expect(err.message).toMatch(/Request aborted/);
        });

        // Cancel all ongoing requests after the retry is scheduled
        setTimeout(() => {
            retryManager.cancelAllRequests();
        }, 50);

        await requestPromise;

        // With the new code, after cancellation, onFailure is called and request is stored
        expect(hooks.onFailure).toHaveBeenCalledTimes(1);

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
        mock = new AxiosMockAdapter(retryManager.getAxiosInstance());

        let callCount = 0;
        mock.onGet('/after-retry-fail').reply(() => {
            callCount++;
            // Always fail
            return [500, 'Fail'];
        });

        await retryManager.getAxiosInstance().get('/after-retry-fail').catch(() => {});

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

        expect(manager.listPlugins()).toContain('TestPlugin');
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
        expect(plugins).toEqual(['PluginOne', 'PluginTwo']);
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

        const config = { url: 'http://example.com' } as AxiosRetryerRequestConfig;
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

        const config = { url: 'http://example.com' } as AxiosRetryerRequestConfig;
        expect(() => manager['triggerHook']('beforeRetry', config)).not.toThrow();
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
});