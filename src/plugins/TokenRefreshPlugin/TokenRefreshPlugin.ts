import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import axios from 'axios';

import type { RetryManager } from '../../core/RetryManager.ts';
import type { RetryLogger } from '../../services/logger.ts';
import type { RetryPlugin } from '../../types';
import type { TokenRefreshPluginOptions } from './types';

const PLUGIN_DEFAULTS: Required<TokenRefreshPluginOptions> = {
  maxRefreshAttempts: 3,
  authHeaderName: 'Authorization',
  refreshStatusCodes: [401],
  refreshTimeout: 15000,
  retryOnRefreshFail: true,
  tokenPrefix: 'Bearer ',
};

/**
 * A RetryPlugin that manages token refresh on certain status codes (e.g., 401).
 * It intercepts failed requests, attempts to refresh the token,
 * and re-dispatches any queued requests if refresh succeeds.
 */
export class TokenRefreshPlugin implements RetryPlugin {
  public name = 'TokenRefreshPlugin';
  public version = '1.0.0';

  private manager!: RetryManager;
  private interceptorId: number | null = null;
  private refreshAxios!: AxiosInstance;
  private isRefreshing = false;
  private refreshQueue: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];

  private readonly refreshToken: (axiosInst: AxiosInstance) => Promise<{ token: string }>;
  private readonly options: Required<TokenRefreshPluginOptions>;
  private logger: RetryLogger | null = null;

  constructor(
    refreshToken: (axiosInst: AxiosInstance) => Promise<{ token: string }>,
    options?: TokenRefreshPluginOptions,
  ) {
    this.refreshToken = refreshToken;
    this.options = { ...PLUGIN_DEFAULTS, ...options };
  }

  /**
   * Called by RetryManager when we register this plugin via manager.use(plugin).
   * Attaches a response interceptor to the manager’s axios instance and
   * creates a dedicated axios instance for refresh calls.
   */
  public initialize(manager: RetryManager): void {
    this.manager = manager;
    // Clone manager's axios defaults into a dedicated instance for refresh calls.
    this.refreshAxios = axios.create(manager.axiosInstance.defaults);
    this.logger = manager.getLogger();

    this.interceptorId = manager.axiosInstance.interceptors.response.use(
      (resp) => resp,
      (error: AxiosError) => this.handleResponseError(error),
    );

    this.manager.axiosInstance.interceptors.request.use((config) => {
      const { authHeaderName } = this.options;
      //update the auth header
      if (this.manager.axiosInstance.defaults.headers.common[authHeaderName] && config.headers[authHeaderName]) {
        config.headers[authHeaderName] = this.manager.axiosInstance.defaults.headers.common[authHeaderName];
      }
      return config;
    });
  }

  /**
   * Called when the plugin is removed.
   */
  public onBeforeDestroyed(manager: RetryManager): void {
    // eslint-disable-next-line eqeqeq
    if (this.interceptorId != null) {
      manager.axiosInstance.interceptors.response.eject(this.interceptorId);
    }
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
    if (originalRequest.__isRetryRefreshRequest) {
      return Promise.reject(error);
    }
    if (!this.isRefreshableError(error)) {
      return Promise.reject(error);
    }
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
    if (!originalRequest.__isRetryRefreshRequest) {
      this.manager.triggerAndEmit('onBeforeTokenRefresh');
    }
    try {
      const token = await this.executeTokenRefresh();
      this.updateAuthHeader(token);
      this.retryQueuedRequests(token);
      return this.retryRequest(originalRequest, token);
    } catch (err) {
      this.handleRefreshFailure();
      return Promise.reject(err);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Attempts token refresh up to (maxRefreshAttempts + 1) times if retryOnRefreshFail is true.
   * Each attempt is subject to a timeout defined in refreshTimeout.
   */
  private async executeTokenRefresh(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('No token refresh handler provided');
    }
    const { maxRefreshAttempts, refreshTimeout, retryOnRefreshFail } = this.options;
    let lastError: Error | undefined;

    // Total attempts = maxRefreshAttempts + 1
    for (let attempt = 1; attempt <= maxRefreshAttempts; attempt++) {
      this.logger?.debug(`[${this.name}] Refresh attempt ${attempt}/${maxRefreshAttempts}`);
      try {
        const refreshPromise = new Promise<{ token: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Token refresh timeout')), refreshTimeout);
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
        lastError = error as Error;
        if (!retryOnRefreshFail) {
          break;
        }
        if (attempt < maxRefreshAttempts + 1) {
          this.logger?.debug(`[${this.name}] Refresh attempt failed, retrying...`);
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
   * Retries the given request using the refreshAxios instance,
   * marking it with __isRetryRefreshRequest to avoid loops.
   */
  private retryRequest(request: AxiosRequestConfig, token: string): Promise<AxiosResponse> {
    const { authHeaderName, tokenPrefix } = this.options;
    request.__isRetryRefreshRequest = true;
    request.headers = {
      ...request.headers,
      [authHeaderName]: `${tokenPrefix}${token}`,
    };
    return this.refreshAxios(request);
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
  private handleRefreshFailure(): void {
    const error = new Error('Token refresh failed');
    this.refreshQueue.forEach(({ reject }) => reject(error));
    this.refreshQueue = [];
    this.manager.triggerAndEmit('onTokenRefreshFailed');
    this.logger?.error(`${this.name} Token refresh failed - clearing queue`);
  }
}
