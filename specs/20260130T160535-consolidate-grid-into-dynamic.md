# Consolidate Grid Implementation into Dynamic Namespace

**Date**: 2026-01-30
**Status**: Implemented
**Author**: AI-assisted
**Related**: `specs/20260130T025939-grid-workspace-api.md`, `specs/20260127T150000-dynamic-workspace-architecture.md`

## Overview

Replace the old Dynamic workspace implementation with Grid's implementation, using the `dynamic` namespace. This consolidates three overlapping systems (Cell, Grid, old Dynamic) into one canonical cell-level CRDT workspace API exported from `@epicenter/hq/dynamic`.

**Key Design Decision**: Static and Dynamic are completely separate sub-path exports. They do NOT export from root `index.ts`. This means no namespace prefixes are needed - both use `createWorkspace`, `WorkspaceClient`, etc.

## API Surface After Consolidation

### Import Patterns

```typescript
// Dynamic workspace (cell-level CRDT, external schema)
import { createWorkspace, WorkspaceClient } from '@epicenter/hq/dynamic';

// Static workspace (row-level CRDT, arktype schema, migrations)
import { createWorkspace, WorkspaceClient } from '@epicenter/hq/static';

// Core utilities (shared, if needed)
import { generateId, DateTimeString } from '@epicenter/hq';
```

### Dynamic Workspace Usage

```typescript
import {
  // Factory
  createWorkspace,

  // Field helpers (all 11)
  id, text, richtext, integer, real, boolean, date, select, tags, json, table,

  // Icon utilities
  createIcon, isIcon, parseIcon,

  // Key utilities (internal - not exported from public API)
  // Note: RowId was consolidated into Id (see specs/20260201T025500-consolidate-id-types.md)

  // HeadDoc (optional time travel)
  createHeadDoc,

  // Extension authoring
  defineExports,

  // Types
  type WorkspaceClient,
  type WorkspaceBuilder,
  type TableHelper,
  type ExtensionContext,
  type KvStore,
} from '@epicenter/hq/dynamic';

const workspace = createWorkspace({
  id: 'my-workspace',
  definition: {
    name: 'My Workspace',
    tables: [
      table({
        id: 'posts',
        name: 'Posts',
        fields: [
          id(),
          text({ id: 'title' }),
          richtext({ id: 'content' }),
          date({ id: 'createdAt' }),
          select({ id: 'status', options: ['draft', 'published'] as const }),
          tags({ id: 'categories', options: ['tech', 'design'] as const }),
        ],
      }),
    ],
    kv: [],
  },
  headDoc, // Optional - enables time travel, disables GC
}).withExtensions({
  persistence,
  sqlite,
});

// Access tables with validation
const posts = workspace.table('posts');
const result = posts.getRow('row123');
if (result.status === 'valid') {
  console.log(result.row.title);
}
```

### Type Naming (No Prefixes)

Since imports come from distinct paths, no "Dynamic" or "Static" prefix is needed:

| Current (Grid) | After Consolidation |
|----------------|---------------------|
| `createGridWorkspace` | `createWorkspace` |
| `GridWorkspaceClient` | `WorkspaceClient` |
| `GridWorkspaceBuilder` | `WorkspaceBuilder` |
| `GridTableHelper` | `TableHelper` |
| `GridExtensionContext` | `ExtensionContext` |
| `GridKvStore` | `KvStore` |

### Field Helpers Inventory

All 11 field helpers available from `@epicenter/hq/dynamic`:

1. **`id()`** - Primary key, always NOT NULL
2. **`text({ id, nullable?, default? })`** - String field
3. **`richtext({ id })`** - Y.Doc reference (always nullable, lazy creation)
4. **`integer({ id, nullable?, default? })`** - Integer field
5. **`real({ id, nullable?, default? })`** - Float field
6. **`boolean({ id, nullable?, default? })`** - Boolean field
7. **`date({ id, nullable?, default? })`** - Temporal.ZonedDateTime with timezone
8. **`select({ id, options, nullable?, default? })`** - Single choice from tuple
9. **`tags({ id, options?, nullable?, default? })`** - Array of strings
10. **`json({ id, schema, nullable?, default? })`** - TypeBox-validated JSON
11. **`table({ id, name, fields, description?, icon? })`** - Table definition

## Motivation

### Current State

Three workspace implementations exist with significant overlap:

```
packages/epicenter/src/
├── cell/                    # Cell-level CRDT with legacy API baggage
├── grid/                    # Cell-level CRDT with clean API (newest)
└── dynamic/                 # Runtime-editable schema (superseded design)
```

**Cell** is actively used but has dual overloads:

```typescript
// Legacy overload (returns client directly, no extensions)
const client = createCellWorkspace({
  id: 'my-workspace',
  definition,
});

// HeadDoc overload (returns builder, supports extensions)
const builder = createCellWorkspace({
  headDoc,
  definition,
});
const client = builder.withExtensions({ ... });
```

**Grid** has the clean API we want:

```typescript
// Single pattern: always builder, HeadDoc optional
const client = createGridWorkspace({
  id: 'my-workspace',
  definition,
  headDoc,  // Optional
}).withExtensions({ ... });
```

**Old Dynamic** stores schema IN the Y.Doc (superseded):

```typescript
// Creates/modifies schema at runtime
workspace.tables.create('posts', { name: 'Posts' });
workspace.fields.create('posts', 'title', { type: 'text' });
```

This creates problems:

1. **Maintenance burden**: Three implementations doing similar things
2. **Confusion**: Which API should new code use?
3. **Inconsistent APIs**: Cell has legacy baggage, Grid is cleaner
4. **Namespace waste**: "dynamic" implies runtime schema editing, but that design is superseded

### Desired State

One canonical implementation in `@epicenter/hq/dynamic` with clean naming:

```typescript
import { createWorkspace } from '@epicenter/hq/dynamic';

const client = createWorkspace({
  id: 'my-workspace',
  definition,
  headDoc, // Optional
}).withExtensions({
  persistence,
  sqlite,
});
```

The name "dynamic" refers to the cell-level granularity (vs Static's row-level), not runtime schema editing.

## Research Findings

### Feature Comparison

| Feature                      | Cell                                | Grid                                         | Old Dynamic |
| ---------------------------- | ----------------------------------- | -------------------------------------------- | ----------- |
| **Schema location**          | External JSON                       | External JSON                                | In Y.Doc    |
| **LWW granularity**          | Cell-level                          | Cell-level                                   | Cell-level  |
| **HeadDoc support**          | Optional                            | Optional                                     | None        |
| **Extension system**         | Builder pattern                     | Builder pattern                              | None        |
| **Legacy API**               | Yes (dual overloads)                | No                                           | N/A         |
| **`getTypedRows()`**         | Yes                                 | No                                           | No          |
| **TypeBox converters**       | Yes (exported)                      | Uses Cell's                                  | N/A         |
| **Schema file utils**        | Yes (`parseSchema`, `getTableById`) | Uses `getTableById` inline                   | N/A         |
| **`createRow` overloads**    | Simple only                         | Simple + options object                      | Via stores  |
| **`setRow` method**          | No                                  | Yes                                          | N/A         |
| **Extension context typing** | `CellExtensionContext`              | `GridExtensionContext<TTableDefs>` (generic) | N/A         |

**Key finding**: Grid is essentially Cell v2 with cleaner typing and no legacy API.

**Implication**: Use Grid's implementation, but ensure we don't lose Cell's utility exports.

### Export Analysis

**Cell exports these utilities that Grid doesn't (must preserve):**

```typescript
// From cell/index.ts - utilities that should move to dynamic
export {
  schemaFieldToTypebox,
  schemaTableToTypebox,
} from './converters/to-typebox';
export { getTableById, parseSchema } from './schema-file';
export type {
  CellResult,
  GetCellResult,
  NotFoundCellResult,
  ValidCellResult,
  InvalidCellResult,
} from './validation-types';
```

**Grid already imports from Cell:**

```typescript
// grid/grid-table-helper.ts line 22-24
import {
  schemaFieldToTypebox,
  schemaTableToTypebox,
} from '../cell/converters/to-typebox';
```

**Key finding**: Grid depends on Cell's converters. These should become shared core utilities.

### Naming Analysis

| Name      | What It Implies            | Actual Behavior                                               |
| --------- | -------------------------- | ------------------------------------------------------------- |
| "Static"  | Fixed schema, compile-time | Row-level LWW, migrations                                     |
| "Cell"    | Cell granularity           | Cell-level LWW, external schema                               |
| "Grid"    | Visual layout              | Cell-level LWW, external schema                               |
| "Dynamic" | Runtime schema editing     | **Currently**: runtime editable; **Proposed**: cell-level LWW |

**Key finding**: "Dynamic" vs "Static" is a meaningful distinction if we redefine "Dynamic" to mean "cell-level granularity with flexible schema validation" rather than "schema stored in CRDT".

## Design Decisions

| Decision                 | Choice                          | Rationale                                                        |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------- |
| Namespace                | `dynamic`                       | Already exists, avoids new import paths, contrasts with `static` |
| Implementation           | Grid's                          | Cleaner API, no legacy baggage, better typing                    |
| Factory name             | `createWorkspace`               | No prefix needed - import path provides context                  |
| Type names               | `WorkspaceClient`, etc.         | No prefix needed - import path provides context                  |
| Root index.ts            | Does NOT export dynamic/static  | Separate sub-paths, no collisions                                |
| TypeBox converters       | Move to core                    | Used by both Grid and Cell; avoid circular deps                  |
| Schema file utils        | Move to core                    | General-purpose utilities                                        |
| `getTypedRows()`         | Defer                           | Cell has it, Grid doesn't; add later if needed                   |
| Cell folder              | Delete                          | All functionality moves to dynamic or core                       |
| Grid folder              | Delete                          | All functionality moves to dynamic                               |
| Old Dynamic              | Delete                          | Superseded design, no external users                             |
| Backwards compatibility  | Clean break                     | No type aliases, no re-exports from old paths                    |

## Architecture

### Current Structure

```
packages/epicenter/src/
├── core/                           # Shared utilities (keep)
│   ├── schema/fields/              # Field types and factories
│   ├── tables/                     # Row-level table helpers (Static)
│   └── utils/y-keyvalue-lww.ts     # LWW CRDT primitive
│
├── cell/                           # TO DELETE
│   ├── converters/to-typebox.ts    # → Move to core
│   ├── schema-file.ts              # → Move to core
│   ├── validation-types.ts         # → Move to dynamic
│   ├── keys.ts                     # → Already duplicated in grid
│   ├── table-helper.ts             # → Superseded by grid
│   └── ...
│
├── grid/                           # TO MERGE INTO DYNAMIC
│   ├── create-grid-workspace.ts    # → Rename to create-workspace.ts
│   ├── grid-table-helper.ts        # → Rename to table-helper.ts
│   ├── extensions.ts               # → Keep, rename types
│   └── ...
│
└── dynamic/                        # OLD - TO DELETE AND REPLACE
    ├── create-dynamic-workspace.ts # → Delete (old implementation)
    └── ...
```

### Target Structure

```
packages/epicenter/src/
├── core/
│   ├── schema/
│   │   ├── fields/                 # (unchanged)
│   │   ├── converters/             # NEW: TypeBox/Arktype converters
│   │   │   └── to-typebox.ts       # ← from cell/converters
│   │   └── schema-file.ts          # ← from cell/schema-file.ts
│   └── ...
│
├── static/                         # (unchanged, separate sub-path)
│   └── index.ts                    # Exports createWorkspace, WorkspaceClient, etc.
│
├── dynamic/                        # REPLACED with Grid implementation
│   ├── index.ts                    # Exports createWorkspace, WorkspaceClient, etc.
│   ├── types.ts                    # Type definitions (no Grid prefix)
│   ├── create-workspace.ts         # ← from grid/create-grid-workspace.ts
│   ├── table-helper.ts             # ← from grid/grid-table-helper.ts
│   ├── extensions.ts               # ← from grid/extensions.ts
│   ├── validation-types.ts         # ← from cell/validation-types.ts
│   ├── stores/
│   │   └── kv-store.ts             # ← from grid/stores/kv-store.ts
│   └── keys.ts                     # ← from grid/keys.ts
│
├── cell/                           # DELETED
├── grid/                           # DELETED
│
└── index.ts                        # Core utilities only (NOT static/dynamic)
```

### Package Exports Configuration

Update `package.json` exports:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./dynamic": "./dist/dynamic/index.js",
    "./static": "./dist/static/index.js"
  }
}
```

## Implementation Plan

### Phase 1: Move Shared Utilities to Core

- [ ] **1.1** Create `core/schema/converters/` directory
- [ ] **1.2** Move `cell/converters/to-typebox.ts` to `core/schema/converters/to-typebox.ts`
- [ ] **1.3** Update imports in Grid's `grid-table-helper.ts` to use new core path
- [ ] **1.4** Move `cell/schema-file.ts` to `core/schema/schema-file.ts`
- [ ] **1.5** Export new utilities from `core/schema/index.ts`
- [ ] **1.6** Verify Cell and Grid still work with new import paths

### Phase 2: Replace Dynamic with Grid Implementation

- [ ] **2.1** Delete all files in `dynamic/` (old implementation)
- [ ] **2.2** Copy `grid/create-grid-workspace.ts` → `dynamic/create-workspace.ts`
- [ ] **2.3** Copy `grid/grid-table-helper.ts` → `dynamic/table-helper.ts`
- [ ] **2.4** Copy `grid/extensions.ts` → `dynamic/extensions.ts`
- [ ] **2.5** Copy `grid/types.ts` → `dynamic/types.ts`
- [ ] **2.6** Copy `grid/keys.ts` → `dynamic/keys.ts`
- [ ] **2.7** Copy `grid/stores/kv-store.ts` → `dynamic/stores/kv-store.ts`
- [ ] **2.8** Copy `cell/validation-types.ts` → `dynamic/validation-types.ts`

### Phase 3: Rename - Remove Prefixes

- [ ] **3.1** In `dynamic/create-workspace.ts`:
  - Rename `createGridWorkspace` → `createWorkspace`
  - Rename `GridWorkspaceBuilder` → `WorkspaceBuilder`
  - Rename `GridWorkspaceClient` → `WorkspaceClient`
  - Update internal imports to use `./` paths
- [ ] **3.2** In `dynamic/table-helper.ts`:
  - Rename `createGridTableHelper` → `createTableHelper`
  - Rename `GridTableHelper` → `TableHelper`
  - Update imports to use `../core/schema/converters/to-typebox`
- [ ] **3.3** In `dynamic/extensions.ts`:
  - Rename `GridExtensionContext` → `ExtensionContext`
  - Rename `GridExtensionFactory` → `ExtensionFactory`
  - Rename all `Grid*` types to remove prefix
- [ ] **3.4** In `dynamic/types.ts`:
  - Rename all `Grid*` types to remove prefix
- [ ] **3.5** In `dynamic/stores/kv-store.ts`:
  - Rename `GridKvStore` → `KvStore`
  - Rename `createGridKvStore` → `createKvStore`
- [ ] **3.6** Create new `dynamic/index.ts` with all exports (no prefixes)

### Phase 4: Update Root Package Exports

- [ ] **4.1** Update `src/index.ts`:
  - Remove Cell re-exports
  - Remove Grid re-exports
  - Do NOT add Dynamic exports (separate sub-path)
  - Keep core utilities only
- [ ] **4.2** Update `package.json` exports map for sub-paths

### Phase 5: Update Dependents

- [ ] **5.1** Search for all `@epicenter/hq/cell` imports in the codebase
- [ ] **5.2** Search for all `@epicenter/hq/grid` imports in the codebase
- [ ] **5.3** Update extension documentation (`persistence`, `sqlite`, `websocket-sync`)
- [ ] **5.4** Update test files to use new imports
- [ ] **5.5** Update JSDoc examples throughout

### Phase 6: Delete Old Code

- [ ] **6.1** Delete `src/cell/` directory entirely
- [ ] **6.2** Delete `src/grid/` directory entirely
- [ ] **6.3** Run full test suite
- [ ] **6.4** Run type check

### Phase 7: Verify and Document

- [ ] **7.1** Ensure all tests pass
- [ ] **7.2** Ensure type checking passes
- [ ] **7.3** Update package README if needed
- [ ] **7.4** Update any JSDoc that references old names
- [ ] **7.5** Mark spec as Implemented

## Edge Cases

### Extension Documentation References Cell

1. All extension JSDoc examples reference `createCellWorkspace`
2. During migration, update these to `createWorkspace` (from `@epicenter/hq/dynamic`)
3. Search pattern: `createCellWorkspace` in `src/extensions/`

### Grid Imports from Cell

1. `grid/grid-table-helper.ts` imports from `../cell/converters/to-typebox`
2. After Phase 1, this becomes `../core/schema/converters/to-typebox`
3. After Phase 2-3, this becomes `./` relative path within dynamic

### Tests Reference Old Paths

1. Test files like `create-cell-workspace.test.ts` use Cell imports
2. After Phase 5, tests should be renamed and updated
3. Consider keeping test coverage, just updating imports

### Main Index Should NOT Export Dynamic/Static

1. `src/index.ts` currently exports `CellWorkspaceClient`, etc.
2. After migration, root index exports ONLY core utilities
3. Dynamic types come from `@epicenter/hq/dynamic`
4. Static types come from `@epicenter/hq/static`

## Open Questions

1. **Should we add backwards-compatible type aliases?**
   - Options: (a) Add aliases like `type CellWorkspaceClient = WorkspaceClient`, (b) Clean break
   - **Decision**: Clean break. No external consumers yet; internal migration is manageable.

2. **Should `getTypedRows()` be added to Dynamic?**
   - Cell has this method on the client; Grid doesn't
   - **Recommendation**: Defer. Add later if usage patterns demand it.

3. **Should validation-types stay separate or merge into types.ts?**
   - Cell has `validation-types.ts` separate from `types.ts`
   - Grid inlines these in `types.ts`
   - **Recommendation**: Keep separate for clarity; validation types are reusable.

4. **Should `createWorkspaceYDoc` be exported from dynamic or core?**
   - Grid exports it from `grid/index.ts`
   - It's a general utility that could benefit Static too
   - **Recommendation**: Export from dynamic. Core shouldn't know about workspace-specific Y.Doc setup.

## Success Criteria

- [x] `createWorkspace` from `@epicenter/hq/dynamic` works identically to current `createGridWorkspace`
- [x] `createWorkspace` from `@epicenter/hq/static` unchanged
- [x] All existing Grid tests pass with renamed imports
- [x] No `cell/` or `grid/` directories remain
- [x] `@epicenter/hq/dynamic` exports all necessary types and utilities
- [x] `@epicenter/hq` does NOT export dynamic/static workspace APIs
- [x] Extension examples work with `createWorkspace` from dynamic
- [x] TypeScript type checking passes (pre-existing issues in scripts/tests unrelated to this change)
- [x] Full test suite passes (509 tests pass)
- [x] No runtime regressions in workspace functionality
- [x] All JSDoc updated to reflect new naming

## References

- `packages/epicenter/src/grid/create-grid-workspace.ts` - Source implementation to move
- `packages/epicenter/src/grid/grid-table-helper.ts` - Table helper to move
- `packages/epicenter/src/cell/converters/to-typebox.ts` - Converter to move to core
- `packages/epicenter/src/cell/schema-file.ts` - Utilities to move to core
- `packages/epicenter/src/cell/validation-types.ts` - Types to move to dynamic
- `packages/epicenter/src/index.ts` - Main exports to update
- `specs/20260130T025939-grid-workspace-api.md` - Original Grid spec
- `specs/20260127T150000-dynamic-workspace-architecture.md` - Old Dynamic spec (historical context)
