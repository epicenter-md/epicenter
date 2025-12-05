# Unified Workspace Architecture

Everything is a workspace. The epicenter is just a workspace that aggregates other workspaces.

## Core Concept

```typescript
// Before: Two concepts (workspaces and epicenter)
const workspace = defineWorkspace({...});
const epicenter = createEpicenter({ workspaces: [...], path: '...', database: '...' });

// After: One concept (just workspaces)
const epicenter = defineWorkspace({
  id: 'epicenter',
  tables: {},
  exports: (api) => ({}),
  dependencies: [usersWorkspace, postsWorkspace],
});
```

## How It Works

### 1. Define Workspaces

Each workspace defines its tables and actions:

```typescript
import { defineWorkspace, defineQuery, defineMutation } from '@epicenter/epicenter';
import { type } from 'arktype';

const usersWorkspace = defineWorkspace({
  id: 'users',

  tables: {
    users: {
      id: id(),
      name: text(),
      email: text(),
    }
  },

  exports: (api) => ({
    createUser: defineMutation({
      input: type({
        name: 'string>0',
        email: 'email'
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
  tables: {}, // No tables of its own
  exports: (api) => ({
    // Optional: Add app-level orchestration actions
    // Or just return empty object
  }),
  dependencies: [usersWorkspace, postsWorkspace, commentsWorkspace],
});

// epicenter.config.ts
export default epicenter;
```

### 3. Runtime Injection

The Epicenter CLI provides the database and storage:

```typescript
// The CLI does this internally:
const app = await runWorkspace(epicenter, {
  database: './data/app.db',
  rootDir: './data'
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
  id: 'posts',
  tables: {
    posts: {
      id: id(),
      title: text(),
      authorId: text(),
    }
  },
  exports: (api) => ({
    createPost: defineMutation({
      input: Type.Object({
        authorId: Type.String(),
        title: Type.String({ minLength: 1 })
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
  }),
  dependencies: [usersWorkspace],
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
  database: './data.db',
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
  exports: () => ({})
});

// Runtime injection (handled by CLI)
const app = await runWorkspace(epicenter, {
  database: './data.db',
  rootDir: './data'
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
  exports: (api) => ({
    createUser: defineMutation({
      input: Type.Object({
        name: Type.String({ minLength: 1 }),
        email: Type.String({ format: 'email' })
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
  exports: (api) => ({
    createPost: defineMutation({
      input: Type.Object({
        authorId: Type.String(),
        title: Type.String({ minLength: 1 })
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
  exports: () => ({})
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