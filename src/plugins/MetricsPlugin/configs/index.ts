import type { AxiosRetryerMetrics } from '../../../types';

export const EMPTY_TIMER_STATS = {
  activeTimers: 0,
  activeRetryTimers: 0,
};

export function createInitialMetrics(): AxiosRetryerMetrics {
  return {
    totalRequests: 0,
    successfulRetries: 0,
    failedRetries: 0,
    completelyFailedRequests: 0,
    canceledRequests: 0,
    completelyFailedCriticalRequests: 0,
    errorTypes: {
      network: 0,
      server5xx: 0,
      client4xx: 0,
      cancelled: 0,
    },
    retryAttemptsDistribution: {},
    retryPrioritiesDistribution: {},
    requestCountsByPriority: {},
    queueWaitDuration: 0,
    retryDelayDuration: 0,
  };
}
