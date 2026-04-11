import type { DebugSanitizationPluginOptions, SanitizeOptions } from '../types';

export function resolveSanitizeOptions(options: DebugSanitizationPluginOptions = {}): SanitizeOptions {
  return options.sanitizeOptions ?? {};
}
