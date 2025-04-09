import { useState, useEffect, useCallback, useRef } from 'react';
import { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { RetryManager } from '../';
import { useRetryManager } from './context';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';

export interface UseAxiosRetryerOptions<T = any, D = any> {
  /**
   * Whether to fetch data automatically when the component mounts
   * @default true
   */
  autoFetch?: boolean;
  
  /**
   * Initial data to use before the request completes
   */
  initialData?: T;
  
  /**
   * Request configuration for axios
   */
  config?: AxiosRequestConfig<D>;
  
  /**
   * Priority of the request
   * @default AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM
   */
  priority?: typeof AXIOS_RETRYER_REQUEST_PRIORITIES[keyof typeof AXIOS_RETRYER_REQUEST_PRIORITIES];
  
  /**
   * Custom retry manager (if not using RetryManagerProvider)
   */
  manager?: RetryManager;
  
  /**
   * Callback for successful request
   */
  onSuccess?: (data: T, response: AxiosResponse<T, D>) => void;
  
  /**
   * Callback for failed request
   */
  onError?: (error: Error | AxiosError) => void;
  
  /**
   * Manual dependency array to trigger refetch
   */
  deps?: any[];
}

export interface UseAxiosRetryerResult<T = any, D = any> {
  /**
   * Fetched data, or initialData if the request hasn't completed
   */
  data: T | undefined;
  
  /**
   * Original AxiosResponse object if available
   */
  response: AxiosResponse<T, D> | undefined;
  
  /**
   * Error object if the request failed
   */
  error: Error | AxiosError | undefined;
  
  /**
   * Whether the request is currently loading
   */
  loading: boolean;
  
  /**
   * Function to manually trigger a fetch
   */
  refetch: () => Promise<T | undefined>;
  
  /**
   * Function to cancel the current request
   */
  cancel: () => void;
  
  /**
   * Function to clear the error state
   */
  clearError: () => void;
}

/**
 * Hook for making Axios requests with retry capabilities
 * 
 * @param url The URL to request
 * @param method The HTTP method (get, post, put, etc.)
 * @param options Additional options
 * @returns The request state and control functions
 * 
 * @example
 * ```tsx
 * const { data, loading, error, refetch } = useAxiosRetryer('/api/users', 'get');
 * 
 * if (loading) return <div>Loading...</div>;
 * if (error) return <div>Error: {error.message} <button onClick={refetch}>Retry</button></div>;
 * 
 * return (
 *   <div>
 *     <h1>Users</h1>
 *     <ul>
 *       {data?.map(user => (
 *         <li key={user.id}>{user.name}</li>
 *       ))}
 *     </ul>
 *   </div>
 * );
 * ```
 */
export function useAxiosRetryer<T = any, D = any>(
  url: string,
  method: string,
  options: UseAxiosRetryerOptions<T, D> = {}
): UseAxiosRetryerResult<T, D> {
  const {
    autoFetch = true,
    initialData,
    config = {},
    priority = AXIOS_RETRYER_REQUEST_PRIORITIES.MEDIUM,
    onSuccess,
    onError,
    deps = [],
    manager: externalManager
  } = options;
  
  // Try to get manager from context if not provided externally
  let contextManager: RetryManager | undefined;
  try {
    contextManager = useRetryManager();
  } catch (e) {
    if (!externalManager) {
      throw new Error('useAxiosRetryer requires a RetryManager. Either use RetryManagerProvider or pass a manager in options.');
    }
  }
  
  const manager = externalManager || contextManager;
  
  const [data, setData] = useState<T | undefined>(initialData);
  const [response, setResponse] = useState<AxiosResponse<T, D>>();
  const [error, setError] = useState<Error | AxiosError>();
  const [loading, setLoading] = useState<boolean>(autoFetch);
  
  // Store request ID for cancellation
  const requestId = useRef<string | undefined>();
  
  // Enhanced request config with priority
  const requestConfig: AxiosRequestConfig<D> = {
    ...config,
    __priority: priority,
    __requestId: requestId.current
  };
  
  // Function to fetch data
  const fetchData = useCallback(async (): Promise<T | undefined> => {
    // Generate unique request ID for cancellation
    requestId.current = `react-hook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    requestConfig.__requestId = requestId.current;
    
    setLoading(true);
    setError(undefined);
    
    try {
      const axiosResponse = await manager!.axiosInstance.request<T, AxiosResponse<T, D>, D>({
        url,
        method,
        ...requestConfig
      });
      
      setResponse(axiosResponse);
      setData(axiosResponse.data);
      setLoading(false);
      
      if (onSuccess) {
        onSuccess(axiosResponse.data, axiosResponse);
      }
      
      return axiosResponse.data;
    } catch (err) {
      setError(err as Error | AxiosError);
      setLoading(false);
      
      if (onError) {
        onError(err as Error | AxiosError);
      }
      
      return undefined;
    }
  }, [url, method, JSON.stringify(requestConfig), manager, onSuccess, onError, ...deps]);
  
  // Cancel the current request
  const cancel = useCallback(() => {
    if (requestId.current) {
      manager!.cancelRequest(requestId.current);
      requestId.current = undefined;
      setLoading(false);
    }
  }, [manager]);
  
  // Clear error state
  const clearError = useCallback(() => {
    setError(undefined);
  }, []);
  
  // Auto fetch on mount or when dependencies change
  useEffect(() => {
    if (autoFetch) {
      fetchData();
    }
    
    // Cleanup: cancel request on unmount
    return () => {
      cancel();
    };
  }, [fetchData, autoFetch, cancel]);
  
  return {
    data,
    response,
    error,
    loading,
    refetch: fetchData,
    cancel,
    clearError
  };
} 