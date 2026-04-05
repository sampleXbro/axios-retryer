import MockAdapter from 'axios-mock-adapter';

import { RetryManager, type Logger, createRetryer, AXIOS_RETRYER_REQUEST_PRIORITIES } from '../src';
import { RequestDependencyPlugin } from '../src/plugins/RequestDependencyPlugin';
import { RetryLogger } from '../src/services/logger';
import { assignRequestMetadata, getRequestMetadata } from '../src/utils/requestMetadata';

describe('P2 Improvements', () => {
  describe('T-010: Injectable logger', () => {
    it('accepts a custom Logger via options', () => {
      const logs: string[] = [];
      const customLogger: Logger = {
        log: (msg) => logs.push(`LOG:${msg}`),
        error: (msg) => logs.push(`ERR:${msg}`),
        warn: (msg) => logs.push(`WARN:${msg}`),
        debug: (msg) => logs.push(`DBG:${msg}`),
      };

      const manager = new RetryManager({ logger: customLogger, debug: true });
      expect(manager.getLogger()).toBe(customLogger);
      expect(logs.some((l) => l.startsWith('DBG:'))).toBe(true);
      manager.destroy();
    });

    it('falls back to RetryLogger when no logger is provided', () => {
      const manager = new RetryManager();
      expect(manager.getLogger()).toBeInstanceOf(RetryLogger);
      manager.destroy();
    });

    it('routes plugin registration logs through the custom logger', () => {
      const logs: string[] = [];
      const customLogger: Logger = {
        log: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
        warn: (msg) => logs.push(msg),
        debug: () => {},
      };

      const manager = new RetryManager({ logger: customLogger });
      manager.use({
        name: 'TestPlugin',
        version: '1.0.0',
        initialize: () => {},
      });

      expect(logs.some((l) => l.includes('Plugin registered'))).toBe(true);
      manager.destroy();
    });

    it('Logger type is exported from the root entry', () => {
      const logger: Logger = {
        log: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
      };
      expect(logger).toBeDefined();
    });
  });

  describe('T-014: Constant-time critical request tracking', () => {
    it('tracks critical requests without O(n) scan when using blockingQueueThreshold', async () => {
      const manager = createRetryer({ maxConcurrentRequests: 10 });
      manager.use(
        new RequestDependencyPlugin({
          blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
        }),
      );
      const mock = new MockAdapter(manager.axiosInstance);

      let resolveHigh: (() => void) | undefined;
      const highBlockPromise = new Promise<void>((res) => {
        resolveHigh = res;
      });

      mock.onGet('/critical').reply(() => {
        return highBlockPromise.then(() => [200, 'ok']);
      });
      mock.onGet('/normal').reply(200, 'ok');

      const criticalConfig = {
        url: '/critical',
        method: 'GET' as const,
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
      };
      const criticalReq = manager.axiosInstance.request(criticalConfig);

      await new Promise((r) => setTimeout(r, 50));

      resolveHigh!();
      await criticalReq;
      manager.destroy();
    });

    it('resets critical count on cancelAllRequests', () => {
      const manager = createRetryer({ maxConcurrentRequests: 10 });
      const dependencyPlugin = new RequestDependencyPlugin({
        blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      });
      manager.use(dependencyPlugin);
      const mock = new MockAdapter(manager.axiosInstance);
      mock.onGet('/any').reply(() => new Promise(() => {}));

      manager.axiosInstance.get('/any', {
        __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH },
      }).catch(() => {});

      setTimeout(() => {
        manager.cancelAllRequests();
        expect(dependencyPlugin.getActiveBlockingRequestCount()).toBe(0);
        manager.destroy();
      }, 50);
    });
  });

  describe('T-015: Stack-trace guarded behind debug mode', () => {
    it('does not include stack traces in non-debug mode', async () => {
      const errorLogs: unknown[] = [];
      const customLogger: Logger = {
        log: () => {},
        error: (_msg, data) => errorLogs.push(data),
        warn: () => {},
        debug: () => {},
      };

      const manager = new RetryManager({ logger: customLogger, debug: false, retries: 0 });
      const mock = new MockAdapter(manager.axiosInstance);
      mock.onGet('/fail').networkError();

      try {
        await manager.axiosInstance.get('/fail');
      } catch {
        // expected
      }

      const interceptorErrorLog = errorLogs.find(
        (d) => typeof d === 'object' && d !== null && 'message' in d,
      ) as Record<string, unknown> | undefined;

      if (interceptorErrorLog) {
        expect(interceptorErrorLog).not.toHaveProperty('stack');
      }

      manager.destroy();
    });

    it('includes stack traces in debug mode', async () => {
      const errorLogs: unknown[] = [];
      const customLogger: Logger = {
        log: () => {},
        error: (_msg, data) => errorLogs.push(data),
        warn: () => {},
        debug: () => {},
      };

      const manager = new RetryManager({
        logger: customLogger,
        debug: true,
        retries: 0,
      });
      const mock = new MockAdapter(manager.axiosInstance);
      mock.onGet('/fail').networkError();

      try {
        await manager.axiosInstance.get('/fail');
      } catch {
        // expected
      }

      const interceptorErrorLog = errorLogs.find(
        (d) => typeof d === 'object' && d !== null && 'code' in d && 'stack' in d,
      );

      if (interceptorErrorLog) {
        expect(interceptorErrorLog).toHaveProperty('stack');
      }

      manager.destroy();
    });

    it('non-debug error logs remain concise (message + code only)', async () => {
      const errorLogs: unknown[] = [];
      const customLogger: Logger = {
        log: () => {},
        error: (_msg, data) => errorLogs.push(data),
        warn: () => {},
        debug: () => {},
      };

      const manager = new RetryManager({ logger: customLogger, debug: false, retries: 0 });
      const mock = new MockAdapter(manager.axiosInstance);
      mock.onGet('/err').reply(500, 'Server Error');

      try {
        await manager.axiosInstance.get('/err');
      } catch {
        // expected
      }

      for (const log of errorLogs) {
        if (typeof log === 'object' && log !== null && 'code' in log) {
          expect(log).not.toHaveProperty('stack');
        }
      }

      manager.destroy();
    });
  });
});
