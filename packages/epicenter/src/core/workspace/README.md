# Workspace

A workspace is a self-contained domain module with its own schema, indexes, and actions. Workspaces are composed into an Epicenter to create your application.

## What is a Workspace?

When you create an Epicenter client, each workspace becomes a property on that client:

```typescript
const blogWorkspace = defineWorkspace({ name: 'blog', ... });
const authWorkspace = defineWorkspace({ name: 'auth', ... });

const epicenter = await createEpicenterClient({
  workspaces: [blogWorkspace, authWorkspace]
});

// Each workspace is accessible by its name:
epicenter.blog.createPost(...)  // blogWorkspace actions
epicenter.auth.login(...)       // authWorkspace actions
```

Each workspace has:
- **Schema**: Define your data structure with typed columns
- **Indexes**: Synchronized snapshots for querying (SQLite, markdown, vector, etc.)
- **Actions**: Business logic (queries and mutations) with access to db and indexes

## Workspace Clients

A **workspace client** is not a standalone concept. It's a single workspace extracted from an **Epicenter client**.

```typescript
// An Epicenter client is an object of workspace clients:
type EpicenterClient = {
  [workspaceName: string]: WorkspaceClient
}

// createEpicenterClient returns the full object:
const epicenter = await createEpicenterClient({ workspaces: [A, B, C] });
// => { workspaceA: clientA, workspaceB: clientB, workspaceC: clientC }

// createWorkspaceClient returns one workspace from that object:
const client = await createWorkspaceClient(workspaceC);
// => clientC (equivalent to epicenter.workspaceC)
```

Both `createEpicenterClient` and `createWorkspaceClient` use the same initialization logic. They initialize all workspaces, including dependencies. The only difference is what they return: the full object vs. a single workspace client.

---

# Workspace Dependencies

When you have workspaces that depend on other workspaces, you hit a type recursion problem. If workspace A depends on B, which depends on C, which depends on D, and TypeScript tries to infer the full dependency chain recursively, the type system eventually gives up with "Type instantiation is excessively deep and possibly infinite."

Epicenter solves this using a minimal constraint pattern: dependency arrays are constrained to `AnyWorkspaceConfig[]` (which only includes `id`, `name`, and `actions`), stopping recursive type inference. At runtime, all workspace configs are complete; the minimal constraint is purely for type safety.

## The Type System

```typescript
// Minimal constraint for dependencies
type AnyWorkspaceConfig = {
  id: string;
  exports: (context: any) => WorkspaceExports;
};

// Full workspace config
type WorkspaceConfig<
  TDeps extends readonly AnyWorkspaceConfig[],
  TSchema extends WorkspaceSchema,
  TIndexMap extends WorkspaceIndexMap,
  TExports extends WorkspaceExports
> = {
  id: string;
  schema: TSchema;
  dependencies?: TDeps;
  indexes: (ctx: { db: Db<TSchema> }) => TIndexMap | Promise<TIndexMap>;
  exports: (ctx: {
    db: Db<TSchema>;
    indexes: TIndexMap;
    workspaces: DependencyActionsMap<TDeps>;
  }) => TActionMap;
};
```

## How It Works

**At compile time**: Dependencies are constrained to `AnyWorkspaceConfig[]`. This minimal interface (id, name, actions) prevents TypeScript from recursively inferring the entire dependency tree. Without this constraint, TypeScript would try to infer `WorkspaceConfig<WorkspaceConfig<WorkspaceConfig<...>>>` infinitely.

**At runtime**: All workspace configs have full properties (schema, indexes, setupYDoc, etc.). The minimal constraint is purely for type inference. Dependencies are resolved flat with hoisting (like VS Code extensions): all transitive dependencies must be declared at the root level.

**Accessing dependencies**: The `actions` function receives a `workspaces` object that maps dependency names to their action maps:

```typescript
// Dependencies are keyed by their 'name' property
type DependencyActionsMap<TDeps extends readonly AnyWorkspaceConfig[]> = {
  [W in TDeps[number] as W['name']]: ReturnType<W['actions']>;
};
```

## Example

```typescript
// Define workspaces
const connectionPoolWorkspace = defineWorkspace({
  id: 'connection-pool',
  name: 'connectionPool',
  schema: { /* ... */ },
  indexes: () => ({ /* ... */ }),
  exports: () => ({
    getConnection: defineQuery({ /* ... */ })
  })
});

const databaseWorkspace = defineWorkspace({
  id: 'database',
  name: 'database',
  schema: { /* ... */ },
  dependencies: [connectionPoolWorkspace],
  indexes: () => ({ /* ... */ }),
  exports: ({ workspaces }) => ({
    getUser: defineQuery({
      handler: async () => {
        // Access dependency actions by name
        await workspaces.connectionPool.getConnection();
      }
    })
  })
});

const authWorkspace = defineWorkspace({
  id: 'auth',
  name: 'auth',
  schema: { /* ... */ },
  dependencies: [databaseWorkspace],
  indexes: () => ({ /* ... */ }),
  exports: ({ workspaces }) => ({
    verifyToken: defineQuery({
      handler: async () => {
        // Full type information for direct dependencies
        await workspaces.database.getUser();
      }
    })
  })
});

// Example workspace with flat/hoisted dependencies
const rootWorkspace = defineWorkspace({
  id: 'root',
  name: 'root',
  schema: { /* ... */ },
  // ALL transitive dependencies must be listed here (flat/hoisted)
  dependencies: [authWorkspace, databaseWorkspace, connectionPoolWorkspace],
  indexes: () => ({ /* ... */ }),
  exports: ({ workspaces }) => ({
    login: defineQuery({
      handler: async () => {
        // Access any dependency by name
        await workspaces.auth.verifyToken();
        await workspaces.database.getUser();
        await workspaces.connectionPool.getConnection();
      }
    })
  })
});
```

## Flat/Hoisted Dependencies

Like VS Code extensions, Epicenter uses flat dependency resolution:

1. All transitive dependencies must be declared at the root level
2. If workspace A depends on B, and B depends on C, then A must list both B and C in its dependencies array
3. Dependencies are initialized in topological order (Kahn's algorithm)

This model:
- Prevents "dependency hell" with deeply nested trees
- Ensures consistent initialization order
- Makes all dependencies explicit and auditable

## The Three-Stage Dependency Pattern

Workspaces use a three-stage dependency pattern (schema → indexes → actions) that avoids TypeScript's circular inference problem:

```typescript
defineWorkspace({
  // Stage 1: Schema (base data structure)
  schema: { posts: { title: text() } },

  // Stage 2: Indexes (depend on schema)
  indexes: {
    sqlite: (c) => sqliteIndex(c)
  },

  // Stage 3: Actions (depend on schema AND indexes)
  exports: ({ db, indexes, workspaces }) => ({
    getPost: defineQuery({
      handler: async () => {
        // Full type information for indexes
        return indexes.sqlite.posts.select().all();
      }
    })
  })
});
```

This works because we **parameterize return values, not function types**. Instead of `TIndexesFn extends () => any` with `ReturnType<TIndexesFn>` (which creates circular inference), we use `TIndexMap` directly and inline the function signature.

See `typescript-inference-problem.md` and `inference-test.ts` in this directory for details.

## When This Matters

This system is mostly invisible until you:
1. Have workspace dependencies (then you must list all transitives at root)
2. Need type information for dependency actions (accessed via `workspaces.dependencyName`)
3. See type errors about "Type instantiation is excessively deep" (the minimal constraint prevents this)

The flat/hoisted model means you always have explicit control over which workspaces are used, and the type system provides full autocomplete for your direct dependencies' actions.
