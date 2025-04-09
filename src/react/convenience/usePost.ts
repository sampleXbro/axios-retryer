import { useAxiosRetryerMutation, UseAxiosRetryerMutationOptions, UseAxiosRetryerMutationResult } from '../useAxiosRetryerMutation';

/**
 * Convenience hook for POST requests
 * 
 * @param url URL to post data to
 * @param options Mutation options
 * @returns Mutation result and control functions
 * 
 * @example
 * ```tsx
 * const { mutate, loading, error } = usePost('/api/users');
 * 
 * const handleSubmit = async (formData) => {
 *   await mutate(formData);
 * };
 * ```
 */
export function usePost<T = any, D = any>(
  url: string,
  options?: Omit<UseAxiosRetryerMutationOptions<T, D>, 'url' | 'method'>
): UseAxiosRetryerMutationResult<T, D> {
  return useAxiosRetryerMutation<T, D>({
    url,
    method: 'post',
    ...options
  });
} 