/**
 * P2 coverage for TEST_GAP_ANALYSIS.md §27 TypeScript compile-time contracts.
 * Uses @ts-expect-error where a compile failure is the assertion; runtime checks verify widened managers.
 */
import type { AxiosRequestConfig } from 'axios';

import {
  RetryManager,
  createRetryer,
  type AxiosRetryerDetailedMetrics,
  type AxiosRetryerRequestMetadata,
} from '../src';
import { CachingPlugin } from '../src/plugins/CachingPlugin/CachingPlugin';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin/MetricsPlugin';
import { ManualRetryPlugin, type ManualRetryPluginEvents } from '../src/plugins/ManualRetryPlugin';
import type { RetryPlugin } from '../src/types';
import { createTokenRefreshPlugin } from '../src/plugins';

describe('P2 TypeScript contracts (§27)', () => {
  it('27.1 onTokenRefreshed is a type error without TokenRefreshPlugin', () => {
    const manager = new RetryManager({ retries: 0 });
    // @ts-expect-error — token-refresh event is not on the default RetryManager event map
    manager.on('onTokenRefreshed', (_token: string) => {});
    manager.destroy();
  });

  it('27.2 after createTokenRefreshPlugin().use(), onTokenRefreshed compiles', () => {
    const refresh = createTokenRefreshPlugin(async () => ({ token: 't' }));
    const manager = new RetryManager({ retries: 0 }).use(refresh);
    manager.on('onTokenRefreshed', (_token: string) => {});
    manager.destroy();
  });

  it('27.3 onCacheHit is a type error without CachingPlugin', () => {
    const manager = new RetryManager({ retries: 0 });
    // @ts-expect-error — cache events are not on the default RetryManager event map
    manager.on('onCacheHit', () => {});
    manager.destroy();
  });

  it('27.3b with CachingPlugin registered, onCacheHit compiles', () => {
    const manager = new RetryManager({ retries: 0 }).use(new CachingPlugin());
    manager.on('onCacheHit', (_payload) => {});
    manager.destroy();
  });

  it('27.4 listener payload for onMetricsUpdated is structurally typed (runtime smoke)', () => {
    const manager = new RetryManager({ retries: 0 }).use(new MetricsPlugin());
    manager.on('onMetricsUpdated', (payload) => {
      const typed: AxiosRetryerDetailedMetrics = payload;
      expect(typeof typed.totalRequests).toBe('number');
    });
    manager.destroy();
  });

  it('27.5 RetryManagerOptions rejects unknown properties on object literals', () => {
    // @ts-expect-error — excess property check (not a valid RetryManager option)
    createRetryer({ retries: 1, thisIsNotAValidRetryManagerOption: true });
  });

  it('27.6 valid __axiosRetryer.priority literals type-check', () => {
    const ok: AxiosRequestConfig = { url: '/', __axiosRetryer: { priority: 2 } };
    expect(ok.__axiosRetryer?.priority).toBe(2);
  });

  it('27.6 invalid priority is rejected by the type checker', () => {
    const bad: AxiosRequestConfig = {
      url: '/',
      // @ts-expect-error — priority must be AxiosRetryerRequestPriority
      __axiosRetryer: { priority: 99 },
    };
    expect(bad.url).toBe('/');
  });

  it('27.7 custom plugin _events shape is visible after use()', () => {
    type WidgetEvents = { onWidgetTick?: (n: number) => void };
    const widgetPlugin: RetryPlugin<WidgetEvents> = {
      name: 'WidgetPlugin',
      version: '1.0.0',
      initialize: () => {},
    };
    const manager = new RetryManager({ retries: 0 }).use(widgetPlugin);
    manager.on('onWidgetTick', (n: number) => {
      expect(n).toBe(1);
    });
    manager.emit('onWidgetTick', 1);
    manager.destroy();
  });

  it('27.8 chained .use(A).use(B) exposes both plugin event maps', () => {
    const manager = new RetryManager({ retries: 0 })
      .use(new MetricsPlugin())
      .use(new ManualRetryPlugin({ maxRequestsToStore: 1 }));
    manager.on('onMetricsUpdated', () => {});
    manager.on('onManualRetryProcessStarted', () => {});
    manager.destroy();
  });

  it('27.9 AxiosRetryerRequestMetadata documents core optional fields (compile-time shape)', () => {
    const sample: AxiosRetryerRequestMetadata = {
      requestId: 'r',
      priority: 1,
      requestRetries: 2,
      requestMode: 'automatic',
      backoffType: 0,
      extra: { any: 'thing' },
    };
    expect(sample.requestId).toBe('r');
  });

  it('27.10 createRetryer() is assignable to RetryManager', () => {
    const manager: RetryManager = createRetryer({ retries: 0 });
    expect(manager.listPlugins()).toEqual([]);
    manager.destroy();
  });

  it('27.x explicit RetryManager<ManualRetryPluginEvents> allows on() without chaining', () => {
    const manager = new RetryManager<ManualRetryPluginEvents>({ retries: 0 });
    manager.use(new ManualRetryPlugin());
    manager.on('onManualRetryProcessStarted', () => {});
    manager.destroy();
  });
});
