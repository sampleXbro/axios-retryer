'use strict';

import type { AxiosError, AxiosRequestConfig } from 'axios';

import type { PluginContext, RetryPlugin } from '../../types';
import { getRequestMetadata } from '../../utils/requestMetadata';
import { resolveSanitizeOptions } from './configs';
import type { DebugSanitizationPluginOptions, SanitizeOptions } from './types';
import { sanitizeData, sanitizeHeaders, sanitizeUrl } from './utils';

export type { DebugSanitizationPluginOptions } from './types';

/**
 * Plugin that adds sanitized debug logging for requests and errors.
 *
 * Lazy-loads the sanitization module and logs sanitized request URLs, headers,
 * data, and error responses via the manager's logger.
 *
 * @example
 * ```typescript
 * import { DebugSanitizationPlugin } from 'axios-retryer/plugins/DebugSanitizationPlugin';
 *
 * const debugPlugin = new DebugSanitizationPlugin({
 *   sanitizeOptions: { sensitiveHeaders: ['x-custom-secret'] }
 * });
 * manager.use(debugPlugin);
 * ```
 */
export class DebugSanitizationPlugin implements RetryPlugin {
  public name = 'DebugSanitizationPlugin';
  public version = '1.0.0';

  private context!: PluginContext;
  private interceptorIdReq: number | null = null;
  private interceptorIdRes: number | null = null;
  private readonly sanitizeOptions: SanitizeOptions;

  constructor(options: DebugSanitizationPluginOptions = {}) {
    this.sanitizeOptions = resolveSanitizeOptions(options);
  }

  public initialize(context: PluginContext): void {
    this.context = context;

    this.interceptorIdReq = context.axiosInstance.interceptors.request.use((config) => {
      this.logSanitizedRequest(config);
      return config;
    });

    this.interceptorIdRes = context.axiosInstance.interceptors.response.use(undefined, (error: AxiosError) => {
      if (error.config) {
        this.logSanitizedError(error.config, error);
      }
      return Promise.reject(error);
    });
  }

  public onBeforeDestroyed(context: PluginContext): void {
    if (this.interceptorIdReq !== null) {
      context.axiosInstance.interceptors.request.eject(this.interceptorIdReq);
    }
    if (this.interceptorIdRes !== null) {
      context.axiosInstance.interceptors.response.eject(this.interceptorIdRes);
    }
  }

  private logSanitizedRequest(config: AxiosRequestConfig): void {
    const metadata = getRequestMetadata(config);
    this.context.getLogger()?.debug('[DebugSanitizationPlugin] Sanitized request', {
      requestId: metadata?.requestId,
      url: sanitizeUrl(config.url || '', this.sanitizeOptions),
      method: config.method?.toUpperCase(),
      headers: sanitizeHeaders(config.headers, this.sanitizeOptions),
      priority: metadata?.priority,
    });
  }

  private logSanitizedError(config: AxiosRequestConfig, error: AxiosError): void {
    const metadata = getRequestMetadata(config);
    this.context.getLogger()?.debug('[DebugSanitizationPlugin] Sanitized error', {
      requestId: metadata?.requestId,
      url: sanitizeUrl(config.url || '', this.sanitizeOptions),
      method: config.method?.toUpperCase(),
      status: error.response?.status,
      statusText: error.response?.statusText,
      code: error.code,
      message: error.message,
      headers: sanitizeHeaders(config.headers, this.sanitizeOptions),
      data:
        this.sanitizeOptions.sanitizeRequestData !== false
          ? sanitizeData(config.data, this.sanitizeOptions)
          : undefined,
      response: error.response
        ? {
            data:
              this.sanitizeOptions.sanitizeResponseData !== false
                ? sanitizeData(error.response.data as Record<string, unknown>, this.sanitizeOptions)
                : undefined,
            headers: sanitizeHeaders(error.response.headers, this.sanitizeOptions),
          }
        : undefined,
    });
  }
}
