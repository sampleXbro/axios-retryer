import { createRetryer } from '../src';
import { createManualRetryPlugin, createTokenRefreshPlugin } from '../src/plugins';

const verifyDynamicEventTyping = (): void => {
  const retryer = createRetryer();

  retryer.on('beforeRetry', (config) => {
    const requestUrl: string | undefined = config.url;
    expect(requestUrl).toBeDefined();
  });

  // @ts-expect-error Token refresh events require TokenRefreshPlugin to be registered first.
  retryer.on('onTokenRefreshed', () => undefined);

  // @ts-expect-error Manual replay events require ManualRetryPlugin to be registered first.
  retryer.on('onManualRetryProcessStarted', () => undefined);

  const retryerWithTokenRefresh = retryer.use(createTokenRefreshPlugin(async () => ({ token: 'fresh-token' })));
  const retryerWithManualRetry = retryer.use(createManualRetryPlugin());

  const tokenListener = (token: string): void => {
    expect(token).toBe('fresh-token');
  };

  retryerWithTokenRefresh.on('onTokenRefreshed', tokenListener);
  retryerWithTokenRefresh.off('onTokenRefreshed', tokenListener);
  retryerWithTokenRefresh.triggerAndEmit('onTokenRefreshed', 'fresh-token');
  retryerWithManualRetry.on('onManualRetryProcessStarted', () => undefined);
};

describe('RetryManager dynamic event typing', () => {
  it('narrows plugin events after plugin registration', () => {
    expect(typeof verifyDynamicEventTyping).toBe('function');
  });
});
