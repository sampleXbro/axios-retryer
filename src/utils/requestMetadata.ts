import type { AxiosRequestConfig } from 'axios';

import type { AxiosRetryerRequestMetadata } from '../types';

export function ensureRequestMetadata(config: AxiosRequestConfig): AxiosRetryerRequestMetadata {
  if (!config.__axiosRetryer) {
    config.__axiosRetryer = {};
  }

  return config.__axiosRetryer;
}

export function getRequestMetadata(config: AxiosRequestConfig | null | undefined): AxiosRetryerRequestMetadata | undefined {
  if (!config) {
    return undefined;
  }

  return config.__axiosRetryer;
}

export function setRequestMetadataValue<K extends keyof AxiosRetryerRequestMetadata>(
  config: AxiosRequestConfig,
  key: K,
  value: AxiosRetryerRequestMetadata[K],
): AxiosRetryerRequestMetadata {
  const metadata = ensureRequestMetadata(config);

  if (value === undefined) {
    delete metadata[key];
  } else {
    (metadata as AxiosRetryerRequestMetadata & Record<string, unknown>)[key as string] = value;
  }

  return metadata;
}

export function assignRequestMetadata(
  config: AxiosRequestConfig,
  values: Partial<AxiosRetryerRequestMetadata>,
): AxiosRetryerRequestMetadata {
  const metadata = ensureRequestMetadata(config);

  (Object.keys(values) as Array<keyof AxiosRetryerRequestMetadata>).forEach((key) => {
    const value = values[key];
    if (value === undefined) {
      delete metadata[key];
    } else {
      (metadata as AxiosRetryerRequestMetadata & Record<string, unknown>)[key as string] = value;
    }
  });

  return metadata;
}
