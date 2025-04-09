import { useState, useCallback } from 'react';
import { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { RetryManager } from '../';
import { useRetryManager } from './context';
import { AXIOS_RETRYER_REQUEST_PRIORITIES } from '../types';

export interface UseAxiosRetryerMutationOptions<T = any, D = any> {
  /**
   * HTTP method for the mutation
   * @default 'post'
   */
  method?: string;
  
  /**
   * URL to send the mutation request to
   */
  url?: string;
  
  /**
   * Axios request configuration
   */
  config?: AxiosRequestConfig<D>;
  
  /**
   * Request priority
   * @default AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH
   */
  priority?: typeof AXIOS_RETRYER_REQUEST_PRIORITIES[keyof typeof AXIOS_RETRYER_REQUEST_PRIORITIES];
  
  /**
   * Custom retry manager (if not using RetryManagerProvider)
   */
  manager?: RetryManager;
  
  /**
   * Callback when mutation succeeds
   */
  onSuccess?: (data: T, response: AxiosResponse<T, D>) => void;
  
  /**
   * Callback when mutation fails
   */
  onError?: (error: Error | AxiosError) => void;
  
  /**
   * List of cache keys to invalidate on successful mutation
   */
  invalidateQueries?: string[];
}

export interface UseAxiosRetryerMutationResult<T = any, D = any> {
  /**
   * Function to trigger the mutation
   */
  mutate: (data?: D, config?: AxiosRequestConfig<D>) => Promise<T | undefined>;
  
  /**
   * Data returned from the latest mutation
   */
  data: T | undefined;
  
  /**
   * Original AxiosResponse from the latest mutation
   */
  response: AxiosResponse<T, D> | undefined;
  
  /**
   * Error from the latest mutation
   */
  error: Error | AxiosError | undefined;
  
  /**
   * Whether a mutation is in progress
   */
  loading: boolean;
  
  /**
   * Reset the mutation state
   */
  reset: () => void;
}

// External queryCache from the query hook
// Used for invalidating queries after mutations
declare const queryCache: Record<string, any>;

/**
 * Hook for performing mutation operations (POST, PUT, DELETE, etc.)
 * 
 * @param optionsOrUrl URL string or options object
 * @param options Options if first parameter is URL
 * @returns Mutation controls and state
 * 
 * @example
 * ```tsx
 * const { mutate, loading, error } = useAxiosRetryerMutation('/api/users');
 * 
 * const handleSubmit = async (userData) => {
 *   try {
 *     const newUser = await mutate(userData);
 *     console.log('User created:', newUser);
 *   } catch (err) {
 *     console.error('Failed to create user');
 *   }
 * };
 * 
 * return (
 *   <form onSubmit={handleSubmit}>
 *     {loading && <Spinner />}
 *     {error && <ErrorMessage error={error} />}
 *     Form fields
 *     <button type="submit" disabled={loading}>Create User</button>
 *   </form>
 * );
 * ```
 */
export function useAxiosRetryerMutation<T = any, D = any>(
  optionsOrUrl: string | UseAxiosRetryerMutationOptions<T, D>,
  maybeOptions?: UseAxiosRetryerMutationOptions<T, D>
): UseAxiosRetryerMutationResult<T, D> {
  // Parse options
  const options: UseAxiosRetryerMutationOptions<T, D> = typeof optionsOrUrl === 'string'
    ? { url: optionsOrUrl, ...(maybeOptions || {}) }
    : optionsOrUrl;
  
  const {
    method = 'post',
    url,
    config = {},
    priority = AXIOS_RETRYER_REQUEST_PRIORITIES.HIGH,
    onSuccess,
    onError,
    invalidateQueries = [],
    manager: externalManager
  } = options;
  
  // Try to get manager from context if not provided externally
  let contextManager: RetryManager | undefined;
  try {
    contextManager = useRetryManager();
  } catch (e) {
    if (!externalManager) {
      throw new Error('useAxiosRetryerMutation requires a RetryManager. Either use RetryManagerProvider or pass a manager in options.');
    }
  }
  
  const manager = externalManager || contextManager;
  
  // State for mutation
  const [data, setData] = useState<T>();
  const [response, setResponse] = useState<AxiosResponse<T, D>>();
  const [error, setError] = useState<Error | AxiosError>();
  const [loading, setLoading] = useState(false);
  
  // Reset function
  const reset = useCallback(() => {
    setData(undefined);
    setResponse(undefined);
    setError(undefined);
    setLoading(false);
  }, []);
  
  // Mutation function
  const mutate = useCallback(async (
    mutationData?: D,
    mutationConfig?: AxiosRequestConfig<D>
  ): Promise<T | undefined> => {
    if (!url) {
      throw new Error('URL is required for mutation. Provide it either as the first argument or in options.');
    }
    
    const requestId = `mutation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const requestConfig: AxiosRequestConfig<D> = {
      ...config,
      ...mutationConfig,
      __priority: priority,
      __requestId: requestId
    };
    
    setLoading(true);
    setError(undefined);
    
    try {
      const axiosResponse = await manager!.axiosInstance.request<T, AxiosResponse<T, D>, D>({
        url,
        method,
        data: mutationData,
        ...requestConfig
      });
      
      // Handle successful response
      setResponse(axiosResponse);
      setData(axiosResponse.data);
      setLoading(false);
      
      // Invalidate cached queries if specified
      if (invalidateQueries.length > 0 && typeof queryCache !== 'undefined') {
        invalidateQueries.forEach(key => {
          if (queryCache[key]) {
            delete queryCache[key];
          }
        });
      }
      
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
      
      throw err;
    }
  }, [url, method, JSON.stringify(config), priority, manager, onSuccess, onError, invalidateQueries]);
  
  return {
    mutate,
    data,
    response,
    error,
    loading,
    reset
  };
} 