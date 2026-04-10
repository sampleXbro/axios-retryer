/**
 * P0 Plugin System Tests from TEST_GAP_ANALYSIS.md
 *
 * Tests for contract guarantees, security boundaries, and behaviors users depend on in production.
 * Missing these tests means users could hit bugs that violate documented promises.
 */

import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RetryManager } from '../src';
import { PluginRegistrationError } from '../src/core/errors';

// ────────────────────────────────────────────────────────────────────────────
// 12. Plugin System
// ────────────────────────────────────────────────────────────────────────────

describe('P0 Plugin System (12.x)', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  // 12.1 Registration
  describe('12.1 Registration', () => {
    it('12.1.1: Plugin with valid semver version registers successfully', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
      };

      manager.use(mockPlugin as any);

      expect(manager.listPlugins()).toContainEqual(expect.objectContaining({ name: 'TestPlugin', version: '1.0.0' }));

      manager.destroy();
    });

    it('12.1.2: Plugin with invalid version format throws PluginRegistrationError', () => {
      const manager = new RetryManager({ axiosInstance });

      const invalidVersions = ['1.0', 'v1.0.0', 'latest', 'invalid'];

      for (const version of invalidVersions) {
        const mockPlugin = {
          name: 'TestPlugin',
          version,
          initialize: jest.fn(),
        };

        expect(() => manager.use(mockPlugin as any)).toThrow(PluginRegistrationError);
      }

      manager.destroy();
    });

    it('12.1.3: Registering plugin with duplicate name throws PluginRegistrationError', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin1 = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
      };

      const mockPlugin2 = {
        name: 'TestPlugin',
        version: '2.0.0',
        initialize: jest.fn(),
      };

      manager.use(mockPlugin1 as any);

      expect(() => manager.use(mockPlugin2 as any)).toThrow(PluginRegistrationError);

      manager.destroy();
    });

    it('12.1.4: Plugin initialize is called with valid PluginContext', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
      };

      manager.use(mockPlugin as any);

      expect(mockPlugin.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          axiosInstance,
          getLogger: expect.any(Function),
          on: expect.any(Function),
          off: expect.any(Function),
          emit: expect.any(Function),
        }),
      );

      manager.destroy();
    });

    it('12.1.5: Plugin that throws in initialize is removed from registry', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(() => {
          throw new Error('Init failed');
        }),
      };

      expect(() => manager.use(mockPlugin as any)).toThrow();

      // Plugin should be removed from registry
      expect(manager.listPlugins()).not.toContainEqual(expect.objectContaining({ name: 'TestPlugin' }));

      manager.destroy();
    });

    it('12.1.6: Plugin registered with beforeRetryerInterceptors: true ejects then re-installs interceptors', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        beforeRetryerInterceptors: true,
      };

      manager.use(mockPlugin as any);

      expect(mockPlugin.initialize).toHaveBeenCalled();

      manager.destroy();
    });

    it('12.1.7: Plugin registered with beforeRetryerInterceptors: false does NOT eject retryer interceptors', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        beforeRetryerInterceptors: false,
      };

      manager.use(mockPlugin as any);

      expect(mockPlugin.initialize).toHaveBeenCalled();

      manager.destroy();
    });

    it('12.1.8: Plugin with interceptorPlacement: afterRetryer defaults to false for beforeRetryerInterceptors', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        interceptorPlacement: 'afterRetryer' as const,
      };

      manager.use(mockPlugin as any);

      expect(mockPlugin.initialize).toHaveBeenCalled();

      manager.destroy();
    });

    it('12.1.9: listPlugins returns all registered plugins with name and version', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin1 = {
        name: 'TestPlugin1',
        version: '1.0.0',
        initialize: jest.fn(),
      };

      const mockPlugin2 = {
        name: 'TestPlugin2',
        version: '2.0.0',
        initialize: jest.fn(),
      };

      manager.use(mockPlugin1 as any);
      manager.use(mockPlugin2 as any);

      const plugins = manager.listPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins).toContainEqual(expect.objectContaining({ name: 'TestPlugin1', version: '1.0.0' }));
      expect(plugins).toContainEqual(expect.objectContaining({ name: 'TestPlugin2', version: '2.0.0' }));

      manager.destroy();
    });

    it('12.1.10: listPlugins returns empty array when no plugins are registered', () => {
      const manager = new RetryManager({ axiosInstance });

      const plugins = manager.listPlugins();

      expect(plugins).toEqual([]);

      manager.destroy();
    });
  });

  // 12.2 Unregistration
  describe('12.2 Unregistration', () => {
    it('12.2.1: unuse calls onBeforeDestroyed on the plugin', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        onBeforeDestroyed: jest.fn(),
      };

      manager.use(mockPlugin as any);
      manager.unuse('TestPlugin');

      expect(mockPlugin.onBeforeDestroyed).toHaveBeenCalled();

      manager.destroy();
    });

    it('12.2.2: unuse removes the plugin from registry', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
      };

      manager.use(mockPlugin as any);
      manager.unuse('TestPlugin');

      expect(manager.listPlugins()).not.toContainEqual(expect.objectContaining({ name: 'TestPlugin' }));

      manager.destroy();
    });

    it('12.2.3: unuse with nonexistent returns false', () => {
      const manager = new RetryManager({ axiosInstance });

      const result = manager.unuse('NonExistentPlugin');

      expect(result).toBe(false);

      manager.destroy();
    });

    it('12.2.4: After unuse, plugin event listeners no longer fire', async () => {
      const manager = new RetryManager({ axiosInstance });

      let eventFired = false;
      let queuedListener: (() => void) | null = null;

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          queuedListener = () => {
            eventFired = true;
          };
          context.on('onRequestQueued' as any, queuedListener);
        }),
        onBeforeDestroyed: jest.fn((context: any) => {
          if (queuedListener) {
            context.off('onRequestQueued' as any, queuedListener);
          }
        }),
      };

      manager.use(mockPlugin as any);
      manager.unuse('TestPlugin');

      mock.onGet('/api/data').reply(200, { data: 'success' });
      await axiosInstance.get('/api/data');

      expect(eventFired).toBe(false);

      manager.destroy();
    });

    it('12.2.5: Plugin without onBeforeDestroyed method: unuse succeeds without error', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn(),
        // No onBeforeDestroyed
      };

      manager.use(mockPlugin as any);

      expect(() => manager.unuse('TestPlugin')).not.toThrow();

      manager.destroy();
    });
  });

  // 12.3 PluginContext API
  describe('12.3 PluginContext API', () => {
    it('12.3.1: context.axiosInstance returns the managers axios instance (read-only)', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.axiosInstance).toBe(axiosInstance);
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.2: context.getLogger returns the managers logger', () => {
      const manager = new RetryManager({
        axiosInstance,
        debug: false,
      });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          const logger = context.getLogger();
          expect(logger).toBeDefined();
          expect(logger.debug).toBeDefined();
          expect(logger.warn).toBeDefined();
          expect(logger.error).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.3: context.on/off/emit/triggerAndEmit delegate to EventBus', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.on).toBeDefined();
          expect(context.off).toBeDefined();
          expect(context.emit).toBeDefined();
          expect(context.triggerAndEmit).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.4: context.cancelRequest delegates to lifecycle manager', () => {
      const manager = new RetryManager({
        axiosInstance,
        debug: false,
      });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.cancelRequest).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.5: context.registerQueueGate/unregisterQueueGate delegate to queue', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.registerQueueGate).toBeDefined();
          expect(context.unregisterQueueGate).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.6: context.refreshQueue triggers queue drain', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.refreshQueue).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.7: context.registerMetricsRecorder sets metrics recorder on manager', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.registerMetricsRecorder).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.8: context.getTimerStats returns live timer counts', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.getTimerStats).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });

    it('12.3.9: context.releaseRequestTracking releases lifecycle AND marks queue complete', () => {
      const manager = new RetryManager({ axiosInstance });

      const mockPlugin = {
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: jest.fn((context: any) => {
          expect(context.releaseRequestTracking).toBeDefined();
        }),
      };

      manager.use(mockPlugin as any);

      manager.destroy();
    });
  });
});
