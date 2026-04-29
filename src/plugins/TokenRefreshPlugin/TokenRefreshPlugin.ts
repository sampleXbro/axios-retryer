import type { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { AxiosError } from 'axios';

import { RetryerConfigError } from '../../core/errors/RetryerConfigError';
import { TimerManager } from '../../core/TimerManager';
import type { Logger, PluginContext, RetryPlugin } from '../../types';
import {
  shouldRetryRefreshError,
  shouldStopRefreshRetries,
  TokenRefreshAbortError,
  toTokenRefreshError,
} from './errors';
import { TokenRefreshFailedError, TokenRefreshQueueOverflowError } from './errors';
import { resolveTokenRefreshPluginOptions, type ResolvedTokenRefreshPluginOptions } from './configs';
import type {
  RefreshQueueEntry,
  TokenRefreshHandler,
  TokenRefreshPluginEvents,
  TokenRefreshPluginOptions,
} from './types';
import { TeardownGuard } from './managers/TeardownGuard';
import { RefreshExecutor } from './managers/RefreshExecutor';
import {
  createRefreshAxios,
  extractTokenFromAuthHeader,
  getHeader,
  hasHeader,
  safeStringEqual,
  sanitizeHeaderValue,
  setHeader,
} from './utils';
import {
  assignRequestMetadata,
  ensureRequestMetadata,
  getRequestMetadata,
  setRequestMetadataValue,
} from '../../utils/requestMetadata';

export type { TokenRefreshPluginEvents } from './types';

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
  public readonly _events?: Readonly<TokenRefreshPluginEvents>;

  private context!: PluginContext<TokenRefreshPluginEvents>;
  private requestInterceptorId: number | null = null;
  private interceptorId: number | null = null;
  private responseInterceptorId: number | null = null;
  private refreshAxios!: AxiosInstance;
  private isRefreshing = false;
  private refreshQueue: RefreshQueueEntry[] = [];
  private readonly teardown = new TeardownGuard();
  private timerManager = new TimerManager();
  private failedAuthHeaderValue: string | null = null;

  private readonly refreshToken: TokenRefreshHandler;
  private readonly options: ResolvedTokenRefreshPluginOptions;
  private logger: Logger | null = null;

  constructor(refreshToken: TokenRefreshHandler, options?: TokenRefreshPluginOptions) {
    this.refreshToken = refreshToken;
    this.options = resolveTokenRefreshPluginOptions(options);

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
    this.teardown.reset();
    this.failedAuthHeaderValue = null;
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
      if (metadata.manualReplayAttempt) {
        this.failedAuthHeaderValue = null;
        setRequestMetadataValue(config, 'manualReplayAttempt', undefined);
      }
      const { authHeaderName } = this.options;
      const currentToken = this.context.axiosInstance.defaults.headers.common[authHeaderName];

      if (!metadata.isRetryRefreshRequest && hasHeader(config, authHeaderName)) {
        if (this.isRefreshing) {
          if (this.isQueueOverflowing()) {
            this.context.releaseRequestTracking(config);
            return Promise.reject(this.bindRefreshErrorToRequest(this.buildQueueOverflowError(), config));
          }
          // Refresh in progress — queue this request until the new token arrives.
          return new Promise((resolve, reject) => {
            this.refreshQueue.push({
              kind: 'hold-request',
              config,
              resolveConfig: (c) => resolve(c as InternalAxiosRequestConfig),
              reject,
            });
          });
        }

        // The current token is known to have failed refresh — reject before hitting the network.
        // Compare against the token THIS REQUEST is actually carrying, not the defaults, so that
        // requests bearing a fresh token (e.g. from ManualRetryPlugin's rehydrateAuth) are not
        // incorrectly fast-failed when the defaults haven't been updated yet.
        const requestTokenValue = getHeader(config, authHeaderName);
        if (
          this.failedAuthHeaderValue !== null &&
          requestTokenValue !== null &&
          safeStringEqual(requestTokenValue, this.failedAuthHeaderValue)
        ) {
          this.context.releaseRequestTracking(config);
          return Promise.reject(this.bindRefreshErrorToRequest(new TokenRefreshFailedError(), config));
        }
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
      this.requestInterceptorId = null;
    }
    if (this.interceptorId !== null) {
      context.axiosInstance.interceptors.response.eject(this.interceptorId);
      this.interceptorId = null;
    }
    if (this.responseInterceptorId !== null) {
      context.axiosInstance.interceptors.response.eject(this.responseInterceptorId);
      this.responseInterceptorId = null;
    }
  }

  private withTeardown<T>(promise: Promise<T>): Promise<T> {
    return this.teardown.wrap(promise);
  }

  private ensureActive(): void {
    this.teardown.ensureActive();
  }

  private bindRefreshErrorToRequest(error: Error, config: AxiosRequestConfig, response?: AxiosResponse): AxiosError {
    const axiosError = new AxiosError(
      error.message,
      'TOKEN_REFRESH_FAILED',
      config as InternalAxiosRequestConfig,
      undefined,
      response,
    );

    axiosError.name = error.name;
    (axiosError as Error & { cause?: unknown }).cause = (error as Error & { cause?: unknown }).cause ?? error;

    return axiosError;
  }

  /**
   * Returns true when the queue is at or above `maxQueuedRequests`.
   * A value <= 0 disables the cap.
   */
  private isQueueOverflowing(): boolean {
    const cap = this.options.maxQueuedRequests;
    if (!Number.isFinite(cap) || cap <= 0) return false;
    return this.refreshQueue.length >= cap;
  }

  private buildQueueOverflowError(): TokenRefreshQueueOverflowError {
    const error = new TokenRefreshQueueOverflowError(this.refreshQueue.length);
    this.logger?.warn(`[${this.name}] Refresh queue overflow; rejecting incoming request`, {
      queueSize: this.refreshQueue.length,
      maxQueuedRequests: this.options.maxQueuedRequests,
    });
    return error;
  }

  private rejectQueueEntryWithBoundError(logicalError: Error, entry: RefreshQueueEntry): void {
    if (entry.kind === 'hold-request') {
      this.context.releaseRequestTracking(entry.config);
      entry.reject(this.bindRefreshErrorToRequest(logicalError, entry.config));
    } else if (entry.kind === 'retry-after-error') {
      entry.reject(this.bindRefreshErrorToRequest(logicalError, entry.request, entry.sourceError.response));
    } else {
      entry.reject(this.bindRefreshErrorToRequest(logicalError, entry.response.config, entry.response));
    }
  }

  private dispose(error: Error): void {
    if (this.teardown.error) {
      return;
    }

    this.timerManager.destroy();
    this.isRefreshing = false;

    this.teardown.dispose(error, () => {
      this.refreshQueue.forEach((entry) => {
        this.rejectQueueEntryWithBoundError(error, entry);
      });
      this.refreshQueue = [];
    });
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
    let hasCustomAuthError: boolean;
    try {
      hasCustomAuthError = customErrorDetector(response.data);
    } catch (error) {
      this.logger?.warn(`[${this.name}] customErrorDetector threw; ignoring body-auth refresh signal`, {
        error: error instanceof Error ? error.message : error,
      });
      return response;
    }

    if (hasCustomAuthError) {
      this.logger?.debug(`[${this.name}] Custom auth error detected in response body`);
      this.context.releaseRequestTracking(response.config);

      if (this.isRefreshing) {
        if (this.isQueueOverflowing()) {
          throw this.bindRefreshErrorToRequest(this.buildQueueOverflowError(), response.config, response);
        }
        // Queue the request and wait for token refresh to complete
        return new Promise((resolve, reject) => {
          this.refreshQueue.push({
            kind: 'retry-after-body-auth-error',
            response,
            resolveResponse: resolve,
            reject,
          });
        });
      }

      try {
        // Start refresh flow
        this.isRefreshing = true;
        const token = await this.withTeardown(this.executeTokenRefresh());
        this.ensureActive();
        if (token === null) {
          this.flushQueuedAfterSkippedRefresh();
          return response;
        }
        this.updateAuthHeader(token);
        this.flushQueuedWithToken(token);

        // Retry the current request with new token
        return this.withTeardown(this.retryRequest(response.config, token));
      } catch (err) {
        const refreshError = this.handleRefreshFailure(err);
        throw this.bindRefreshErrorToRequest(refreshError, response.config, response);
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
    if (error.code === 'TOKEN_REFRESH_FAILED') {
      return Promise.reject(error);
    }
    this.ensureActive();
    if (getRequestMetadata(originalRequest)?.isRetryRefreshRequest) {
      return Promise.reject(error);
    }
    if (!this.isRefreshableError(error)) {
      return Promise.reject(error);
    }
    // If this request carries the same token that previously failed to refresh,
    // reject immediately — retrying the refresh endpoint would yield the same result.
    if (
      this.failedAuthHeaderValue !== null &&
      getHeader(originalRequest, this.options.authHeaderName) === this.failedAuthHeaderValue
    ) {
      this.context.releaseRequestTracking(originalRequest);
      return Promise.reject(
        this.bindRefreshErrorToRequest(new TokenRefreshFailedError(), originalRequest, error.response),
      );
    }
    // If this request used an older token than the current global auth header,
    // replay once with the current token instead of triggering a second refresh cycle.
    const latestAuthHeader = this.context.axiosInstance?.defaults?.headers?.common?.[this.options.authHeaderName];
    const requestAuthHeader = getHeader(originalRequest, this.options.authHeaderName);
    if (
      typeof latestAuthHeader === 'string' &&
      typeof requestAuthHeader === 'string' &&
      latestAuthHeader.length > 0 &&
      requestAuthHeader.length > 0 &&
      latestAuthHeader !== requestAuthHeader
    ) {
      const latestToken = extractTokenFromAuthHeader(latestAuthHeader, this.options.tokenPrefix);
      return this.withTeardown(this.retryRequest(originalRequest, latestToken));
    }
    this.context.releaseRequestTracking(originalRequest);
    if (this.isRefreshing) {
      return this.queueRefreshRequest(originalRequest, error);
    }
    return this.handleTokenRefresh(originalRequest, error);
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
  private async handleTokenRefresh(
    originalRequest: AxiosRequestConfig,
    originalError: AxiosError,
  ): Promise<AxiosResponse> {
    this.isRefreshing = true;
    if (!getRequestMetadata(originalRequest)?.isRetryRefreshRequest) {
      this.context.triggerAndEmit('onBeforeTokenRefresh');
    }
    try {
      const token = await this.executeTokenRefresh();
      this.ensureActive();
      if (token === null) {
        this.flushQueuedAfterSkippedRefresh();
        return Promise.reject(originalError);
      }
      this.updateAuthHeader(token);
      this.flushQueuedWithToken(token);
      return this.withTeardown(this.retryRequest(originalRequest, token));
    } catch (err) {
      const refreshError = this.handleRefreshFailure(err);
      return Promise.reject(this.bindRefreshErrorToRequest(refreshError, originalRequest, originalError.response));
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Attempts token refresh up to maxRefreshAttempts times if retryOnRefreshFail is true.
   * Each attempt is subject to a timeout defined in refreshTimeout. Throw a non-Axios
   * error from the refresh handler to stop remaining refresh retries immediately, for
   * example when no refresh token is available in storage.
   */
  private executeTokenRefresh(): Promise<string | null> {
    const executor = new RefreshExecutor({
      pluginName: this.name,
      refreshAxios: this.refreshAxios,
      refreshToken: this.refreshToken,
      timerManager: this.timerManager,
      teardown: this.teardown,
      maxRefreshAttempts: this.options.maxRefreshAttempts,
      refreshTimeout: this.options.refreshTimeout,
      retryOnRefreshFail: this.options.retryOnRefreshFail,
      maxRefreshBackoffMs: this.options.maxRefreshBackoffMs,
      getLogger: () => this.logger,
      onRefreshSuccess: (token) => {
        this.context.triggerAndEmit('onTokenRefreshed', token);
      },
    });
    return executor.run();
  }

  /**
   * Updates the manager's default auth header so subsequent requests automatically carry the new token.
   */
  private updateAuthHeader(token: string): void {
    const { authHeaderName, tokenPrefix } = this.options;
    this.context.axiosInstance.defaults.headers.common[authHeaderName] = `${tokenPrefix}${sanitizeHeaderValue(token)}`;
    this.failedAuthHeaderValue = null;
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
  private queueRefreshRequest(request: AxiosRequestConfig, sourceError: AxiosError): Promise<AxiosResponse> {
    if (this.isQueueOverflowing()) {
      return Promise.reject(
        this.bindRefreshErrorToRequest(this.buildQueueOverflowError(), request, sourceError.response),
      );
    }
    return new Promise((resolve, reject) => {
      this.refreshQueue.push({
        kind: 'retry-after-error',
        request,
        sourceError,
        resolveResponse: resolve,
        reject,
      });
    });
  }

  private flushQueuedWithToken(token: string): void {
    const { authHeaderName, tokenPrefix } = this.options;
    const pending = this.refreshQueue;
    this.refreshQueue = [];
    for (const entry of pending) {
      if (entry.kind === 'hold-request') {
        setHeader(entry.config, authHeaderName, `${tokenPrefix}${sanitizeHeaderValue(token)}`);
        entry.resolveConfig(entry.config);
      } else if (entry.kind === 'retry-after-error') {
        this.retryRequest(entry.request, token).then(entry.resolveResponse).catch(entry.reject);
      } else {
        this.retryRequest(entry.response.config, token).then(entry.resolveResponse).catch(entry.reject);
      }
    }
  }

  /**
   * When the refresh handler opts out (`token` null/undefined), release waiters without treating refresh as failed.
   */
  private flushQueuedAfterSkippedRefresh(): void {
    const pending = this.refreshQueue;
    this.refreshQueue = [];
    for (const entry of pending) {
      if (entry.kind === 'hold-request') {
        entry.resolveConfig(entry.config);
      } else if (entry.kind === 'retry-after-error') {
        entry.reject(entry.sourceError);
      } else {
        entry.resolveResponse(entry.response);
      }
    }
  }

  /**
   * If the token refresh fails completely, reject all queued requests and emit an event.
   * @returns The logical refresh failure error — callers must wrap with `bindRefreshErrorToRequest`
   *          for the initiating request so RetryManager receives `config`.
   */
  private handleRefreshFailure(error?: unknown): Error {
    if (this.teardown.error) {
      error = this.teardown.error;
    }

    let refreshError: Error;
    if (shouldStopRefreshRetries(error) || !shouldRetryRefreshError(error)) {
      refreshError = toTokenRefreshError(error);
    } else if (error instanceof AxiosError) {
      // Real transport failures from the refresh call — match queued waiters; details on `cause`.
      refreshError = new TokenRefreshFailedError();
      (refreshError as Error & { cause?: unknown }).cause = error;
    } else {
      // Exhausted retryable refresh failures (e.g. custom errors, timeout) — preserve message/type.
      refreshError = toTokenRefreshError(error);
    }

    this.refreshQueue.forEach((entry) => {
      this.rejectQueueEntryWithBoundError(refreshError, entry);
    });
    this.refreshQueue = [];
    // Record the token that failed so subsequent requests with the same token fail fast.
    const currentAuth = this.context.axiosInstance?.defaults?.headers?.common?.[this.options.authHeaderName];
    if (typeof currentAuth === 'string') {
      this.failedAuthHeaderValue = currentAuth;
    }
    this.context.triggerAndEmit('onTokenRefreshFailed');
    this.logger?.error(`${this.name} Token refresh failed - clearing queue`, {
      reason: refreshError.message,
      aborted: shouldStopRefreshRetries(error) || !shouldRetryRefreshError(error),
    });

    return refreshError;
  }
}
