'use strict';

import type { SanitizeOptions } from '../types';

/**
 * Default sensitive headers that should be redacted in built-in logs and diagnostics
 */
export const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'password',
  'x-auth-token',
  'token',
  'refresh-token',
  'x-refresh-token',
  'secret',
  'x-api-secret',
  'client-secret',
  'x-client-secret',
  'access-token',
  'api-token',
];

/**
 * Default sensitive request/response body fields that should be redacted
 */
export const DEFAULT_SENSITIVE_FIELDS = [
  'password',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'clientSecret',
  'client_secret',
  'credentials',
  'credential',
  'private_key',
  'privateKey',
];

const DEFAULT_OPTIONS: Required<SanitizeOptions> = {
  sensitiveHeaders: [],
  sensitiveFields: [],
  redactionChar: '*',
  sanitizeRequestData: true,
  sanitizeResponseData: true,
  sanitizeUrlParams: true,
  allowedFields: [],
  allowlistOnly: true,
};

// Create a redaction value once
const getRedactionValue = (char: string): string => char.repeat(8);

type LookupCollections = {
  sensitiveFields: string[];
  sensitiveFieldsSet: Set<string>;
  sensitiveHeaders: string[];
  sensitiveHeadersSet: Set<string>;
  allowedFieldsSet: Set<string>;
};

const lookupCache = new Map<string, LookupCollections>();

function normalizeList(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))).sort();
}

/**
 * Creates sets of lowercase sensitive fields and headers for faster lookups.
 * Results are memoized by option shape to avoid rebuilding identical Sets.
 */
function createLookupCollections(options: Required<SanitizeOptions>): LookupCollections {
  const sensitiveFields = normalizeList([...DEFAULT_SENSITIVE_FIELDS, ...options.sensitiveFields]);
  const sensitiveHeaders = normalizeList([...DEFAULT_SENSITIVE_HEADERS, ...options.sensitiveHeaders]);
  const allowedFields = normalizeList(options.allowedFields);
  const cacheKey = [sensitiveFields.join('|'), sensitiveHeaders.join('|'), allowedFields.join('|')].join('::');
  const cached = lookupCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const collections: LookupCollections = {
    sensitiveFields,
    sensitiveFieldsSet: new Set(sensitiveFields),
    sensitiveHeaders,
    sensitiveHeadersSet: new Set(sensitiveHeaders),
    allowedFieldsSet: new Set(allowedFields),
  };

  lookupCache.set(cacheKey, collections);
  return collections;
}

function isAllowedKey(key: string, allowedFieldsSet: Set<string>): boolean {
  return allowedFieldsSet.has(key.toLowerCase());
}

/**
 * Checks if a key contains any sensitive field name
 */
function isSensitiveKey(key: string, sensitiveFieldsSet: Set<string>, sensitiveFields: string[]): boolean {
  const lowerKey = key.toLowerCase();

  // Direct match is fastest
  if (sensitiveFieldsSet.has(lowerKey)) {
    return true;
  }

  // Check if the key includes any sensitive field
  for (const field of sensitiveFields) {
    if (lowerKey.includes(field)) {
      return true;
    }
  }

  return false;
}

/**
 * Sanitizes sensitive information from request or response data
 * @param data - The data to sanitize
 * @param options - Sanitization options
 * @returns Sanitized data object
 */
export function sanitizeData(
  data: Record<string, unknown> | null | undefined,
  options: SanitizeOptions = {},
): Record<string, unknown> | null | undefined {
  if (!data) return data;

  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const lookups = createLookupCollections(mergedOptions);
  const redactionValue = getRedactionValue(mergedOptions.redactionChar);
  const seen = new WeakMap<object, unknown>();

  const sanitizeValue = (value: unknown, keyHint?: string): unknown => {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      if (!mergedOptions.allowlistOnly) {
        return value;
      }

      return keyHint && isAllowedKey(keyHint, lookups.allowedFieldsSet) ? value : redactionValue;
    }

    if (value instanceof Date) {
      if (mergedOptions.allowlistOnly && (!keyHint || !isAllowedKey(keyHint, lookups.allowedFieldsSet))) {
        return redactionValue;
      }
      return new Date(value.getTime());
    }

    const seenValue = seen.get(value);
    if (seenValue) {
      return seenValue;
    }

    if (Array.isArray(value)) {
      const sanitizedArray: unknown[] = [];
      seen.set(value, sanitizedArray);

      value.forEach((entry, index) => {
        sanitizedArray[index] = sanitizeValue(entry);
      });

      return sanitizedArray;
    }

    const sanitizedObject: Record<string, unknown> = {};
    seen.set(value, sanitizedObject);

    Object.keys(value as Record<string, unknown>).forEach((key) => {
      const currentValue = (value as Record<string, unknown>)[key];

      if (isSensitiveKey(key, lookups.sensitiveFieldsSet, lookups.sensitiveFields)) {
        sanitizedObject[key] = redactionValue;
        return;
      }

      if (currentValue && typeof currentValue === 'object') {
        sanitizedObject[key] = sanitizeValue(currentValue, key);
        return;
      }

      if (mergedOptions.allowlistOnly && !isAllowedKey(key, lookups.allowedFieldsSet)) {
        sanitizedObject[key] = redactionValue;
        return;
      }

      sanitizedObject[key] = currentValue;
    });

    return sanitizedObject;
  };

  return sanitizeValue(data) as Record<string, unknown>;
}

/**
 * Sanitizes sensitive headers
 * @param headers - The headers to sanitize
 * @param options - Sanitization options
 * @returns Sanitized headers object
 */
export function sanitizeHeaders(
  headers: Record<string, unknown> | null | undefined,
  options: SanitizeOptions = {},
): Record<string, unknown> | null | undefined {
  if (!headers) return headers;

  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const lookups = createLookupCollections(mergedOptions);

  const redactionValue = getRedactionValue(mergedOptions.redactionChar);
  const sanitized = { ...headers };

  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase();

    // Check if the header is sensitive
    if (
      lookups.sensitiveHeadersSet.has(lowerKey) ||
      lookups.sensitiveHeaders.some((header) => lowerKey.includes(header))
    ) {
      sanitized[key] = redactionValue;
    }
  }

  return sanitized;
}

/**
 * Sanitizes sensitive URL parameters
 * @param url - The URL to sanitize
 * @param options - Sanitization options
 * @returns Sanitized URL string
 */
export function sanitizeUrl(url: string | undefined, options: SanitizeOptions = {}): string | undefined {
  if (!url) return url;

  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  if (!mergedOptions.sanitizeUrlParams) return url;

  const lookups = createLookupCollections(mergedOptions);
  const redactionValue = getRedactionValue(mergedOptions.redactionChar);

  try {
    if (!url.includes('?')) return url;

    const hashIndex = url.indexOf('#');
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
    const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf('?');

    if (queryIndex === -1) {
      return url;
    }

    const base = withoutHash.slice(0, queryIndex);
    const query = withoutHash.slice(queryIndex + 1);

    if (!query) {
      return url;
    }

    const params = new URLSearchParams(query);
    let sanitized = false;

    const paramKeys = new Set<string>();
    params.forEach((_, key) => {
      paramKeys.add(key);
    });

    paramKeys.forEach((key) => {
      if (isSensitiveKey(key, lookups.sensitiveFieldsSet, lookups.sensitiveFields)) {
        params.set(key, redactionValue);
        sanitized = true;
      }
    });

    return sanitized ? `${base}?${params.toString()}${hash}` : url;
  } catch {
    return url;
  }
}
