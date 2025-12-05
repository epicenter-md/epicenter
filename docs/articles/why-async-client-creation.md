# Why We Made Client Creation Async in Epicenter

When building Epicenter, we faced a decision that impacts every app using the library: should creating a client require `await`, or should we make it synchronous and hide the async work inside?

Most database libraries go with the lazy approach:

```typescript
// Drizzle, Prisma, MongoDB - all synchronous
const db = drizzle(connectionUrl);
const prisma = new PrismaClient();
const mongo = new MongoClient(url);

// Connection happens here (first query)
const users = await db.select().from(usersTable);
```

We went the other way:

```typescript
// Epicenter - async creation
const client = await createWorkspaceClient(workspace);

// Already connected
const users = await client.getUsers();
```

Here's why we made that choice, and how to work with it.

## The Two Patterns

There are two ways to handle expensive initialization:

**Pattern 1: Lazy Connection (what most ORMs do)**

```typescript
// Fast - just stores config
const db = drizzle(url);

// Slow - connects to database, loads WASM, initializes IndexedDB
const users = await db.select().from(usersTable);

// Fast - already connected
const posts = await db.select().from(postsTable);
```

**Pattern 2: Eager Connection (what we do)**

```typescript
// Slow - connects database, creates indexes, loads everything
const client = await createWorkspaceClient(workspace);

// Fast - everything's ready
const users = await client.getUsers();
const posts = await client.getPosts();
```

### What Makes Connection Expensive?

The `await` during initialization isn't arbitrary overhead—it's genuinely expensive work. When connecting to a SQLite database in the browser, the system needs to:

1. **Load the SQLite WASM module** (~1MB of WebAssembly code)
2. **Initialize IndexedDB** for persistence across page reloads
3. **Set up OPFS** (Origin Private File System) for efficient file access
4. **Create the database file structure** and initialize tables

This can take 100-500ms on a fast machine, longer on mobile. You can defer it to the first query, but you can't eliminate it. The question is: when do you pay the cost?

## Why We Chose Eager Connection

The core reason: wiring up lazy initialization everywhere is genuinely difficult.

If we made client creation synchronous but kept indexes async, every action would need to check if the index is ready:

```typescript
// What we'd have to do with lazy initialization
actions: ({ indexes }) => ({
  getUsers: async () => {
    // Wait for the index to be ready
    const sqlite = await indexes.sqlite;
    return sqlite.db.select().from(users);
  },

  getPosts: async () => {
    // Wait again (might be cached, but still awkward)
    const sqlite = await indexes.sqlite;
    return sqlite.db.select().from(posts);
  }
})
```

This gets messy fast. Every single action that touches an index needs this boilerplate. Miss one, and you get runtime errors.

More importantly, we want actions to be straightforward and easily editable by developers. Having to remember `await indexes.sqlite` in every action creates cognitive overhead and makes the codebase harder to maintain—especially when multiple people are contributing. Actions should read like business logic, not infrastructure management.

With eager initialization, indexes are already ready:

```typescript
actions: ({ indexes }) => ({
  getUsers: async () => {
    // indexes.sqlite is ready
    return indexes.sqlite.db.select().from(users);
  },

  getPosts: async () => {
    // No await needed
    return indexes.sqlite.db.select().from(posts);
  }
})
```

## The Local-First Argument

The architecture and constraints of local-first apps are often different from traditional web apps. (see how local-first apps are more like installing applications on your computer—they need to load and initialize the full application environment before you can interact with them)

To guarantee the local-first experience, these apps typically preload their entire JavaScript runtime upfront. This includes:

1. Connecting to a local database (SQLite WASM in the browser)
2. Loading indexes from IndexedDB
3. Initializing Y.js for real-time collaboration
4. Setting up observers for data synchronization

This is expensive work. You can't hide it.

In a traditional app, you might want lazy initialization so the page loads instantly. But local-first apps already have a longer startup time. Users expect it. The app is loading their local data and full application environment, not just rendering a page.

Given that, we'd rather do all the initialization upfront. The first user action should be fast, not blocked by "oh wait, we still need to connect the database."

## The Simplest Pattern: Just Await It

Here's a way way to use an async client: create the promise at module level and await it when you need it.

Since the client is only going to be accessed in the scope of async handlers (like button clicks) rather than the top level, we can keep the initialization in the top level synchronous, and hand off the promise to other handler scopes that are executed later:

```typescript
// workspace.ts - create promise at module level
import { createWorkspaceClient } from '@epicenter/hq';
import { workspace } from './workspace-config';

// Promise starts immediately, shared across your app
export const clientPromise = createWorkspaceClient(workspace);
```

```tsx
// CreatePostButton.tsx - await in your handlers
import { clientPromise } from './workspace';

function CreatePostButton() {
  return (
    <button onClick={async () => {
      // Wait for client (only slow on first click)
      const client = await clientPromise;

      // Use it
      await client.createPost({ title: 'Hello World' });
    }}>
      Create Post
    </button>
  );
}
```
Funnily enough, this is exactly the pattern we talked about earlier with `const sqlite = await indexes.sqlite;`. In the same way we can pass the promise `indexes.sqlite` and await it in action handlers lazily when they're executed, we can pass the promise of `clientPromise` to await it in button handlers lazily when they're executed

This works because:
- The promise is created once when your module loads
- Subsequent clicks are instant—the promise is already resolved

**Important caveat:** This pattern is safe in local-first apps because they're typically fully statically rendered (no server-side rendering). Exporting module-level promises is generally safer in this context compared to traditional SSR applications where you need to be more careful about shared state across requests.

## How to Use Async Clients in Your App

### In SvelteKit

Put the client creation in your load function:

```typescript
// src/routes/+page.ts
import { createWorkspaceClient } from '@epicenter/hq';
import { workspace } from './workspace';

export const load = async () => {
  const client = await createWorkspaceClient(workspace);

  return {
    client
  };
};
```

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  let { data } = $props();
  const { client } = data;
</script>

<button onclick={() => client.createPost({ title: 'Hello' })}>
  Create Post
</button>
```

### In React with TanStack Query

Use a query to initialize the client once:

```typescript
// hooks/useWorkspaceClient.ts
import { useQuery } from '@tanstack/react-query';
import { createWorkspaceClient } from '@epicenter/hq';
import { workspace } from './workspace';

export function useWorkspaceClient() {
  return useQuery({
    queryKey: ['workspace-client'],
    queryFn: () => createWorkspaceClient(workspace),
    staleTime: Infinity, // Client doesn't go stale
  });
}
```

```tsx
// App.tsx
function App() {
  const { data: client, isLoading } = useWorkspaceClient();

  if (isLoading) return <div>Loading workspace...</div>;

  return (
    <button onClick={() => client.createPost({ title: 'Hello' })}>
      Create Post
    </button>
  );
}
```

### In Plain React

Create the client at the module level and wrap it:

```typescript
// lib/workspace.ts
import { createWorkspaceClient } from '@epicenter/hq';
import { workspace } from './workspace';

// Create promise at module load
const clientPromise = createWorkspaceClient(workspace);

export function useWorkspace() {
  const [client, setClient] = useState(null);

  useEffect(() => {
    clientPromise.then(setClient);
  }, []);

  return client;
}
```

## The Trade-off

Lazy initialization: fast client creation, slow first query

Eager initialization: slow client creation, fast queries

For local-first apps that need to initialize databases, indexes, and sync engines anyway, eager wins. You can't avoid the cost. You can only choose when to pay it.

We'd rather pay upfront and have every user action be fast, rather than make them wait on their first click.
