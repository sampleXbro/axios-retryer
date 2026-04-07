/**
 * Compile-time checks: plugin events are only on the RetryManager type returned from use(),
 * not on a variable that was only ever typed as new RetryManager() / createRetryer().
 */
import { RetryManager, createRetryer } from '../src';
import {
  ManualRetryPlugin,
  type ManualRetryPluginEvents,
} from '../src/plugins/ManualRetryPlugin';

describe('RetryManager.use() and plugin event types', () => {
  const plugin = new ManualRetryPlugin({ maxRequestsToStore: 10 });

  it('does not amend the type when use() return is ignored (expect TS error)', () => {
    const retryManager = new RetryManager({ retries: 0 });
    retryManager.use(plugin);
    // @ts-expect-error onManualRetryProcessStarted is not on RetryManager<{}> — use return value of use()
    retryManager.on('onManualRetryProcessStarted', () => {});
  });

  it('does not amend let binding when reassigning from use() (expect TS error)', () => {
    let retryManager = new RetryManager({ retries: 0 });
    retryManager = retryManager.use(plugin);
    // @ts-expect-error let stays RetryManager<{}>; assign use() to a new const or chain on new RetryManager()
    retryManager.on('onManualRetryProcessStarted', () => {});
  });

  it('chain .use() so the manager variable includes ManualRetryPlugin events', () => {
    const retryManager = new RetryManager({ retries: 0 }).use(plugin);
    retryManager.on('onManualRetryProcessStarted', () => {});
    expect(retryManager.listPlugins().some((p) => p.name === 'ManualRetryPlugin')).toBe(true);
  });

  it('createRetryer().use(plugin) widens the same way as RetryManager', () => {
    const retryer = createRetryer({ retries: 0 }).use(plugin);
    retryer.on('onManualRetryProcessStarted', () => {});
    expect(retryer.listPlugins().some((p) => p.name === 'ManualRetryPlugin')).toBe(true);
  });

  it('assign use() to a new const — let + reassignment does not widen TS type of the binding', () => {
    const base = new RetryManager({ retries: 0 });
    const withPlugin = base.use(plugin);
    withPlugin.on('onManualRetryProcessStarted', () => {});
    expect(withPlugin.listPlugins().some((p) => p.name === 'ManualRetryPlugin')).toBe(true);
  });

  it('explicit generic on constructor includes plugin events without chaining', () => {
    const retryManager = new RetryManager<ManualRetryPluginEvents>({
      retries: 0,
    });
    retryManager.use(plugin);
    retryManager.on('onManualRetryProcessStarted', () => {});
    expect(retryManager.listPlugins().some((p) => p.name === 'ManualRetryPlugin')).toBe(true);
  });
});
