# Static-Only Server & CLI Architecture

**Status:** Draft
**Created:** 2026-02-05
**Author:** System Analysis

## Problem Statement

The server and CLI infrastructure currently attempts to support both the static and dynamic workspace APIs, creating unnecessary complexity and type incompatibilities:

1. **Type Mismatch:** Server imports `AnyWorkspaceClient` from dynamic API (3 type params), but CLI passes static API clients (4 type params), requiring an `as any` cast
2. **Structural Incompatibility:** Server code assumes dynamic API structure (e.g., `tables.definitions`, `tables.get()`) that doesn't exist on static API's `TablesHelper`
3. **Naming Confusion:** Dynamic API uses "extensions" while static API uses "capabilities" for the same concept
4. **Dead Abstraction:** Duck-typing and type erasure exists only to bridge static/dynamic, but we only want to support static

## Goals

1. **Rewrite server from scratch** to work exclusively with the static workspace API
2. **Keep CLI static-only** (already correct, just needs cleanup)
3. **Preserve dynamic API** in `/packages/epicenter/src/dynamic/` for future decisions, but don't use it
4. **Remove all type casts** between static and dynamic
5. **Clarify naming:** Static API uses "capabilities", not "extensions"

## Current Architecture

### CLI (Correct - Already Static)

```
epicenter.config.ts (user file)
  ↓ exports default createWorkspace(...) [static API]
  ↓
discovery.ts - resolveWorkspace()
  ↓ finds and imports config
  ↓ validates with isWorkspaceClient(value)
  ↓ returns AnyWorkspaceClient [from static/types.ts]
  ↓
cli.ts - createCLI(client)
  ↓ builds yargs commands
  ↓ table commands (iterate client.tables)
  ↓ kv commands (use client.kv)
  ↓ action commands (use client.actions)
  ↓ serve command → createServer(client as any) ← TYPE CAST HERE
  ↓
server.ts - createServer(client) [WRONG - uses dynamic types]
```

### Server (Wrong - Uses Dynamic Types)

```typescript
// server.ts:3 - PROBLEM
import type { AnyWorkspaceClient } from '../dynamic/workspace/types';

// tables.ts:13-14 - PROBLEM
workspace.tables.definitions  // ❌ Doesn't exist on static TablesHelper
workspace.tables.get(tableName)  // ❌ Doesn't exist on static TablesHelper
```

## Target Architecture

### Static API Type Hierarchy

```
WorkspaceDefinition
  ↓ defineWorkspace()
  ↓
WorkspaceClientBuilder [IS a client + has .withExtensions() + .withActions()]
  ├── Directly usable: client.tables.posts.upsert(...)
  ├── .withExtensions({ persistence, sync })
  │     ↓ returns WorkspaceClient with capabilities
  └── .withActions((client) => ({ ... }))
        ↓ returns WorkspaceClientWithActions (terminal)

Type parameters:
- TId extends string
- TTableDefinitions extends TableDefinitions (Record<string, TableDefinition>)
- TKvDefinitions extends KvDefinitions (Record<string, KvDefinition>)
- TExtensions extends ExtensionMap (Record<string, ExtensionFactory>)
```

### Static API Structure

```typescript
// What the server receives
WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions> = {
  id: string;
  ydoc: Y.Doc;
  tables: TablesHelper<TTableDefs>;  // Mapped type!
  kv: KvHelper<TKvDefs>;
  definitions: { tables: TTableDefs; kv: TKvDefs };  // For server/CLI introspection
  extensions: InferExtensionExports<TExtensions>;
  actions?: Actions;  // Optional, only if .withActions() was called
  destroy(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

// TablesHelper is a mapped type (NOT an object with methods)
type TablesHelper<TTableDefs> = {
  [K in keyof TTableDefs]: TableHelper<InferTableRow<TTableDefs[K]>>
}

// So client.tables is like:
{
  posts: TableHelper<PostRow>,
  comments: TableHelper<CommentRow>,
}

// You iterate it with:
Object.entries(client.tables)  // [tableName, tableHelper][]
Object.keys(client.tables)     // tableName[]
```

### Extension System

**Note:** This spec assumes the extension naming unification (spec `20260205T110000-unify-extension-naming.md`) has already been completed, so static API now uses:
- `ExtensionFactory` (not `CapabilityFactory`)
- `ExtensionMap` (not `CapabilityMap`)
- `client.extensions` property (not `client.capabilities`)

Files in `/packages/epicenter/src/extensions/` will import from **static**:

```typescript
// Target (CORRECT for static-only server)
import { ExtensionFactory } from '../../static/types';
```

## Implementation Plan

### Phase 1: Add Definitions to WorkspaceClient

**Status:** ✅ Implemented

**Problem:** Server needs table definitions for:
1. Iterating table names for route generation
2. Accessing field schemas for validation

**Solution:** Add `definitions` property directly on `WorkspaceClient` (not on `TablesHelper`).

**File:** `packages/epicenter/src/static/create-workspace.ts`

**Implementation in `createWorkspace()`:**

```typescript
const definitions = {
  tables: (config.tables ?? {}) as TTableDefinitions,
  kv: (config.kv ?? {}) as TKvDefinitions,
};

const baseClient = {
  id,
  ydoc,
  tables,
  kv,
  definitions,  // ← available for server/CLI introspection
  extensions: {} as InferExtensionExports<Record<string, never>>,
  destroy,
  [Symbol.asyncDispose]: destroy,
};
```

This avoids polluting `TablesHelper` with metadata and keeps the definitions at the workspace level where they belong.

### Phase 2: Rewrite Server to Use Static API

**File:** `packages/epicenter/src/server/server.ts`

**Changes:**

1. **Fix imports:**

```typescript
// BEFORE
import type { AnyWorkspaceClient } from '../dynamic/workspace/types';

// AFTER
import type { AnyWorkspaceClient } from '../static/types';
```

2. **Update function signatures (no changes needed):**

```typescript
function createServer(
  client: AnyWorkspaceClient,
  options?: ServerOptions,
): ReturnType<typeof createServerInternal>;

function createServer(
  clients: AnyWorkspaceClient[],
  options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
```

These signatures work because `AnyWorkspaceClient` is just `WorkspaceClient<any, any, any, any>` - the server doesn't need specific table types.

3. **Update internal implementation (minimal changes):**

The server currently accesses:
- `client.id` ✅ (exists on static)
- `client.ydoc` ✅ (exists on static)
- `client.actions` ✅ (optional on static)
- `client.destroy()` ✅ (exists on static)

All of these work as-is! The only issue is in the tables plugin.

### Phase 3: Rewrite Tables Plugin

**File:** `packages/epicenter/src/server/tables.ts`

**Current implementation (assumes dynamic API):**

```typescript
export function createTablesPlugin(
  workspaceClients: Record<string, AnyWorkspaceClient>,
) {
  for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
    for (const tableName of Object.keys(workspace.tables.definitions)) {  // ❌
      const tableHelper = workspace.tables.get(tableName);  // ❌
      const fields = workspace.tables.definitions[tableName]!.fields;  // ❌
      // ...
    }
  }
}
```

**Target implementation (static API):**

```typescript
import type { AnyWorkspaceClient } from '../static/types';

export function createTablesPlugin(
  workspaceClients: Record<string, AnyWorkspaceClient>,
) {
  const app = new Elysia();

  for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
    // Access definitions from the workspace client
    const tableDefinitions = workspace.definitions.tables;

    for (const [tableName, value] of Object.entries(workspace.tables)) {
      const tableDef = tableDefinitions[tableName];
      if (!tableDef) continue;

      const tableHelper = value as TableHelper<{ id: string }>;
      const basePath = `/workspaces/${workspaceId}/tables/${tableName}`;
      const tags = [workspaceId, 'tables'];

      // GET - list all rows
      app.get(basePath, () => tableHelper.getAllValid(), {
        detail: { description: `List all ${tableName}`, tags },
      });

      // POST - validate with Standard Schema, migrate, then set
      app.post(basePath, ({ body, status }) => {
        const result = tableDef.schema['~standard'].validate(body);
        if (result instanceof Promise) {
          return status(500, { error: 'Async schema validation not supported' });
        }
        if (result.issues) {
          return status(422, { errors: result.issues });
        }
        const row = tableDef.migrate(result.value);
        tableHelper.set(row);
        return Ok({ id: row.id });
      }, {
        detail: { description: `Create or update ${tableName}`, tags },
      });

      // ... other CRUD endpoints (GET /:id, PUT /:id, DELETE /:id)
    }
  }

  return app;
}
```

**Key changes:**
1. Access `workspace.definitions.tables` for table definitions (no `$meta` indirection)
2. Iterate `Object.entries(workspace.tables)` directly — no metadata properties to skip
3. Use `tableDef.schema['~standard'].validate()` for Standard Schema validation
4. Use `tableDef.migrate()` for version migration

### Phase 4: Remove Type Cast from CLI

**File:** `packages/epicenter/src/cli/cli.ts`

**Current:**

```typescript
(argv) => {
  // Type assertion needed: CLI uses static API (4 type params), server uses dynamic API (3 type params).
  // Both are structurally compatible at runtime (same id, ydoc, tables, actions properties).
  // Proper fix requires shared base interface - tracked in type design review.
  createServer(client as any, {
    port: argv.port,
  }).start();
},
```

**Target:**

```typescript
(argv) => {
  createServer(client, {
    port: argv.port,
  }).start();
},
```

No cast needed! Both CLI and server now use the same `AnyWorkspaceClient` from `../static/types`.

### Phase 5: Update Extensions to Use Static API (Optional)

**Affected files in `/packages/epicenter/src/extensions/`:**

1. `websocket-sync.ts`
2. `persistence/desktop.ts`
3. `persistence/web.ts`
4. `sqlite/sqlite.ts`
5. `markdown/markdown.ts`
6. `revision-history/index.ts`

**Current pattern:**

```typescript
import { ExtensionFactory } from '../../dynamic';

export const myExtension: ExtensionFactory<any, any, MyExports> = (context) => {
  return {
    someMethod() { ... },
    whenSynced: Promise.resolve(),
    destroy: async () => {},
  };
};
```

**Target pattern:**

```typescript
import { ExtensionFactory } from '../../static/types';

export const myExtension: ExtensionFactory<any, any, MyExports> = (context) => {
  return {
    someMethod() { ... },
    whenSynced: Promise.resolve(),
    destroy: async () => {},
  };
};
```

**Changes:**
1. Import `ExtensionFactory` from static instead of dynamic
2. Type parameters are the same: `<TTableDefs, TKvDefs, TExports>`
3. Context shape is identical (has `id`, `ydoc`, `tables`, `kv`)
4. Return type is identical (has `whenSynced`, `destroy`, and custom exports)

**The APIs are structurally identical!** After the naming unification, both use "ExtensionFactory".

## Migration Strategy

### What We're NOT Doing

- ❌ Delete `/packages/epicenter/src/dynamic/` directory
- ❌ Remove dynamic API from package exports
- ❌ Migrate apps using dynamic API
- ❌ Remove dynamic tests

**Reason:** Dynamic API is preserved for future evaluation. We're just making server/CLI not depend on it.

### What We ARE Doing

- ✅ Add `definitions` property to `WorkspaceClient` for server introspection
- ✅ Change server imports to use static `AnyWorkspaceClient`
- ✅ Rewrite tables plugin to work with static API structure
- ✅ Remove `as any` cast in CLI serve command
- ✅ (Optional) Update extension files to use static `CapabilityFactory`

### Testing Strategy

1. **Unit tests:** Verify `WorkspaceClient.definitions` contains correct table/kv definitions
2. **Integration tests:** Test server with static workspace clients
3. **Manual testing:**
   - Create workspace with static API
   - Start server with CLI: `bun epicenter serve`
   - Test REST endpoints: `GET /workspaces/{id}/tables/{table}`
   - Test WebSocket sync: Connect to `ws://localhost:3913/workspaces/{id}/sync`
   - Test actions: `POST /workspaces/{id}/actions/{path}`

### Rollback Plan

If issues arise:
1. Revert server imports back to dynamic
2. Keep `definitions` property (doesn't break anything)
3. Restore `as any` cast in CLI
4. File issue with detailed error logs

## Benefits

1. **Type Safety:** No more `as any` casts between APIs
2. **Clarity:** Server explicitly targets one API, not both
3. **Simplicity:** Remove duck-typing abstractions
4. **Performance:** No runtime type checking
5. **Maintainability:** One code path for server/CLI

## Open Questions

1. ~~**Should we rename "capabilities" to "extensions" in static API for consistency?**~~
   - ✅ **RESOLVED:** Addressed in spec `20260205T110000-unify-extension-naming.md`
   - This spec assumes that naming unification has been completed first

2. ~~**Should `$meta` be exposed on the public API?**~~
   - ✅ **RESOLVED:** Implemented as `client.definitions` — a clean, public property on `WorkspaceClient` that exposes `{ tables, kv }` for server/CLI introspection. No `$` prefix needed since it's a first-class property.

3. **Should server validate against schemas at HTTP layer?**
   - Pro: Better error messages before Y.js
   - Con: Validation happens again in table helper
   - Recommendation: Yes, validate early for better DX

## Implementation Checklist

### Phase 1: Definitions on WorkspaceClient
- [x] Add `definitions` property to `WorkspaceClient` type
- [x] Implement `definitions` in `createWorkspace()` (shared between base and extension clients)
- [ ] Add tests for definitions access
- [ ] Update type exports if needed

### Phase 2: Server Imports
- [ ] Change `server.ts` import from dynamic to static
- [ ] Change `tables.ts` import from dynamic to static
- [ ] Verify no type errors
- [ ] Update any other server files importing dynamic types

### Phase 3: Tables Plugin
- [ ] Rewrite `createTablesPlugin()` to iterate `Object.entries()`
- [x] Access definitions via `workspace.definitions.tables`
- [ ] Use `tableDef.schema` for validation
- [ ] Test all CRUD endpoints

### Phase 4: CLI Cleanup
- [ ] Remove `as any` cast from `cli.ts` serve command
- [ ] Remove outdated comments about type mismatch
- [ ] Verify CLI serve command works
- [ ] Test end-to-end: discovery → CLI → server

### Phase 5: Extensions (Optional)
- [ ] Update `websocket-sync.ts` to import `ExtensionFactory` from static
- [ ] Update `persistence/desktop.ts`
- [ ] Update `persistence/web.ts`
- [ ] Update `sqlite/sqlite.ts`
- [ ] Update `markdown/markdown.ts`
- [ ] Update `revision-history/index.ts`
- [ ] Test each extension with static API

### Phase 6: Documentation
- [ ] Update server README with static API examples
- [ ] Update CLI README
- [ ] Add migration guide for extension authors
- [ ] Document `definitions` property in API reference

## Success Criteria

1. ✅ Server compiles with no `as any` casts
2. ✅ CLI serve command works without type assertions
3. ✅ All REST endpoints functional with static clients
4. ✅ WebSocket sync works with static clients
5. ✅ All tests pass
6. ✅ No regression in dynamic API functionality (kept separate)

## Timeline Estimate

- **Phase 1 (Metadata):** 2 hours
- **Phase 2 (Server Imports):** 30 minutes
- **Phase 3 (Tables Plugin):** 3-4 hours
- **Phase 4 (CLI Cleanup):** 15 minutes
- **Phase 5 (Extensions):** 2-3 hours (if pursued)
- **Phase 6 (Documentation):** 1-2 hours

**Total:** 1-2 days for phases 1-4 (core functionality)

## References

- Current server: `/packages/epicenter/src/server/server.ts`
- Current CLI: `/packages/epicenter/src/cli/cli.ts`
- Static types: `/packages/epicenter/src/static/types.ts`
- Dynamic types: `/packages/epicenter/src/dynamic/workspace/types.ts` (preserved but not used)
- Extensions: `/packages/epicenter/src/extensions/`
