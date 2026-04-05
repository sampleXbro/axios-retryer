export { TokenRefreshPlugin } from './TokenRefreshPlugin';
export type { TokenRefreshPluginEvents } from './TokenRefreshPlugin';
export { MissingTokenRefreshHandlerError } from './MissingTokenRefreshHandlerError';
export { TokenRefreshAbortError } from './TokenRefreshAbortError';
export { TokenRefreshFailedError } from './TokenRefreshFailedError';
export { TokenRefreshTimeoutError } from './TokenRefreshTimeoutError';
export type { TokenRefreshHandler, TokenRefreshPluginOptions, TokenRefreshResult } from './types';

import { TokenRefreshPlugin } from './TokenRefreshPlugin';
import { TokenRefreshAbortError } from './TokenRefreshAbortError';
import type { TokenRefreshHandler, TokenRefreshPluginOptions } from './types';

/**
 * Creates a TokenRefreshPlugin instance.
 * Functional alternative to using the `new TokenRefreshPlugin()` constructor.
 *
 * @param refreshToken Function that performs the token refresh operation
 * @param options Configuration options for the TokenRefreshPlugin
 * @returns A configured TokenRefreshPlugin instance
 * 
 * @example
 * ```typescript
 * const tokenRefresher = createTokenRefreshPlugin(
 *   async (axiosInstance) => {
 *     const refreshToken = localStorage.getItem('refreshToken');
 *     if (!refreshToken) {
 *       throw new TokenRefreshAbortError('Refresh token not found');
 *     }
 *     const { data } = await axiosInstance.post('/auth/refresh', { refreshToken });
 *     return { token: data.accessToken };
 *   },
 *   { 
 *     authHeaderName: 'Authorization',
 *     tokenPrefix: 'Bearer '
 *   }
 * );
 * 
 * manager.use(tokenRefresher);
 * ```
 */
export function createTokenRefreshPlugin(
  refreshToken: TokenRefreshHandler,
  options?: TokenRefreshPluginOptions
): TokenRefreshPlugin {
  return new TokenRefreshPlugin(refreshToken, options);
}
