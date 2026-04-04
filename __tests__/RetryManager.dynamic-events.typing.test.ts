import { createRetryer } from '../src';
import { createTokenRefreshPlugin } from '../src/plugins';

const verifyDynamicEventTyping = (): void => {
  const retryer = createRetryer();

  retryer.on('beforeRetry', (config) => {
    const requestUrl: string | undefined = config.url;
    expect(requestUrl).toBeDefined();
  });

  // @ts-expect-error Token refresh events require TokenRefreshPlugin to be registered first.
  retryer.on('onTokenRefreshed', () => undefined);

  // @ts-expect-error Hook-only callbacks are not subscribable events.
  retryer.on('beforeManualRetry', () => null);

  const retryerWithTokenRefresh = retryer.use(createTokenRefreshPlugin(async () => ({ token: 'fresh-token' })));

  const tokenListener = (token: string): void => {
    expect(token).toBe('fresh-token');
  };

  retryerWithTokenRefresh.on('onTokenRefreshed', tokenListener);
  retryerWithTokenRefresh.off('onTokenRefreshed', tokenListener);
  retryerWithTokenRefresh.triggerAndEmit('onTokenRefreshed', 'fresh-token');
};

describe('RetryManager dynamic event typing', () => {
  it('narrows plugin events after plugin registration', () => {
    expect(typeof verifyDynamicEventTyping).toBe('function');
  });
});
