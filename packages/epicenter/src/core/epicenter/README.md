# Epicenter

Epicenter is a composition layer that brings multiple workspaces together into a unified application. While workspaces define individual domains with their own data and actions, Epicenter provides a single client interface to access all workspace actions.

## What is Epicenter?

Epicenter is a collection of workspaces that work together. It provides:

- **Unified client interface**: Access all workspace actions through a single typed client
- **Flat dependency resolution**: All transitive workspace dependencies must be declared at the root level
- **Type-safe composition**: Full TypeScript inference for all workspace actions
- **Automatic resource management**: Use `await using` syntax for automatic cleanup
- **Storage isolation**: Each client instance has its own storage context (directory + environment)

## Two Ways to Use Epicenter

### 1. As a Client (Scripts, Migrations, CLI Tools)

Create an Epicenter client directly for standalone scripts:

```typescript
// Script or migration
{
  await using client = await createEpicenterClient(config);
  await client.pages.createPage({ ... });
  // Automatic cleanup when block exits
}
```

**Important:** When running scripts with `createEpicenterClient`, **ensure no server is running** in the same directory. Multiple clients accessing the same storage context (`.epicenter/` directory) simultaneously will conflict.

### 2. As a Server (Web APIs, Long-Running Processes)

The server is just a wrapper around `createEpicenterClient` that:
1. Creates an Epicenter client
2. Keeps it alive
3. Maps REST, MCP, and Hocuspocus endpoints to client actions

```typescript
// Server (long-running)
const { app, client } = await createServer(config);
Bun.serve({ fetch: app.fetch, port: 3913 });

// Other processes can now use the HTTP API
await fetch('http://localhost:3913/pages/createPage', {
  method: 'POST',
  body: JSON.stringify({ title: 'New Post', ... }),
});
```

## Epicenter Client Lifecycle

When you call `createEpicenterClient(config)` (or `createServer()`, which internally calls it), here's what happens:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. REGISTRATION                                              │
│    • Collect all workspace configs                           │
│    • Build workspace registry                                │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. DEPENDENCY VERIFICATION                                   │
│    • Check all dependencies exist (flat/hoisted model)       │
│    • Throw error if any transitive dependencies missing      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. TOPOLOGICAL SORT                                          │
│    • Build dependency graph                                  │
│    • Sort workspaces by dependencies                         │
│    • Ensure deterministic initialization order               │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. INITIALIZE EACH WORKSPACE (in sorted order)               │
│                                                              │
│    For each workspace:                                       │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ a. Create Y.Doc (CRDT data structure)               │  │
│    │    • Unique document ID = workspace ID               │  │
│    │    • In-memory collaborative data structure          │  │
│    └─────────────────────────────────────────────────────┘  │
│                       │                                      │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ b. Set Up Providers                                  │  │
│    │    • Persistence (IndexedDB or filesystem)           │  │
│    │    • Loads existing state into Y.Doc                 │  │
│    │    • Starts auto-save on updates                     │  │
│    └─────────────────────────────────────────────────────┘  │
│                       │                                      │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ c. Initialize Database (createEpicenterDb)           │  │
│    │    • Wraps Y.Doc with table API                      │  │
│    │    • Provides type-safe CRUD operations              │  │
│    └─────────────────────────────────────────────────────┘  │
│                       │                                      │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ d. Initialize Indexes                                │  │
│    │    • SQLite index (sync to .db file)                 │  │
│    │    • Markdown index (sync to .md files)              │  │
│    │    • Sets up observers for auto-sync                 │  │
│    └─────────────────────────────────────────────────────┘  │
│                       │                                      │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ e. Create Actions                                    │  │
│    │    • Call actions factory function                   │  │
│    │    • Inject db, indexes, and dependency clients      │  │
│    │    • Returns callable action functions               │  │
│    └─────────────────────────────────────────────────────┘  │
│                       │                                      │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ f. Create Workspace Client                           │  │
│    │    • Combine actions + destroy/asyncDispose          │  │
│    │    • Store in clients map                            │  │
│    └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. RETURN EPICENTER CLIENT                                   │
│    • Object with all workspace clients                       │
│    • Keyed by workspace ID                                   │
│    • Includes destroy() and Symbol.asyncDispose for cleanup  │
└─────────────────────────────────────────────────────────────┘
```

### Storage Context

Each client instance writes to a **storage context** determined by:
- **Directory**: Where the script runs (affects `.epicenter/` path)
- **Environment**: Browser (IndexedDB) vs Node (filesystem)
- **Workspace ID**: The specific workspace being accessed

```
Storage Context = Directory + Environment + Workspace ID

Examples:
  /project-a + Node + pages → /project-a/.epicenter/pages.yjs
  /project-b + Node + pages → /project-b/.epicenter/pages.yjs (different!)
  Browser + pages → IndexedDB:pages (different!)
```

### `.epicenter/` Folder Structure

The `.epicenter` folder contains all Epicenter internal data:

```
.epicenter/
├── blog.db                           # SQLite database (per workspace)
├── blog.yjs                          # YJS persistence (per workspace)
├── auth.db
├── auth.yjs
├── blog/                             # Workspace-specific index artifacts
│   ├── markdown.log                  # Markdown index sync log (indexId = "markdown")
│   ├── markdown.diagnostics.json
│   └── sqlite.log                    # SQLite index error log (indexId = "sqlite")
└── auth/
    ├── markdown.log
    └── sqlite.log
```

**Key design decisions:**
- YJS and DB files stay at root level (easy to find, prominent)
- Index logs/diagnostics go inside workspace folders
- Simple naming: `{indexId}.{suffix}` (indexId is the key from the indexes object)
- Supports multiple indexes of the same type (e.g., `markdownDocs.log`, `markdownObsidian.log`)

**Rule:** Only one client can access the same storage context at a time.

### Cleanup Lifecycle

When you dispose a client (automatically with `await using` or manually with `await client.destroy()`):

```
┌─────────────────────────────────────────────────────────────┐
│ destroy() or Symbol.asyncDispose Called                      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ For Each Workspace:                                          │
│                                                              │
│    1. Destroy Indexes                                        │
│       • Close SQLite connections                             │
│       • Unsubscribe observers                                │
│       • Checkpoint WAL files                                 │
│                                                              │
│    2. Destroy Y.Doc                                          │
│       • Disconnect providers                                 │
│       • Clean up observers                                   │
│       • Free memory                                          │
└─────────────────────────────────────────────────────────────┘
```

## Epicenter vs Workspace

### Workspace
A workspace is a self-contained domain module:
- Defines its own schema (tables)
- Defines its own indexes (SQLite, markdown, vector, etc.)
- Defines its own actions (queries and mutations)
- Can depend on other workspaces

### Epicenter
An epicenter is a composition of workspaces:
- No schema, indexes, or actions of its own
- Simply aggregates multiple workspaces
- Provides a unified client interface
- Manages workspace initialization and cleanup

Think of it this way:
- **Workspace**: A module (like a library)
- **Epicenter**: An application (composed of modules)

## Sequential Script Execution

Multiple scripts can safely run one after another using the `await using` syntax:

```typescript
// Script 1: Import data
{
  await using client = await createEpicenterClient(config);
  const data = await readFile('data.json');
  await client.pages.createPage(data);
  // Auto-disposed when block exits
}

// Script 2: Generate content (runs after Script 1 completes)
{
  await using client = await createEpicenterClient(config);
  const pages = await client.pages.getAllPages();
  await generateContent(pages);
  // Auto-disposed when block exits
}
```

Each `await using` block:
1. Creates a fresh client
2. Loads current state from `.epicenter/`
3. Runs your code
4. Disposes the client (saves state, cleans up)
5. Next block starts fresh

This ensures scripts run sequentially with no conflicts.

## Usage Example

```typescript
// Define individual workspaces
const pagesWorkspace = defineWorkspace({
  id: 'pages',
  name: 'pages',
  schema: { /* ... */ },
  indexes: ({ db }) => ({ /* ... */ }),
  exports: ({ db, indexes }) => ({
    createPage: defineMutation({ /* ... */ }),
    getPages: defineQuery({ /* ... */ }),
  }),
});

const authWorkspace = defineWorkspace({
  id: 'auth',
  name: 'auth',
  schema: { /* ... */ },
  indexes: ({ db }) => ({ /* ... */ }),
  exports: ({ db, indexes }) => ({
    login: defineMutation({ /* ... */ }),
    logout: defineMutation({ /* ... */ }),
  }),
});

// Compose them into an epicenter
const myApp = defineEpicenter({
  id: 'my-app',
  workspaces: [pagesWorkspace, authWorkspace],
});

// Create a unified client with automatic cleanup
{
  await using client = await createEpicenterClient(myApp);

  // Access workspace actions by workspace name
  await client.auth.login({ email: '...', password: '...' });
  const { data: pages } = await client.pages.getPages();

  // Automatic cleanup when scope exits
}

// For long-lived servers, use manual cleanup:
const client = await createEpicenterClient(myApp);
// ... use client for app lifetime ...
process.on('SIGTERM', async () => {
  await client.destroy();
});
```

## Flat Dependency Resolution

Epicenter uses a flat/hoisted dependency model (like VS Code extensions or pnpm):

```typescript
// If workspace A depends on B, and B depends on C,
// then Epicenter's workspaces array must include ALL THREE:
const epicenter = defineEpicenter({
  id: 'my-app',
  workspaces: [workspaceA, workspaceB, workspaceC], // Flat list
});
```

This model:
- Makes all dependencies explicit and auditable
- Prevents "dependency hell" with deeply nested trees
- Ensures deterministic initialization order (topological sort)

If you forget to include a transitive dependency, you'll get a clear error at runtime:
```
Missing dependency: workspace "A" depends on "C",
but it was not found in workspaces array.

Fix: Add "C" to workspaces array (flat/hoisted resolution).
```

## Type Safety

Epicenter provides full TypeScript inference:

```typescript
const epicenter = defineEpicenter({
  id: 'my-app',
  workspaces: [pages, auth],
});

const client = await createEpicenterClient(epicenter);

// TypeScript knows about all workspace actions:
client.pages.createPage // ✓ Type-safe
client.pages.getPages   // ✓ Type-safe
client.auth.login       // ✓ Type-safe
client.auth.logout      // ✓ Type-safe
client.invalid.action   // ✗ Compile error
```

The client type is inferred from the workspace configs, so you get full autocomplete and type checking.

## Epicenter vs createWorkspaceClient

Both `createEpicenterClient` and `createWorkspaceClient` use the same initialization logic under the hood (`initializeWorkspaces`), which returns an object of all initialized workspace clients:

```typescript
// What happens internally for BOTH functions:
const allClients = initializeWorkspaces([A, B, C]);
// => { workspaceA: clientA, workspaceB: clientB, workspaceC: clientC }
```

All workspaces are initialized in both cases. **The only difference is what they return.**

- **createEpicenterClient**: Returns the entire object of workspace clients
  ```typescript
  const client = await createEpicenterClient({ workspaces: [A, B, C] });
  // Returns: { workspaceA: clientA, workspaceB: clientB, workspaceC: clientC }
  client.workspaceA.doSomething(); // ✓ All workspaces accessible
  client.workspaceB.doSomething(); // ✓
  client.workspaceC.doSomething(); // ✓
  ```

- **createWorkspaceClient**: Returns only the specified workspace client from the object
  ```typescript
  const client = await createWorkspaceClient(workspaceC); // C depends on A, B
  // Returns: clientC (accessed from the full object)
  client.doSomething(); // ✓ Only C's actions available
  client.workspaceA; // undefined - other workspaces not exposed on return value
  ```

In other words, **createWorkspaceClient** returns a subset of **createEpicenterClient**.

## Architecture

```
┌─────────────────────────────────────────┐
│           Epicenter Client              │
│  (Unified interface to all workspaces)  │
└─────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Workspace A │ │ Workspace B │ │ Workspace C │
│             │ │             │ │             │
│ • Schema    │ │ • Schema    │ │ • Schema    │
│ • Indexes   │ │ • Indexes   │ │ • Indexes   │
│ • Actions   │ │ • Actions   │ │ • Actions   │
└─────────────┘ └─────────────┘ └─────────────┘
```

Each workspace maintains its own:
- YJS document (collaborative data)
- Database abstraction (tables API)
- Indexes (synchronized snapshots)
- Actions (business logic)

Epicenter orchestrates initialization and provides a unified interface.

## Implementation Details

### config.ts
Defines `EpicenterConfig` type and `defineEpicenter` function with validation:
- Validates epicenter ID is a non-empty string
- Validates workspaces is a non-empty array
- Checks for duplicate workspace names (throws error)
- Checks for duplicate workspace IDs (throws error)

### client.ts
Defines `EpicenterClient` type and `createEpicenterClient` function:
- Uses `initializeWorkspaces` from workspace/client for initialization
- Implements flat/hoisted dependency resolution
- Provides `destroy()` and `Symbol.asyncDispose` for resource management with `await using` syntax
- Maps workspace names to their action clients

### index.ts
Central export point that re-exports from config.ts and client.ts.
