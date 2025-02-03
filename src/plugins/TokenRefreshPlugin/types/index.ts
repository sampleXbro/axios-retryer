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
  refreshStatusCodes?: number[];
}
