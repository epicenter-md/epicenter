# WorkspaceDoc Consolidation

**Status**: In Progress
**Created**: 2026-01-21T22:47:28

## Problem

Currently we have two overlapping abstractions:

1. **`WorkspaceDoc`** - Y.Doc wrapper with typed accessors (tables, kv, schema methods)
2. **`WorkspaceClient`** - Adds lifecycle management (extensions, whenSynced, destroy) on top of WorkspaceDoc

This creates:

- Confusion about which type to use where
- Nested access patterns (`context.workspaceDoc.tables` instead of `context.tables`)
- Two separate files/concepts for what is conceptually one thing

## Solution

Consolidate everything into `WorkspaceDoc`. It becomes the ONE abstraction for workspace management.

### Before

```typescript
// Two separate types
type WorkspaceDoc = {
	ydoc;
	workspaceId;
	epoch;
	tables;
	kv;
	getSchema();
	getSchemaMap();
	getKvMap();
	getTablesMap();
	mergeSchema();
	observeSchema();
};

type WorkspaceClient = {
	id;
	ydoc;
	tables;
	kv;
	extensions;
	getSchema();
	whenSynced;
	destroy();
};

// Nested ExtensionContext
type ExtensionContext = {
	workspaceDoc: WorkspaceDoc;
	extensionId: string;
};

// Extension access pattern
({ workspaceDoc }) => {
	const { ydoc, tables } = workspaceDoc;
};
```

### After

```typescript
// ONE unified type
type WorkspaceDoc<TTableDefs, TKvDefs, TExtensions> = {
	// Core Y.Doc
	ydoc: Y.Doc;
	workspaceId: string;
	epoch: number;
	tables: Tables<TTableDefs>;
	kv: Kv<TKvDefs>;

	// Schema methods
	getSchema(): WorkspaceSchemaMap;
	getSchemaMap(): SchemaMap;
	getKvMap(): KvMap;
	getTablesMap(): TablesMap;
	mergeSchema(schema): void;
	observeSchema(callback): () => void;

	// Lifecycle (moved from WorkspaceClient)
	extensions: TExtensions;
	whenSynced: Promise<void>;
	destroy(): Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
};

// Flattened ExtensionContext
type ExtensionContext<TTableDefs, TKvDefs> = Omit<
	WorkspaceDoc<TTableDefs, TKvDefs, never>,
	'extensions' | 'whenSynced' | 'destroy' | typeof Symbol.asyncDispose
> & { extensionId: string };

// Extension access pattern (flattened)
({ ydoc, tables, extensionId }) => {
	// Direct access, no nesting
};
```

## Implementation Plan

### Phase 1: Update createWorkspaceDoc to accept extensions

- [ ] Add `extensionFactories` parameter to `createWorkspaceDoc`
- [ ] Add `onSync` parameter for schema merging callback
- [ ] Move extension initialization logic from `createClientCore`
- [ ] Add `extensions`, `whenSynced`, `destroy` to return object
- [ ] Update `WorkspaceDoc` type to include lifecycle fields

### Phase 2: Flatten ExtensionContext

- [ ] Change `ExtensionContext` from `{ workspaceDoc, extensionId }` to flattened type
- [ ] Update `createWorkspaceDoc` to pass flattened context to extensions

### Phase 3: Update all extensions to flattened access

- [ ] `persistence/desktop.ts` - `{ ydoc }` instead of `{ workspaceDoc }`
- [ ] `persistence/web.ts` - `{ ydoc }` instead of `{ workspaceDoc }`
- [ ] `sqlite/sqlite.ts` - `{ workspaceId, tables }` instead of `{ workspaceDoc }`
- [ ] `websocket-sync.ts` - `{ ydoc }` instead of `{ workspaceDoc }`
- [ ] `markdown/markdown.ts` - `{ workspaceId, tables, ydoc }` instead of `{ workspaceDoc }`
- [ ] `revision-history/local.ts` - `{ ydoc, workspaceId }` instead of `{ workspaceDoc }`

### Phase 4: Remove WorkspaceClient

- [ ] Remove `WorkspaceClient` type from `workspace.ts`
- [ ] Remove `createClientCore` function (logic moved to `createWorkspaceDoc`)
- [ ] Update `createClient` to return `WorkspaceDoc` directly
- [ ] Update `createClientBuilder` to work with new structure
- [ ] Update exports in `index.ts`

### Phase 5: Update consuming code

- [ ] Update any code that uses `WorkspaceClient` type
- [ ] Update JSDoc examples throughout codebase
- [ ] Verify typecheck passes
- [ ] Run tests

## Files to Modify

### Core files

- `packages/epicenter/src/core/docs/workspace-doc.ts` - Main changes
- `packages/epicenter/src/core/extension.ts` - Flatten ExtensionContext
- `packages/epicenter/src/core/workspace/workspace.ts` - Remove createClientCore, update createClient

### Extensions

- `packages/epicenter/src/extensions/persistence/desktop.ts`
- `packages/epicenter/src/extensions/persistence/web.ts`
- `packages/epicenter/src/extensions/sqlite/sqlite.ts`
- `packages/epicenter/src/extensions/websocket-sync.ts`
- `packages/epicenter/src/extensions/markdown/markdown.ts`
- `packages/epicenter/src/extensions/revision-history/local.ts`

### Exports

- `packages/epicenter/src/index.ts`
- `packages/epicenter/src/core/workspace/index.ts`
- `packages/epicenter/src/core/docs/index.ts`

## Key Decisions

### Why flatten ExtensionContext?

Extensions are the primary consumers of workspace data. Flattening reduces:

- Cognitive load (one less level of nesting)
- Verbosity (`context.tables` vs `context.workspaceDoc.tables`)
- The temptation to pass around `workspaceDoc` separately

### Why keep `workspaceId` instead of `id`?

`workspaceId` is more explicit and matches the Y.Doc naming. The old `id` was ambiguous (could be extension ID, row ID, etc.).

### What about backward compatibility?

This is a breaking change for:

1. Code that imports `WorkspaceClient` type
2. Extensions that use `{ workspaceDoc }` destructuring

Since this is an internal refactor before public release, breaking changes are acceptable.

## Progress Log

- [x] Initial analysis and planning
- [x] Created specification document
- [x] Phase 1: Update createWorkspaceDoc (added extensions, lifecycle, flattened context)
- [x] Phase 2: Flatten ExtensionContext (moved to workspace-doc.ts)
- [x] Phase 3: Update extensions to use flattened access
- [x] Phase 4: Remove WorkspaceClient and createClientCore
- [x] Phase 5: Verify and test

## Review

### Summary of Changes

Consolidated two overlapping abstractions (`WorkspaceClient` and `WorkspaceDoc`) into a single unified `WorkspaceDoc` type.

### Files Modified

**Core (workspace-doc.ts)**:

- Added `extensionFactories` and `onSync` parameters to `createWorkspaceDoc`
- Added `extensions`, `whenSynced`, `destroy`, `[Symbol.asyncDispose]` to return object
- Moved extension types (`ExtensionContext`, `ExtensionFactory`, etc.) from extension.ts
- `ExtensionContext` is now flattened: `{ ydoc, workspaceId, tables, kv, extensionId }`

**workspace.ts**:

- Removed `createClientCore` function (logic moved to `createWorkspaceDoc`)
- `createClientBuilder.withExtensions` now calls `createWorkspaceDoc` directly

**extension.ts**:

- Now just re-exports types from `workspace-doc.ts`

**Extensions updated to flattened context**:

- `persistence/desktop.ts` - `({ ydoc }) => ...`
- `persistence/web.ts` - `({ ydoc }) => ...`
- `sqlite/sqlite.ts` - `({ workspaceId, tables }) => ...`
- `websocket-sync.ts` - `({ ydoc }) => ...`
- `markdown/markdown.ts` - `({ workspaceId, tables, ydoc }) => ...`
- `revision-history/local.ts` - `({ ydoc, workspaceId }) => ...`

**Imports updated**:

- `cli/cli.ts` - `WorkspaceDoc` instead of `WorkspaceClient`
- `cli/discovery.ts` - `WorkspaceDoc` instead of `WorkspaceClient`
- `server/tables.ts` - `WorkspaceDoc` instead of `WorkspaceClient`
- `server/server.ts` - Changed `.id` to `.workspaceId`
- `index.ts` - Removed duplicate `WorkspaceDoc` export

### Key Architecture Change

**Before**:

```typescript
type WorkspaceClient = { id, ydoc, tables, kv, extensions, whenSynced, destroy };
type WorkspaceDoc = { ydoc, workspaceId, tables, kv, getSchema, ... };
type ExtensionContext = { workspaceDoc: WorkspaceDoc; extensionId: string };
// Extension: ({ workspaceDoc }) => { const { ydoc } = workspaceDoc; }
```

**After**:

```typescript
type WorkspaceDoc = { ydoc, workspaceId, epoch, tables, kv, extensions, whenSynced, destroy, getSchema, ... };
type ExtensionContext = { ydoc, workspaceId, tables, kv, extensionId, ... };
// Extension: ({ ydoc, tables }) => { ... }
```

### Breaking Changes

1. `WorkspaceClient` type no longer exists - use `WorkspaceDoc`
2. Extensions now receive flattened context - destructure directly instead of `context.workspaceDoc.x`
3. `.id` property renamed to `.workspaceId` on workspace instances
