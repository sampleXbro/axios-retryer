import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { RetryManager, AXIOS_RETRYER_REQUEST_PRIORITIES } from '../../src';
import type { RequestQueue } from '../../src/core/requestQueue';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('full race diagnosis', () => {
  it('patches drainQueue and traces ordering with core blocking enabled', async () => {
    const axiosInstance = axios.create();
    const mock = new AxiosMockAdapter(axiosInstance);
    const log: string[] = [];

    const manager = new RetryManager({
      axiosInstance,
      maxConcurrentRequests: 5,
      retries: 0,
      queueDelay: 0,
      blockingPriorityThreshold: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL,
      cancelPendingOnDependencyFailure: false,
    });

    // Spy BETWEEN manager interceptor and the queue drain
    axiosInstance.interceptors.request.use((cfg) => {
      const blockingIds = (manager as any).dependencyGatekeeper.blockingRequestIds as Set<string>;
      log.push(`SPY_A prio=${(cfg as unknown as { __axiosRetryer?: { priority?: number } }).__axiosRetryer?.priority ?? 'none'} blockingSize=${blockingIds.size}`);
      return cfg;
    });

    // Patch drainQueue for tracing
    const queue = (manager as unknown as { requestQueue: RequestQueue }).requestQueue;
    const origDrain = (queue as unknown as { drainQueue: () => void }).drainQueue.bind(queue);
    (queue as unknown as { drainQueue: () => void }).drainQueue = function() {
      const blockingIds = (manager as any).dependencyGatekeeper.blockingRequestIds as Set<string>;
      log.push(`drainQueue blockingSize=${blockingIds.size}`);
      origDrain();
    };

    let releaseCritical!: () => void;
    mock.onGet('/critical').reply(() =>
      new Promise<[number, object]>((r) => { releaseCritical = () => r([200, {}]); }),
    );
    mock.onGet('/highest').reply(() => [200, {}]);
    mock.onGet('/low').reply(() => [200, {}]);

    const critP = manager.axiosInstance.get('/critical', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL },
    });
    const highP = manager.axiosInstance.get('/highest', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.HIGHEST },
    });
    const lowP = manager.axiosInstance.get('/low', {
      __axiosRetryer: { priority: AXIOS_RETRYER_REQUEST_PRIORITIES.LOW },
    });

    await delay(50);

    console.log('=== Full race trace ===');
    log.forEach((e, i) => console.log(`  [${i}] ${e}`));

    releaseCritical?.();
    await Promise.all([critP, highP, lowP]);
    manager.destroy();
    mock.restore();
  });
});
