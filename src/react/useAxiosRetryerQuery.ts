import { useState, useEffect, useMemo } from 'react';
import { AxiosRequestConfig } from 'axios';
import { useAxiosRetryer, UseAxiosRetryerOptions, UseAxiosRetryerResult } from './useAxiosRetryer';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';
import { useRetryManager } from './context';
import { CachingPlugin, CachingPluginOptions } from '../plugins/CachingPlugin';

export interface UseAxiosRetryerQueryOptions<T = any, D = any> extends UseAxiosRetryerOptions<T, D> {
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
  
  /**
   * Custom caching options to pass to CachingPlugin
   * If provided, these override the standard options
   */
  cachingOptions?: Partial<CachingPluginOptions>;
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
    cacheDuration = 60000, // 1 minute default
    refetchInterval,
    refetchOnWindowFocus = true,
    useStaleData = true,
    priority = AXIOS_RETRYER_REQUEST_PRIORITIES.LOW, // Default to lower priority for background fetches
    config = {},
    cachingOptions,
    manager: externalManager,
    ...restOptions
  } = options;
  
  // Get manager from props or context
  let contextManager;
  try {
    contextManager = useRetryManager();
  } catch (e) {
    if (!externalManager) {
      throw new Error('useAxiosRetryerQuery requires a RetryManager. Either use RetryManagerProvider or pass a manager in options.');
    }
  }
  
  const manager = externalManager || contextManager;
  
  // Ensure manager exists before proceeding
  if (!manager) {
    throw new Error('RetryManager is required for useAxiosRetryerQuery');
  }
  
  const [isStale, setIsStale] = useState(false);
  
  // Setup CachingPlugin with our options
  useMemo(() => {
    // Don't add plugin if caching is disabled
    if (cacheDuration <= 0) return;
    
    // Check if CachingPlugin already exists
    const existingPlugin = manager.listPlugins().find(p => p.name === 'CachingPlugin');
    
    if (!existingPlugin) {
      // Create cache config based on our options
      const cacheConfig: Partial<CachingPluginOptions> = {
        timeToRevalidate: cacheDuration,
        cacheMethods: ['GET'],
        ...cachingOptions
      };
      
      // Add the plugin
      manager.use(new CachingPlugin(cacheConfig));
    }
  }, [manager, cacheDuration, JSON.stringify(cachingOptions)]);
  
  // Use the base hook with our customizations
  const result = useAxiosRetryer<T, D>(url, 'get', {
    ...restOptions,
    autoFetch: restOptions.autoFetch !== false,
    priority,
    config,
    manager,
    onSuccess: (data, response) => {
      setIsStale(false);
      if (options.onSuccess) {
        options.onSuccess(data, response);
      }
    }
  });
  
  // Function to invalidate cache and refetch
  const invalidateCache = async (): Promise<T | undefined> => {
    // Find CachingPlugin
    const plugin = manager.listPlugins().find(p => p.name === 'CachingPlugin');
    
    // Clear cache if plugin exists
    if (plugin) {
      // Cast the plugin to access clearCache method
      (plugin as unknown as CachingPlugin).clearCache?.();
    }
    
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
      setIsStale(true);
      result.refetch();
    };
    
    window.addEventListener('focus', handleFocus);
    
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [refetchOnWindowFocus, result.refetch]);
  
  return {
    ...result,
    isStale,
    invalidateCache
  };
} 