import type { ManualRetryPluginOptions } from '../types';

export type ResolvedManualRetryPluginOptions = Required<
  Pick<
    ManualRetryPluginOptions,
    'maxRequestsToStore' | 'manualRetryMaxAge' | 'storeNonIdempotent' | 'storeAuthRequests'
  >
> &
  Pick<ManualRetryPluginOptions, 'beforeRetry' | 'prepareRequestForStore' | 'rehydrateAuth' | 'requestStore'>;

export const DEFAULT_MANUAL_RETRY_PLUGIN_OPTIONS: Required<
  Pick<
    ManualRetryPluginOptions,
    'maxRequestsToStore' | 'manualRetryMaxAge' | 'storeNonIdempotent' | 'storeAuthRequests'
  >
> = {
  maxRequestsToStore: 200,
  manualRetryMaxAge: 5 * 60 * 1000,
  storeNonIdempotent: false,
  storeAuthRequests: false,
};

export function resolveManualRetryPluginOptions(
  options: ManualRetryPluginOptions = {},
): ResolvedManualRetryPluginOptions {
  return {
    ...DEFAULT_MANUAL_RETRY_PLUGIN_OPTIONS,
    ...options,
  };
}
