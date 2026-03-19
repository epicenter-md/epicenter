# Surgical SQLite Index Updates

**Date**: 2026-03-14
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace the full nuke-and-rebuild strategy in the SQLite index extension with surgical per-row updates. When a file is edited, only that file's row in SQLite + FTS is updated—not the entire database.

## Motivation

### Current State

`packages/filesystem/src/extensions/sqlite-index/index.ts` rebuilds the entire in-memory SQLite database on every Yjs table mutation:

```typescript
// Line 182 — observe fires on ANY table change
unobserve = filesTable.observe(() => scheduleSync());

// scheduleSync debounces 100ms, then calls rebuild()

async function rebuild(): Promise<void> {
  const rows = filesTable.getAllValid();           // Read ALL rows
  const paths = computePaths(rows);                // Compute ALL paths
  for (const row of rows) {                        // Read ALL content docs
    const handle = await contentDocs.open(row.id);
    const text = handle.read();
  }
  // DELETE everything, INSERT everything
  await client.batch([
    'DELETE FROM files_fts',
    'DELETE FROM files',
    ...insertStatements
  ], 'write');
}
```

This creates problems:

1. **O(N) content reads on every mutation**: Editing one file triggers `contentDocs.open()` for every file in the workspace. Content reads are async and sequential—this is the bottleneck.
2. **Wasted work**: A single rename re-reads all content, recomputes all paths, and rewrites all rows.
3. **Missed mutations under load**: The `rebuilding` guard flag silently drops a rebuild if one is already in progress. If a rebuild takes >100ms (the debounce window), a mutation can be lost.

### Desired State

The observer receives `changedIds: Set<string>`. For each changed ID:
- Deleted row → `DELETE` from `files` + `files_fts`
- Added/updated row → read only that row's content, compute only that row's path, upsert only that row

Full rebuild only happens on initial load and manual recovery.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Keep debouncing | Yes, same 100ms | Coalesces rapid edits (typing) into one batch of surgical updates |
| Path cascade on folder rename | Query SQLite for descendants | Folder renames are rare; querying `WHERE path LIKE '/old/%'` is fast on in-memory SQLite |
| Keep full `rebuild()` | Yes, for init + recovery | No SQLite state on page load—need a full build. Exposed `rebuild()` stays for corruption recovery |
| Path computation for single row | Walk `parentId` chain via `filesTable.get()` | Reuses existing Yjs reads, no need for a separate index |

## Architecture

```
CURRENT FLOW (every mutation):
────────────────────────────────
filesTable.observe() → debounce 100ms → rebuild()
  → getAllValid()           (N rows)
  → computePaths()          (N walks)
  → contentDocs.open()      (N async reads)
  → DELETE all + INSERT all (2N+2 statements)

NEW FLOW (per mutation):
────────────────────────────────
filesTable.observe(changedIds) → debounce 100ms → syncRows(changedIds)
  → for each changedId:
      → filesTable.get(id)        (1 read)
      → computePathForRow()       (1 walk)
      → contentDocs.open(id)      (1 async read, files only)
      → DELETE + INSERT row       (4 statements per row)
  → if folder renamed:
      → query descendants         (1 SELECT)
      → recompute descendant paths
      → batch upsert descendants

INITIAL LOAD (unchanged):
────────────────────────────────
rebuild() — same as current full nuke-and-rebuild
```

## Implementation Plan

### Phase 1: Add `syncRows()` and single-row path computation

- [x] **1.1** Add `computePathForRow(id, filesTable)` function that walks the `parentId` chain using `filesTable.get()` calls (not `getAllValid()`)
- [x] **1.2** Add `syncRows(changedIds: Set<string>)` async function that handles add/update/delete per row
- [x] **1.3** Change the observer from `filesTable.observe(() => scheduleSync())` to `filesTable.observe((changedIds) => scheduleSync(changedIds))` — pass changed IDs through the debounce

### Phase 2: Handle folder rename cascading

- [x] **2.1** In `syncRows`, detect when a changed row is a folder whose `path` in SQLite differs from its newly computed path
- [x] **2.2** Query SQLite for descendants: `SELECT id FROM files WHERE path LIKE ?` using the old path prefix
- [x] **2.3** Recompute paths for all descendants and include their upserts in the same batch

### Phase 3: Wire up and clean up

- [x] **3.1** Switch the observer to call `scheduleSync(changedIds)` instead of `scheduleSync()`
- [x] **3.2** Update `scheduleSync` to accumulate changed IDs across debounce window (union of all sets)
- [x] **3.3** Keep `rebuild()` for initial load (`whenReady`) and the public `rebuild()` export
- [x] **3.4** Remove the `rebuilding` guard flag—no longer needed since `syncRows` is incremental

## Edge Cases

### Rapid folder rename + file edit in same debounce window

1. User renames folder `/docs` → `/notes`
2. Within 100ms, user edits `/notes/readme.md`
3. Both IDs land in the same `changedIds` set
4. `syncRows` processes the folder first (recomputes descendants), then the file (which now has the correct parent path)
5. **Resolution**: Process folders before files in each batch. Sort `changedIds` so folder-type rows are handled first.

### File deleted before syncRows runs

1. User deletes a file
2. 100ms later, `syncRows` fires with that ID
3. `filesTable.get(id)` returns `not_found`
4. **Resolution**: Already handled—`not_found` triggers `DELETE` from SQLite.

### Initial load (empty SQLite)

1. Page loads, SQLite is `:memory:` with empty tables
2. No prior state to diff against
3. **Resolution**: `rebuild()` runs as before during `whenReady`. Surgical updates only kick in after init.

### Content doc fails to open

1. `contentDocs.open(id)` throws for a specific file
2. **Resolution**: Same as current—catch and set content to `null`. File is still searchable by name.

## Open Questions

1. **Should we accumulate or replace changedIds across debounce resets?**
   - Current code resets the timer on each new mutation. If we accumulate IDs, rapid edits to different files get batched together. If we replace, only the latest mutation's IDs survive.
   - **Recommendation**: Accumulate (union). This ensures no mutations are lost during rapid activity.

2. **Should folders be processed before files in a batch?**
   - If a folder rename and a child file edit happen in the same batch, processing order matters for path correctness.
   - **Recommendation**: Yes, sort changedIds so folders come first. Query `filesTable.get(id)` for each to check type.

## Success Criteria

- [ ] Editing a file only triggers 1 `contentDocs.open()` call (not N)
- [ ] Renaming a file updates 1 row in SQLite (not N)
- [ ] Renaming a folder updates the folder + its descendants (not all rows)
- [ ] Deleting a file removes 1 row from SQLite (not rebuilds everything)
- [ ] Initial page load still does a full rebuild
- [ ] `rebuild()` is still callable for manual recovery
- [ ] FTS search results remain correct after surgical updates
- [ ] No regressions in existing behavior

## References

- `packages/filesystem/src/extensions/sqlite-index/index.ts` — Main file being modified
- `packages/filesystem/src/extensions/sqlite-index/schema.ts` — SQLite schema (unchanged)
- `packages/filesystem/src/extensions/sqlite-index/ddl.ts` — DDL generation (unchanged)
- `packages/workspace/src/workspace/table-helper.ts` — Observer API providing `changedIds: Set<string>`
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts` — Underlying change types (`add`/`update`/`delete`)
- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — Consumer wiring `createSqliteIndex()` into workspace

## Review

**Completed**: 2026-03-14

### Summary

Replaced the full nuke-and-rebuild strategy with surgical per-row updates in `index.ts`. The observer now forwards `changedIds` through a debounced `scheduleSync` that accumulates IDs and flushes them to `syncRows`. Editing a file touches only that file's row. Folder renames cascade to descendants via a SQLite `LIKE` query. Full `rebuild()` is preserved for initial load and manual recovery.

### Changes

- **`computePathForRow(id, filesTable)`**: New module-level function. Walks `parentId` chain via `filesTable.get()` calls (not bulk `getAllValid()`). Mirrors `computePaths` behavior for cycles/orphans.
- **`syncRows(changedIds)`**: New function inside factory closure. Classifies rows as deleted/folder/file, processes folders before files, reads content only for non-folders, batches all statements in one `client.batch()` call.
- **Folder rename cascading**: After upserting a folder, queries SQLite for descendants whose path starts with the old prefix. Recomputes descendant paths by string replacement and includes `UPDATE` statements in the same batch.
- **`scheduleSync(changedIds)`**: Now accepts and accumulates `Set<string>` across debounce resets. Flushes accumulated set to `syncRows` when timer fires.
- **Observer**: Changed from `() => scheduleSync()` to `(changedIds) => scheduleSync(changedIds)`.
- **`rebuilding` guard removed**: No longer needed since `syncRows` is incremental and doesn't conflict with itself.
- **`rebuild()`**: Kept exactly as-is for initial load and public export, minus the `try/finally` wrapper that only existed for the guard flag.

### Deviations from Spec

- None. Implementation followed the spec exactly.
