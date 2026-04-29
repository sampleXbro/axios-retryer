export { TokenRefreshPlugin } from './TokenRefreshPlugin';
export type { TokenRefreshPluginEvents } from './types';
export {
  MissingTokenRefreshHandlerError,
  TokenRefreshAbortError,
  TokenRefreshFailedError,
  TokenRefreshQueueOverflowError,
  TokenRefreshTimeoutError,
} from './errors';
export type { TokenRefreshHandler, TokenRefreshPluginOptions, TokenRefreshResult } from './types';

import { TokenRefreshPlugin } from './TokenRefreshPlugin';
import type { TokenRefreshHandler, TokenRefreshPluginOptions } from './types';

/**
 * Creates a TokenRefreshPlugin instance.
 * Functional alternative to using the `new TokenRefreshPlugin()` constructor.
 *
 * @param refreshToken Function that performs the token refresh operation. Return `{ token: string }` to apply a new token, or resolve with no usable `token` (`null`/`undefined`/omitted) to skip that cycle without failure events (see plugin docs).
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
  options?: TokenRefreshPluginOptions,
): TokenRefreshPlugin {
  return new TokenRefreshPlugin(refreshToken, options);
}
