import { useState, useEffect } from 'react';
import { AxiosRequestConfig } from 'axios';
import { useAxiosRetryer, UseAxiosRetryerOptions, UseAxiosRetryerResult } from './useAxiosRetryer';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';

// Simple in-memory cache for query results
const queryCache: Record<string, {
  data: any;
  timestamp: number;
  etag?: string;
}> = {};

export interface UseAxiosRetryerQueryOptions<T = any, D = any> extends UseAxiosRetryerOptions<T, D> {
  /**
   * Unique cache key for this query, defaults to URL
   */
  cacheKey?: string;
  
  /**
   * Time in milliseconds to cache the data (0 = no cache)
   * @default 60000 (1 minute)
   */
  cacheDuration?: number;
  
  /**
   * Automatically refetch data at this interval (in ms)
   */
  refetchInterval?: number;
  
  /**
   * Whether to refetch on window focus
   * @default true
   */
  refetchOnWindowFocus?: boolean;
  
  /**
   * Whether to use stale data while revalidating
   * @default true
   */
  useStaleData?: boolean;
}

export interface UseAxiosRetryerQueryResult<T = any, D = any> extends UseAxiosRetryerResult<T, D> {
  /**
   * Whether the data is stale (being revalidated)
   */
  isStale: boolean;
  
  /**
   * Force a refetch (ignoring cache)
   */
  invalidateCache: () => Promise<T | undefined>;
}

/**
 * Hook for data queries with caching and revalidation
 * 
 * @param url The URL to request
 * @param options Additional options
 * @returns The request state and control functions
 * 
 * @example
 * ```tsx
 * const { data, loading, error, isStale } = useAxiosRetryerQuery('/api/users', {
 *   cacheDuration: 5 * 60 * 1000, // 5 minutes
 *   refetchInterval: 30 * 1000, // Poll every 30 seconds
 * });
 * 
 * if (loading && !data) return <div>Loading...</div>;
 * 
 * return (
 *   <div>
 *     {isStale && <div>Refreshing...</div>}
 *     <UserList users={data || []} />
 *     {error && <div>Error: {error.message}</div>}
 *   </div>
 * );
 * ```
 */
export function useAxiosRetryerQuery<T = any, D = any>(
  url: string,
  options: UseAxiosRetryerQueryOptions<T, D> = {}
): UseAxiosRetryerQueryResult<T, D> {
  const {
    cacheKey = url,
    cacheDuration = 60000, // 1 minute default
    refetchInterval,
    refetchOnWindowFocus = true,
    useStaleData = true,
    priority = AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, // Default to lower priority for background fetches
    config = {},
    ...restOptions
  } = options;
  
  const [isStale, setIsStale] = useState(false);
  
  // Build custom config with caching headers
  const customConfig: AxiosRequestConfig<D> = {
    ...config
  };
  
  // Add etag/if-none-match for efficient caching
  if (queryCache[cacheKey]?.etag) {
    customConfig.headers = {
      ...customConfig.headers,
      'If-None-Match': queryCache[cacheKey].etag
    };
  }
  
  // Check for cached data and use it as initialData if available and not expired
  const cachedData = queryCache[cacheKey];
  const isCacheValid = cachedData && (Date.now() - cachedData.timestamp < cacheDuration);
  const initialData = useStaleData && isCacheValid ? cachedData.data : undefined;
  
  // Set up auto-fetch based on cache state
  const shouldAutoFetch = !isCacheValid || restOptions.autoFetch !== false;
  
  // Use the base hook with our customizations
  const result = useAxiosRetryer<T, D>(url, 'get', {
    ...restOptions,
    initialData,
    autoFetch: shouldAutoFetch,
    priority,
    config: customConfig,
    onSuccess: (data, response) => {
      // Update cache on successful response
      queryCache[cacheKey] = {
        data,
        timestamp: Date.now(),
        etag: response.headers.etag
      };
      
      setIsStale(false);
      if (options.onSuccess) {
        options.onSuccess(data, response);
      }
    }
  });
  
  // Function to invalidate cache and refetch
  const invalidateCache = async (): Promise<T | undefined> => {
    delete queryCache[cacheKey];
    setIsStale(true);
    return result.refetch();
  };
  
  // Set up refetch interval if specified
  useEffect(() => {
    if (!refetchInterval) return;
    
    const intervalId = setInterval(() => {
      setIsStale(true);
      result.refetch();
    }, refetchInterval);
    
    return () => clearInterval(intervalId);
  }, [refetchInterval, result.refetch]);
  
  // Set up window focus listener if enabled
  useEffect(() => {
    if (!refetchOnWindowFocus) return;
    
    const handleFocus = () => {
      // Check if cache is stale on window focus
      if (queryCache[cacheKey] && (Date.now() - queryCache[cacheKey].timestamp > cacheDuration / 2)) {
        setIsStale(true);
        result.refetch();
      }
    };
    
    window.addEventListener('focus', handleFocus);
    
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [refetchOnWindowFocus, cacheKey, cacheDuration, result.refetch]);
  
  return {
    ...result,
    isStale,
    invalidateCache
  };
} 