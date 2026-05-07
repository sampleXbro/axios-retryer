import type { AxiosResponseHeaders, RawAxiosResponseHeaders } from 'axios';

/** Maximum delay enforced from a server-supplied Retry-After header (5 minutes). */
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Extracts the raw `Retry-After` header value from an Axios response headers object.
 * Handles both the AxiosHeaders class (with `.get()`) and plain header records.
 */
export function extractRetryAfterHeader(
  headers: AxiosResponseHeaders | Partial<RawAxiosResponseHeaders> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const axiosHeaders = headers as { get?: (name: string) => unknown };
  if (typeof axiosHeaders.get === 'function') {
    return normalizeRetryAfterValue(axiosHeaders.get('retry-after'));
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after') {
      return normalizeRetryAfterValue(value);
    }
  }

  return undefined;
}

export function normalizeRetryAfterValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 ? normalizeRetryAfterValue(value[0]) : undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

export function parseRetryAfterMs(headerValue: string | undefined | null): number {
  if (!headerValue) {
    return 0;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }

  return 0;
}
