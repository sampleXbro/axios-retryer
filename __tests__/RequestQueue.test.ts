//@ts-nocheck
import { RequestQueue } from '../src/core/requestQueue';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../src';

describe('RequestQueue', () => {
  const mockIsCriticalRequest = jest.fn();
  const mockHasActiveCriticalRequests = jest.fn();

  const createConfig = (priority: number, timestamp: number, requestId: string) => ({
    __priority: priority,
    __timestamp: timestamp,
    __requestId: requestId,
  });

  let queue: RequestQueue;

  beforeEach(() => {
    mockIsCriticalRequest.mockReset();
    mockHasActiveCriticalRequests.mockReset();
    queue = new RequestQueue(2, 50, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined);
  });

  it('should initialize correctly with valid parameters', () => {
    expect(() => new RequestQueue(1, 50, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined)).not.toThrow();
  });

  it('should throw an error if maxConcurrent is less than 1', () => {
    expect(() => new RequestQueue(0, 50, mockHasActiveCriticalRequests, mockIsCriticalRequest, undefined)).toThrow(
      'maxConcurrent must be >= 1. Received: 0'
    );
  });

  it('should enqueue requests and resolve them in priority order', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);

    const results: string[] = [];
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, Date.now(), 'req2')).then(() =>
      results.push('req2')
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results).toEqual(['req2', 'req1']);
  });

  it('should mark requests as complete and process more', async () => {
    mockIsCriticalRequest.mockReturnValue(false);
    mockHasActiveCriticalRequests.mockReturnValue(false);

    const results: string[] = [];
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM, Date.now(), 'req2')).then(() =>
      results.push('req2')
    );

    queue.markComplete();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results).toEqual(['req1', 'req2']);
  });

  it('should return the correct waiting count', () => {
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req44'));
    expect(queue.getWaitingCount()).toBe(1);
  });

  it('should return the correct waiting requests', () => {
    const config = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req33');
    queue.enqueue(config);
    expect(queue.getWaiting()[0].config).toEqual(config);
  });

  it('should return busy state correctly', () => {
    expect(queue.isBusy).toBe(true);
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req33'));
    expect(queue.isBusy).toBe(false);
  });

  it('should handle canceling non-existent requests', () => {
    const result = queue.cancelQueuedRequest('non-existent');
    expect(result).toBe(false);
  });

  it('should insert requests in the correct priority order', () => {
    const lowPriority = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req1');
    const highPriority = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH, Date.now(), 'req2');
    queue.enqueue(lowPriority);
    queue.enqueue(highPriority);

    const waiting = queue.getWaiting();
    expect(waiting[0].config.__priority).toBe(AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH);
    expect(waiting[1].config.__priority).toBe(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW);
  });

  it('should dequeue requests correctly based on priority and criticality', async () => {
    mockIsCriticalRequest.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockHasActiveCriticalRequests.mockReturnValueOnce(true);

    const results: string[] = [];
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req1')).then(() =>
      results.push('req1')
    );
    queue.enqueue(createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.CRITICAL, Date.now(), 'req2')).then(() =>
      results.push('req2')
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(results).toEqual(['req2', 'req1']);
  });

  it('should cancel queued requests correctly', async () => {
    const config = createConfig(AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, Date.now(), 'req22');
    const promise = queue.enqueue(config);

    const result = queue.cancelQueuedRequest('req22');

    await expect(promise).rejects.toThrow()

    expect(result).toBe(true);
    expect(queue.getWaitingCount()).toBe(0);
  });
});