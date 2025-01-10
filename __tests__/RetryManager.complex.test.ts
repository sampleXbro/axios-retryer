//@ts-nocheck
import axios from 'axios';
import { RetryManager } from '../src/core/RetryManager';
import AxiosMockAdapter from 'axios-mock-adapter';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('RetryManager - Complex retry scenarios', () => {
  let retryManager: RetryManager;
  let mock: AxiosMockAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset timing mocks
    jest.useRealTimers();

    mockedAxios.create.mockReturnValue(axios);

    retryManager = new RetryManager({
      mode: 'automatic',
      retries: 5,
    });
    mock = new AxiosMockAdapter(retryManager.getAxiosInstance());
  });

  afterEach(() => {
    mock.restore();
  });

  describe('Multiple requests with varying response times', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('should handle 3 requests with 2 retries and one slow failing request', async () => {
      // Mock the axios request implementation
      let requestCount = 0;
      mockedAxios.request.mockImplementation((config: any) => {
        const url = config.url;
        requestCount++;

        if (url === '/slow') {
          return new Promise((_, reject) => {
            setTimeout(() => {
              reject({ config, message: 'timeout' });
            }, 10000); // 10 seconds
          });
        }

        return Promise.reject({ config, message: 'error' });
      });

      // Send 3 requests
      const requests = [
        retryManager.getAxiosInstance().request({ url: '/fast1' }),
        retryManager.getAxiosInstance().request({ url: '/slow' }),
        retryManager.getAxiosInstance().request({ url: '/fast2' }),
      ];

      // Fast forward time to trigger retries
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(1000); // Advance 1 second for retry delay
      }

      // Fast forward the remaining time for the slow request
      jest.advanceTimersByTime(10000);

      await expect(Promise.all(requests)).rejects.toStrictEqual({ config: { url: '/fast1' }, message: 'error' });
      expect(requestCount).toBe(3);
    });

    it('should handle 3 requests with 2 retries and one slow successful request', async () => {
      let requestCount = 0;
      mockedAxios.request.mockImplementation((config: any) => {
        const url = config.url;
        requestCount++;

        if (url === '/slow') {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({ data: 'success', config });
            }, 10000);
          });
        }

        return Promise.reject({ config, message: 'error' });
      });

      const requests = [
        retryManager.getAxiosInstance().request({ url: '/fast1' }),
        retryManager.getAxiosInstance().request({ url: '/slow' }),
        retryManager.getAxiosInstance().request({ url: '/fast2' }),
      ];

      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(1000);
      }

      jest.advanceTimersByTime(10000);

      await expect(Promise.all(requests)).rejects.toStrictEqual({ config: { url: '/fast1' }, message: 'error' });
      expect(requestCount).toBe(3);
    });

    it('should handle 3 requests with 5 retries and one slow failing request', async () => {
      let requestCount = 0;
      mockedAxios.request.mockImplementation((config: any) => {
        const url = config.url;
        requestCount++;

        if (url === '/slow') {
          return new Promise((_, reject) => {
            setTimeout(() => {
              reject({ config, message: 'timeout' });
            }, 10000);
          });
        }

        return Promise.reject({ config, message: 'error' });
      });

      const requests = [
        retryManager.getAxiosInstance().request({ url: '/fast1' }),
        retryManager.getAxiosInstance().request({ url: '/slow' }),
        retryManager.getAxiosInstance().request({ url: '/fast2' }),
      ];

      // Advance time for all retries
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(1000);
      }

      jest.advanceTimersByTime(10000);

      await expect(Promise.all(requests)).rejects.toStrictEqual({ config: { url: '/fast1' }, message: 'error' });
      expect(requestCount).toBe(3);
    });

    it('should handle 3 requests with 5 retries and one slow successful request', async () => {
      let requestCount = 0;
      mockedAxios.request.mockImplementation((config: any) => {
        const url = config.url;
        requestCount++;

        if (url === '/slow') {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({ data: 'success', config });
            }, 10000);
          });
        }

        return Promise.reject({ config, message: 'error' });
      });

      const requests = [
        retryManager.getAxiosInstance().request({ url: '/fast1' }),
        retryManager.getAxiosInstance().request({ url: '/slow' }),
        retryManager.getAxiosInstance().request({ url: '/fast2' }),
      ];

      // Advance time for all retries
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(1000);
      }

      jest.advanceTimersByTime(10000);

      await expect(Promise.all(requests)).rejects.toStrictEqual({ config: { url: '/fast1' }, message: 'error' });
      expect(requestCount).toBe(3);
    });
  });
});
