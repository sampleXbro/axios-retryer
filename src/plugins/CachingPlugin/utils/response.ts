'use strict';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import { cloneValue } from '../../../utils/clone';

export function createCachedResponseSnapshot(
  response: AxiosResponse<unknown>,
  sensitiveHeaders: readonly string[],
): AxiosResponse<unknown> {
  const headers = cloneValue(response.headers) as Record<string, unknown>;

  if (sensitiveHeaders.length > 0) {
    const blockedHeaders = new Set(sensitiveHeaders.map((headerName) => headerName.toLowerCase()));

    for (const key of Object.keys(headers)) {
      if (blockedHeaders.has(key.toLowerCase())) {
        delete headers[key];
      }
    }
  }

  return {
    config: {} as AxiosRequestConfig,
    data: cloneValue(response.data),
    headers,
    status: response.status,
    statusText: response.statusText,
  } as AxiosResponse<unknown>;
}

export function cloneAxiosResponse(
  response: Pick<AxiosResponse<unknown>, 'data' | 'headers' | 'status' | 'statusText'>,
  config: AxiosRequestConfig,
): AxiosResponse<unknown> {
  return {
    config: config as AxiosRequestConfig,
    data: cloneValue(response.data),
    headers: cloneValue(response.headers),
    status: response.status,
    statusText: response.statusText,
  } as AxiosResponse<unknown>;
}
