import type { AxiosRequestConfig } from 'axios';

export function hasHeader(config: AxiosRequestConfig, headerName: string): boolean {
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
  const direct = (headers as Record<string, unknown>)[headerName];
  if (direct !== undefined && direct !== null && direct !== false) {
    return true;
  }

  const directLower = (headers as Record<string, unknown>)[target];
  if (directLower !== undefined && directLower !== null && directLower !== false) {
    return true;
  }

  return Object.entries(headers as Record<string, unknown>).some(
    ([key, value]) => key.toLowerCase() === target && value !== undefined && value !== null && value !== false,
  );
}

export function getHeader(config: AxiosRequestConfig, headerName: string): string | null {
  const headers = config.headers;
  if (!headers) {
    return null;
  }

  if (typeof (headers as { get?: (name: string) => unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => unknown }).get(headerName);
    if (typeof value === 'string') {
      return value;
    }
  }

  const target = headerName.toLowerCase();
  const direct = (headers as Record<string, unknown>)[headerName] ?? (headers as Record<string, unknown>)[target];
  if (typeof direct === 'string') {
    return direct;
  }

  const entry = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === target);
  return typeof entry?.[1] === 'string' ? entry[1] : null;
}

export function setHeader(config: AxiosRequestConfig, headerName: string, value: string): void {
  if (!config.headers) {
    config.headers = {};
  }

  if (typeof (config.headers as { set?: (name: string, value: string) => void }).set === 'function') {
    (config.headers as { set: (name: string, value: string) => void }).set(headerName, value);
    return;
  }

  config.headers[headerName] = value;
}

export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0\u2028\u2029]/g, '');
}

export function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return diff === 0;
}

export function extractTokenFromAuthHeader(authHeaderValue: string, tokenPrefix: string): string {
  if (authHeaderValue.startsWith(tokenPrefix)) {
    return authHeaderValue.slice(tokenPrefix.length);
  }

  return authHeaderValue;
}
