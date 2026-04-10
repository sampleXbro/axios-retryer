/**
 * P1 coverage for TEST_GAP_ANALYSIS.md §15 CachingPlugin (gaps beyond existing CachingPlugin*.test.ts).
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { RetryManager } from '../src';
import { CachingPlugin } from '../src/plugins/CachingPlugin/CachingPlugin';

describe('P1 CachingPlugin (§15)', () => {
  it('15.1.1 first GET is miss, second identical GET is hit', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin({ cacheMethods: ['GET'] });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    const hit = jest.fn();
    const miss = jest.fn();
    manager.on('onCacheHit', hit);
    manager.on('onCacheMiss', miss);
    mock.onGet('/r').reply(200, { v: 1 });
    await instance.get('/r');
    await instance.get('/r');
    expect(miss).toHaveBeenCalledTimes(1);
    expect(hit).toHaveBeenCalledTimes(1);
    mock.restore();
    manager.destroy();
  });

  it('15.1.2 cache hit returns cloned data (mutating response does not corrupt stored entry)', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin({ cacheMethods: ['GET'] });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    mock.onGet('/m').reply(200, { nested: { x: 1 } });
    const first = await instance.get('/m');
    first.data.nested.x = 999;
    const second = await instance.get('/m');
    expect(second.data.nested.x).toBe(1);
    mock.restore();
    manager.destroy();
  });

  it('15.1.5 POST is not cached by default (two calls hit network; cache stays empty)', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin();
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    mock.onPost('/p').reply(200, { ok: true });
    await instance.post('/p');
    await instance.post('/p');
    expect(mock.history.post.length).toBe(2);
    expect(plugin.getCacheStats().size).toBe(0);
    mock.restore();
    manager.destroy();
  });

  it('15.2.1 equivalent params with different object key order share cache key (second is hit)', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin({ cacheMethods: ['GET'] });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    const hit = jest.fn();
    manager.on('onCacheHit', hit);
    mock.onGet('/q').reply(200, { ok: true });
    await instance.get('/q', { params: { z: 1, a: 2 } });
    await instance.get('/q', { params: { a: 2, z: 1 } });
    expect(hit).toHaveBeenCalledTimes(1);
    mock.restore();
    manager.destroy();
  });

  it('15.3.5 clearCache removes entries (follow-up is miss)', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin({ cacheMethods: ['GET'] });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    const miss = jest.fn();
    manager.on('onCacheMiss', miss);
    mock.onGet('/c').reply(200, { n: 1 });
    await instance.get('/c');
    await plugin.clearCache();
    await instance.get('/c');
    expect(miss).toHaveBeenCalledTimes(2);
    mock.restore();
    manager.destroy();
  });

  it('15.3.2 invalidateCache with RegExp removes matching entries (next call is miss)', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin({ cacheMethods: ['GET'] });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    const miss = jest.fn();
    manager.on('onCacheMiss', miss);
    mock.onGet('/api/users/1').reply(200, { id: 1 });
    await instance.get('/api/users/1');
    const removed = plugin.invalidateCache(/users\/1/) as number;
    expect(removed).toBeGreaterThanOrEqual(1);
    await instance.get('/api/users/1');
    expect(miss).toHaveBeenCalledTimes(2);
    mock.restore();
    manager.destroy();
  });

  it('15.6.5 maxItems:1 evicts prior key (two URLs → two misses after eviction)', async () => {
    const instance = axios.create();
    const plugin = new CachingPlugin({ cacheMethods: ['GET'], maxItems: 1 });
    const manager = new RetryManager({ retries: 0, axiosInstance: instance }).use(plugin);
    const mock = new MockAdapter(instance);
    mock.onGet('/first').reply(200, { k: 'first' });
    mock.onGet('/second').reply(200, { k: 'second' });
    await instance.get('/first');
    await instance.get('/second');
    await instance.get('/first');
    expect(plugin.getCacheStats().size).toBeLessThanOrEqual(1);
    mock.restore();
    manager.destroy();
  });
});
