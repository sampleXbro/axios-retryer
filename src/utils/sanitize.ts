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
  const allSensitiveFields = [
    ...DEFAULT_SENSITIVE_FIELDS,
    ...mergedOptions.sensitiveFields,
  ];
  
  const redactionValue = mergedOptions.redactionChar.repeat(8);
  
  // Create a deep copy to avoid modifying the original
  const sanitized = JSON.parse(JSON.stringify(data));
  
  // Recursively sanitize the object
  function recursiveSanitize(obj: Record<string, any>) {
    if (!obj || typeof obj !== 'object') return;
    
    Object.keys(obj).forEach(key => {
      const lowerKey = typeof key === 'string' ? key.toLowerCase() : key;
      
      // Check if current key is sensitive
      if (allSensitiveFields.some(field => 
        typeof lowerKey === 'string' && 
        lowerKey === field.toLowerCase() || 
        lowerKey.includes(field.toLowerCase())
      )) {
        obj[key] = redactionValue;
      } 
      // If it's an object or array, recursively check it
      else if (obj[key] && typeof obj[key] === 'object') {
        recursiveSanitize(obj[key]);
      }
    });
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
  const allSensitiveHeaders = [
    ...DEFAULT_SENSITIVE_HEADERS,
    ...mergedOptions.sensitiveHeaders,
  ];
  
  const redactionValue = mergedOptions.redactionChar.repeat(8);
  const sanitized = { ...headers };
  
  Object.keys(sanitized).forEach(key => {
    const lowerKey = key.toLowerCase();
    if (allSensitiveHeaders.some(header => lowerKey === header.toLowerCase() || lowerKey.includes(header.toLowerCase()))) {
      sanitized[key] = redactionValue;
    }
  });
  
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
  if (!options.sanitizeUrlParams) return url;
  
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const allSensitiveFields = [
    ...DEFAULT_SENSITIVE_FIELDS,
    ...mergedOptions.sensitiveFields,
  ];
  
  const redactionValue = mergedOptions.redactionChar.repeat(8);
  
  try {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    let sanitized = false;
    
    allSensitiveFields.forEach(field => {
      if (params.has(field)) {
        params.set(field, redactionValue);
        sanitized = true;
      }
    });
    
    return sanitized ? urlObj.toString() : url;
  } catch (e) {
    // If URL parsing fails, fallback to simple string replacement
    return url;
  }
} 