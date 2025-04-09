import { useAxiosRetryerQuery, UseAxiosRetryerQueryOptions, UseAxiosRetryerQueryResult } from '../useAxiosRetryerQuery';

/**
 * Convenience hook for GET requests with caching
 * 
 * @param url URL to fetch data from
 * @param options Query options
 * @returns Query result
 * 
 * @example
 * ```tsx
 * const { data, loading, error } = useGet('/api/users');
 * ```
 */
export function useGet<T = any, D = any>(
  url: string,
  options?: UseAxiosRetryerQueryOptions<T, D>
): UseAxiosRetryerQueryResult<T, D> {
  return useAxiosRetryerQuery<T, D>(url, options);
} 