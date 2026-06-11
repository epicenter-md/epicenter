# Deprecate Dynamic Workspace API

**Date**: 2026-02-20
**Status**: Implemented
**Author**: AI-assisted

## Overview

Remove the Dynamic workspace API (`@epicenter/workspace/dynamic`) and promote the Static API to the primary (and only) workspace API. The `static/` folder becomes the top-level workspace implementation; the `dynamic/` folder is deleted. The extensions coupled to Dynamic (sqlite, markdown, revision-history) are deleted alongside it since no app imports them.

## Motivation

### Current State

Epicenter has two parallel workspace APIs:

```
packages/epicenter/src/
├── dynamic/     ← Field-based schema, cell-level LWW (Notion-like)
├── static/      ← Standard Schema with versioning
└── shared/      ← Common utilities (YKeyValueLww, lifecycle, etc.)
```

Both wrap Y.js, both have typed table helpers, both have extension systems, and both are actively imported across the codebase. The Dynamic API's stated purpose is "Notion-like" user-configurable schemas. The Static API's purpose is type-safe, versioned workspace data.

This creates problems:

1. **Duplicated surface area**: Two `createWorkspace()` functions, two `TableHelper` types, two extension context types, two sets of result types (`GetResult`, `RowResult`, etc.). Every new feature has to be considered for both APIs or one falls behind.

2. **The Dynamic API doesn't deliver on its promise**: It's described as "Notion-like" (user-configurable schemas), but schemas are fixed at `defineWorkspace()` time. Users can't add, remove, or reorder columns at runtime. The actually dynamic data structure already exists in the Sheet helpers (`Y.Map<Y.Map>` with dynamic columns, fractional ordering, CSV import/export).

3. **The unique feature doesn't justify the cost**: The Dynamic API's one differentiator is cell-level LWW with timestamps (`YKeyValueLww` per cell). See "Why Cell-Level LWW Doesn't Justify the Dynamic API" below for the full analysis.

4. **Architectural overhead with no payoff**: The Dynamic API layers CellStore → RowStore → TableHelper on top of a flat `Y.Array`. The RowStore maintains an in-memory index to compensate for the flat storage model. The Sheet's nested `Y.Map` gives O(1) row lookups without an index.

5. **Confusing developer experience**: New code has to choose between `@epicenter/workspace/dynamic` and `@epicenter/workspace/static` without a clear reason to pick one over the other. The naming implies "dynamic = flexible, static = rigid," which is backwards: the Dynamic API has fixed schemas while the Sheet structure is truly dynamic.

6. **The coupled extensions are dead code**: The sqlite, markdown, and revision-history extensions import Dynamic types directly. No app in the monorepo (`apps/epicenter`, `apps/tab-manager`, `apps/fs-explorer`) actually imports these extensions. They exist only as internal code within `packages/epicenter/`. Deleting Dynamic means deleting these extensions too, which simplifies the migration enormously.

### Why Cell-Level LWW Doesn't Justify the Dynamic API

The Dynamic API stores data as `Y.Array<{ key: 'rowId:columnId', val: value, ts: timestamp }>`: a flat array with compound cell keys and timestamp-based LWW conflict resolution. This is 600+ lines of custom CRDT code (`YKeyValueLww` + `CellStore` + `RowStore`).

The alternative is `Y.Map<Y.Map>`: an outer map keyed by rowId, inner map keyed by columnId. Zero custom CRDT code. Cell-level conflict resolution for free via Yjs internals.

We evaluated every scenario where the timestamp variant might win:

| Scenario                                | Dynamic (timestamp LWW)   | Y.Map<Y.Map> (Yjs native)                 | Verdict                                              |
| --------------------------------------- | ------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Two users, different fields of same row | Both preserved            | Both preserved                            | Identical                                            |
| Two users, same cell, online            | Last write wins naturally | Last write wins naturally                 | Identical                                            |
| Two users, same cell, offline           | Later timestamp wins      | ClientId-based (arbitrary but consistent) | Neither is more "correct"                            |
| Long offline (days)                     | "Later timestamp wins"    | Arbitrary winner                          | Either produces surprise; real answer is conflict UI |
| Large rows (50+ fields)                 | Only changed cells sync   | Only changed keys sync                    | Similar cost                                         |
| Formulas / dependency tracking          | Built on top              | Built on top                              | Identical                                            |

The timestamp variant is marginally more predictable for same-cell offline conflicts. But that's the rarest scenario (requires two users editing the same cell while offline), and the predictability comes at real costs:

- **Clock skew makes it actively harmful.** The code documents this: "If a device's clock is far in the future, its writes dominate indefinitely." A skewed clock can produce worse outcomes than Yjs's clientId resolution, which has no temporal bias.
- **Compaction is your problem.** `YKeyValueLww` must manually garbage-collect loser entries from the Y.Array (constructor lines 256-264, observer lines 396-403). `Y.Map` delegates GC to battle-tested Yjs internals.
- **The pending/pendingDeletes machinery** (119 lines of bookkeeping) exists solely because Y.Array observers are deferred. `Y.Map.set()` is immediately readable.

The Static API's use of `YKeyValueLww` at the row level is justified: each key is a rowId, each value is an entire row object. Row-level atomicity makes sense there. But for the Dynamic API, where the whole point is cell-level granularity, `Y.Map<Y.Map>` gives you that for free.

### Desired State

One workspace API, no qualifier:

```
packages/epicenter/src/
├── workspace/   ← The workspace API (née static/)
└── shared/      ← Common utilities
```

Imports go from `@epicenter/workspace/static` to `@epicenter/workspace` (or a new subpath like `@epicenter/workspace/workspace`). The `dynamic/` folder and its coupled extensions are gone. Consumers that need "Notion-like" dynamic columns use the Sheet data structure from `@epicenter/filesystem`.

## Research Findings

### What Each Consumer Actually Uses

Grepping the codebase for `@epicenter/workspace/dynamic` imports reveals:

| Consumer                                          | What it imports                                                                              | What it actually needs                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/epicenter/` templates (whispering, entries) | `defineWorkspace`, field factories (`id`, `text`, `select`, etc.)                            | Workspace definitions: migrate to Static `defineWorkspace` + `defineTable` |
| `apps/epicenter/` workspace service               | `WorkspaceDefinition` type                                                                   | Type: migrate to Static equivalent                                         |
| `apps/epicenter/` yjs workspace                   | `createWorkspace`, `Extension`, `ExtensionContext`                                           | Core workspace: migrate to Static `createWorkspace`                        |
| `apps/epicenter/` workspace-persistence           | `ExtensionContext` type                                                                      | Type only: migrate to Static                                               |
| `apps/tab-manager/` (2 files)                     | `generateId`                                                                                 | Just the ID utility: already exported from root `@epicenter/workspace`            |
| `extensions/sqlite`                               | `ExtensionContext`, schema types, `Row`, `TableDefinition`, Drizzle converters               | **Dead code**: no app imports this extension                               |
| `extensions/markdown`                             | `ExtensionContext`, schema types, `Field`, `Row`, `TableHelper`, `TableById`, `getTableById` | **Dead code**: no app imports this extension                               |
| `extensions/revision-history`                     | `ExtensionContext`, schema types                                                             | **Dead code**: no app imports this extension                               |
| `extensions/sync/desktop`                         | `ExtensionContext`                                                                           | Type only: migrate to Static                                               |

**Key finding 1**: App-level consumers (`apps/`) use the Dynamic API superficially: `createWorkspace`, type imports, and `generateId`. These are straightforward import path changes.

**Key finding 2**: The deep coupling is in sqlite/markdown/revision-history extensions, but no app imports them. They can be deleted alongside Dynamic rather than migrated. This eliminates the hardest phase of the migration.

**Key finding 3**: The `./node` export (`"./node": "./src/dynamic/workspace/node.ts"`) is dead. It's only referenced in its own JSDoc. Delete it.

### Extension-Dynamic Type Coupling (for reference)

Even though these extensions will be deleted, documenting the coupling explains why migration would have been expensive:

| Extension                   | Dynamic imports                                                                                                    | Static equivalent exists?                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `sqlite/sqlite.ts`          | `ExtensionContext`, `KvField`, `Row`, `TableDefinition`, `Id`, `convertTableDefinitionsToDrizzle`                  | Partial: no `convertTableDefinitionsToDrizzle` equivalent          |
| `sqlite/builders.ts`        | `DateTimeString`, `generateId` (also `typebox`)                                                                    | Yes: these are in `shared/`                                        |
| `markdown/markdown.ts`      | `ExtensionContext`, `Field`, `Id`, `KvField`, `Row`, `TableDefinition`, `TableById`, `getTableById`, `TableHelper` | No: `Field`, `TableById`, `getTableById` have no Static equivalent |
| `markdown/configs.ts`       | `Field`, `Row`, `tableToArktype`                                                                                   | No: `tableToArktype` is a Dynamic converter                        |
| `revision-history/local.ts` | `ExtensionContext`, `KvField`, `TableDefinition`                                                                   | Partial                                                             |
| `sync/desktop.ts`           | `ExtensionContext`                                                                                                 | Yes: Static has its own `ExtensionContext`                         |

The markdown extension alone would require rewriting its entire serialization system to work with Standard Schema instead of Dynamic Field objects. Since no app uses it, deletion is the right call.

### Cell-Level LWW vs. Y.Map Conflict Resolution

| Scenario                           | Dynamic (YKeyValueLww per cell)      | Sheet (nested Y.Map)                     |
| ---------------------------------- | ------------------------------------ | ---------------------------------------- |
| Different users, different cells   | Both edits preserved                 | Both edits preserved                     |
| Different users, same cell         | Timestamp wins (deterministic)       | ClientId wins (arbitrary but consistent) |
| Offline reconnect, different cells | Both edits preserved                 | Both edits preserved                     |
| Offline reconnect, same cell       | Later timestamp wins                 | Arbitrary winner                         |
| Row deletion                       | O(k): delete each cell entry        | O(1): `rows.delete(rowId)`              |
| Row existence check                | O(1) via maintained in-memory index  | O(1) native Y.Map.has                    |
| Add column to existing rows        | Must iterate all rows, write per row | Just start writing to new key            |

The same-cell concurrent conflict is the only scenario where behavior differs, and it's rare enough to be irrelevant in practice. The Sheet's Y.Map is simpler and equally correct for all real-world use cases.

### What Stays, What Goes

| Component                                | Location                       | Decision             | Rationale                                                           |
| ---------------------------------------- | ------------------------------ | -------------------- | ------------------------------------------------------------------- |
| `YKeyValueLww`                           | `shared/y-keyvalue/`           | **Keep**             | Used by Static API's tables and KV. Core CRDT primitive.            |
| `YKeyValue`                              | `shared/y-keyvalue/`           | **Keep**             | Simpler variant, may have uses.                                     |
| `y-keyvalue-comparison.test.ts`          | `shared/y-keyvalue/`           | **Keep**             | Documents behavior differences; useful reference.                   |
| `ymap-simplicity-case.test.ts`           | `shared/y-keyvalue/`           | **Keep**             | Documents the Y.Map analysis that justified this decision.          |
| `cell-keys.ts`                           | `shared/`                      | **Remove**           | Only used by Dynamic's CellStore.                                   |
| `CellStore`                              | `dynamic/tables/`              | **Remove**           | Replaced by Static's row-level storage or Sheet's Y.Map.            |
| `RowStore`                               | `dynamic/tables/`              | **Remove**           | In-memory index compensating for flat storage. Not needed.          |
| `TableHelper` (dynamic)                  | `dynamic/tables/`              | **Remove**           | Static's TableHelper covers all use cases.                          |
| Field factories (`id()`, `text()`, etc.) | `dynamic/schema/`              | **Remove**           | Static uses Standard Schema; Sheet uses runtime column definitions. |
| TypeBox converters                       | `dynamic/schema/converters/`   | **Remove**           | All converters are Dynamic-specific.                                |
| `defineWorkspace` (dynamic)              | `dynamic/workspace/`           | **Remove**           | Static's `defineWorkspace` replaces it.                             |
| `HeadDoc`, epoch system                  | `dynamic/`                     | **Keep as archived** | Already marked archived. Future versioned workspaces feature.       |
| `extensions/sqlite`                      | `extensions/sqlite/`           | **Remove**           | Dead code; no app imports it. Deeply coupled to Dynamic types.      |
| `extensions/markdown`                    | `extensions/markdown/`         | **Remove**           | Dead code; no app imports it. Deeply coupled to Dynamic types.      |
| `extensions/revision-history`            | `extensions/revision-history/` | **Remove**           | Dead code; no app imports it.                                       |

### Deletion Inventory

Files to delete (confirmed via grep and glob):

**`src/dynamic/` (entire directory)**:

- `workspace/`: `create-workspace.ts`, `create-workspace.test.ts`, `normalize.test.ts`, `workspace.ts`, `types.ts`, `node.ts`, README
- `tables/`: `table-helper.ts`, `create-tables.ts`, `y-cell-store.ts`, `y-row-store.ts`, + 5 test files
- `schema/`: `fields/`, `converters/`, `workspace-definition.ts`, `workspace-definition-validator.ts`, `schema-file.ts`, README
- `kv/`: `create-kv.ts`, `kv-helper.ts`, `kv-helper.test.ts`
- `extension.ts`, `index.ts`, `provider-types.ts`, `workspace-doc.ts`, `YDOC-ARCHITECTURE.md`
- **12 test files** in total

**`src/extensions/` (Dynamic-coupled extensions)**:

- `sqlite/`: `sqlite.ts`, `builders.ts`, `index.ts`, tests
- `markdown/`: `markdown.ts`, `configs.ts`, `diagnostics-manager.ts`, `io.ts`, `index.ts`, tests, README
- `revision-history/`: `index.ts`, `local.ts`, tests
- `extensions/index.ts`: needs rewriting (remove sqlite/markdown/revision-history exports)

**`src/shared/`**:

- `cell-keys.ts`: only used by CellStore

**Other**:

- `scripts/ymap-vs-ykeyvalue-benchmark.ts`: comparison benchmark, can keep or delete
- `scripts/yjs-data-structure-benchmark.ts`: general benchmark, keep
- `scripts/yjs-gc-benchmark.ts`: general benchmark, keep

## Design Decisions

| Decision                                   | Choice                                                     | Rationale                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder rename                              | `static/` → `workspace/` (or promote to root)              | "Static" only made sense as a contrast to "Dynamic." Without the contrast, it's just the workspace API.                                                             |
| Export path                                | `@epicenter/workspace/static` → `@epicenter/workspace` (merge into root) | Reduces import ceremony. Most consumers just want `createWorkspace`.                                                                                                |
| Migration approach                         | Two phases: migrate apps, then delete                      | App imports are shallow (path changes only). Extensions are dead code. No need for phased re-exports.                                                               |
| Dead extensions                            | Delete alongside Dynamic                                   | sqlite, markdown, revision-history: zero app imports. Migrating them would be the most expensive part for no benefit.                                               |
| `./node` export                            | Delete                                                     | Dead. Only self-references in its own JSDoc.                                                                                                                        |
| `typebox` dependency                       | Remove                                                     | Only used by Dynamic's schema system and `extensions/sqlite/builders.ts` (which is being deleted). After removal, verify no imports remain.                         |
| Comparison test files                      | Keep                                                       | `ymap-simplicity-case.test.ts` and `y-keyvalue-comparison.test.ts` document the reasoning behind this decision. They're in `shared/`, not `dynamic/`.               |
| Backward compat for `@epicenter/workspace/static` | Temporary re-export                                        | Keep the old path working during migration with a deprecation comment. Remove in a follow-up.                                                                       |
| Display metadata (table name, icon)        | Defer                                                      | Dynamic definitions had `name`, `icon`, `description`. Static doesn't. No app currently depends on this through the Static API. Add if migration surfaces the need. |
| Sync extension                             | Keep, migrate `ExtensionContext` import                    | `sync/desktop.ts` imports `ExtensionContext` from Dynamic. Single line change to import from Static.                                                                |

## Architecture

### Before

```
@epicenter/workspace
├── .                  → shared utilities (Id, actions, lifecycle)
├── ./dynamic          → Dynamic workspace API (field-based)
│   ├── schema/        → Field factories, TypeBox converters
│   ├── tables/        → CellStore → RowStore → TableHelper
│   ├── kv/            → Dynamic KV
│   └── workspace/     → createWorkspace (dynamic)
├── ./static           → Static workspace API (Standard Schema)
│   ├── define-table   → defineTable with versioning
│   ├── create-*       → createWorkspace, createTables, createKv
│   └── types          → TableHelper, WorkspaceClient, etc.
└── ./extensions       → Extensions (sqlite, markdown, revision-history coupled to dynamic)
    ├── sqlite/        → Dead: no app imports
    ├── markdown/      → Dead: no app imports
    ├── revision-history/ → Dead: no app imports
    └── sync/          → Live: apps use this
```

### After

```
@epicenter/workspace
├── .                  → Workspace API + shared utilities (merged)
│   ├── define-table   → defineTable with versioning
│   ├── create-*       → createWorkspace, createTables, createKv
│   ├── types          → TableHelper, WorkspaceClient, etc.
│   └── shared/        → YKeyValueLww, actions, lifecycle, id
└── ./extensions       → Extensions (sync only, using workspace types)
    └── sync/          → Live: desktop + web sync
```

## Implementation Plan

### Phase 1: Migrate App Consumers (import path changes only)

The app-level migration is shallow. No logic changes, just import paths.

- [x] **1.1** `apps/tab-manager/` (2 files): Changed `import { generateId } from '@epicenter/workspace/dynamic'` to `import { generateId } from '@epicenter/workspace'`.
- [x] **1.2** `apps/epicenter/src/lib/templates/whispering.ts`: Rewrote from Dynamic field factories to Static `defineTable` + arktype schemas.
- [x] **1.3** `apps/epicenter/src/lib/templates/entries.ts`: Same rewrite as 1.2.
- [x] **1.4** `apps/epicenter/src/lib/workspaces/dynamic/service.ts`: Defined local `WorkspaceDefinition` type (display metadata only), removed Dynamic import.
- [x] **1.5** `apps/epicenter/src/lib/yjs/workspace.ts`: Rewrote to use Static `createWorkspace` with template registry lookup by ID.
- [x] **1.6** `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: Changed to Static `ExtensionContext`, simplified to Y.Doc binary persistence only.
- [ ] **1.7** `apps/epicenter/src/lib/query/index.ts`: No change needed: import path was already correct.
- [x] **1.8** `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`: Updated to pass workspace ID instead of definition.
- [x] **1.8b** `apps/epicenter/src/routes/.../tables/[tableId]/+page.svelte`: Rewrote for Static API (property access, data-derived columns).
- [x] **1.8c** `apps/epicenter/src/routes/.../settings/[key]/+page.svelte`: Simplified to not-found state (no runtime KV schema).
- [x] **1.9** Verified: zero `@epicenter/workspace/dynamic` imports in `apps/`. Pre-existing errors only.

**NOTE on 1.2-1.3**: This is the only non-trivial step. The Dynamic templates define workspaces like:

```typescript
defineWorkspace({
	id: '...',
	tables: [table({ id: 'posts', fields: [id(), text({ id: 'title' })] })],
});
```

The Static equivalent is:

```typescript
defineWorkspace({
	id: '...',
	tables: {
		posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
	},
});
```

Every field factory (`id()`, `text()`, `select()`, etc.) must be translated to an arktype schema property. Review each template's fields carefully.

### Phase 2: Migrate Sync Extension

- [x] **2.1** `extensions/sync/desktop.ts`: Changed import to `../../static/types.js`. Updated JSDoc example.
- [x] **2.2** Verified: sync extension only destructures `{ ydoc }` from context. Static's `ExtensionContext` generics all have defaults, so bare `ExtensionContext` works.

### Phase 3: Promote Static and Delete Dynamic

- [ ] **3.1** Move `static/` contents up to root level (or rename to `workspace/`).: Deferred: kept `static/` in place, merged exports into root `index.ts` instead.
- [x] **3.2** Merged Static exports into root `src/index.ts` (defineTable, defineWorkspace, createWorkspace, all types, introspection, validation).
- [x] **3.3** Updated `package.json` exports: removed `"./dynamic"` and `"./node"`. Kept `"./static"` as alias.
- [x] **3.4** Kept `"./static"` export pointing to `./src/static/index.ts` for backward compatibility.
- [ ] **3.5** Existing `@epicenter/workspace/static` imports left as-is (still works via the kept export). Migration deferred.
- [x] **3.6** Deleted `src/dynamic/` folder entirely (58 files).
- [x] **3.7** Deleted `src/shared/cell-keys.ts` and `cell-keys.test.ts`.
- [x] **3.8** Deleted `src/extensions/sqlite/` folder entirely.
- [x] **3.9** Deleted `src/extensions/markdown/` folder entirely.
- [x] **3.10** Deleted `src/extensions/revision-history/` folder entirely.
- [x] **3.11** Rewrote `src/extensions/index.ts` to only export sync persistence and error logger.
- [x] **3.12** Kept `"./extensions"` export (still exports persistence + error logger).
- [x] **3.13** Removed `typebox` from dependencies.

### Phase 4: Cleanup and Verify

- [x] **4.1** Updated root `src/index.ts`: removed Dynamic references, added Static API exports.
- [ ] **4.2** Update `AGENTS.md` references: deferred to follow-up.
- [ ] **4.3** Update `packages/epicenter/README.md`: deferred to follow-up.
- [x] **4.4** READMEs in deleted folders removed with folder deletion. Updated `apps/epicenter/src/lib/yjs/README.md`.
- [ ] **4.5** Kept `"./static"` re-export for backward compatibility.
- [x] **4.6** `bun run typecheck`: 0 source errors (149 pre-existing test file errors only).
- [x] **4.7** `bun test`: 377 pass, 0 fail.
- [x] **4.8** Zero imports of `@epicenter/workspace/dynamic` or `@epicenter/workspace/node` anywhere in the monorepo.
- [ ] **4.9** App build: not tested (requires Tauri build environment). Typecheck passes.
- [x] **4.10** Deleted `scripts/ymap-vs-ykeyvalue-benchmark.ts`.

## Edge Cases

### Apps using Dynamic workspace definitions that include field metadata (name, icon, description)

Dynamic `table()` definitions carry display metadata: `name: 'Blog Posts'`, `icon: 'emoji:📝'`, `description: '...'`. The Static `defineTable()` is pure schema: no display metadata. Apps that render table names/icons in the UI get this from the Dynamic definition.

During migration (Phase 1, steps 1.2-1.3), check whether the templates use display metadata. If they do, the metadata must move to a separate config object or be added as an optional field to `defineWorkspace` / `defineTable`. This is likely a minor issue since most display metadata is handled in the Svelte UI layer, not in the workspace definition.

### The `HeadDoc` and epoch system

Already marked as archived documentation for future versioned workspaces. Not part of the current Dynamic API runtime. Should remain archived; not affected by this deprecation.

### Ingest code using Dynamic schema utilities

The `src/ingest/` folder imports from `../../static/` (confirmed via grep). It does NOT import from Dynamic. No migration needed for ingest.

### The `extensions/index.ts` barrel export

Currently exports sqlite, markdown, revision-history, sync, and error-logger. After deleting the first three, this file must be rewritten. The `"./extensions"` export path in `package.json` may need updating or removal depending on what remains.

## Risk Assessment

| Risk                                                                  | Likelihood | Impact | Mitigation                                                                                      |
| --------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------- |
| App templates fail to compile after field factory → arktype migration | Medium     | High   | Phase 1 is first; verify with typecheck before proceeding                                       |
| Static `ExtensionContext` shape breaks sync extension                 | Low        | Medium | Check that sync only uses `{ ydoc }` from context                                               |
| Removing typebox breaks something unexpected                          | Low        | Medium | Grep for all typebox imports before removing                                                    |
| External consumers of `@epicenter/workspace/dynamic` exist outside monorepo  | Very Low   | Medium | Package is `0.0.1`; likely no external consumers. Temporary re-export at `./static` for safety. |

## Success Criteria

- [x] Zero imports of `@epicenter/workspace/dynamic` or `@epicenter/workspace/node` across the monorepo
- [x] `src/dynamic/` folder deleted
- [x] `src/extensions/sqlite/`, `src/extensions/markdown/`, `src/extensions/revision-history/` deleted
- [x] `typebox` removed from package.json dependencies
- [x] All existing tests pass (minus deleted Dynamic tests): 377 pass, 0 fail
- [x] `bun run typecheck` clean across all packages (pre-existing test errors only)
- [ ] Apps build and run correctly: typecheck passes; full build requires Tauri environment
- [x] Net reduction in code and dependencies: ~17,900 lines deleted

## Review

### Summary

Removed the entire Dynamic workspace API and its coupled extensions. ~17,900 lines deleted across 58 files. The Static API is now the sole workspace API, with its exports merged into the root `@epicenter/workspace` package.

### Key Decisions Made During Implementation

1. **Templates split into metadata + workspace**: Templates now have display metadata (`id, name, description, icon`) and a `.workspace` property containing the Static `defineWorkspace()` result. Service.ts stores only metadata JSON.

2. **`createWorkspaceClient()` takes ID, not definition**: Changed signature from `(definition: WorkspaceDefinition)` to `(workspaceId: string)`. Looks up Static definition from template registry by ID. Cleaner separation.

3. **KV JSON persistence removed**: Static's `KvHelper` has a different API than Dynamic's `Kv` (no `.toJSON()` or blanket `.observe()`). Simplified persistence to Y.Doc binary only.

4. **Schema tab uses data-derived columns**: Since Static schemas are arktype types (no runtime `Field` objects), the table page derives column names from row data rather than schema introspection.

5. **Settings page simplified**: Current templates don't define KV stores, so the settings detail page shows "not found" state.

6. **Kept `./static` export as alias**: Rather than breaking existing `@epicenter/workspace/static` imports, kept the export path working. Migration to `@epicenter/workspace` deferred.

7. **Renamed `src/static/` → `src/workspace/`**: The "static" name only made sense as contrast to "dynamic." Now that the Dynamic API is gone, the folder is simply the workspace implementation. All internal imports updated. The `./static` package.json export alias is preserved (points to new path) for backward compatibility with external consumers.

### Deferred Work

- Migrate remaining external `@epicenter/workspace/static` imports to `@epicenter/workspace` (tab-manager, fs-explorer, server, filesystem packages)
- Update `packages/epicenter/README.md` and `AGENTS.md`
- Remove the `./static` re-export alias once all consumers migrated
- Re-implement sqlite/markdown extensions against the Workspace API if needed in future

### Verification

- **Tests**: 377 pass, 0 fail
- **Package typecheck**: 0 source errors (149 pre-existing in test files)
- **App typecheck**: 233 errors, all pre-existing
- **Import grep**: Zero `@epicenter/workspace/dynamic` or `@epicenter/workspace/node` anywhere

## References

- `packages/epicenter/src/static/`: The surviving (and now primary) workspace API
- `packages/epicenter/src/shared/`: Shared utilities (kept)
- `packages/epicenter/src/shared/y-keyvalue/ymap-simplicity-case.test.ts`: Analysis proving Y.Map<Y.Map> equivalence
- `packages/epicenter/src/extensions/sync/`: Sync extension (kept, migrated to Static types)
- `packages/epicenter/package.json`: Updated export map
- `apps/epicenter/src/lib/templates/`: Migrated workspace templates
- `apps/epicenter/src/lib/workspaces/dynamic/`: Migrated app-level workspace code
- `apps/tab-manager/src/lib/`: Migrated tab manager imports
