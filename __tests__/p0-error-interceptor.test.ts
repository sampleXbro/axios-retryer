/**
 * P0 Error Interceptor Tests from TEST_GAP_ANALYSIS.md
 *
 * Tests for contract guarantees, security boundaries, and behaviors users depend on in production.
 * Missing these tests means users could hit bugs that violate documented promises.
 */

import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RequestAbortedError, RetryManager } from '../src';
import { AxiosError } from 'axios';

// ────────────────────────────────────────────────────────────────────────────
// 4. Error Interceptor
// ────────────────────────────────────────────────────────────────────────────

describe('P0 Error Interceptor (4.x)', () => {
  let axiosInstance: AxiosInstance;
  let mock: MockAdapter;

  beforeEach(() => {
    axiosInstance = axios.create();
    mock = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
  });

  // 4.1 Retry Decision Logic
  describe('4.1 Retry Decision Logic', () => {
    it('4.1.1: Error without config property rejects immediately without retry', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      // Simulate error without config property
      const error = new Error('Test error') as any;
      delete error.config;

      mock.onGet('/api/data').reply(() => {
        throw error;
      });

      await axiosInstance.get('/api/data').catch(() => {});

      // Should not retry (error without config)
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });

    it('4.1.2: Error with code: REQUEST_CANCELED does not retry', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      mock.onGet('/api/data').reply(() => {
        const error = new AxiosError('Request canceled');
        error.code = 'REQUEST_CANCELED';
        throw error;
      });

      await axiosInstance.get('/api/data').catch(() => {});

      // Should not retry (cancelled request)
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });

    it('4.1.3: Non-retryable status (404) in AUTOMATIC mode is never retried', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        mode: 'automatic',
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      mock.onGet('/api/data').reply(404, { error: 'not found' });

      await axiosInstance.get('/api/data').catch(() => {});

      // Should not retry (404 is not retryable by default)
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });

    it('4.1.4: Retryable status (503) in MANUAL mode is never retried (stored instead)', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        mode: 'manual',
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      mock.onGet('/api/data').reply(503, { error: 'service unavailable' });

      await axiosInstance.get('/api/data').catch(() => {});

      // In manual mode, should not retry (stored for later)
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });

    it('4.1.5: Per-request requestRetries overrides global retries', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      mock.onGet('/api/data').reply(500, { error: 'server error' });

      await axiosInstance
        .get('/api/data', {
          __axiosRetryer: { requestRetries: 2 } as any,
        })
        .catch(() => {});

      // Should retry 2 times despite global retries: 0
      expect(mock.history.get.length).toBe(3);

      manager.destroy();
    });

    it('4.1.6: Per-request requestMode: manual overrides global mode: automatic', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        mode: 'automatic',
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      mock.onGet('/api/data').reply(500, { error: 'server error' });

      await axiosInstance
        .get('/api/data', {
          __axiosRetryer: { requestMode: 'manual' } as any,
        })
        .catch(() => {});

      // Should not retry (manual mode overrides automatic)
      expect(mock.history.get.length).toBe(1);

      manager.destroy();
    });

    it('4.1.7: retryAttempt counter increments correctly across multiple retries', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 2,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      let attemptCount = 0;
      mock.onGet('/api/data').reply(() => {
        attemptCount++;
        if (attemptCount < 3) {
          return [500, { error: 'server error' }];
        }
        return [200, { data: 'success' }];
      });

      await axiosInstance.get('/api/data');

      // Should have 3 attempts (initial + 2 retries)
      expect(attemptCount).toBe(3);

      manager.destroy();
    });

    it('4.1.8: Retry exhaustion emits onFailure then onRequestError in that order', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      const eventOrder: string[] = [];

      manager.on('onFailure' as any, () => {
        eventOrder.push('onFailure');
      });

      manager.on('onRequestError' as any, () => {
        eventOrder.push('onRequestError');
      });

      mock.onGet('/api/data').reply(500, { error: 'server error' });

      await axiosInstance.get('/api/data').catch(() => {});

      // onFailure should fire before onRequestError
      expect(eventOrder).toEqual(['onFailure', 'onRequestError']);

      manager.destroy();
    });

    it('4.1.9: throwErrorOnFailedRetries: false resolves with null instead of rejecting', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
        throwErrorOnFailedRetries: false,
      });

      mock.onGet('/api/data').reply(500, { error: 'server error' });

      const result = await axiosInstance.get('/api/data');

      // Should resolve with null in silent failure mode
      expect(result).toBeNull();

      manager.destroy();
    });

    it('4.1.10: throwErrorOnFailedRetries: true rejects with original AxiosError', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
        throwErrorOnFailedRetries: true,
      });

      mock.onGet('/api/data').reply(500, { error: 'server error' });

      await expect(axiosInstance.get('/api/data')).rejects.toThrow();

      manager.destroy();
    });
  });

  // 4.2 Retry-After Header Handling
  describe('4.2 Retry-After Header Handling', () => {
    type RetrySchedulerLike = {
      waitForRetryDelay: (config: AxiosError['config'], delay: number) => Promise<boolean>;
    };

    const collectScheduledDelays = (manager: RetryManager): number[] => {
      const delays: number[] = [];

      manager.on('onRetryScheduled', (delayMs) => {
        delays.push(delayMs);
      });

      return delays;
    };

    const stubRetryWait = (manager: RetryManager): void => {
      const retryScheduler = (manager as unknown as { retryScheduler: RetrySchedulerLike }).retryScheduler;
      jest.spyOn(retryScheduler, 'waitForRetryDelay').mockResolvedValue(true);
    };

    const createManager = (strategyDelay = 100): RetryManager =>
      new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
        throwErrorOnFailedRetries: false,
        retryStrategy: {
          getDelay: () => strategyDelay,
          getIsRetryable: (error) => error.response?.status === 503,
          shouldRetry: (error, attempt, maxRetries) => error.response?.status === 503 && attempt <= maxRetries,
        },
      });

    it('4.2.1: Retry-After: 2 (seconds) produces a 2000ms scheduled delay', async () => {
      const manager = createManager();
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'Retry-After': '2' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await expect(axiosInstance.get('/api/data')).resolves.toMatchObject({ status: 200 });
      expect(delays).toEqual([2000]);

      manager.destroy();
    });

    it('4.2.2: Retry-After: 0 is ignored and falls back to the retry strategy delay', async () => {
      const manager = createManager(250);
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'Retry-After': '0' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([250]);

      manager.destroy();
    });

    it('4.2.3: Retry-After: 600 is capped at MAX_RETRY_AFTER_MS (300000ms)', async () => {
      const manager = createManager();
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'Retry-After': '600' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([300000]);

      manager.destroy();
    });

    it('4.2.4: Retry-After HTTP-date format produces the correct delay', async () => {
      const manager = createManager();
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      const baseNow = Date.parse('2026-04-10T12:00:00.000Z');
      jest.spyOn(Date, 'now').mockReturnValue(baseNow);

      mock.onGet('/api/data').replyOnce(
        503,
        { error: 'service unavailable' },
        {
          'Retry-After': new Date(baseNow + 2000).toUTCString(),
        },
      );
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([2000]);

      manager.destroy();
    });

    it('4.2.5: past Retry-After HTTP-date falls back to the retry strategy delay', async () => {
      const manager = createManager(250);
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      const baseNow = Date.parse('2026-04-10T12:00:00.000Z');
      jest.spyOn(Date, 'now').mockReturnValue(baseNow);

      mock.onGet('/api/data').replyOnce(
        503,
        { error: 'service unavailable' },
        {
          'Retry-After': new Date(baseNow - 1000).toUTCString(),
        },
      );
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([250]);

      manager.destroy();
    });

    it('4.2.6: malformed Retry-After values are ignored', async () => {
      const manager = createManager(250);
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'Retry-After': 'garbage' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([250]);

      manager.destroy();
    });

    it('4.2.7: negative Retry-After seconds are ignored', async () => {
      const manager = createManager(250);
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'Retry-After': '-5' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([250]);

      manager.destroy();
    });

    it('4.2.8: Retry-After only overrides the retry strategy when it is larger', async () => {
      const manager = createManager(1500);
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'Retry-After': '1' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([1500]);

      manager.destroy();
    });

    it('4.2.9: Retry-After headers are read case-insensitively', async () => {
      const manager = createManager();
      const delays = collectScheduledDelays(manager);
      stubRetryWait(manager);

      mock.onGet('/api/data').replyOnce(503, { error: 'service unavailable' }, { 'ReTrY-AfTeR': '2' });
      mock.onGet('/api/data').replyOnce(200, { data: 'success' });

      await axiosInstance.get('/api/data');
      expect(delays).toEqual([2000]);

      manager.destroy();
    });
  });

  describe('4.3 Network Errors', () => {
    it('4.3.1: Network error (no response) emits onInternetConnectionError after onRequestError', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 0,
        debug: false,
        throwErrorOnFailedRetries: false,
      });
      const eventOrder: string[] = [];

      manager.on('onRequestError', () => {
        eventOrder.push('onRequestError');
      });
      manager.on('onInternetConnectionError', () => {
        eventOrder.push('onInternetConnectionError');
      });

      mock.onGet('/offline').networkErrorOnce();

      await axiosInstance.get('/offline').catch(() => undefined);

      expect(eventOrder).toEqual(['onRequestError', 'onInternetConnectionError']);

      manager.destroy();
    });

    it('4.3.2: Network error IS retried by default (no status code, but error is retryable)', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
        debug: false,
      });

      mock.onGet('/offline-retry').networkErrorOnce();
      mock.onGet('/offline-retry').replyOnce(200, { ok: true });

      await expect(axiosInstance.get('/offline-retry')).resolves.toMatchObject({ status: 200 });
      expect(mock.history.get).toHaveLength(2);

      manager.destroy();
    });

    it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'])('4.3.3: %s is treated as retryable', async (errorCode) => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
        debug: false,
      });
      let attempts = 0;

      mock.onGet('/node-network-error').reply(() => {
        attempts += 1;
        if (attempts === 1) {
          throw new AxiosError(errorCode, errorCode, {
            url: '/node-network-error',
            method: 'get',
            headers: {},
          } as never);
        }

        return [200, { ok: true }];
      });

      await expect(axiosInstance.get('/node-network-error')).resolves.toMatchObject({ status: 200 });
      expect(attempts).toBe(2);

      manager.destroy();
    });

    it('4.3.4: DNS resolution failure (ENOTFOUND) is retryable', async () => {
      const manager = new RetryManager({
        axiosInstance,
        retries: 1,
        queueDelay: 0,
        debug: false,
      });
      let attempts = 0;

      mock.onGet('/dns-failure').reply(() => {
        attempts += 1;
        if (attempts === 1) {
          throw new AxiosError('lookup failed', 'ENOTFOUND', {
            url: '/dns-failure',
            method: 'get',
            headers: {},
          } as never);
        }

        return [200, { ok: true }];
      });

      await expect(axiosInstance.get('/dns-failure')).resolves.toMatchObject({ status: 200 });
      expect(attempts).toBe(2);

      manager.destroy();
    });
  });

  describe('4.4 Cancellation During Retry', () => {
    const createRetryManager = (options: Partial<ConstructorParameters<typeof RetryManager>[0]> = {}): RetryManager =>
      new RetryManager({
        axiosInstance,
        retries: 1,
        debug: false,
        retryStrategy: {
          getDelay: () => 1_000,
          getIsRetryable: (error) => error.response?.status === 500,
          shouldRetry: (error, attempt, maxRetries) => error.response?.status === 500 && attempt <= maxRetries,
        },
        ...options,
      });

    it('4.4.1: Request cancelled during backoff sleep: sleep promise rejects, no retry attempt is made', async () => {
      const manager = createRetryManager({
        throwErrorOnCancelRequest: true,
      });
      const retryScheduler = (
        manager as unknown as {
          retryScheduler: { waitForRetryDelay(config: unknown, delay: number): Promise<boolean> };
        }
      ).retryScheduler;
      const originalWait = retryScheduler.waitForRetryDelay.bind(retryScheduler);
      let waitStarted!: () => void;
      const waitStartedPromise = new Promise<void>((resolve) => {
        waitStarted = resolve;
      });

      jest.spyOn(retryScheduler, 'waitForRetryDelay').mockImplementation(async (config, delay) => {
        const waitPromise = originalWait(config, delay);
        waitStarted();
        return waitPromise;
      });

      mock.onGet('/cancel-during-sleep').reply(500);

      const controller = new AbortController();
      const requestPromise = axiosInstance.get('/cancel-during-sleep', {
        signal: controller.signal,
      });

      await waitStartedPromise;
      controller.abort();

      await expect(requestPromise).rejects.toBeInstanceOf(RequestAbortedError);
      expect(mock.history.get).toHaveLength(1);

      manager.destroy();
    });

    it('4.4.2: Request cancelled after backoff sleep but before axiosInstance.request(): no request is dispatched', async () => {
      const manager = createRetryManager({
        throwErrorOnCancelRequest: true,
      });
      const retryScheduler = (
        manager as unknown as {
          retryScheduler: { waitForRetryDelay(config: unknown, delay: number): Promise<boolean> };
        }
      ).retryScheduler;
      const controller = new AbortController();

      jest.spyOn(retryScheduler, 'waitForRetryDelay').mockImplementation(async () => {
        controller.abort();
        return true;
      });

      mock.onGet('/cancel-between-sleep-and-retry').reply(500);

      await expect(
        axiosInstance.get('/cancel-between-sleep-and-retry', {
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(RequestAbortedError);
      expect(mock.history.get).toHaveLength(1);

      manager.destroy();
    });

    it('4.4.3: throwErrorOnCancelRequest: false resolves with null when cancelled during retry', async () => {
      const manager = createRetryManager({
        throwErrorOnCancelRequest: false,
      });
      const retryScheduler = (
        manager as unknown as {
          retryScheduler: { waitForRetryDelay(config: unknown, delay: number): Promise<boolean> };
        }
      ).retryScheduler;
      const originalWait = retryScheduler.waitForRetryDelay.bind(retryScheduler);
      let waitStarted!: () => void;
      const waitStartedPromise = new Promise<void>((resolve) => {
        waitStarted = resolve;
      });

      jest.spyOn(retryScheduler, 'waitForRetryDelay').mockImplementation(async (config, delay) => {
        const waitPromise = originalWait(config, delay);
        waitStarted();
        return waitPromise;
      });

      mock.onGet('/silent-cancel-during-retry').reply(500);

      const controller = new AbortController();
      const requestPromise = axiosInstance.get('/silent-cancel-during-retry', {
        signal: controller.signal,
      });

      await waitStartedPromise;
      controller.abort();

      await expect(requestPromise).resolves.toBeNull();
      expect(mock.history.get).toHaveLength(1);

      manager.destroy();
    });

    it('4.4.4: throwErrorOnCancelRequest: true rejects with RequestAbortedError when cancelled during retry', async () => {
      const manager = createRetryManager({
        throwErrorOnCancelRequest: true,
      });
      const retryScheduler = (
        manager as unknown as {
          retryScheduler: { waitForRetryDelay(config: unknown, delay: number): Promise<boolean> };
        }
      ).retryScheduler;
      const originalWait = retryScheduler.waitForRetryDelay.bind(retryScheduler);
      let waitStarted!: () => void;
      const waitStartedPromise = new Promise<void>((resolve) => {
        waitStarted = resolve;
      });

      jest.spyOn(retryScheduler, 'waitForRetryDelay').mockImplementation(async (config, delay) => {
        const waitPromise = originalWait(config, delay);
        waitStarted();
        return waitPromise;
      });

      mock.onGet('/loud-cancel-during-retry').reply(500);

      const controller = new AbortController();
      const requestPromise = axiosInstance.get('/loud-cancel-during-retry', {
        signal: controller.signal,
      });

      await waitStartedPromise;
      controller.abort();

      await expect(requestPromise).rejects.toBeInstanceOf(RequestAbortedError);
      expect(mock.history.get).toHaveLength(1);

      manager.destroy();
    });
  });
});
