import type { AxiosRequestConfig } from 'axios';

import type { AxiosRetryerRequestMetadata } from '../types';

export type InternalAxiosRetryerRequestMetadata = AxiosRetryerRequestMetadata & {
  isRetryRefreshRequest?: boolean;
  /** Set by ManualRetryPlugin so TokenRefreshPlugin clears refresh-failure fast-fail for this attempt. */
  manualReplayAttempt?: boolean;
  retryAfterMs?: number;
  silentlyCancelled?: boolean;
  cachingOptions?: {
    cache?: boolean;
    ttr?: number;
  };
};

// Allowlist of valid metadata keys — prevents prototype-pollution via key injection.
const ALLOWED_METADATA_KEYS = new Set<string>([
  'retryAttempt',
  'requestRetries',
  'requestMode',
  'requestId',
  'correlationId',
  'isRetrying',
  'priority',
  'timestamp',
  'backoffType',
  'retryableStatuses',
  'isRetryRefreshRequest',
  'manualReplayAttempt',
  'retryAfterMs',
  'silentlyCancelled',
  'cachingOptions',
]);

function isSafeMetadataKey(key: string): boolean {
  return ALLOWED_METADATA_KEYS.has(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

function createMetadataObject(
  initial?: Partial<InternalAxiosRetryerRequestMetadata>,
): InternalAxiosRetryerRequestMetadata {
  const meta: InternalAxiosRetryerRequestMetadata = {};
  // Prevent JSON.stringify from leaking internal retry state into logs or serialized configs.
  Object.defineProperty(meta, 'toJSON', {
    value: () => undefined,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  if (initial) {
    for (const key of Object.keys(initial)) {
      if (isSafeMetadataKey(key)) {
        (meta as Record<string, unknown>)[key] = (initial as Record<string, unknown>)[key];
      }
    }
  }
  return meta;
}

type ConfigWithMetadata = AxiosRequestConfig & { __axiosRetryer?: InternalAxiosRetryerRequestMetadata };

export function ensureRequestMetadata(config: AxiosRequestConfig): InternalAxiosRetryerRequestMetadata {
  const c = config as ConfigWithMetadata;
  if (!c.__axiosRetryer) {
    c.__axiosRetryer = createMetadataObject();
  } else if (typeof (c.__axiosRetryer as { toJSON?: unknown }).toJSON !== 'function') {
    // User-provided plain object from per-request config: re-wrap with security guarantees.
    c.__axiosRetryer = createMetadataObject(c.__axiosRetryer);
  }
  return c.__axiosRetryer;
}

export function getRequestMetadata(
  config: AxiosRequestConfig | null | undefined,
): InternalAxiosRetryerRequestMetadata | undefined {
  if (!config) {
    return undefined;
  }

  return (config as ConfigWithMetadata).__axiosRetryer;
}

export function setRequestMetadataValue<K extends keyof InternalAxiosRetryerRequestMetadata>(
  config: AxiosRequestConfig,
  key: K,
  value: InternalAxiosRetryerRequestMetadata[K],
): InternalAxiosRetryerRequestMetadata {
  const metadata = ensureRequestMetadata(config);

  if (value === undefined) {
    delete metadata[key];
  } else {
    (metadata as Record<string, unknown>)[key as string] = value;
  }

  return metadata;
}

export function assignRequestMetadata(
  config: AxiosRequestConfig,
  values: Partial<InternalAxiosRetryerRequestMetadata>,
): InternalAxiosRetryerRequestMetadata {
  const metadata = ensureRequestMetadata(config);

  for (const key of Object.keys(values) as Array<keyof InternalAxiosRetryerRequestMetadata>) {
    if (!isSafeMetadataKey(key as string)) {
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      delete metadata[key];
    } else {
      (metadata as Record<string, unknown>)[key as string] = value;
    }
  }

  return metadata;
}
