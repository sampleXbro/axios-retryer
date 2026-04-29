import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import type { Logger } from '../../../types';
import { getRequestMetadata } from '../../../utils/requestMetadata';
import { createInflightCacheEntry, type InflightCacheEntry } from '../utils';

export interface InflightDedupeOptions {
  getLogger: () => Logger | null | undefined;
}

/**
 * Tracks per-request state used by the in-flight deduplication path:
 *   - leaders that own a pending network call,
 *   - followers that piggy-back on a leader's response,
 *   - requests already served from cache (so a synthetic 200 doesn't get re-cached),
 *   - a stable tracking id keyed off the request metadata's `requestId` (with a
 *     WeakMap fallback for environments where the RetryManager's request
 *     interceptor has not yet run).
 */
export class InflightDedupe {
  private readonly inflightRequests = new Map<string, InflightCacheEntry>();
  private readonly inflightLeaders = new Map<string, string>();
  private readonly inflightFollowers = new Map<string, string>();
  private readonly servedFromCache = new Set<string>();
  private readonly trackingIdFallback = new WeakMap<AxiosRequestConfig, string>();

  constructor(private readonly options: InflightDedupeOptions) {}

  public getOrAssignTrackingId(config: AxiosRequestConfig): string {
    const requestId = getRequestMetadata(config)?.requestId;
    if (requestId) {
      return requestId;
    }

    let fallbackId = this.trackingIdFallback.get(config);
    if (!fallbackId) {
      fallbackId = `ct_${Math.random().toString(36).slice(2)}`;
      this.trackingIdFallback.set(config, fallbackId);
      // No `requestId` means RetryManager's request interceptor hasn't run yet for this
      // config — typically a sign that CachingPlugin was registered before another plugin
      // that spreads the config (e.g. TokenRefreshPlugin). Inflight dedup may be split
      // between two object identities. Warn once per fallback assignment so users can
      // spot misordering in production.
      this.options
        .getLogger()
        ?.warn(
          '[CachingPlugin] Request lacks requestId; falling back to WeakMap-keyed tracking id. ' +
            'Register CachingPlugin AFTER any plugin that mutates the request config.',
        );
    }
    return fallbackId;
  }

  public peekInflight(cacheKey: string): InflightCacheEntry | undefined {
    return this.inflightRequests.get(cacheKey);
  }

  public registerLeader(config: AxiosRequestConfig, cacheKey: string): InflightCacheEntry {
    const entry = createInflightCacheEntry();
    this.inflightRequests.set(cacheKey, entry);
    this.inflightLeaders.set(this.getOrAssignTrackingId(config), cacheKey);
    return entry;
  }

  public registerFollower(config: AxiosRequestConfig, cacheKey: string): void {
    this.inflightFollowers.set(this.getOrAssignTrackingId(config), cacheKey);
  }

  public consumeFollower(config: AxiosRequestConfig | undefined): boolean {
    if (!config) {
      return false;
    }
    const id = this.getOrAssignTrackingId(config);
    if (!this.inflightFollowers.has(id)) {
      return false;
    }
    this.inflightFollowers.delete(id);
    return true;
  }

  public clearFollower(config: AxiosRequestConfig): void {
    this.inflightFollowers.delete(this.getOrAssignTrackingId(config));
  }

  public markServedFromCache(config: AxiosRequestConfig): void {
    this.servedFromCache.add(this.getOrAssignTrackingId(config));
  }

  public consumeServedFromCache(config: AxiosRequestConfig | undefined): boolean {
    if (!config) {
      return false;
    }
    const id = this.getOrAssignTrackingId(config);
    if (!this.servedFromCache.has(id)) {
      return false;
    }
    this.servedFromCache.delete(id);
    return true;
  }

  public resolve(config: AxiosRequestConfig | undefined, response: AxiosResponse): void {
    if (!config) {
      return;
    }
    const trackingId = this.getOrAssignTrackingId(config);
    const leaderKey = this.inflightLeaders.get(trackingId);
    if (!leaderKey) {
      return;
    }
    const inflight = this.inflightRequests.get(leaderKey);
    if (inflight) {
      inflight.resolve(response);
      this.inflightRequests.delete(leaderKey);
    }
    this.inflightLeaders.delete(trackingId);
  }

  public reject(config: AxiosRequestConfig, error: unknown): void {
    const trackingId = this.getOrAssignTrackingId(config);
    const leaderKey = this.inflightLeaders.get(trackingId);
    if (!leaderKey) {
      return;
    }
    const inflight = this.inflightRequests.get(leaderKey);
    if (inflight) {
      inflight.reject(error);
      this.inflightRequests.delete(leaderKey);
    }
    this.inflightLeaders.delete(trackingId);
  }

  public clearInflightOnly(): void {
    this.inflightRequests.clear();
  }

  public clearAll(): void {
    this.inflightRequests.clear();
    this.inflightLeaders.clear();
    this.inflightFollowers.clear();
    this.servedFromCache.clear();
  }
}
