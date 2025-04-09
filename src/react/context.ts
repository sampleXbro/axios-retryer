import { createContext, useContext } from 'react';
import { RetryManagerOptions } from '../types';
import { createRetryer, RetryManager } from '../index';

/**
 * React context for providing RetryManager instance throughout the app
 */
export const RetryManagerContext = createContext<RetryManager | undefined>(undefined);

/**
 * Hook to access the RetryManager from context
 * 
 * @returns The RetryManager instance from context
 * @throws Error if used outside a RetryManagerProvider
 * 
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const manager = useRetryManager();
 *   
 *   const handleClick = () => {
 *     manager.axiosInstance.get('/api/data');
 *   };
 *   
 *   return <button onClick={handleClick}>Fetch Data</button>;
 * };
 * ```
 */
export function useRetryManager(): RetryManager {
  const context = useContext(RetryManagerContext);
  
  if (!context) {
    throw new Error('useRetryManager must be used within a RetryManagerProvider');
  }
  
  return context;
}

/**
 * Creates a RetryManager instance for use with React
 * 
 * @param options Options for the RetryManager
 * @returns A RetryManager instance
 * 
 * @example
 * ```tsx
 * // In your app entry point
 * const manager = createReactRetryer({
 *   retries: 3,
 *   debug: process.env.NODE_ENV !== 'production'
 * });
 * 
 * ReactDOM.render(
 *   <RetryManagerProvider manager={manager}>
 *     <App />
 *   </RetryManagerProvider>,
 *   document.getElementById('root')
 * );
 * ```
 */
export function createReactRetryer(options?: RetryManagerOptions): RetryManager {
  return createRetryer(options);
} 