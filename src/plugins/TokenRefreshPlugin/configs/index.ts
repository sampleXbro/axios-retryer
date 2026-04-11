import type { TokenRefreshPluginOptions } from '../types';

export type ResolvedTokenRefreshPluginOptions = Required<Omit<TokenRefreshPluginOptions, 'customErrorDetector'>> & {
  customErrorDetector?: TokenRefreshPluginOptions['customErrorDetector'];
};

export const DEFAULT_TOKEN_REFRESH_PLUGIN_OPTIONS: Required<Omit<TokenRefreshPluginOptions, 'customErrorDetector'>> = {
  maxRefreshAttempts: 3,
  authHeaderName: 'Authorization',
  refreshStatusCodes: [401],
  refreshTimeout: 15000,
  retryOnRefreshFail: true,
  tokenPrefix: 'Bearer ',
  maxRefreshBackoffMs: 30_000,
};

export function resolveTokenRefreshPluginOptions(
  options?: TokenRefreshPluginOptions,
): ResolvedTokenRefreshPluginOptions {
  return { ...DEFAULT_TOKEN_REFRESH_PLUGIN_OPTIONS, ...options };
}
