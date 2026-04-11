import type { AxiosResponse } from 'axios';

import { getRequestMetadata } from '../../utils/requestMetadata';
import type { CircuitBreakerAdaptiveTimeoutMetrics } from './CircuitBreakerTypes';

export interface ResponseTimeMetrics {
  times: number[];
  sampleSize: number;
  lastCalculated: number;
  currentPercentileMs: number;
  scopeKey: string;
  normalizedUrl: string;
  host?: string;
}

interface AdaptiveTimeoutTrackerOptions {
  percentile: number;
  sampleSize: number;
  multiplier: number;
  maxTrackedScopes: number;
}

/**
 * Tracks per-scope response times and computes a configurable percentile
 * to derive an adaptive request timeout. Memory-bounded by `maxTrackedScopes`
 * using FIFO eviction.
 */
export class AdaptiveTimeoutTracker {
  /**
   * @internal Exposed for test inspection only; not part of the public API.
   */
  responseMetrics: Record<string, ResponseTimeMetrics> = {};

  private readonly percentile: number;
  private readonly sampleSize: number;
  private readonly multiplier: number;
  private readonly maxTrackedScopes: number;

  constructor(options: AdaptiveTimeoutTrackerOptions) {
    this.percentile = options.percentile;
    this.sampleSize = options.sampleSize;
    this.multiplier = options.multiplier;
    this.maxTrackedScopes = options.maxTrackedScopes;
  }

  public trackResponseTime(response: AxiosResponse, scopeKey: string, normalizedUrl: string, host?: string): void {
    if (!response.config.url) {
      return;
    }

    let responseTime = 0;

    if (response.headers && response.headers['x-response-time']) {
      responseTime = parseInt(response.headers['x-response-time'], 10);
    } else if (getRequestMetadata(response.config)?.timestamp) {
      responseTime = Date.now() - (getRequestMetadata(response.config)?.timestamp || 0);
    }

    if (responseTime <= 0) {
      responseTime = 100;
    }

    if (!this.responseMetrics[scopeKey]) {
      const keys = Object.keys(this.responseMetrics);
      if (keys.length >= this.maxTrackedScopes) {
        delete this.responseMetrics[keys[0]];
      }
      this.responseMetrics[scopeKey] = {
        times: [],
        sampleSize: this.sampleSize,
        lastCalculated: 0,
        currentPercentileMs: 0,
        scopeKey,
        normalizedUrl,
        host,
      };
    }

    const metrics = this.responseMetrics[scopeKey];
    metrics.times.push(responseTime);

    if (metrics.times.length > metrics.sampleSize) {
      metrics.times.shift();
    }

    this.updatePercentile(scopeKey);
  }

  public getComputedTimeout(scopeKey: string): number | undefined {
    const metrics = this.responseMetrics[scopeKey];
    if (metrics && this.isActive(metrics)) {
      return Math.round(metrics.currentPercentileMs * this.multiplier);
    }
    return undefined;
  }

  public isActive(metrics: ResponseTimeMetrics): boolean {
    return metrics.times.length >= metrics.sampleSize && metrics.currentPercentileMs > 0;
  }

  public getAdaptiveTimeoutMetrics(): CircuitBreakerAdaptiveTimeoutMetrics[] {
    return Object.values(this.responseMetrics).map((metrics) => ({
      scopeKey: metrics.scopeKey,
      url: metrics.normalizedUrl,
      host: metrics.host,
      timeoutMs: Math.round(metrics.currentPercentileMs * this.multiplier),
      p95ResponseTimeMs: metrics.currentPercentileMs,
      samplesCount: metrics.times.length,
    }));
  }

  public reset(): void {
    this.responseMetrics = {};
  }

  private updatePercentile(scopeKey: string): void {
    const metrics = this.responseMetrics[scopeKey];
    if (!metrics || metrics.times.length === 0) {
      return;
    }

    if (metrics.times.length < metrics.sampleSize) {
      metrics.currentPercentileMs = 0;
      return;
    }

    const sortedTimes = [...metrics.times].sort((a, b) => a - b);
    const index = Math.max(0, Math.min(Math.ceil(sortedTimes.length * this.percentile) - 1, sortedTimes.length - 1));
    metrics.currentPercentileMs = sortedTimes[index];
    metrics.lastCalculated = Date.now();
  }
}
