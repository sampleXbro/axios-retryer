import { useAxiosRetryerMutation, UseAxiosRetryerMutationOptions, UseAxiosRetryerMutationResult } from '../useAxiosRetryerMutation';

/**
 * Convenience hook for PUT requests
 * 
 * @param url URL to put data to
 * @param options Mutation options
 * @returns Mutation result and control functions
 * 
 * @example
 * ```tsx
 * const { mutate, loading, error } = usePut('/api/users/123');
 * 
 * const handleUpdate = async (userData) => {
 *   await mutate(userData);
 * };
 * ```
 */
export function usePut<T = any, D = any>(
  url: string,
  options?: Omit<UseAxiosRetryerMutationOptions<T, D>, 'url' | 'method'>
): UseAxiosRetryerMutationResult<T, D> {
  return useAxiosRetryerMutation<T, D>({
    url,
    method: 'put',
    ...options
  });
} 