import type { AxiosInstance } from 'axios';

import type { Logger, PluginContext } from '../../src/types';

/**
 * Minimal {@link PluginContext} for unit tests that call `plugin.initialize(...)` outside `RetryManager`.
 * Real wiring sets these on the manager; CachingPlugin and others require `triggerAndEmit` and related hooks.
 */
export function createMinimalPluginContext(axiosInstance: AxiosInstance, logger: Logger): PluginContext {
  return {
    axiosInstance,
    getLogger: () => logger,
    on: jest.fn(),
    off: jest.fn(() => false),
    emit: jest.fn(),
    triggerAndEmit: jest.fn(),
    cancelRequest: jest.fn(),
    cancelAllRequests: jest.fn(),
    cancelQueuedRequests: jest.fn(),
    registerQueueGate: jest.fn(),
    unregisterQueueGate: jest.fn(() => false),
    refreshQueue: jest.fn(),
    registerMetricsRecorder: jest.fn(),
    getTimerStats: jest.fn(() => ({ activeTimers: 0, activeRetryTimers: 0 })),
    releaseRequestTracking: jest.fn(),
  } as PluginContext;
}
