import type { AxiosRequestConfig } from 'axios';

import { cloneValue } from '../../../utils/clone';

const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options']);

export const SENSITIVE_REPLAY_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-api-key',
  'api-key',
  'apikey',
  'token',
  'refresh-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
] as const;

const SENSITIVE_REPLAY_HEADER_SET = new Set<string>(SENSITIVE_REPLAY_HEADERS);

export function isEligibleForManualRetry(config: AxiosRequestConfig, storeNonIdempotent: boolean): boolean {
  if (storeNonIdempotent) {
    return true;
  }

  const method = (config.method || 'get').toLowerCase();
  if (IDEMPOTENT_METHODS.has(method)) {
    return true;
  }

  return hasHeader(config, 'Idempotency-Key');
}

export function hasSensitiveAuthMaterial(config: AxiosRequestConfig): boolean {
  if (config.auth) {
    return true;
  }

  return Object.keys(config.headers ?? {}).some((headerName) =>
    SENSITIVE_REPLAY_HEADER_SET.has(headerName.toLowerCase()),
  );
}

export function hasHeader(config: AxiosRequestConfig, headerName: string): boolean {
  const target = headerName.toLowerCase();
  return Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === target);
}

export function cloneStoredRequest(config: AxiosRequestConfig): AxiosRequestConfig {
  const storedConfig: AxiosRequestConfig = {
    ...config,
    data: cloneValue(config.data),
    headers: config.headers ? { ...config.headers } : {},
    params: cloneValue(config.params),
  };

  stripAuthHeaders(storedConfig);

  return storedConfig;
}

export function stripAuthHeaders(config: AxiosRequestConfig): void {
  if (!config.headers) {
    return;
  }

  for (const key of Object.keys(config.headers)) {
    if (SENSITIVE_REPLAY_HEADER_SET.has(key.toLowerCase())) {
      delete config.headers[key];
    }
  }

  delete config.auth;
}

export function neutralizeDefaultAuthHeaders(
  config: AxiosRequestConfig,
  defaultHeaders: Record<string, unknown> | undefined,
  hasDefaultAuth: boolean,
): void {
  const commonHeaders = (defaultHeaders?.common as Record<string, unknown> | undefined) ?? {};

  config.headers = config.headers || {};

  for (const headerName of SENSITIVE_REPLAY_HEADERS) {
    const target = headerName.toLowerCase();
    const hasInCommon = Object.keys(commonHeaders).some((key) => key.toLowerCase() === target);
    const hasInDefaults = defaultHeaders
      ? Object.keys(defaultHeaders).some((key) => key.toLowerCase() === target)
      : false;

    if (hasInCommon || hasInDefaults) {
      // Setting the value to `undefined` tells axios to OMIT the header, which is exactly
      // what we want when a default header would otherwise leak into a manually-replayed
      // request. `delete` would not work — axios re-applies defaults at send time.
      (config.headers as Record<string, string | undefined>)[headerName] = undefined;
    }
  }

  if (hasDefaultAuth) {
    config.auth = undefined;
  }
}
