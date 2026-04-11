export interface SanitizeOptions {
  sensitiveHeaders?: readonly string[];
  sensitiveFields?: readonly string[];
  redactionChar?: string;
  sanitizeRequestData?: boolean;
  sanitizeResponseData?: boolean;
  sanitizeUrlParams?: boolean;
  allowedFields?: readonly string[];
  allowlistOnly?: boolean;
}

export interface DebugSanitizationPluginOptions {
  sanitizeOptions?: SanitizeOptions;
}
