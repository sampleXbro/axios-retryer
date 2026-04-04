export { DebugSanitizationPlugin, type DebugSanitizationPluginOptions } from './DebugSanitizationPlugin';

import { DebugSanitizationPlugin, type DebugSanitizationPluginOptions } from './DebugSanitizationPlugin';

/**
 * Creates a DebugSanitizationPlugin instance.
 * Functional alternative to using the `new DebugSanitizationPlugin()` constructor.
 *
 * The debug sanitization plugin adds sanitized debug logging for requests and errors,
 * redacting sensitive information like tokens, passwords, and API keys.
 *
 * @param options Configuration options for the DebugSanitizationPlugin
 * @returns A configured DebugSanitizationPlugin instance
 *
 * @example
 * ```typescript
 * const debugPlugin = createDebugSanitizationPlugin({
 *   sanitizeOptions: {
 *     sensitiveHeaders: ['x-custom-secret'],
 *     redactionChar: '#'
 *   }
 * });
 *
 * manager.use(debugPlugin);
 * ```
 */
export function createDebugSanitizationPlugin(options?: DebugSanitizationPluginOptions): DebugSanitizationPlugin {
  return new DebugSanitizationPlugin(options);
}
