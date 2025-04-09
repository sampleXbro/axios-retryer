import React, { ReactNode } from 'react';
import { RetryManager } from '../';
import { RetryManagerContext } from './context';

export interface RetryManagerProviderProps {
  /**
   * The RetryManager instance to provide to the app
   */
  manager: RetryManager;
  
  /**
   * React children
   */
  children: ReactNode;
}

/**
 * Provider component that makes RetryManager available throughout the app
 * 
 * @param props Provider props
 * @returns Provider component
 * 
 * @example
 * ```tsx
 * const App = () => {
 *   const manager = createReactRetryer();
 *   
 *   return (
 *     <RetryManagerProvider manager={manager}>
 *       <YourApp />
 *     </RetryManagerProvider>
 *   );
 * };
 * ```
 */
export function RetryManagerProvider({ manager, children }: RetryManagerProviderProps): JSX.Element {
  return (
    <RetryManagerContext.Provider value={manager}>
      {children}
    </RetryManagerContext.Provider>
  );
} 