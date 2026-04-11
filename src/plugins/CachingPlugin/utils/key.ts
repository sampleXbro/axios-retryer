import type { AxiosRequestConfig } from 'axios';

import { AXIOS_RETRYER_HTTP_METHODS } from '../../../types';
import type { CacheInvalidationMatcher, CacheKeyBuilderContext, CachingPluginOptions } from '../types';

export function fingerprintValue(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `fp_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function compareStringTuples(
  [leftKey, leftValue]: readonly [string, string],
  [rightKey, rightValue]: readonly [string, string],
): number {
  return leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue);
}

export function normalizeUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');

  if (queryIndex === -1) {
    return withoutHash;
  }

  const pathname = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);

  if (!query) {
    return pathname;
  }

  const entries = Array.from(new URLSearchParams(query).entries()).sort(compareStringTuples);

  if (entries.length === 0) {
    return pathname;
  }

  const normalizedQuery = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `${pathname}?${normalizedQuery}`;
}

function normalizeValue(value: unknown, lowercaseKeys = false): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return Array.from(value.entries()).sort(compareStringTuples);
  }

  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([key, entryValue]) => [String(key), normalizeValue(entryValue, lowercaseKeys)] as const)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  }

  if (value instanceof Set) {
    return Array.from(value.values()).map((entryValue) => normalizeValue(entryValue, lowercaseKeys));
  }

  if (Array.isArray(value)) {
    return value.map((entryValue) => normalizeValue(entryValue, lowercaseKeys));
  }

  if (typeof value === 'object') {
    const objectValue =
      typeof (value as { toJSON?: () => unknown }).toJSON === 'function'
        ? (value as { toJSON: () => unknown }).toJSON()
        : value;

    if (objectValue !== value) {
      return normalizeValue(objectValue, lowercaseKeys);
    }

    const normalizedObject: Record<string, unknown> = {};
    Object.entries(objectValue as Record<string, unknown>)
      .map(
        ([key, entryValue]) =>
          [lowercaseKeys ? key.toLowerCase() : key, normalizeValue(entryValue, lowercaseKeys)] as const,
      )
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .forEach(([key, entryValue]) => {
        normalizedObject[key] = entryValue;
      });

    return normalizedObject;
  }

  return String(value);
}

export function stableStringify(value: unknown, lowercaseKeys = false): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(normalizeValue(JSON.parse(trimmed), lowercaseKeys));
      } catch (_error) {
        // Fall through and treat invalid JSON-like strings as plain strings.
      }
    }

    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(normalizeValue(value, lowercaseKeys));
}

export function buildDefaultCacheKey(context: CacheKeyBuilderContext): string {
  return [
    context.method,
    context.normalizedUrl,
    context.normalizedParams,
    context.normalizedData,
    context.normalizedHeaders,
  ].join('|');
}

export function buildCacheKeyContext(
  config: AxiosRequestConfig,
  options: Pick<Required<CachingPluginOptions>, 'compareHeaders' | 'varyHeaders'>,
): CacheKeyBuilderContext {
  let normalizedHeaders: string;

  if (options.compareHeaders && config.headers) {
    normalizedHeaders = stableStringify(config.headers, true);
  } else if (options.varyHeaders.length > 0 && config.headers) {
    const headers = config.headers as Record<string, unknown>;
    const varySet = new Set(options.varyHeaders.map((headerName) => headerName.toLowerCase()));
    const varyEntries: [string, string][] = [];

    for (const key of Object.keys(headers)) {
      if (varySet.has(key.toLowerCase())) {
        varyEntries.push([key.toLowerCase(), String(headers[key])]);
      }
    }

    varyEntries.sort(compareStringTuples);
    normalizedHeaders = varyEntries.length > 0 ? JSON.stringify(varyEntries) : '';
  } else {
    normalizedHeaders = '';
  }

  return {
    config,
    method: (config.method || AXIOS_RETRYER_HTTP_METHODS.GET).toUpperCase(),
    normalizedUrl: normalizeUrl(config.url ?? ''),
    normalizedParams: stableStringify(config.params),
    normalizedData: stableStringify(config.data),
    normalizedHeaders,
  };
}

export function describeInvalidationMatcher(matcher: CacheInvalidationMatcher): {
  type: 'exact' | 'prefix' | 'regexp';
  fingerprint: string;
} {
  if (matcher instanceof RegExp) {
    return {
      type: 'regexp',
      fingerprint: fingerprintValue(String(matcher)),
    };
  }

  if (typeof matcher === 'string') {
    return {
      type: 'exact',
      fingerprint: fingerprintValue(matcher),
    };
  }

  return {
    type: 'exact' in matcher ? 'exact' : 'prefix',
    fingerprint: fingerprintValue('exact' in matcher ? matcher.exact : matcher.prefix),
  };
}

export function matchesInvalidationMatcher(key: string, matcher: CacheInvalidationMatcher): boolean {
  if (matcher instanceof RegExp) {
    return matcher.test(key);
  }

  if (typeof matcher === 'string') {
    return key === matcher;
  }

  if ('exact' in matcher) {
    return key === matcher.exact;
  }

  return key.startsWith(matcher.prefix);
}
