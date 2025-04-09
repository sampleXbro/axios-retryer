# React Integration for axios-retryer

This package provides React hooks and components for using axios-retryer in React applications. It includes hooks for data fetching, mutations, and a context provider for global retry configuration.

## Installation

```bash
npm install axios-retryer
```

## Setup

Wrap your application with the `RetryManagerProvider`:

```tsx
import { createReactRetryer, RetryManagerProvider } from 'axios-retryer/react';
import { RETRY_MODES } from 'axios-retryer';

const App = () => {
  // Create a RetryManager for React
  const manager = createReactRetryer({
    mode: RETRY_MODES.AUTOMATIC,
    retries: 3,
    debug: process.env.NODE_ENV !== 'production'
  });
  
  return (
    <RetryManagerProvider manager={manager}>
      <YourApp />
    </RetryManagerProvider>
  );
};
```

## ⚡ Tree-Shakeable Imports

For optimal bundle size, you can import individual hooks directly from their subpaths:

```tsx
// Instead of this (imports everything):
import { useGet } from 'axios-retryer/react';

// Use this for smaller bundles:
import { useGet } from 'axios-retryer/react/hooks/useGet';
```

Available subpaths:

```tsx
// Base hooks:
import { useAxiosRetryer } from 'axios-retryer/react/hooks/useAxiosRetryer';
import { useAxiosRetryerQuery } from 'axios-retryer/react/hooks/useAxiosRetryerQuery';
import { useAxiosRetryerMutation } from 'axios-retryer/react/hooks/useAxiosRetryerMutation';

// Convenience hooks:
import { useGet } from 'axios-retryer/react/hooks/useGet';
import { usePost } from 'axios-retryer/react/hooks/usePost';
import { usePut } from 'axios-retryer/react/hooks/usePut';
import { useDelete } from 'axios-retryer/react/hooks/useDelete';
```

This ensures that only the code you actually use gets included in your final bundle.

## Basic Usage

### Data Fetching with `useAxiosRetryerQuery`

```tsx
import { useAxiosRetryerQuery } from 'axios-retryer/react';

const UsersComponent = () => {
  const { 
    data, 
    loading, 
    error, 
    refetch, 
    isStale 
  } = useAxiosRetryerQuery('/api/users', {
    cacheDuration: 5 * 60 * 1000, // Cache for 5 minutes
    refetchInterval: 30 * 1000,   // Refresh every 30 seconds
    refetchOnWindowFocus: true    // Refresh when tab becomes active
  });
  
  if (loading && !data) return <div>Loading...</div>;
  
  return (
    <div>
      {isStale && <div className="banner">Refreshing data...</div>}
      
      <h1>Users</h1>
      {error && <div className="error">Error: {error.message}</div>}
      
      <button onClick={() => refetch()}>Refresh</button>
      
      <ul>
        {data?.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
};
```

### Making Mutations with `useAxiosRetryerMutation`

```tsx
import { useAxiosRetryerMutation } from 'axios-retryer/react';

const CreateUserForm = () => {
  const [formData, setFormData] = useState({ name: '', email: '' });
  
  const { 
    mutate, 
    loading, 
    error, 
    data: newUser 
  } = useAxiosRetryerMutation('/api/users', {
    // Invalidate these cache keys after successful mutation
    invalidateQueries: ['/api/users', '/api/dashboard/stats']
  });
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await mutate(formData);
      setFormData({ name: '', email: '' });
    } catch (err) {
      // Error handling is already done by the hook
    }
  };
  
  return (
    <form onSubmit={handleSubmit}>
      <h2>Create User</h2>
      
      {error && <div className="error">Error: {error.message}</div>}
      {newUser && <div className="success">User created successfully!</div>}
      
      <div>
        <label>
          Name:
          <input
            value={formData.name}
            onChange={(e) => setFormData({...formData, name: e.target.value})}
          />
        </label>
      </div>
      
      <div>
        <label>
          Email:
          <input
            value={formData.email}
            onChange={(e) => setFormData({...formData, email: e.target.value})}
          />
        </label>
      </div>
      
      <button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Create User'}
      </button>
    </form>
  );
};
```

#### Cache Invalidation

The `useAxiosRetryerMutation` hook seamlessly integrates with CachingPlugin to invalidate cached data after mutations:

```tsx
// Invalidate specific cache keys
const { mutate } = useAxiosRetryerMutation('/api/posts', {
  invalidateQueries: ['/api/posts', '/api/user/1/posts']
});
```

The cache invalidation system works as follows:

1. After a successful mutation, the hook checks if any cache keys need to be invalidated
2. If the CachingPlugin is registered with the RetryManager, it uses it to invalidate the specified keys
3. For a single key, it calls `invalidateCache(key)` on the plugin
4. For multiple keys (≤ 5), it invalidates each key individually
5. For many keys (> 5), it clears the entire cache for efficiency using `clearCache()`

This intelligent approach balances performance with precision.

### Plugin Integration Notes

Both `useAxiosRetryerQuery` and `useAxiosRetryerMutation` hooks automatically integrate with the CachingPlugin:

- If CachingPlugin is not registered with RetryManager, the hooks will register it
- The query hook configures the plugin with the specified `cacheDuration` and `cachingOptions`
- The mutation hook uses the plugin to invalidate specified cache keys after successful mutations
- For optimal performance, avoid duplicate plugin registration by using a shared RetryManager with `RetryManagerProvider`

This integration happens behind the scenes, so you don't need to manually register the CachingPlugin when using these hooks.

## Convenience Hooks

The library includes shorthand hooks for common HTTP methods:

```tsx
import { useGet, usePost, usePut, useDelete } from 'axios-retryer/react';

// GET request with caching
const { data: users } = useGet('/api/users');

// POST request
const { mutate: createUser } = usePost('/api/users');

// PUT request
const { mutate: updateUser } = usePut('/api/users/123');

// DELETE request
const { mutate: deleteUser } = useDelete('/api/users/123');
```

## Advanced Usage

### Using RetryManager Directly

```tsx
import { useRetryManager } from 'axios-retryer/react';

const AdvancedComponent = () => {
  const manager = useRetryManager();
  
  const checkPendingRequests = () => {
    const metrics = manager.getMetrics();
    console.log(`Pending requests: ${metrics.pendingRequests}`);
  };
  
  const cancelAllRequests = () => {
    manager.cancelAllRequests();
  };
  
  return (
    <div>
      <button onClick={checkPendingRequests}>Check Pending</button>
      <button onClick={cancelAllRequests}>Cancel All</button>
    </div>
  );
};
```

### Custom Retry Manager Per Component

```tsx
import { useAxiosRetryerQuery, createRetryer } from 'axios-retryer/react';
import { RETRY_MODES } from 'axios-retryer';

const CustomComponent = () => {
  // Create a custom manager with different settings for this component
  const customManager = createRetryer({
    mode: RETRY_MODES.MANUAL,
    retries: 0 // No automatic retries
  });
  
  const { data, loading, error } = useAxiosRetryerQuery('/api/data', {
    manager: customManager
  });
  
  return (
    <div>
      {/* Component UI */}
    </div>
  );
};
```

## TypeScript Support

The library includes full TypeScript support, allowing you to type your API responses:

```tsx
interface User {
  id: number;
  name: string;
  email: string;
}

const { data } = useGet<User[]>('/api/users');
// data is typed as User[] | undefined

const { mutate } = usePost<User, { name: string; email: string }>('/api/users');
// mutate accepts the second generic type argument
// mutate argument is typed as { name: string; email: string }
// mutate return value is typed as Promise<User | undefined>
```

## Next.js Support

When using with Next.js, you can create a custom hook for SSR safety:

```tsx
// hooks/useSSRSafeQuery.ts
import { useAxiosRetryerQuery } from 'axios-retryer/react';
import { useState, useEffect } from 'react';

export function useSSRSafeQuery(url, options) {
  // Prevent hydration mismatches by only running in browser
  const [isBrowser, setIsBrowser] = useState(false);
  
  useEffect(() => {
    setIsBrowser(true);
  }, []);
  
  if (!isBrowser) {
    // Return placeholder during SSR
    return { 
      data: options?.initialData,
      loading: true,
      error: undefined,
      refetch: () => Promise.resolve(undefined),
      isStale: false
    };
  }
  
  // In browser, use the actual hook
  return useAxiosRetryerQuery(url, options);
}
``` 