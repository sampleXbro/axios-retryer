import { useAxiosRetryerMutation, UseAxiosRetryerMutationOptions, UseAxiosRetryerMutationResult } from '../useAxiosRetryerMutation';

/**
 * Convenience hook for DELETE requests
 * 
 * @param url URL to send delete request to
 * @param options Mutation options
 * @returns Mutation result and control functions
 * 
 * @example
 * ```tsx
 * const { mutate, loading, error } = useDelete('/api/users/123');
 * 
 * const handleDelete = async () => {
 *   if (confirm('Are you sure?')) {
 *     await mutate();
 *     navigate('/users');
 *   }
 * };
 * ```
 */
export function useDelete<T = any, D = any>(
  url: string,
  options?: Omit<UseAxiosRetryerMutationOptions<T, D>, 'url' | 'method'>
): UseAxiosRetryerMutationResult<T, D> {
  return useAxiosRetryerMutation<T, D>({
    url,
    method: 'delete',
    ...options
  });
} 