import { AxiosError } from 'axios';

import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../src';
import { MetricsCollector } from '../src/plugins/MetricsPlugin/MetricsCollector';

function createMetricsState() {
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
    requestCountsByPriority: {},
    retryPrioritiesDistribution: {},
    queueWaitDuration: 0,
    retryDelayDuration: 0,
  };
}

describe('MetricsCollector', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('records retry metrics, prunes stale samples, and resets state', () => {
    const state = createMetricsState();
    const collector = new MetricsCollector(() => state);

    collector.recordRequestStart(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
    collector.recordRetryAttempt(1, AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
    collector.recordRetrySuccess(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
    collector.recordRetryFailure(
      AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
      new AxiosError('server', 'ERR_BAD_RESPONSE', { headers: {} } as never, null, {
        config: {},
        data: {},
        headers: {},
        status: 503,
        statusText: 'Server Error',
      } as never),
    );
    collector.recordRetryFailure(
      AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
      new AxiosError('client', 'ERR_BAD_RESPONSE', { headers: {} } as never, null, {
        config: {},
        data: {},
        headers: {},
        status: 404,
        statusText: 'Bad Request',
      } as never),
    );
    collector.recordRetryFailure(
      AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
      new AxiosError('network', 'ERR_NETWORK'),
    );
    collector.recordQueueWait(400);
    collector.recordRetryDelay(250);
    collector.recordCancellation(true);
    collector.recordTerminalFailure(true);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    collector['queueWaitHistory'] = [
      { timestamp: 1_000_000 - (5 * 60 * 1000) - 1, durationMs: 100 },
      { timestamp: 1_000_000, durationMs: 400 },
    ];
    collector['retryDelayHistory'] = [
      { timestamp: 1_000_000 - (5 * 60 * 1000) - 1, durationMs: 50 },
      { timestamp: 1_000_000, durationMs: 250 },
    ];

    const detailed = collector.buildDetailedMetrics({
      activeTimers: 2,
      activeRetryTimers: 1,
    });

    expect(detailed.totalRequests).toBe(1);
    expect(detailed.successfulRetries).toBe(1);
    expect(detailed.failedRetries).toBe(3);
    expect(detailed.completelyFailedRequests).toBe(1);
    expect(detailed.completelyFailedCriticalRequests).toBe(1);
    expect(detailed.canceledRequests).toBe(1);
    expect(detailed.errorTypesDistribution).toEqual({
      cancelled: 1,
      client4xx: 1,
      network: 1,
      server5xx: 1,
    });
    expect(detailed.retryAttemptsDistribution).toEqual({ 1: 1 });
    expect(detailed.requestCountsByPriority).toEqual({
      [AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH]: 1,
    });
    expect(detailed.avgQueueWait).toBe(0.4);
    expect(detailed.avgRetryDelay).toBe(0.25);
    expect(detailed.priorityMetrics).toEqual(
      expect.arrayContaining([
        {
          priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
          total: 1,
          successes: 1,
          failures: 1,
          successRate: 100,
          failureRate: 100,
        },
        {
          priority: AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
          total: 0,
          successes: 0,
          failures: 1,
          successRate: 0,
          failureRate: 0,
        },
        {
          priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW,
          total: 0,
          successes: 0,
          failures: 1,
          successRate: 0,
          failureRate: 0,
        },
      ]),
    );
    expect(detailed.timerHealth).toEqual({
      activeTimers: 2,
      activeRetryTimers: 1,
      healthScore: 4,
    });

    nowSpy.mockRestore();

    collector.reset();
    expect(state).toEqual(createMetricsState());
  });
});
