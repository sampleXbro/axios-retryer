'use strict';

/**
 * Default sensitive headers that should be redacted in logs and storage
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

/**
 * Options for sanitizing data
 */
export interface SanitizeOptions {
  /**
   * Custom list of sensitive headers to redact (case-insensitive)
   * Will be merged with DEFAULT_SENSITIVE_HEADERS
   */
  sensitiveHeaders?: string[];
  
  /**
   * Custom list of sensitive fields to redact in request/response data
   * Will be merged with DEFAULT_SENSITIVE_FIELDS
   */
  sensitiveFields?: string[];
  
  /**
   * Character to use for redaction
   * @default '*'
   */
  redactionChar?: string;
  
  /**
   * Whether to sanitize request bodies
   * @default true
   */
  sanitizeRequestData?: boolean;
  
  /**
   * Whether to sanitize response bodies
   * @default true
   */
  sanitizeResponseData?: boolean;
  
  /**
   * Whether to sanitize URL parameters
   * @default true
   */
  sanitizeUrlParams?: boolean;
}

const DEFAULT_OPTIONS: Required<SanitizeOptions> = {
  sensitiveHeaders: [],
  sensitiveFields: [],
  redactionChar: '*',
  sanitizeRequestData: true,
  sanitizeResponseData: true,
  sanitizeUrlParams: true,
};

// Create a redaction value once
const getRedactionValue = (char: string) => char.repeat(8);

/**
 * Creates sets of lowercase sensitive fields and headers for faster lookups
 */
function createSensitiveSets(options: Required<SanitizeOptions>) {
  // Create lowercase sets for O(1) lookups
  const sensitiveFieldsSet = new Set([
    ...DEFAULT_SENSITIVE_FIELDS,
    ...options.sensitiveFields
  ].map(field => field.toLowerCase()));
  
  const sensitiveHeadersSet = new Set([
    ...DEFAULT_SENSITIVE_HEADERS,
    ...options.sensitiveHeaders
  ].map(header => header.toLowerCase()));
  
  return { sensitiveFieldsSet, sensitiveHeadersSet };
}

/**
 * Checks if a key contains any sensitive field name
 */
function isSensitiveKey(key: string, sensitiveFieldsSet: Set<string>): boolean {
  const lowerKey = key.toLowerCase();
  
  // Direct match is fastest
  if (sensitiveFieldsSet.has(lowerKey)) {
    return true;
  }
  
  // Check if the key includes any sensitive field - use Array.from for compatibility
  for (const field of Array.from(sensitiveFieldsSet)) {
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
  data: Record<string, any> | null | undefined,
  options: SanitizeOptions = {},
): Record<string, any> | null | undefined {
  if (!data) return data;
  
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const { sensitiveFieldsSet } = createSensitiveSets(mergedOptions);
  const redactionValue = getRedactionValue(mergedOptions.redactionChar);
  
  // Use structuredClone for better performance if available
  const sanitized = typeof structuredClone === 'function' 
    ? structuredClone(data) 
    : JSON.parse(JSON.stringify(data));
  
  // Recursively sanitize the object
  function recursiveSanitize(obj: Record<string, any>) {
    if (!obj || typeof obj !== 'object') return;
    
    // Handle arrays
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (obj[i] && typeof obj[i] === 'object') {
          recursiveSanitize(obj[i]);
        }
      }
      return;
    }
    
    // Handle objects
    for (const key of Object.keys(obj)) {
      // Check if current key is sensitive
      if (isSensitiveKey(key, sensitiveFieldsSet)) {
        obj[key] = redactionValue;
      } 
      // If it's an object, recursively check it
      else if (obj[key] && typeof obj[key] === 'object') {
        recursiveSanitize(obj[key]);
      }
    }
  }
  
  recursiveSanitize(sanitized);
  return sanitized;
}

/**
 * Sanitizes sensitive headers
 * @param headers - The headers to sanitize
 * @param options - Sanitization options
 * @returns Sanitized headers object
 */
export function sanitizeHeaders(
  headers: Record<string, any> | null | undefined,
  options: SanitizeOptions = {},
): Record<string, any> | null | undefined {
  if (!headers) return headers;
  
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const { sensitiveHeadersSet } = createSensitiveSets(mergedOptions);
  
  const redactionValue = getRedactionValue(mergedOptions.redactionChar);
  const sanitized = { ...headers };
  
  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase();
    
    // Check if the header is sensitive
    if (sensitiveHeadersSet.has(lowerKey) || 
        Array.from(sensitiveHeadersSet).some(h => lowerKey.includes(h))) {
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
export function sanitizeUrl(
  url: string | undefined,
  options: SanitizeOptions = {},
): string | undefined {
  if (!url) return url;
  
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  if (!mergedOptions.sanitizeUrlParams) return url;
  
  const { sensitiveFieldsSet } = createSensitiveSets(mergedOptions);
  const redactionValue = getRedactionValue(mergedOptions.redactionChar);
  
  try {
    // Fast path - if URL has no query params, return as is
    if (!url.includes('?')) return url;
    
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    let sanitized = false;
    
    // Manual iteration of query parameters for compatibility
    const paramKeys = new Set<string>();
    // Add all keys to set
    params.forEach((_, key) => {
      paramKeys.add(key);
    });
    
    // Check each key
    paramKeys.forEach(key => {
      if (isSensitiveKey(key, sensitiveFieldsSet)) {
        params.set(key, redactionValue);
        sanitized = true;
      }
    });
    
    return sanitized ? urlObj.toString() : url;
  } catch (e) {
    // If URL parsing fails, fallback to string
    return url;
  }
} 