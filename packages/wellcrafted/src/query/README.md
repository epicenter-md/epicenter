# Query Utilities

A set of utilities for integrating wellcrafted's Result types with TanStack Query, providing a clean pattern for organizing your data fetching layer.

## Overview

The query utilities solve a common integration challenge: your service functions return `Result<T, E>` types, but TanStack Query expects functions that either return data or throw errors. These utilities bridge that gap while providing two convenient interfaces for each query and mutation.

## Quick Start

```typescript
import { QueryClient } from '@tanstack/query-core';
import { createQueryFactories } from 'wellcrafted/query';

// Create your query client
const queryClient = new QueryClient();

// Create factory functions
const { defineQuery, defineMutation } = createQueryFactories(queryClient);
```

## Architecture Pattern: The RPC-like Approach

The query utilities enable a powerful architectural pattern inspired by RPC (Remote Procedure Call), where your query layer acts as a bridge between UI components and pure service functions. This pattern is used successfully in production apps like [Whispering](https://github.com/braden-w/whispering).

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │ Query/RPC   │ --> │   Services   │
│ Components  │     │    Layer    │     │    (Pure)    │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

### Layer Responsibilities

1. **Services Layer**: Pure functions with no UI dependencies
   - Business logic only
   - Return `Result<T, E>` types
   - Platform-agnostic
   - Easily testable

2. **Query Layer**: Adds reactivity and caching
   - Wraps service calls with TanStack Query
   - Handles runtime dependency injection
   - Transforms errors for UI consumption
   - Manages cache updates

3. **UI Layer**: Consumes queries reactively or imperatively
   - Uses the dual interface pattern
   - Handles loading states
   - Displays errors

## Recommended Folder Structure

Here's how to organize your code for maximum clarity:

```
src/
├── services/           # Pure business logic
│   ├── api/           # External API calls
│   │   ├── users.ts
│   │   └── products.ts
│   ├── db/            # Database operations
│   │   └── index.ts
│   └── platform/      # Platform-specific code
│       ├── web.ts
│       └── desktop.ts
│
├── query/             # Query layer with caching
│   ├── _factories.ts  # createQueryFactories setup
│   ├── users.ts       # User-related queries
│   ├── products.ts    # Product-related queries
│   └── index.ts       # RPC namespace export
│
└── components/        # UI components
    └── UserList.svelte
```

## Real-World Example: Building an RPC Namespace

This example shows how to build a complete data fetching layer:

### Step 1: Create Your Services

```typescript
// services/api/users.ts
import { Ok, Err, type Result } from 'wellcrafted/result';

export type User = {
  id: string;
  name: string;
  email: string;
};

export type UserServiceError = {
  code: 'NOT_FOUND' | 'NETWORK_ERROR' | 'UNAUTHORIZED';
  message: string;
};

export async function getUser(id: string): Promise<Result<User, UserServiceError>> {
  try {
    const response = await fetch(`/api/users/${id}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return Err({ code: 'NOT_FOUND', message: 'User not found' });
      }
      return Err({ code: 'NETWORK_ERROR', message: 'Failed to fetch user' });
    }
    
    return Ok(await response.json());
  } catch (error) {
    return Err({ code: 'NETWORK_ERROR', message: error.message });
  }
}

export async function updateUser(user: User): Promise<Result<User, UserServiceError>> {
  // Implementation...
}
```

### Step 2: Create Query Definitions

```typescript
// query/_factories.ts
import { QueryClient } from '@tanstack/query-core';
import { createQueryFactories } from 'wellcrafted/query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      cacheTime: 10 * 60 * 1000, // 10 minutes
    },
  },
});

export const { defineQuery, defineMutation } = createQueryFactories(queryClient);
```

```typescript
// query/users.ts
import { defineQuery, defineMutation, queryClient } from './_factories';
import * as userService from '../services/api/users';

export const users = {
  // Query with parameters
  getUser: (userId: string) => 
    defineQuery({
      queryKey: ['users', userId],
      resultQueryFn: () => userService.getUser(userId),
    }),

  // Query all users
  getAllUsers: defineQuery({
    queryKey: ['users'],
    resultQueryFn: () => userService.getAllUsers(),
  }),

  // Mutation with optimistic updates
  updateUser: defineMutation({
    mutationKey: ['users', 'update'],
    resultMutationFn: async (user: User) => {
      const result = await userService.updateUser(user);
      
      if (result.error) return result;

      // Optimistic cache update
      queryClient.setQueryData(['users', user.id], user);
      queryClient.invalidateQueries({ queryKey: ['users'] });

      return result;
    },
    onError: (error) => {
      // Error is already in the right format for UI
      console.error('Failed to update user:', error);
    },
  }),
};
```

### Step 3: Create the RPC Namespace

```typescript
// query/index.ts
export { queryClient } from './_factories';

import { users } from './users';
import { products } from './products';
import { settings } from './settings';

// This creates your RPC-like interface
export const rpc = {
  users,
  products,
  settings,
} as const;
```

### Step 4: Use in Components

```svelte
<!-- components/UserProfile.svelte -->
<script lang="ts">
  import { createQuery, createMutation } from '@tanstack/svelte-query';
  import { rpc } from '$lib/query';

  export let userId: string;

  // Reactive query - automatically updates UI
  const userQuery = createQuery(rpc.users.getUser(userId).options());
  
  // Reactive mutation - provides loading states
  const updateMutation = createMutation(rpc.users.updateUser.options());

  // Or use imperatively in event handlers
  async function handleQuickUpdate(updates: Partial<User>) {
    const { data, error } = await rpc.users.updateUser.execute({
      ...userQuery.data,
      ...updates
    });

    if (error) {
      toast.error(error.message);
    }
  }
</script>

{#if userQuery.isPending}
  <div>Loading user...</div>
{:else if userQuery.error}
  <div>Error: {userQuery.error.message}</div>
{:else if userQuery.data}
  <UserForm 
    user={userQuery.data}
    onSave={(user) => updateMutation.mutate(user)}
    isSaving={updateMutation.isPending}
  />
{/if}
```

## The Dual Interface Pattern

Every query and mutation provides two ways to use it:

### 1. Reactive Interface (`.options()`)

Best for UI components that need to track state:

```typescript
// Creates a reactive subscription
const query = createQuery(rpc.users.getUser(userId).options());
// Access: query.data, query.isPending, query.error
```

### 2. Imperative Interface (`.execute()` / `.fetch()`)

Best for event handlers and workflows:

```typescript
// Direct execution without subscriptions
const { data, error } = await rpc.users.updateUser.execute(user);
// No reactive overhead, just the result
```

## Advanced Patterns

### Runtime Dependency Injection

The query layer can handle dynamic service selection based on runtime conditions:

```typescript
// query/transcription.ts
import { settings } from '../stores/settings';

export const transcription = {
  transcribe: defineMutation({
    resultMutationFn: async (audio: Blob) => {
      // Select service based on user settings
      const provider = settings.value.transcriptionProvider;
      
      switch (provider) {
        case 'openai':
          return services.openai.transcribe(audio, {
            apiKey: settings.value.openaiKey,
            model: settings.value.openaiModel,
          });
        case 'whisper':
          return services.whisper.transcribe(audio);
        default:
          return Err({ code: 'INVALID_PROVIDER', message: `Unknown provider: ${provider}` });
      }
    },
  }),
};
```

### Error Transformation

Transform service errors into UI-friendly formats:

```typescript
// query/users.ts
export const users = {
  createUser: defineMutation({
    resultMutationFn: async (userData: CreateUserInput) => {
      const result = await userService.createUser(userData);
      
      if (result.error) {
        // Transform service error to UI error
        return Err({
          title: 'Failed to create user',
          description: getErrorMessage(result.error.code),
          action: { type: 'retry', data: userData },
        });
      }
      
      return result;
    },
  }),
};

function getErrorMessage(code: string): string {
  switch (code) {
    case 'DUPLICATE_EMAIL':
      return 'A user with this email already exists';
    case 'INVALID_DATA':
      return 'Please check your input and try again';
    default:
      return 'An unexpected error occurred';
  }
}
```

### Coordinating Multiple Services

The query layer can orchestrate complex operations:

```typescript
// query/orders.ts
export const orders = {
  placeOrder: defineMutation({
    resultMutationFn: async (orderData: OrderInput) => {
      // Step 1: Validate inventory
      const inventory = await rpc.inventory.checkAvailability.fetch();
      if (!hasStock(orderData.items, inventory.data)) {
        return Err({ code: 'OUT_OF_STOCK', message: 'Some items are out of stock' });
      }

      // Step 2: Process payment
      const payment = await services.payment.charge(orderData.payment);
      if (payment.error) return Err(payment.error);

      // Step 3: Create order
      const order = await services.orders.create({
        ...orderData,
        paymentId: payment.data.id,
      });

      // Step 4: Update caches
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });

      return order;
    },
  }),
};
```

## Testing

The factory pattern makes testing straightforward:

```typescript
// tests/users.test.ts
import { QueryClient } from '@tanstack/query-core';
import { createQueryFactories } from 'wellcrafted/query';
import { vi } from 'vitest';

describe('User Queries', () => {
  let queryClient: QueryClient;
  let defineQuery: ReturnType<typeof createQueryFactories>['defineQuery'];

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    ({ defineQuery } = createQueryFactories(queryClient));
  });

  it('should fetch user data', async () => {
    const mockUser = { id: '1', name: 'Test User', email: 'test@example.com' };
    vi.mocked(userService.getUser).mockResolvedValue(Ok(mockUser));

    const userQuery = defineQuery({
      queryKey: ['users', '1'],
      resultQueryFn: () => userService.getUser('1'),
    });

    const result = await userQuery.fetch();
    expect(result.data).toEqual(mockUser);
  });
});
```

## Best Practices

1. **Keep Services Pure**: Services should only contain business logic, no UI concerns
2. **Use Result Types**: Always return `Result<T, E>` from services for consistent error handling
3. **Transform Errors in Query Layer**: Convert service errors to UI-friendly formats
4. **Leverage Both Interfaces**: Use reactive for UI state, imperative for workflows
5. **Organize by Feature**: Group related queries together (users, products, etc.)
6. **Cache Thoughtfully**: Update related caches after mutations

## Migration Guide

If you're migrating from a traditional setup:

```typescript
// Before: Direct API calls in components
async function loadUser() {
  try {
    const response = await fetch(`/api/users/${userId}`);
    user = await response.json();
  } catch (error) {
    errorMessage = error.message;
  }
}

// After: Using the query pattern
const userQuery = createQuery(rpc.users.getUser(userId).options());
// Automatically handles loading, error, caching, and refetching
```

## Additional Resources

- [Whispering App](https://github.com/braden-w/whispering) - A real-world example using this pattern
- [TanStack Query Docs](https://tanstack.com/query) - Learn more about the underlying query library
- [Result Type Pattern](/result/README.md) - Understanding Result types for error handling