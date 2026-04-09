import type { AxiosInstance } from 'axios';

export interface TokenRefreshResult {
  /**
   * New access token. When `null` or `undefined` (or omitted), the plugin treats the refresh as a no-op:
   * no header update, no `onTokenRefreshed` / `onTokenRefreshFailed`, and no “failed refresh” short-circuit.
   * Concurrent waiters are released without forcing `TokenRefreshFailedError`.
   */
  token?: string | null;
}

export type TokenRefreshHandler = (axiosInst: AxiosInstance) => Promise<TokenRefreshResult>;

export interface TokenRefreshPluginOptions {
  /** If true, allow multiple refresh attempts up to maxRefreshAttempts on failure. */
  retryOnRefreshFail?: boolean;
  /** Maximum number of refresh attempts (1 => 1 total attempt, 2 => 2 attempts, etc.). */
  maxRefreshAttempts?: number;
  /** Timeout in ms for each refresh call. */
  refreshTimeout?: number;
  /** The HTTP header name to set with the new token (e.g. "Authorization"). */
  authHeaderName?: string;
  /** A prefix for your token (commonly "Bearer "). */
  tokenPrefix?: string;
  /** HTTP status codes that trigger a token refresh (e.g., [401, 419]). */
  refreshStatusCodes?: readonly number[];
  /**
   * Maximum backoff delay in ms between refresh retry attempts.
   * Caps the exponential backoff to prevent multi-minute stalls with high maxRefreshAttempts.
   * Default: 30_000 (30 seconds).
   */
  maxRefreshBackoffMs?: number;
  /**
   * Maximum number of requests that may queue up while a token refresh is in progress.
   * Requests beyond this limit are immediately rejected with `TokenRefreshFailedError`
   * rather than held in memory indefinitely.
   * Default: 1000.
   */
  maxRefreshQueueSize?: number;
  /**
   * Optional function to detect auth errors in response bodies (for APIs that return 200 with error in body)
   * Return true if response contains an auth error that should trigger token refresh
   */
  customErrorDetector?: (response: unknown) => boolean;
}
