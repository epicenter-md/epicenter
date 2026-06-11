# Three-Tier Extension API

**Date**: 2026-03-13
**Status**: Implemented
**Supersedes**: `20260219T195800-document-extension-api.md` (partially: the document extension API spec introduced `withDocumentExtension`; this spec redefines `withExtension` and adds `withWorkspaceExtension`)

## Problem

Developers forget to chain `.withDocumentExtension('persistence', indexeddbPersistence)` after `.withExtension('persistence', indexeddbPersistence)`. This causes document content (rich-text bodies) to silently not persist while workspace metadata (table rows, KV) does. Both Honeycrisp and Fuji shipped with this bug.

The root cause is an API design problem: the common case (persistence for both workspace and documents) requires two calls, while the uncommon case (workspace-only) requires one. The pit of success is inverted.

```
┌────────────────────────────────────────────────────────────────────────┐
│  CURRENT API: common case requires TWO calls                          │
│                                                                        │
│  .withExtension('persistence', idb)          ← workspace Y.Doc only   │
│  .withDocumentExtension('persistence', idb)  ← document Y.Docs only   │
│                                                                        │
│  Forgetting the second line = silent data loss                         │
└────────────────────────────────────────────────────────────────────────┘
```

## Design Decision

Three methods, each mapping to a clear intent:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NEW API: common case requires ONE call                                │
│                                                                         │
│  .withExtension(key, factory)                 → both (90% case)        │
│  .withWorkspaceExtension(key, factory)        → workspace Y.Doc only   │
│  .withDocumentExtension(key, factory, opts?)  → document Y.Docs only   │
│                                                                         │
│  The unqualified name is the broadest scope. Qualifiers narrow it.      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why this naming

The unqualified form (`.withExtension`) is the default, used 90% of the time. Qualified forms (`.withWorkspaceExtension`, `.withDocumentExtension`) signal "this is scoped differently." This follows the same pattern as `import` vs `import type`: the common case is unadorned.

### Why extension factories don't need to know their scope

Extension factories already receive `{ ydoc }` and operate on whatever Y.Doc they get. `indexeddbPersistence` creates `new IndexeddbPersistence(ydoc.guid, ydoc)`: it doesn't know or care whether `ydoc` is the workspace doc or a content doc. The framework decides routing; the factory is scope-agnostic.

```typescript
// This function works identically for workspace and document Y.Docs.
// The guid differentiates the IndexedDB database name.
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
    const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
    return {
        clearData: () => idb.clearData(),
        whenReady: idb.whenSynced,
        destroy: () => idb.destroy(),
    };
}
```

## API

### `withExtension(key, factory)`: both scopes

Registers the extension for the workspace Y.Doc AND all content Y.Docs. The factory fires once for the workspace doc (at build time) and once per content doc (at `documents.open()` time).

```typescript
createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)      // workspace + all docs
    .withExtension('sync', createSyncExtension({...}))       // workspace + all docs
```

Workspace-level behavior is identical to the current `withExtension`: the factory receives the full `ExtensionContext` with typed access to prior extensions. Document-level behavior is identical to the current `withDocumentExtension`: the factory receives a `DocumentContext` with `{ id, ydoc, whenReady, extensions }`.

### `withWorkspaceExtension(key, factory)`: workspace Y.Doc only

Fires only for the workspace Y.Doc. Use when an extension is genuinely workspace-scoped and should NOT fire for content documents.

```typescript
createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)
    .withWorkspaceExtension('analytics', analyticsExtension)    // workspace only
```

Same signature and context as the current `withExtension`.

### `withDocumentExtension(key, factory, options?)`: document Y.Docs only

Fires only for content Y.Docs. Supports optional `{ tags }` for targeting specific document types.

```typescript
createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)
    .withDocumentExtension('snapshots', snapshotExtension)                        // all docs
    .withDocumentExtension('markdown', markdownExport, { tags: ['exportable'] })  // tagged docs only
```

Same signature as the current `withDocumentExtension`. Unchanged.

## Migration

### Before (current API)

```typescript
// apps/honeycrisp/src/lib/workspace.ts (BROKEN: documents don't persist)
export default createWorkspace(honeycrisp)
    .withExtension('persistence', indexeddbPersistence);

// apps/fs-explorer/src/lib/fs/fs-state.svelte.ts (correct but verbose)
const ws = createWorkspace({ id: 'fs-explorer', tables: { files: filesTable } })
    .withExtension('persistence', indexeddbPersistence)
    .withDocumentExtension('persistence', indexeddbPersistence, {
        tags: ['persistent'],
    });
```

### After (new API)

```typescript
// apps/honeycrisp/src/lib/workspace.ts (correct: one call covers both)
export default createWorkspace(honeycrisp)
    .withExtension('persistence', indexeddbPersistence);

// apps/fs-explorer/src/lib/fs/fs-state.svelte.ts
// fs-explorer doesn't use document tags for persistence, so withExtension covers both.
const ws = createWorkspace({ id: 'fs-explorer', tables: { files: filesTable } })
    .withExtension('persistence', indexeddbPersistence);
```

### When each method applies

| Extension type          | Method                   | Example                                    |
|-------------------------|--------------------------|--------------------------------------------|
| Persistence (IndexedDB) | `withExtension`          | Always want both                           |
| WebSocket sync          | `withExtension`          | Both need server sync                      |
| BroadcastChannel        | `withExtension`          | Both need cross-tab sync                   |
| Snapshot/version history| `withDocumentExtension`  | Only documents need snapshots              |
| Markdown export         | `withDocumentExtension`  | Only documents render to markdown          |
| Tag-scoped persistence  | `withDocumentExtension`  | Only 'persistent' docs get IndexedDB       |
| Analytics/telemetry     | `withWorkspaceExtension` | Track workspace-level events, not per-doc  |

## Implementation

### `create-workspace.ts` changes

The `withExtension` method currently registers a factory for the workspace Y.Doc only. It needs to additionally push the factory into `documentExtensionRegistrations` (the array that `withDocumentExtension` currently writes to).

```
withExtension(key, factory):
  1. Call factory with workspace ExtensionContext (unchanged)
  2. Register resolved extension in workspace extension chain (unchanged)
  3. NEW: Push factory into documentExtensionRegistrations[] (same array withDocumentExtension uses)
```

The new `withWorkspaceExtension` method is the current `withExtension` behavior: workspace only, no document registration.

`withDocumentExtension` is unchanged.

### `types.ts` changes

Add `withWorkspaceExtension` to `WorkspaceClientBuilder`. Its signature is identical to the current `withExtension` signature. Then update `withExtension`'s JSDoc to document that it fires for both scopes.

### Extension key namespacing

Workspace extensions and document extensions already use independent key namespaces. With `withExtension` registering in both, the same key (e.g., `'persistence'`) appears in both namespaces. This is intentional and correct. The workspace extension context exposes workspace extension exports; the document extension context exposes document extension exports.

## Todo

- [x] Rename current `withExtension` to `withWorkspaceExtension` in `create-workspace.ts`
- [x] Add new `withExtension` that calls `applyWorkspaceExtension` + pushes to `documentExtensionRegistrations`
- [x] Add `withWorkspaceExtension` to `WorkspaceClientBuilder` type in `types.ts`
- [x] Update `withExtension` JSDoc in `types.ts` to document both-scope behavior
- [x] Update `apps/honeycrisp/src/lib/workspace.ts`: remove `.withDocumentExtension` (now redundant)
- [x] Update `apps/fuji/src/lib/workspace.ts`: remove `.withDocumentExtension` (now redundant)
- [x] Update `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`: collapsed to single `.withExtension` (no tagging needed)
- [x] Update `apps/tab-manager/src/lib/workspace.ts`: no changes needed (no document tables)
- [x] Update `apps/whispering/src/lib/workspace.ts`: no changes needed (no document tables)
- [x] Update `create-workspace.test.ts`: add test that `withExtension` fires for both scopes
- [x] Update `create-workspace.test.ts`: add test that `withWorkspaceExtension` fires only for workspace
- [x] Update existing `withDocumentExtension` tests (unchanged behavior, verified passing)
- [x] Run `bun test` in `packages/workspace`: 349 pass, 1 pre-existing fail
- [x] Run `bun typecheck` across monorepo: only pre-existing errors in unrelated packages

## Design Notes

### Why not `{ scope }` option on a single method?

A single `withExtension(key, factory, { scope: 'both' | 'workspace' | 'documents' })` was considered. It has lower API surface (one method) but:

1. The scope option is invisible at a glance: you have to read the third argument to understand behavior.
2. Three methods with clear names are more scannable than one method with a hidden option.
3. `withDocumentExtension` already exists and has tag support: folding tags into a generic options bag alongside scope makes the options bag do too much.

### What about extension chain ordering?

`withExtension('persistence', ...)` fires the factory for the workspace doc during the builder chain (synchronous, like current `withExtension`). For document docs, it pushes the factory into the registrations array. These fire lazily when `documents.open()` is called (unchanged from current `withDocumentExtension` behavior).

This means workspace extensions resolve during the build chain (enabling typed `extensions` access), while document extensions resolve at open time (when the content Y.Doc exists). The ordering guarantee is: workspace persistence loads before document persistence, because `documents.open()` typically happens after `client.whenReady`.

### Will there ever be workspace-only extensions?

Rarely. The only clear cases are analytics/telemetry that track workspace-level events and shouldn't fire per-document, or workspace-level middleware that inspects the workspace Y.Doc structure. `withWorkspaceExtension` exists as an escape hatch: most consumers will never need it.

## Review

### Changes Made

**Core implementation** (`packages/workspace/src/workspace/`):

1. **`create-workspace.ts`**: Extracted shared workspace extension logic into `applyWorkspaceExtension()` helper. `withExtension` now pushes the factory into `documentExtensionRegistrations[]` (with `tags: []` for universal) then delegates to `applyWorkspaceExtension`. New `withWorkspaceExtension` delegates directly to `applyWorkspaceExtension` without document registration. The cast `factory as unknown as DocumentExtensionRegistration['factory']` bridges `ExtensionContext` → `DocumentContext` (runtime compatible since both provide `{ ydoc }`).

2. **`types.ts`**: Added `withWorkspaceExtension` method to `WorkspaceClientBuilder`. Updated `withExtension` return type to accumulate document extensions (`TDocExtensions & Record<TKey, ...>`). Updated JSDoc to document both-scope behavior.

3. **`create-workspace.test.ts`**: Added two tests:
   - `withExtension registers for both workspace and document Y.Docs`: verifies factory fires twice (once for workspace, once on `documents.open()`)
   - `withWorkspaceExtension fires only for workspace Y.Doc, not documents`: verifies factory fires exactly once even after `documents.open()`

**App migrations**:

4. **`apps/honeycrisp/src/lib/workspace.ts`**: Removed `.withDocumentExtension('persistence', indexeddbPersistence)`: single `.withExtension` now covers both.
5. **`apps/fuji/src/lib/workspace.ts`**: Same removal.
6. **`apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`**: Collapsed `.withExtension('persistence', idb).withDocumentExtension('persistence', idb, { tags: ['persistent'] })` into single `.withExtension('persistence', indexeddbPersistence)`. No tagging was actually needed for this app.

**No changes needed**: `apps/tab-manager` and `apps/whispering`: both use `.withExtension` but have no document tables, so the new document registration is a no-op.

### Verification

- `bun test` in `packages/workspace`: 349 pass, 1 pre-existing fail (`factory throw cleanup` test)
- `bun typecheck` across monorepo: only pre-existing errors in `@epicenter/api` (BetterAuth types), `@epicenter/workspace` (unrelated test files, `define-table.ts` generics)
- LSP diagnostics clean on all changed files

### Design Note: fs-explorer simplification

The spec originally proposed keeping fs-explorer with `withWorkspaceExtension` + `withDocumentExtension` (tagged). Per user direction, the tagging was unnecessary: all documents in fs-explorer should persist. This simplified the migration to a single `.withExtension` call, same as Honeycrisp and Fuji.
