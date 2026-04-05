import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import axios from 'axios';

import { RetryerConfigError } from '../../core/errors/RetryerConfigError';
import { TimerManager } from '../../core/TimerManager';
import type { Logger, PluginContext, RetryPlugin } from '../../types';

/**
 * Events added by TokenRefreshPlugin.
 */
export interface TokenRefreshPluginEvents {
  /**
   * Called immediately after a new token is successfully obtained from the refresh flow.
   * @param newToken - The newly acquired token string.
   */
  onTokenRefreshed?: (newToken: string) => void;
  /**
   * Called when all token refresh attempts have failed.
   */
  onTokenRefreshFailed?: () => void;
  /**
   * Called right before the token refresh process begins.
   */
  onBeforeTokenRefresh?: () => void;
}
import {
  createRetryableRefreshError,
  shouldRetryRefreshError,
  shouldStopRefreshRetries,
  TokenRefreshAbortError,
  toTokenRefreshError,
} from './TokenRefreshAbortError';
import { TokenRefreshFailedError } from './TokenRefreshFailedError';
import { MissingTokenRefreshHandlerError } from './MissingTokenRefreshHandlerError';
import type { TokenRefreshHandler, TokenRefreshPluginOptions, TokenRefreshResult } from './types';
import { assignRequestMetadata, ensureRequestMetadata, getRequestMetadata } from '../../utils/requestMetadata';

const PLUGIN_DEFAULTS: Required<Omit<TokenRefreshPluginOptions, 'customErrorDetector'>> = {
  maxRefreshAttempts: 3,
  authHeaderName: 'Authorization',
  refreshStatusCodes: [401],
  refreshTimeout: 15000,
  retryOnRefreshFail: true,
  tokenPrefix: 'Bearer ',
  maxRefreshBackoffMs: 30_000,
};

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

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

function createRefreshAxios(
  context: { axiosInstance: AxiosInstance },
  refreshTimeout: number,
): AxiosInstance {
  const defaults = context.axiosInstance.defaults;

  return axios.create({
    adapter: defaults.adapter,
    baseURL: defaults.baseURL,
    timeout: refreshTimeout,
    withCredentials: defaults.withCredentials,
    httpAgent: defaults.httpAgent,
    httpsAgent: defaults.httpsAgent,
    proxy: defaults.proxy,
    socketPath: defaults.socketPath,
    maxRedirects: defaults.maxRedirects,
  });
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

  private context!: PluginContext<TokenRefreshPluginEvents>;
  private requestInterceptorId: number | null = null;
  private interceptorId: number | null = null;
  private responseInterceptorId: number | null = null;
  private refreshAxios!: AxiosInstance;
  private isRefreshing = false;
  private refreshQueue: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];
  private teardownError: Error | null = null;
  private readonly teardownListeners = new Set<(error: Error) => void>();
  private timerManager = new TimerManager();

  private readonly refreshToken: TokenRefreshHandler;
  private readonly options: Required<Omit<TokenRefreshPluginOptions, 'customErrorDetector'>> & {
    customErrorDetector?: TokenRefreshPluginOptions['customErrorDetector'];
  };
  private logger: Logger | null = null;

  constructor(
    refreshToken: TokenRefreshHandler,
    options?: TokenRefreshPluginOptions,
  ) {
    this.refreshToken = refreshToken;
    this.options = { ...PLUGIN_DEFAULTS, ...options };

    if (!Number.isInteger(this.options.maxRefreshAttempts) || this.options.maxRefreshAttempts < 1) {
      throw new RetryerConfigError(
        'maxRefreshAttempts must be a positive integer',
        'maxRefreshAttempts',
        this.options.maxRefreshAttempts,
      );
    }
    if (!Number.isInteger(this.options.refreshTimeout) || this.options.refreshTimeout < 1) {
      throw new RetryerConfigError(
        'refreshTimeout must be a positive integer',
        'refreshTimeout',
        this.options.refreshTimeout,
      );
    }
  }

  /**
   * Called by RetryManager when we register this plugin via manager.use(plugin).
   * Attaches a response interceptor to the manager's axios instance and
   * creates a dedicated axios instance for refresh calls.
   */
  public initialize(context: PluginContext<TokenRefreshPluginEvents>): void {
    this.timerManager.destroy();
    this.timerManager = new TimerManager();
    this.context = context;
    this.isRefreshing = false;
    this.refreshQueue = [];
    this.teardownError = null;
    this.teardownListeners.clear();
    // Create a sandboxed axios instance for refresh calls.
    // Inherit transport defaults such as baseURL and adapter, but do not reuse
    // the manager interceptors or any default auth headers.
    this.refreshAxios = createRefreshAxios(context, this.options.refreshTimeout);
    this.logger = context.getLogger();

    // Interceptor for handling errors (like 401)
    this.interceptorId = context.axiosInstance.interceptors.response.use(
      (resp) => resp,
      (error: AxiosError) => this.handleResponseError(error),
    );

    // Add interceptor for successful responses to check for custom errors
    if (this.options.customErrorDetector) {
      this.responseInterceptorId = context.axiosInstance.interceptors.response.use(
        (response) => this.handleSuccessResponse(response),
        (error) => Promise.reject(error),
      );
    }

    this.requestInterceptorId = this.context.axiosInstance.interceptors.request.use(async (config) => {
      const metadata = ensureRequestMetadata(config);
      const { authHeaderName } = this.options;
      const currentToken = this.context.axiosInstance.defaults.headers.common[authHeaderName];

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
  public onBeforeDestroyed(context: PluginContext<TokenRefreshPluginEvents>): void {
    this.dispose(new TokenRefreshAbortError('Token refresh aborted because the plugin was destroyed'));

    if (this.requestInterceptorId !== null) {
      context.axiosInstance.interceptors.request.eject(this.requestInterceptorId);
    }
    if (this.interceptorId !== null) {
      context.axiosInstance.interceptors.response.eject(this.interceptorId);
    }
    if (this.responseInterceptorId !== null) {
      context.axiosInstance.interceptors.response.eject(this.responseInterceptorId);
    }
  }

  private withTeardown<T>(promise: Promise<T>): Promise<T> {
    if (this.teardownError) {
      return Promise.reject(this.teardownError);
    }

    return new Promise<T>((resolve, reject) => {
      const rejectOnTeardown = (error: Error) => {
        reject(error);
      };

      this.teardownListeners.add(rejectOnTeardown);

      promise.then(resolve, reject).finally(() => {
        this.teardownListeners.delete(rejectOnTeardown);
      });
    });
  }

  private ensureActive(): void {
    if (this.teardownError) {
      throw this.teardownError;
    }
  }

  private dispose(error: Error): void {
    if (this.teardownError) {
      return;
    }

    this.timerManager.destroy();
    this.teardownError = error;
    this.isRefreshing = false;
    this.refreshQueue.forEach(({ reject }) => reject(error));
    this.refreshQueue = [];

    this.teardownListeners.forEach((listener) => listener(error));
    this.teardownListeners.clear();
  }

  /**
   * Checks successful responses for custom auth errors in the response body
   */
  private async handleSuccessResponse(response: AxiosResponse): Promise<AxiosResponse> {
    this.ensureActive();
    const { customErrorDetector } = this.options;
    const metadata = getRequestMetadata(response.config);
    
    // Skip if request is a refresh request or if no detector provided
    if (metadata?.isRetryRefreshRequest || !customErrorDetector) {
      return response;
    }

    // Check if response contains auth error that should trigger refresh
    if (customErrorDetector(response.data)) {
      this.logger?.debug(`[${this.name}] Custom auth error detected in response body`);
      this.context.releaseRequestTracking(response.config);
      
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
        const token = await this.withTeardown(this.executeTokenRefresh());
        this.ensureActive();
        this.updateAuthHeader(token);
        this.retryQueuedRequests(token);
        
        // Retry the current request with new token
        return this.withTeardown(this.retryRequest(response.config, token));
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
    this.ensureActive();
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
    this.context.releaseRequestTracking(originalRequest);
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
      this.context.triggerAndEmit('onBeforeTokenRefresh');
    }
    try {
      const token = await this.withTeardown(this.executeTokenRefresh());
      this.ensureActive();
      this.updateAuthHeader(token);
      this.retryQueuedRequests(token);
      return this.withTeardown(this.retryRequest(originalRequest, token));
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
    this.ensureActive();
    if (!this.refreshToken) {
      throw new MissingTokenRefreshHandlerError();
    }
    const { maxRefreshAttempts, refreshTimeout, retryOnRefreshFail } = this.options;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRefreshAttempts; attempt++) {
      this.ensureActive();
      this.logger?.debug(`[${this.name}] Refresh attempt ${attempt}/${maxRefreshAttempts}`);
      try {
        const refreshPromise = new Promise<TokenRefreshResult>((resolve, reject) => {
          const { cancel: cancelTimeout } = this.timerManager.createTimeout(
            () => reject(createRetryableRefreshError('Token refresh timeout')),
            refreshTimeout,
          );
          this.refreshToken(this.refreshAxios)
            .then((res) => {
              cancelTimeout();
              resolve(res);
            })
            .catch((err) => {
              cancelTimeout();
              reject(err);
            });
        });
        const { token } = await this.withTeardown(refreshPromise);
        this.ensureActive();
        this.context.triggerAndEmit('onTokenRefreshed', token);
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
          const backoffMs = Math.min(1000 * 2 ** (attempt - 1), this.options.maxRefreshBackoffMs); // 1s, 2s, 4s… capped
          this.logger?.debug(`[${this.name}] Refresh attempt failed, retrying in ${backoffMs}ms...`);
          const { promise: backoffPromise } = this.timerManager.createSleep(backoffMs);
          await this.withTeardown(backoffPromise);
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
    this.context.axiosInstance.defaults.headers.common[authHeaderName] = `${tokenPrefix}${sanitizeHeaderValue(token)}`;
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
        [authHeaderName]: `${tokenPrefix}${sanitizeHeaderValue(token)}`,
      },
    };
    assignRequestMetadata(replayRequest, {
      isRetryRefreshRequest: true,
    });
    return this.context.axiosInstance.request(replayRequest);
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
    if (this.teardownError) {
      error = this.teardownError;
    }

    const refreshError = shouldStopRefreshRetries(error) || !shouldRetryRefreshError(error)
      ? toTokenRefreshError(error)
      : new TokenRefreshFailedError();
    this.refreshQueue.forEach(({ reject }) => reject(refreshError));
    this.refreshQueue = [];
    this.context.triggerAndEmit('onTokenRefreshFailed');
    this.logger?.error(`${this.name} Token refresh failed - clearing queue`, {
      reason: refreshError.message,
      aborted: shouldStopRefreshRetries(error) || !shouldRetryRefreshError(error),
    });
  }
}
