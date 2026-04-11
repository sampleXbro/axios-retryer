import type { AxiosRequestConfig } from 'axios';

/**
 * Header names that indicate authenticated or personalized traffic.
 * Requests carrying any of these headers are excluded from caching by default
 * to prevent cross-principal cache collisions.
 */
const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-auth-token', 'x-api-key']);

export function requestHasAuthHeaders(config: AxiosRequestConfig): boolean {
  if (!config.headers) {
    return false;
  }

  const headers = config.headers as Record<string, unknown>;

  for (const key of Object.keys(headers)) {
    if (AUTH_HEADERS.has(key.toLowerCase())) {
      return true;
    }
  }

  return false;
}
