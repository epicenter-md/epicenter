# Restore SQLite Persistence and Materializer

**Date**: 2026-04-12
**Status**: Implemented
**Author**: AI-assisted

## Overview

Restore the SQLite persistence extension and SQLite materializer that were deleted in `7c0962a`. Rebuild the materializer using the same builder pattern as the markdown materializer. Opt-in per table, pluggable serializers, clean file separation. Instead of restoring the old monolith.

## Motivation

### Current State

The workspace README still documents `filesystemPersistence` and `@epicenter/workspace/extensions/persistence/sqlite` as public API, but the code was deleted as "dead code" (no active consumers at the time). The current persistence story:

| Environment | Persistence | Status |
|---|---|---|
| Browser | IndexedDB (`y-indexeddb`) | ✅ Works |
| Tauri desktop |: | ❌ Nothing |
| Server / CLI |: | ❌ Nothing |

The only remaining materializer is markdown (writes `.md` files). There's no way to get fast SQL reads or FTS5 search over workspace data.

### Problems

1. **No filesystem persistence**: Desktop and CLI environments can't persist Y.Doc state across restarts
2. **No SQL query path**: Apps that need filtered/sorted/joined reads must scan Yjs arrays in memory
3. **No full-text search**: No FTS5 path exists after the mirror deletion
4. **README drift**: The README documents APIs that don't exist, confusing consumers

### Desired State

```typescript
// Persistence: append-only update log in SQLite (desktop/server)
createWorkspace(definition)
  .withExtension('persistence', sqlitePersistence({
    filePath: join(dataDir, 'workspace.db'),
  }))

// Materializer: builder pattern, opt-in per table
  .withWorkspaceExtension('sqlite', (ctx) =>
    createSqliteMaterializer(ctx, { db })
      .table('posts', { fts: ['title', 'body'] })
      .table('users')
  )
```

## Research Findings

### Markdown Materializer Architecture (the reference pattern)

The existing markdown materializer at `packages/workspace/src/extensions/materializer/markdown/` demonstrates the target architecture:

| Aspect | How markdown does it |
|---|---|
| Opt-in | `.table(name, config?)` chainable builder |
| Serializers | Pluggable per-table `serialize` function, defaults provided |
| File separation | `markdown.ts` (lifecycle), `serializers.ts` (pure transforms), `index.ts` (barrel) |
| Lifecycle | `ctx.whenReady` → initial flush → `table.observe()` for incremental |
| Contract | Returns `{ whenReady, dispose }` |
| KV support | `.kv(config?)` optional |

**Key finding**: The builder pattern with per-table opt-in is strictly better than the old `tables: 'all' | string[]` bag approach. It gives type inference per table and lets each table have its own config.

### Deleted SQLite Persistence (147 lines, clean)

The deleted `filesystemPersistence` was already well-structured:
- Append-only `updateV2` blobs to an `updates` table
- Replay on startup → `Y.applyUpdateV2(ydoc, row.data)`
- Debounced compaction (2MB threshold, 5s debounce) via `Y.encodeStateAsUpdateV2`
- Standard extension contract: `{ whenReady, clearLocalData, dispose }`
- Uses `bun:sqlite` directly (fine for Tauri/Bun environments)

**Implication**: Restore mostly as-is. The architecture was sound. It was deleted only because nothing was consuming it.

### Deleted SQLite Mirror (557 lines, monolithic)

The old `createSqliteMirror` mixed everything into one file:
- DDL generation, FTS setup, row sync, search, lifecycle. All in `create-sqlite-mirror.ts`
- Used an async `MirrorDatabase` interface (Turso-compatible)
- `tables: 'all' | string[]` instead of per-table builder

**Implication**: Don't restore as-is. Rebuild with the markdown materializer's builder pattern and split into focused files.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Persistence: restore vs rewrite | Restore as-is | 147 lines, clean code, sound architecture. No value in rewriting. |
| Materializer: restore vs rebuild | Rebuild with builder pattern | Old monolith doesn't match the markdown materializer's superior architecture |
| Materializer DB interface | Keep async `MirrorDatabase` | Stays driver-agnostic (Turso native, WASM, bun:sqlite wrapper) |
| Persistence DB driver | Keep `bun:sqlite` direct | Persistence is a Bun/Tauri concern, not browser. Direct driver is fine. |
| FTS config | Per-table in `.table()` config | Matches builder pattern, more explicit than global `fts` bag |
| KV materialization | Defer | The markdown materializer supports `.kv()` but the old SQLite mirror didn't. Add later if needed. |
| File structure | Mirror markdown's layout | Same directory structure pattern for consistency |

## Architecture

### Extension Layering

```
                    Y.Doc (source of truth)
                         │
            ┌────────────┼────────────────┐
            ▼            ▼                ▼
     SQLite Persistence  IndexedDB    BroadcastChannel
     (durability)        (browser)    (cross-tab)
     "save the CRDT"     "save the    "replicate live"
                          CRDT"
            │
            ▼
     On startup: replay updateV2 blobs → reconstruct Y.Doc
            │
            ▼
     Materializers observe the reconstructed Y.Doc:
            │
      ┌─────┼──────┐
      ▼            ▼
   Markdown     SQLite Materializer
   (files)      (queryable tables + FTS)
```

### SQLite Materializer File Structure

```
extensions/materializer/sqlite/
├── index.ts          : barrel exports
├── sqlite.ts         : createSqliteMaterializer() builder + lifecycle
├── ddl.ts            : generateDdl(), resolveSchema(), quoteIdentifier()
├── fts.ts            : FTS5 virtual table setup, triggers, search()
├── serialize.ts      : serializeValue() row→SQL value mapping
└── types.ts          : MirrorDatabase, MirrorStatement, config types
```

### Builder API Shape

```typescript
// Consumer usage:
.withWorkspaceExtension('sqlite', (ctx) =>
  createSqliteMaterializer(ctx, { db })
    .table('posts', { fts: ['title', 'body'] })
    .table('users')
    .table('tags', {
      fts: ['name'],
      serialize: (value) => customTransform(value),  // optional per-column
    })
)

// Returns:
{
  whenReady: Promise<void>,
  dispose(): void,
  // SQLite-specific additions (exposed via workspace.extensions.sqlite):
  search(table: string, query: string, options?: SearchOptions): Promise<SearchResult[]>,
  count(table: string): Promise<number>,
  rebuild(table?: string): Promise<void>,
  db: MirrorDatabase,  // escape hatch for custom SQL
}
```

### Materializer Lifecycle (mirrors markdown)

```
1. Builder phase (synchronous)
   .table('posts', { fts: ['title', 'body'] })
   .table('users')
   → collects table configs into a Map

2. whenReady (async, after ctx.whenReady)
   await ctx.whenReady
   for each registered table:
     → generateDdl(name, jsonSchema) → db.exec(CREATE TABLE)
     → if fts config: setupFts(name, columns) → CREATE VIRTUAL TABLE
     → fullLoad: INSERT OR REPLACE all valid rows
     → table.observe(changedIds) → incremental sync

3. Incremental sync (on table.observe callback)
   for each changedId:
     table.get(id) →
       valid    → INSERT OR REPLACE
       not_found → DELETE
       invalid  → skip (or DELETE, TBD)

4. dispose()
   → unsubscribe all observers
   → cancel pending debounce timers
```

## Implementation Plan

### Phase 1: Restore SQLite Persistence

- [x] **1.1** Recreate `packages/workspace/src/extensions/persistence/sqlite.ts` with the deleted code from commit `7c0962a`
- [x] **1.2** Re-add `"./extensions/persistence/sqlite"` subpath export to `packages/workspace/package.json`
- [x] **1.3** Run existing tests to verify no regressions (`bun test packages/workspace`)

### Phase 2: Rebuild SQLite Materializer: Types and DDL

- [x] **2.1** Create `packages/workspace/src/extensions/materializer/sqlite/types.ts`: `MirrorDatabase`, `MirrorStatement`, `SearchOptions`, `SearchResult`, builder config types. Restore from deleted code but update to match the builder pattern (remove `tables: 'all' | string[]`, add per-table FTS config type).
- [x] **2.2** Create `packages/workspace/src/extensions/materializer/sqlite/ddl.ts`: restore `generateDdl()`, `resolveSchema()`, `quoteIdentifier()` from deleted code. These are pure functions and were well-tested.
- [x] **2.3** Create `packages/workspace/src/extensions/materializer/sqlite/ddl.test.ts`: restore DDL tests from deleted code.

### Phase 3: Rebuild SQLite Materializer: Core

- [x] **3.1** Create `packages/workspace/src/extensions/materializer/sqlite/serialize.ts`: extract `serializeValue()` from the old monolith into its own file.
- [x] **3.2** Create `packages/workspace/src/extensions/materializer/sqlite/fts.ts`: extract FTS5 setup (CREATE VIRTUAL TABLE, triggers, search query) from the old monolith.
- [x] **3.3** Create `packages/workspace/src/extensions/materializer/sqlite/sqlite.ts`: the main `createSqliteMaterializer()` builder. Follow the markdown materializer's pattern: builder collects configs synchronously, `whenReady` does initial flush, `table.observe()` for incremental sync.
- [x] **3.4** Create `packages/workspace/src/extensions/materializer/sqlite/index.ts`: barrel exports.

### Phase 4: Tests and Exports

- [x] **4.1** Create `packages/workspace/src/extensions/materializer/sqlite/sqlite.test.ts`: port tests from the deleted `create-sqlite-mirror.test.ts`, adapting to the new builder API.
- [x] **4.2** Add `"./extensions/materializer/sqlite"` subpath export to `packages/workspace/package.json`.
- [x] **4.3** Run full test suite: `bun test packages/workspace`: 651 pass, 0 fail
- [x] **4.4** Run typecheck: `bun run typecheck`: no new errors (pre-existing errors in unrelated files)

## Edge Cases

### Schema Migration Mid-Session

1. A table schema has versions 1 and 2
2. The materializer generates DDL from version 2 (highest `_v`)
3. Old v1 rows are read via `table.get(id)` which migrates on read
4. Materialized rows are always the latest version

### FTS Table Already Exists

1. App restarts, SQLite file persists between runs
2. `CREATE VIRTUAL TABLE IF NOT EXISTS` handles this
3. Schema changes (new FTS columns) require a `rebuild()` call

### Large Initial Load

1. Workspace has 10K+ rows
2. Initial `fullLoad` should batch INSERTs inside a transaction
3. The old code did this: preserve the pattern

### Observer Fires Before whenReady

1. The observer is registered after `ctx.whenReady` resolves
2. No race condition: same pattern as markdown materializer

## Open Questions

1. **Should `invalid` rows be deleted or skipped in incremental sync?**
   - Options: (a) Delete from SQLite (b) Skip (leave stale row) (c) Mark with a flag column
   - **Recommendation**: Delete. The old code deleted them. A stale row in the query cache is worse than a missing one.

2. **Should the materializer support `onSync` and `onReady` callbacks like the old code?**
   - The markdown materializer doesn't have these hooks
   - **Recommendation**: Omit for now. Add if a consumer needs them. YAGNI.

3. **Should `MirrorDatabase` stay async or switch to sync (`bun:sqlite` is sync)?**
   - Options: (a) Keep async for Turso/WASM compat (b) Switch to sync for simplicity
   - **Recommendation**: Keep async. The interface cost is low, and it preserves the ability to use WASM-backed SQLite in browser contexts later.

## Success Criteria

- [x] `filesystemPersistence` is importable from `@epicenter/workspace/extensions/persistence/sqlite`
- [x] `createSqliteMaterializer` is importable from `@epicenter/workspace/extensions/materializer/sqlite`
- [x] Builder API works: `.table('posts', { fts: ['title'] }).table('users')`
- [x] DDL tests pass (restored from deleted tests)
- [x] Mirror test suite passes (ported from deleted tests)
- [x] Full workspace test suite passes: `bun test packages/workspace`
- [x] Typecheck passes: `bun run typecheck` (no new errors)

## References

- `packages/workspace/src/extensions/persistence/indexeddb.ts`: Extension contract reference
- `packages/workspace/src/extensions/materializer/markdown/markdown.ts`: Builder pattern reference
- `packages/workspace/src/extensions/materializer/markdown/serializers.ts`: Serializer separation reference
- `packages/workspace/package.json`: Subpath exports to update
- Commit `7c0962a`: Source of deleted code to restore/adapt
- `packages/workspace/README.md`: Still references `filesystemPersistence`, needs no update after restore

## Review

**Completed**: 2026-04-12

### Summary

Restored SQLite persistence verbatim from commit 7c0962a (148 lines, clean append-only update log). Rebuilt the SQLite materializer from scratch using the markdown materializer's builder pattern instead of restoring the old monolithic `createSqliteMirror`. The new materializer splits into 6 focused files (types, ddl, serialize, fts, sqlite, index) matching the markdown materializer's architecture.

### Deviations from Spec

- **`rebuild()` signature**: Combined `rebuild()` and `rebuildTable()` into a single `rebuild(table?: string)` method. Omitting the argument rebuilds all tables; passing a table name rebuilds just that one. Simpler API surface.
- **Removed `onSync`/`onReady` callbacks**: As recommended in Open Questions, these were omitted (YAGNI). The markdown materializer doesn't have them either.
- **Removed `tables: 'all' | string[]`**: As specified, replaced with per-table `.table()` builder opt-in only.
- **Types use `type` instead of `interface`**: Per project convention in AGENTS.md.

### File Structure

```
extensions/persistence/sqlite.ts         : restored verbatim (148 lines)
extensions/materializer/sqlite/
├── index.ts          : barrel exports (12 lines)
├── sqlite.ts         : createSqliteMaterializer() builder + lifecycle (453 lines)
├── ddl.ts            : generateDdl(), resolveSchema(), quoteIdentifier() (208 lines)
├── fts.ts            : FTS5 setup + search (149 lines)
├── serialize.ts      : serializeValue() (45 lines)
├── types.ts          : MirrorDatabase, MirrorStatement, config types (109 lines)
├── ddl.test.ts       : DDL tests (261 lines)
└── sqlite.test.ts    : Materializer tests (543 lines)
```

### Test Results

- DDL tests: 18 pass, 1 todo
- Materializer tests: 14 pass
- Full workspace suite: 651 pass, 0 fail
