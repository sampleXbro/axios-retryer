import type { AxiosRequestConfig } from 'axios';

import type { RequestStore } from '../../../types';

export interface ManualRetryPluginEvents {
  onManualRetryProcessStarted?: () => void;
  onRequestRemovedFromStore?: (request: AxiosRequestConfig) => void;
}

export interface ManualRetryPluginOptions {
  maxRequestsToStore?: number;
  manualRetryMaxAge?: number;
  storeNonIdempotent?: boolean;
  storeAuthRequests?: boolean;
  beforeRetry?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  prepareRequestForStore?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  rehydrateAuth?: (config: AxiosRequestConfig) => AxiosRequestConfig | null;
  requestStore?: RequestStore;
}
