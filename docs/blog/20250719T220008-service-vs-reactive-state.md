# Service Pattern vs Reactive State: Two Approaches to LocalStorage in Svelte

I was building workspace management for epicenter.sh and hit an interesting architectural decision. Do I wrap localStorage in a service with Result types, or just use reactive state?

With a service that has Result types, it's just extra work. Because localStorage is working on a local machine, there are no clients or server boundary - it's completely synchronous. And so it actually makes sense to wrap it with my utility function, `createPersistedState`. This is just a two-way binding where you basically access it as if it's a Svelte.js reactive variable, and it syncs. It stays synchronized because of the `createSubscriber` I use under the hood, which syncs it with any localStorage event changes.

That way is incredibly declarative. The way that I access it is just like you read it by accessing the variable, and you update it by just setting the variable. As opposed to the service implementation, which is more heavyweight. And generally, I have to accompany this by wrapping it with TanStack Query because it won't update in real time. And so you have to opt into a stale-while-revalidate cache pattern.

Let me show you what I mean.

## Approach 1: The Service Pattern

First instinct was to build it "properly" - services, Result types, the works:

```typescript
// workspace-service.ts
export function createWorkspaceService() {
  return {
    getAll(): Result<Workspace[], WorkspaceServiceError> {
      return trySync({
        try: () => {
          const stored = localStorage.getItem(WORKSPACES_KEY);
          return stored ? JSON.parse(stored) : [];
        },
        catch: (error) => WorkspaceServiceError({
          message: 'Failed to retrieve workspaces',
          cause: error
        })
      });
    },
    
    create(data: WorkspaceData): Result<Workspace, WorkspaceServiceError> {
      const { data: workspaces, error } = this.getAll();
      if (error) return Err(error);
      
      // Build workspace, add to array, save to localStorage
      // Wrap everything in trySync for error handling
      // Return Result type
    },
    
    // update, delete, etc - all following the same pattern
  };
}
```

Notice how every operation:
- Returns a Result type
- Needs error handling at every step
- Has to manually read/write localStorage
- Doesn't update the UI automatically

Using it requires unwrapping Results everywhere:

```typescript
const { data: workspaces, error } = WorkspaceServiceLive.getAll();
if (error) {
  // Handle error
}

const result = WorkspaceServiceLive.create(newWorkspace);
if (result.error) {
  // Handle error
}
```

And then you need TanStack Query to make it reactive:

```typescript
const workspacesQuery = createQuery({
  queryKey: ['workspaces'],
  queryFn: async () => {
    const result = WorkspaceServiceLive.getAll();
    if (result.error) throw result.error;
    return result.data;
  }
});
```

That's a lot of ceremony for localStorage.

## Approach 2: Reactive State with createPersistedState

Here's the same thing with `createPersistedState`:

```typescript
// workspaces.svelte.ts
import { createPersistedState } from '@epicenter/svelte-utils';
import { z } from 'zod';

const workspacesSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  port: z.number(),
  username: z.string(),
  password: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
}));

// This is it. Reactive state synced with localStorage.
export const workspaces = createPersistedState({
  key: 'opencode-workspaces',
  schema: workspacesSchema,
  onParseError: (error) => {
    return []; // Just return empty array on any error
  }
});

// Helper functions - just mutate the array
export function createWorkspace(data) {
  workspaces.value = [...workspaces.value, {
    ...data,
    id: nanoid(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  }];
}

export function deleteWorkspace(id: string) {
  workspaces.value = workspaces.value.filter(w => w.id !== id);
}
```

That's it. No Result types. No error handling dance. Just a reactive variable that happens to persist to localStorage.

Using it is just like using a regular Svelte state:

```svelte
<script lang="ts">
  import { workspaces, createWorkspace } from './workspaces.svelte';
  
  // Just read the value
  console.log(workspaces.value);
  
  // Just set the value
  createWorkspace({ name: 'Production', url: 'https://...' });
</script>

<!-- UI updates automatically -->
{#each workspaces.value as workspace}
  <div>{workspace.name}</div>
{/each}
```

No queries. No subscriptions. It's just there. And if you open another tab, they stay in sync automatically because of the storage events.

## The Key Insight

I was treating localStorage like a remote database. But it's not. It's synchronous. It's on the same machine. There's no network boundary.

When you use a service pattern with Result types, you're adding all this complexity for what? localStorage can fail in exactly two ways:
1. It's full (quota exceeded)
2. It's disabled (private browsing)

That's it. And `createPersistedState` handles both by just returning your default value.

## The Real Power

The magic isn't just the simplicity. It's that `createPersistedState` uses Svelte's reactivity system. When you set `workspaces.value`, three things happen:
1. The UI updates (it's reactive)
2. localStorage gets updated (it's persisted)
3. Other tabs get notified (storage events)

All automatically. No manual subscriptions. No cache invalidation. No stale-while-revalidate.

## When Services Still Make Sense

You still need services for actual async operations:

```typescript
// This needs error handling because networks are unreliable
async function validateConnection(workspace): Promise<Result<void, Error>> {
  const response = await fetch(workspace.url);
  // ...
}
```

But for localStorage? Just use the platform. It's already synchronous. It's already reliable. Stop fighting it.

The lesson: Not every data access needs to be wrapped in a service. Sometimes, the simplest solution is the right one.