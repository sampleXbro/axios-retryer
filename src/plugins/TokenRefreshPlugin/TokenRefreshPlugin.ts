import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import axios from 'axios';

import type { RetryManager } from '../../core/RetryManager.ts';
import type { RetryLogger } from '../../services/logger.ts';
import type { RetryPlugin, TokenRefreshPluginEvents } from '../../types';
import { shouldRetryRefreshError, shouldStopRefreshRetries, toTokenRefreshError } from './TokenRefreshAbortError';
import type { TokenRefreshHandler, TokenRefreshPluginOptions, TokenRefreshResult } from './types';
import { assignRequestMetadata, ensureRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';

const PLUGIN_DEFAULTS: Required<Omit<TokenRefreshPluginOptions, 'customErrorDetector'>> = {
  maxRefreshAttempts: 3,
  authHeaderName: 'Authorization',
  refreshStatusCodes: [401],
  refreshTimeout: 15000,
  retryOnRefreshFail: true,
  tokenPrefix: 'Bearer ',
};

function createRetryableRefreshError(message: string): Error & { retryableRefreshFailure: true } {
  const error = new Error(message) as Error & { retryableRefreshFailure: true };
  error.retryableRefreshFailure = true;
  return error;
}

function hasHeader(config: AxiosRequestConfig, headerName: string): boolean {
  const headers = config.headers;
  if (!headers) {
    return false;
  }

  if (typeof (headers as { has?: (name: string) => boolean }).has === 'function') {
    if ((headers as { has: (name: string) => boolean }).has(headerName)) {
      return true;
    }
  }

  if (typeof (headers as { get?: (name: string) => unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => unknown }).get(headerName);
    if (value !== undefined && value !== null && value !== false) {
      return true;
    }
  }

  const target = headerName.toLowerCase();
  if ((headers as Record<string, unknown>)[headerName] !== undefined) {
    return true;
  }

  if ((headers as Record<string, unknown>)[target] !== undefined) {
    return true;
  }

  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function setHeader(config: AxiosRequestConfig, headerName: string, value: string): void {
  if (!config.headers) {
    config.headers = {};
  }

  if (typeof (config.headers as { set?: (name: string, value: string) => void }).set === 'function') {
    (config.headers as { set: (name: string, value: string) => void }).set(headerName, value);
    return;
  }

  config.headers[headerName] = value;
}

/**
 * A RetryPlugin that manages token refresh on certain status codes (e.g., 401).
 * It intercepts failed requests, attempts to refresh the token,
 * and re-dispatches any queued requests if refresh succeeds.
 * 
 * Can also detect custom auth errors in response bodies for APIs that return 200 OK
 * with error messages in the body (like GraphQL).
 */
export class TokenRefreshPlugin implements RetryPlugin<TokenRefreshPluginEvents> {
  public name = 'TokenRefreshPlugin';
  public version = '1.0.0';

  private manager!: RetryManager<TokenRefreshPluginEvents>;
  private requestInterceptorId: number | null = null;
  private interceptorId: number | null = null;
  private responseInterceptorId: number | null = null;
  private refreshAxios!: AxiosInstance;
  private isRefreshing = false;
  private refreshQueue: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];

  private readonly refreshToken: TokenRefreshHandler;
  private readonly options: Required<Omit<TokenRefreshPluginOptions, 'customErrorDetector'>> & {
    customErrorDetector?: TokenRefreshPluginOptions['customErrorDetector'];
  };
  private logger: RetryLogger | null = null;

  constructor(
    refreshToken: TokenRefreshHandler,
    options?: TokenRefreshPluginOptions,
  ) {
    this.refreshToken = refreshToken;
    this.options = { ...PLUGIN_DEFAULTS, ...options };

    if (!Number.isInteger(this.options.maxRefreshAttempts) || this.options.maxRefreshAttempts < 1) {
      throw new Error('maxRefreshAttempts must be a positive integer');
    }
    if (!Number.isInteger(this.options.refreshTimeout) || this.options.refreshTimeout < 1) {
      throw new Error('refreshTimeout must be a positive integer');
    }
  }

  /**
   * Called by RetryManager when we register this plugin via manager.use(plugin).
   * Attaches a response interceptor to the manager's axios instance and
   * creates a dedicated axios instance for refresh calls.
   */
  public initialize(manager: RetryManager<TokenRefreshPluginEvents>): void {
    this.manager = manager;
    // Create a minimal, sandboxed axios instance for refresh calls.
    // Only inherit baseURL and timeout — avoid leaking interceptors, auth headers, or other defaults.
    this.refreshAxios = axios.create({
      baseURL: manager.axiosInstance.defaults.baseURL,
      timeout: this.options.refreshTimeout,
    });
    this.logger = manager.getLogger();

    // Interceptor for handling errors (like 401)
    this.interceptorId = manager.axiosInstance.interceptors.response.use(
      (resp) => resp,
      (error: AxiosError) => this.handleResponseError(error),
    );

    // Add interceptor for successful responses to check for custom errors
    if (this.options.customErrorDetector) {
      this.responseInterceptorId = manager.axiosInstance.interceptors.response.use(
        (response) => this.handleSuccessResponse(response),
        (error) => Promise.reject(error),
      );
    }

    this.requestInterceptorId = this.manager.axiosInstance.interceptors.request.use(async (config) => {
      const metadata = ensureRequestMetadata(config);
      const { authHeaderName } = this.options;
      const currentToken = this.manager.axiosInstance.defaults.headers.common[authHeaderName];

      if (this.isRefreshing && !metadata.isRetryRefreshRequest && hasHeader(config, authHeaderName)) {
        return new Promise((resolve, reject) => {
          this.refreshQueue.push({
            resolve: (token: string) => {
              setHeader(config, authHeaderName, `${this.options.tokenPrefix}${token}`);
              resolve(config);
            },
            reject,
          });
        });
      }

      if (currentToken && hasHeader(config, authHeaderName)) {
        setHeader(config, authHeaderName, String(currentToken));
      }
      return config;
    });
  }

  /**
   * Called when the plugin is removed.
   */
  public onBeforeDestroyed(manager: RetryManager<TokenRefreshPluginEvents>): void {
    if (this.requestInterceptorId !== null) {
      manager.axiosInstance.interceptors.request.eject(this.requestInterceptorId);
    }
    if (this.interceptorId !== null) {
      manager.axiosInstance.interceptors.response.eject(this.interceptorId);
    }
    if (this.responseInterceptorId !== null) {
      manager.axiosInstance.interceptors.response.eject(this.responseInterceptorId);
    }
  }

  /**
   * Checks successful responses for custom auth errors in the response body
   */
  private async handleSuccessResponse(response: AxiosResponse): Promise<AxiosResponse> {
    const { customErrorDetector } = this.options;
    const metadata = getRequestMetadata(response.config);
    
    // Skip if request is a refresh request or if no detector provided
    if (metadata?.isRetryRefreshRequest || !customErrorDetector) {
      return response;
    }

    // Check if response contains auth error that should trigger refresh
    if (customErrorDetector(response.data)) {
      this.logger?.debug(`[${this.name}] Custom auth error detected in response body`);
      this.manager.releaseRequestTracking(response.config);
      
      if (this.isRefreshing) {
        // Queue the request and wait for token refresh to complete
        return new Promise((resolve, reject) => {
          this.refreshQueue.push({
            resolve: (token: string) => {
              // Once we have the token, retry with it
              this.retryRequest(response.config, token)
                .then(resolve)
                .catch(reject);
            },
            reject,
          });
        });
      }
      
      try {
        // Start refresh flow
        this.isRefreshing = true;
        const token = await this.executeTokenRefresh();
        this.updateAuthHeader(token);
        this.retryQueuedRequests(token);
        
        // Retry the current request with new token
        return this.retryRequest(response.config, token);
      } catch (err) {
        this.handleRefreshFailure(err);
        throw err;
      } finally {
        this.isRefreshing = false;
      }
    }

    return response;
  }

  /**
   * Intercepts a failed response. If the error status is refreshable and the request
   * hasn't already been retried, then either queues the request (if refresh is in progress)
   * or starts a new refresh cycle.
   */
  private async handleResponseError(error: AxiosError): Promise<AxiosResponse> {
    const originalRequest = error.config;
    if (!originalRequest) {
      return Promise.reject(error);
    }
    if (getRequestMetadata(originalRequest)?.isRetryRefreshRequest) {
      return Promise.reject(error);
    }
    if (!this.isRefreshableError(error)) {
      return Promise.reject(error);
    }
    this.manager.releaseRequestTracking(originalRequest);
    if (this.isRefreshing) {
      return this.queueRefreshRequest(originalRequest);
    }
    return this.handleTokenRefresh(originalRequest);
  }

  /**
   * Checks if the error status code is in the list of refreshable status codes.
   */
  private isRefreshableError(error: AxiosError): boolean {
    const status = error.response?.status ?? -1;
    return this.options.refreshStatusCodes.includes(status);
  }

  /**
   * Main token refresh flow:
   *  1) Set isRefreshing = true.
   *  2) Attempt to refresh the token.
   *  3) On success, update the auth header and retry both queued and original requests.
   *  4) On failure, clear the queue and reject.
   */
  private async handleTokenRefresh(originalRequest: AxiosRequestConfig): Promise<AxiosResponse> {
    this.isRefreshing = true;
    if (!getRequestMetadata(originalRequest)?.isRetryRefreshRequest) {
      this.manager.triggerAndEmit('onBeforeTokenRefresh');
    }
    try {
      const token = await this.executeTokenRefresh();
      this.updateAuthHeader(token);
      this.retryQueuedRequests(token);
      return this.retryRequest(originalRequest, token);
    } catch (err) {
      this.handleRefreshFailure(err);
      return Promise.reject(err);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Attempts token refresh up to maxRefreshAttempts times if retryOnRefreshFail is true.
   * Each attempt is subject to a timeout defined in refreshTimeout.
   * Throw a non-Axios error from the refresh handler to stop remaining refresh retries immediately,
   * for example when no refresh token is available in storage.
   */
  private async executeTokenRefresh(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('No token refresh handler provided');
    }
    const { maxRefreshAttempts, refreshTimeout, retryOnRefreshFail } = this.options;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRefreshAttempts; attempt++) {
      this.logger?.debug(`[${this.name}] Refresh attempt ${attempt}/${maxRefreshAttempts}`);
      try {
        const refreshPromise = new Promise<TokenRefreshResult>((resolve, reject) => {
          const timer = setTimeout(() => reject(createRetryableRefreshError('Token refresh timeout')), refreshTimeout);
          this.refreshToken(this.refreshAxios)
            .then((res) => {
              clearTimeout(timer);
              resolve(res);
            })
            .catch((err) => {
              clearTimeout(timer);
              reject(err);
            });
        });
        const { token } = await refreshPromise;
        this.manager.triggerAndEmit('onTokenRefreshed', token);
        this.logger?.debug(`[${this.name}] Token successfully refreshed`);
        return token;
      } catch (error) {
        lastError = toTokenRefreshError(error);
        if (shouldStopRefreshRetries(error)) {
          this.logger?.debug(`[${this.name}] Refresh retries aborted by refresh handler`, {
            attempt,
            reason: lastError.message,
          });
          break;
        }
        if (!shouldRetryRefreshError(error)) {
          this.logger?.debug(`[${this.name}] Refresh retries stopped after a terminal refresh error`, {
            attempt,
            reason: lastError.message,
          });
          break;
        }
        if (!retryOnRefreshFail) {
          break;
        }
        if (attempt < maxRefreshAttempts) {
          const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s...
          this.logger?.debug(`[${this.name}] Refresh attempt failed, retrying in ${backoffMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

  /**
   * Updates the manager's default auth header so subsequent requests automatically carry the new token.
   */
  private updateAuthHeader(token: string): void {
    const { authHeaderName, tokenPrefix } = this.options;
    this.manager.axiosInstance.defaults.headers.common[authHeaderName] = `${tokenPrefix}${token}`;
  }

  /**
   * Retries the given request through the retry manager pipeline,
   * marking it with __isRetryRefreshRequest to avoid loops.
   */
  private retryRequest(request: AxiosRequestConfig, token: string): Promise<AxiosResponse> {
    const { authHeaderName, tokenPrefix } = this.options;
    const replayRequest: AxiosRequestConfig = {
      ...request,
      headers: {
        ...request.headers,
        [authHeaderName]: `${tokenPrefix}${token}`,
      },
    };
    assignRequestMetadata(replayRequest, {
      isRetryRefreshRequest: true,
    });
    return this.manager.axiosInstance.request(replayRequest);
  }

  /**
   * If a 401 is encountered while a refresh is already in progress, queue the request.
   */
  private queueRefreshRequest(request: AxiosRequestConfig): Promise<AxiosResponse> {
    return new Promise((resolve, reject) => {
      this.refreshQueue.push({
        resolve: (token: string) => resolve(this.retryRequest(request, token)),
        reject,
      });
    });
  }

  /**
   * Once the token is refreshed, re-dispatch all queued requests.
   */
  private retryQueuedRequests(token: string): void {
    this.refreshQueue.forEach(({ resolve }) => resolve(token));
    this.refreshQueue = [];
  }

  /**
   * If the token refresh fails completely, reject all queued requests and emit an event.
   */
  private handleRefreshFailure(error?: unknown): void {
    const refreshError = shouldStopRefreshRetries(error) || !shouldRetryRefreshError(error)
      ? toTokenRefreshError(error)
      : new Error('Token refresh failed');
    this.refreshQueue.forEach(({ reject }) => reject(refreshError));
    this.refreshQueue = [];
    this.manager.triggerAndEmit('onTokenRefreshFailed');
    this.logger?.error(`${this.name} Token refresh failed - clearing queue`, {
      reason: refreshError.message,
      aborted: shouldStopRefreshRetries(error) || !shouldRetryRefreshError(error),
    });
  }
}
