# Cell Workspace API Consolidation

**Date**: 2026-01-17
**Status**: Implemented
**Updated**: 2026-01-28

## Summary

Consolidated workspace architectures into a unified Cell API:
- **Cell** is now the storage foundation (cell-level LWW CRDT)
- **Cell** inherits HeadDoc + Epochs + Extensions from Core
- **Static** remains unchanged (row-level, compile-time typed schemas)
- **Core** is deprecated after migration
- Everything exports from `@epicenter/hq` and `@epicenter/hq/cell`

## Problem

The codebase had four workspace architectures that overlapped in confusing ways:

1. **Core** (`createClient`): Row-level storage, HeadDoc epochs, extension system
2. **Cell** (`createCellWorkspace`): Cell-level LWW CRDT, external JSON schema, no epochs
3. **Static** (`defineWorkspace`, `defineTable`): Compile-time typed, row-level
4. **Dynamic**: Runtime schema from Y.Doc

Cell's cell-level CRDT was better for concurrent editing, but it lacked Core's HeadDoc/epoch integration and extension system. This consolidation brings the best of both worlds.

## Solution

### Target API

```typescript
import { createHeadDoc, createCellWorkspace, defineExports } from '@epicenter/hq';

// 1. Create head doc (identity + epochs)
const headDoc = createHeadDoc({
  workspaceId: 'my-workspace',
  providers: { persistence },
});

await headDoc.whenSynced;

// 2. Create cell workspace with builder pattern
const workspace = createCellWorkspace({
  headDoc,
  definition: {
    name: 'My Blog',
    tables: {
      posts: {
        name: 'Posts',
        fields: {
          title: { name: 'Title', type: 'text', order: 1 }
        }
      }
    }
  } as const,
})
  .withExtensions({
    sqlite: (ctx) => {
      // ctx.table('posts') is typed based on definition!
      const posts = ctx.table('posts');
      return defineExports({ db: sqliteDb });
    },
  });

await workspace.whenSynced;
// workspace.ydoc.guid = 'my-workspace-0'
// workspace.extensions.sqlite.db is typed
```

### Why Builder Pattern?

1. `createCellWorkspace({ headDoc, definition })` locks in table types from the definition
2. `.withExtensions({ ... })` provides extensions with fully typed context
3. Extensions receive `table(tableId)` typed based on definition's table keys
4. TypeScript errors if you try to access a table not in the definition

## Implementation

### Phase 1: HeadDoc Integration

**Files Modified:**
- `src/cell/types.ts` - Added `CreateCellWorkspaceWithHeadDocOptions`, updated `CellWorkspaceClient` with `epoch`, `extensions`, `whenSynced`
- `src/cell/create-cell-workspace.ts` - Function overloads for legacy and HeadDoc APIs

**Key Changes:**
- Y.Doc guid is now `{workspaceId}-{epoch}` for time-travel support
- Workspace client exposes `epoch` property
- Legacy API (id-based) still works but is deprecated

```typescript
// New HeadDoc-based options
type CreateCellWorkspaceWithHeadDocOptions<TTableDefs> = {
  headDoc: { workspaceId: string; getEpoch(): number };
  definition: WorkspaceSchema & { tables: TTableDefs };
};

// Updated client type
type CellWorkspaceClient<TTableDefs, TExtensions> = {
  id: string;           // workspaceId (no epoch)
  epoch: number;        // Current epoch
  ydoc: Y.Doc;          // guid = '{workspaceId}-{epoch}'
  extensions: TExtensions;
  whenSynced: Promise<void>;
  destroy(): Promise<void>;
  // ... other properties
};
```

### Phase 2: Extension System with Builder Pattern

**Files Created:**
- `src/cell/extensions.ts` - Extension types and builder interface

**Extension Types:**

```typescript
// Context provided to extension factories
type CellExtensionContext<TTableDefs> = {
  ydoc: Y.Doc;
  workspaceId: string;
  epoch: number;
  table<K extends keyof TTableDefs>(tableId: K): TableHelper;
  kv: KvStore;
  definition: WorkspaceSchema & { tables: TTableDefs };
  extensionId: string;
};

// Extension factory function
type CellExtensionFactory<TTableDefs, TExports extends Lifecycle> =
  (context: CellExtensionContext<TTableDefs>) => TExports;

// Map of extension factories
type CellExtensionFactoryMap<TTableDefs> =
  Record<string, CellExtensionFactory<TTableDefs, Lifecycle>>;

// Builder interface
type CellWorkspaceBuilder<TTableDefs> = {
  withExtensions<TExtensions extends CellExtensionFactoryMap<TTableDefs>>(
    extensions: TExtensions
  ): CellWorkspaceClient<TTableDefs, InferCellExtensionExports<TExtensions>>;
};
```

**Implementation Details:**
- Extensions are initialized synchronously; async work tracked via `whenSynced`
- `defineExports()` normalizes extension returns (fills in default `whenSynced` and `destroy`)
- Workspace `whenSynced` aggregates all extension `whenSynced` promises
- Workspace `destroy` calls all extension `destroy` methods using `Promise.allSettled`

### Phase 3: Updated Exports

**Files Modified:**
- `package.json` - Added `/cell` subpath export
- `src/cell/index.ts` - Exports HeadDoc, extension types, lifecycle utilities
- `src/index.ts` - Exports Cell API types with `Cell*` prefix

**Export Structure:**

```json
// package.json exports
{
  ".": "./src/index.ts",
  "./cell": "./src/cell/index.ts",
  "./static": "./src/static/index.ts"
}
```

```typescript
// From @epicenter/hq
export { createCellWorkspace } from './cell';
export type {
  CellExtensionContext,
  CellExtensionFactory,
  CellExtensionFactoryMap,
  CellWorkspaceBuilder,
  CellWorkspaceClient,
  CreateCellWorkspaceWithHeadDocOptions,
  InferCellExtensionExports,
  WorkspaceSchema as CellWorkspaceSchema,
  SchemaTableDefinition as CellTableDefinition,
  SchemaFieldDefinition as CellFieldDefinition,
} from './cell';

// From @epicenter/hq/cell (full Cell API)
export { createHeadDoc, type HeadDoc } from '../core/docs/head-doc';
export { defineExports, type Lifecycle, type MaybePromise } from '../core/lifecycle';
export { createCellWorkspace } from './create-cell-workspace';
export type { CellExtensionContext, ... } from './extensions';
```

### Phase 4: Core Deprecation

**Files Modified:**
- `src/core/workspace/workspace.ts` - Added `@deprecated` JSDoc to `defineWorkspace` and `createClient`

**Deprecation Messages:**

```typescript
/**
 * @deprecated Use `createCellWorkspace` from `@epicenter/hq` or `@epicenter/hq/cell` instead.
 * The Cell API provides cell-level CRDT (better concurrent editing) and a simpler builder pattern.
 *
 * Migration:
 * // Old API (deprecated)
 * const client = createClient(head)
 *   .withDefinition({ tables: {...}, kv: {} })
 *   .withExtensions({ persistence });
 *
 * // New API (recommended)
 * const workspace = createCellWorkspace({
 *   headDoc,
 *   definition: { name: 'My Workspace', tables: {...} },
 * }).withExtensions({ persistence });
 */
export function createClient(...) { ... }
```

## API Comparison

| Feature | Core (deprecated) | Cell (new) |
|---------|-------------------|------------|
| Storage granularity | Row-level | Cell-level LWW |
| Concurrent editing | Whole row conflicts | Per-cell merging |
| HeadDoc integration | ✅ | ✅ |
| Epochs | ✅ | ✅ |
| Extension system | ✅ | ✅ |
| Typed extensions | ❌ | ✅ (from definition) |
| Builder pattern | `.withDefinition().withExtensions()` | `.withExtensions()` |
| Schema location | In code (field factories) | External JSON |

## Files Changed

| File | Changes |
|------|---------|
| `src/cell/create-cell-workspace.ts` | Accept headDoc, extensions; epoch-based doc ID; function overloads |
| `src/cell/types.ts` | Add `CreateCellWorkspaceWithHeadDocOptions`, update `CellWorkspaceClient` |
| `src/cell/index.ts` | Export HeadDoc, extension types, lifecycle utilities |
| `src/cell/extensions.ts` | NEW: Extension types and builder interface |
| `src/index.ts` | Export Cell API as primary |
| `package.json` | Add `/cell` subpath export |
| `src/core/workspace/workspace.ts` | Add deprecation annotations |
| `src/cell/create-cell-workspace.test.ts` | Add tests for HeadDoc API and extensions |

## Test Coverage

Added comprehensive tests for:

1. **Builder pattern** - `withExtensions` method returns correct client
2. **Epoch-based doc ID** - Y.Doc guid is `{workspaceId}-{epoch}`
3. **Extension initialization** - Extensions receive typed context
4. **Extension context** - Access to `workspaceId`, `epoch`, `ydoc`, `table()`, `kv`
5. **Multiple extensions** - All initialized with correct exports
6. **Lifecycle aggregation** - `whenSynced` waits for all extensions
7. **Destroy cleanup** - Calls all extension destroys and Y.Doc destroy
8. **Workspace functionality** - CRUD operations, KV store, batch, getTypedRows
9. **Legacy API compatibility** - Old id-based API still works

All 162 cell tests pass.

## Migration Guide

### From Core to Cell

```typescript
// Before (Core)
import { createHeadDoc, createClient, defineWorkspace } from '@epicenter/hq';

const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
const definition = defineWorkspace({
  tables: { posts: table({ name: 'Posts', fields: { id: id(), title: text() } }) },
  kv: {},
});
const client = createClient(head)
  .withDefinition(definition)
  .withExtensions({ persistence });

// After (Cell)
import { createHeadDoc, createCellWorkspace, defineExports } from '@epicenter/hq';

const headDoc = createHeadDoc({ workspaceId: 'blog', providers: {} });
const workspace = createCellWorkspace({
  headDoc,
  definition: {
    name: 'Blog',
    tables: {
      posts: { name: 'Posts', fields: { title: { name: 'Title', type: 'text', order: 1 } } },
    },
  },
}).withExtensions({
  persistence: (ctx) => {
    // Persistence extension implementation
    return defineExports({ whenSynced: provider.whenSynced, destroy: () => provider.destroy() });
  },
});
```

### Key Differences

1. **Schema format**: Field factories → JSON objects with `type`, `name`, `order`
2. **Builder steps**: Two steps → One step (definition and headDoc together)
3. **Extension context**: Generic → Typed based on definition
4. **KV**: Separate kv definition → Part of WorkspaceSchema

## Future Work

- [ ] Migrate existing Core extensions (sqlite, markdown) to Cell
- [ ] Update app code to use new Cell API
- [ ] Remove Core workspace code after migration complete
- [ ] Consider whether Static API should also use Cell storage
