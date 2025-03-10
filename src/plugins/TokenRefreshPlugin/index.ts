export { TokenRefreshPlugin } from './TokenRefreshPlugin';
export type { TokenRefreshPluginOptions } from './types';

import { TokenRefreshPlugin } from './TokenRefreshPlugin';
import type { TokenRefreshPluginOptions } from './types';
import type { AxiosInstance } from 'axios';

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
  refreshToken: (axiosInst: AxiosInstance) => Promise<{ token: string }>,
  options?: TokenRefreshPluginOptions
): TokenRefreshPlugin {
  return new TokenRefreshPlugin(refreshToken, options);
}