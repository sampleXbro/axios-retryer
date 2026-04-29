/**
 * Branch coverage for MetricsPlugin: resetMetrics, emitMetricsUpdated guard
 * when context is null (after destroy), and the early-return path.
 */
import axios from 'axios';

import { RetryManager } from '../src';
import { MetricsPlugin } from '../src/plugins/MetricsPlugin';

describe('MetricsPlugin extra branches', () => {
  it('resetMetrics zeroes the collector and emits onMetricsUpdated', () => {
    const axiosInstance = axios.create();
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);

    const observed: unknown[] = [];
    manager.on('onMetricsUpdated' as never, (snapshot) => {
      observed.push(snapshot);
    });

    plugin.resetMetrics();
    // resetMetrics → collector.reset → emitMetricsUpdated → onMetricsUpdated.
    expect(observed.length).toBeGreaterThanOrEqual(1);

    manager.destroy();
  });

  it('emitMetricsUpdated returns early after onBeforeDestroyed clears the context', () => {
    const axiosInstance = axios.create();
    const manager = new RetryManager({ axiosInstance, retries: 0 });
    const plugin = new MetricsPlugin();
    manager.use(plugin);

    // Pull the recorder before destroy so we can poke it after.
    const recorderEmit: () => void = (plugin as unknown as { emitMetricsUpdated: () => void }).emitMetricsUpdated.bind(
      plugin,
    );

    manager.destroy();

    // After destroy the context is null → emitMetricsUpdated should bail without throwing.
    expect(() => recorderEmit()).not.toThrow();
  });
});
