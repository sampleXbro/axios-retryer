import type { AxiosRetryerDetailedMetrics } from '../../../types';

export interface MetricsPluginEvents {
  onMetricsUpdated?: (metrics: AxiosRetryerDetailedMetrics) => void;
}
