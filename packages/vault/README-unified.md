# Unified Workspace Architecture

Everything is a workspace. The epicenter is just a workspace that aggregates other workspaces.

## Core Concept

```typescript
// Before: Two concepts (workspaces and epicenter)
const workspace = defineWorkspace({...});
const epicenter = createEpicenter({ workspaces: [...], path: '...', databaseUrl: '...' });

// After: One concept (just workspaces)
const epicenter = defineWorkspace({
  id: 'epicenter',
  dependencies: [usersWorkspace, postsWorkspace],
  tables: {},
  actions: (api) => ({})
});
```

## How It Works

### 1. Define Workspaces

Each workspace defines its tables and actions:

```typescript
import { defineWorkspace, defineQuery, defineMutation } from '@epicenter/epicenter';
import { z } from 'zod';

const usersWorkspace = defineWorkspace({
  id: 'users',

  tables: {
    users: {
      id: id(),
      name: text(),
      email: text(),
    }
  },

  actions: (api) => ({
    createUser: defineMutation({
      input: z.object({
        name: z.string().min(1),
        email: z.string().email()
      }),
      description: 'Create a new user with name and email',
      handler: async ({ name, email }) => {
        // api.users.users already has all table helpers injected!
        const { data, error } = await api.users.users.create({
          id: generateId(),
          name,
          email,
        });
        return data;
      }
    })
  })
});
```

### 2. Compose Workspaces

The "epicenter" is just a workspace that lists others as dependencies:

```typescript
const epicenter = defineWorkspace({
  id: 'epicenter',
  dependencies: [usersWorkspace, postsWorkspace, commentsWorkspace],
  tables: {}, // No tables of its own
  actions: (api) => ({
    // Optional: Add app-level orchestration actions
    // Or just return empty object
  })
});

// epicenter.config.ts
export default epicenter;
```

### 3. Runtime Injection

The Epicenter CLI provides the database and storage:

```typescript
// The CLI does this internally:
const app = await runWorkspace(epicenter, {
  databaseUrl: './data/app.db',
  storagePath: './data'
});

// Now you have the full app with all workspaces initialized
```

## API Shape

The namespace pattern is: `app.workspaceId.tableName.action()`

```typescript
// Table helpers (auto-injected)
app.users.users.getById(id)       // Result<User | null, Error>
app.users.users.create(data)      // Result<User, Error>
app.posts.posts.update(id, data)  // Result<Post | null, Error>
app.posts.comments.delete(id)     // Result<boolean, Error>

// Workspace actions
app.users.createUser(name, email)
app.posts.createPost(authorId, title)

// Drizzle query builder
app.posts.posts
  .select()
  .where(eq(app.posts.posts.authorId, userId))
  .all()
```

## Key Benefits

### 1. **Single Concept**
No distinction between "epicenter" and "workspace". Everything is a workspace.

### 2. **Automatic Table Helpers**
Every table automatically gets:
- `getById()`, `findById()`, `get()`
- `create()`, `update()`, `delete()`, `upsert()`
- `getAll()`, `count()`
- `select()` (Drizzle query builder)

### 3. **Clean Dependencies**
Workspaces declare dependencies and access them through the api parameter:

```typescript
const postsWorkspace = defineWorkspace({
  dependencies: [usersWorkspace],

  actions: (api) => ({
    createPost: defineMutation({
      input: z.object({
        authorId: z.string(),
        title: z.string().min(1)
      }),
      description: 'Create a new post for a user',
      handler: async ({ authorId, title }) => {
        // Access dependency's tables
        const { data: author } = await api.users.users.getById(authorId);
        if (!author) return null;

        // Access own tables
        return api.posts.posts.create({
          id: generateId(),
          title,
          authorId
        });
      }
    })
  })
});
```

### 4. **No Initialization Dance**
No more initialization waiting. The runtime handles everything.

### 5. **True Modularity**
Any workspace can be the root. You could have multiple "epicenters" for different parts of your app.

## Migration from Old Architecture

### Before
```typescript
import { createEpicenter } from '@epicenter/core';

const epicenter = createEpicenter({
  path: './data',
  databaseUrl: './data.db',
  workspaces: [usersWorkspace, postsWorkspace]
});

await app.ready;
```

### After
```typescript
import { defineWorkspace } from '@epicenter/core';
import { runWorkspace } from '@epicenter/runtime';

const epicenter = defineWorkspace({
  id: 'epicenter',
  dependencies: [usersWorkspace, postsWorkspace],
  tables: {},
  actions: () => ({})
});

// Runtime injection (handled by CLI)
const app = await runWorkspace(epicenter, {
  databaseUrl: './data.db',
  storagePath: './data'
});
```

## Complete Example

```typescript
// workspaces/users.ts
export const usersWorkspace = defineWorkspace({
  id: 'users',
  tables: {
    users: {
      id: id(),
      name: text(),
      email: text(),
    }
  },
  actions: (api) => ({
    createUser: defineMutation({
      input: z.object({
        name: z.string().min(1),
        email: z.string().email()
      }),
      description: 'Create a new user',
      handler: async ({ name, email }) => {
        const { data } = await api.users.users.create({
          id: generateId(),
          name,
          email,
        });
        return data;
      }
    })
  })
});

// workspaces/posts.ts
export const postsWorkspace = defineWorkspace({
  id: 'posts',
  dependencies: [usersWorkspace],
  tables: {
    posts: {
      id: id(),
      title: text(),
      authorId: text(),
    }
  },
  actions: (api) => ({
    createPost: defineMutation({
      input: z.object({
        authorId: z.string(),
        title: z.string().min(1)
      }),
      description: 'Create a new post for a user',
      handler: async ({ authorId, title }) => {
        const { data: author } = await api.users.users.getById(authorId);
        if (!author) return null;

        const { data } = await api.posts.posts.create({
          id: generateId(),
          title,
          authorId,
        });
        return data;
      }
    })
  })
});

// epicenter.config.ts
export default defineWorkspace({
  id: 'app',
  dependencies: [usersWorkspace, postsWorkspace],
  tables: {},
  actions: () => ({})
});

// Usage (in your app)
const app = await runWorkspace(config);

// Everything is available through clean namespaces
await app.users.createUser('Alice', 'alice@example.com');
await app.posts.createPost(userId, 'My Post');
const { data: users } = await app.users.users.getAll();
```

## Architecture Benefits

1. **Simplicity**: One concept (workspaces) instead of two (workspaces + epicenter)
2. **Composability**: Workspaces can aggregate other workspaces naturally
3. **Flexibility**: Runtime provides database/storage, not hardcoded in epicenter
4. **Type Safety**: Full TypeScript inference throughout
5. **Clean API**: Clear namespace pattern without surprises

The vault is dead. Long live epicenters!