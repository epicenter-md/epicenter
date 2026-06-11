# Workspace Performance Fix & Dead Code Cleanup

**Date**: 2026-04-12
**Status**: In Progress
**Author**: AI-assisted (from deep audit session)

## Overview

Fix the one real performance bottleneck in the workspace API (O(n²) bulk updates), remove dead code identified during audit, and consolidate an over-split module. Seven changes total, ordered by dependency and risk.

## Motivation

### Current State

The workspace package ships ~91 source files. A structural audit revealed:

1. **One algorithmic bottleneck**: `deleteEntryByKey()` does `toArray().findIndex()` on every update/delete: O(n) per call. Bulk updating 10K existing rows takes 560ms where it should take ~60ms.

2. **Three dead modules** (0 external callers): `ingest/` (7 files), `extensions/materializer/sqlite/` (4 files), `extensions/persistence/sqlite.ts` (1 file).

3. **One dead utility**: `shared/snakify.ts`: only imported by the dead `ingest/` module.

4. **One over-split module**: `shared/standard-schema/` is 3 files for 1 type + 1 function.

5. **No chunked insertion API** for 25K+ row imports, causing UI freezes.

### Desired State

- Bulk update of 10K rows: ~60ms (from 560ms)
- Package has no dead code shipping to consumers
- `shared/standard-schema/` is a single file
- Import operations > 100ms have a progress callback option

## Research Findings

### O(n²) Bulk Update: Root Cause

Benchmarked via `benchmark.test.ts` (9 new tests committed in this session):

```
  10,000 rows:
    Bulk INSERT (new keys):    111.9ms   (11.2µs/row)   ← O(n)
    Bulk UPDATE (existing):    560.1ms   (56.0µs/row)   ← O(n²)
    Single-row autosave:       138.4µs                   ← O(n), acceptable
```

The asymmetry comes from `set()` calling `deleteEntryByKey()` for existing keys:

```typescript
// y-keyvalue-lww.ts, line ~468
private deleteEntryByKey(key: string): void {
    const index = this.yarray.toArray().findIndex((e) => e.key === key);
    //            ^^^^^^^^^^^^^^^^^ O(n) copy + O(n) scan
    if (index !== -1) this.yarray.delete(index);
}
```

The observer already handles duplicate-key resolution during sync conflicts. It's the same dedup logic needed here.

### Storage Edge Cases: Confirmed Non-Issue

Benchmarked 7 storage scenarios at 10K scale:

| Scenario | Result |
|---|---|
| 10K rows, each edited 20x | 1.035x baseline (3.5% overhead) |
| 10K rows added, edited 3x, deleted all | 36 bytes residual |
| 5K permanent + 10 cycles churning 5K | +22 bytes total |
| 500 edits to 1 row among 1K | 0.0 bytes growth |
| 10K rows from 100 different clients | +2.1 KB (~22 bytes/client) |

Storage is not a concern with `gc: true`.

### Dead Code: Caller Counts

| Module | Files | External callers | Last meaningful use |
|---|---|---|---|
| `ingest/` | 7 | 0 | Internal script only |
| `materializer/sqlite/` | 4 | 0 | Never imported by an app |
| `persistence/sqlite.ts` | 1 | 0 | Never imported by an app |
| `shared/snakify.ts` | 1 | 0 (only by dead `ingest/`) | Dead dependency |

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fix O(n²) update | Defer delete to observer | Observer already handles this for sync conflicts; reuse existing dedup |
| Build entry→index map | In observer, from single `toArray()` | O(n) build once + O(1) per lookup vs O(n) per `indexOf` call |
| Keep `delete()` as O(n) | Accepted | `delete()` is rare (benchmarks confirm), not worth the complexity |
| Move ingest/ to Breddit app | Move, don't delete | See `specs/20260412T151815-breddit.md`: ingest code becomes Breddit's data layer |
| Remove materializer/sqlite/ | Delete | Zero consumers; can be rebuilt if needed |
| Remove persistence/sqlite.ts | Delete | Zero consumers; indexeddb covers all current apps |
| Merge standard-schema/ | Single file | 3 files for 2 exports is unnecessary indirection |
| Bulk import API | Defer to after perf fix | Depends on the perf fix; design the API after verifying the new numbers |

## Architecture

### O(n²) Fix: Before and After

```
BEFORE (current):
─────────────────
set('foo', newVal)                    // existing key
  ├── deleteEntryByKey('foo')         // O(n): toArray().findIndex()
  │     ├── yarray.toArray()          // O(n) copy
  │     ├── .findIndex(...)           // O(n) scan
  │     └── yarray.delete(idx)        // O(1)
  └── yarray.push([entry])           // O(1)
                                      // Total: O(n) per set

For 10K updates: 10K × O(n) = O(n²) = 560ms


AFTER (proposed):
─────────────────
set('foo', newVal)                    // existing key
  └── yarray.push([entry])           // O(1): just push, no delete
                                      // Observer deduplicates in batch

Observer fires (once per transaction):
  ├── Build entryIndexMap from        // O(n): one toArray() call
  │   single toArray() snapshot
  ├── For each conflict:              // O(1) per lookup via Map
  │     entryIndexMap.get(existing)
  └── Batch delete all losers          // O(k) for k conflicts
                                      // Total: O(n + k) per transaction

For 10K updates in one transaction: O(n + 10K) = O(n) ≈ ~60ms
```

### Pending/Read Correctness During Dedup Window

Between `set()` and observer firing, the Y.Array has duplicate entries:

```
Y.Array: [..., old-foo-entry, ..., new-foo-entry]

Reads are correct because:
  get('foo')    → checks pending first → returns new value  ✓
  has('foo')    → checks pending first → true               ✓
  entries()     → yields pending first, skips map dupes     ✓

This is the SAME state as during multi-device sync conflicts,
which the observer already handles correctly.
```

## Implementation Plan

### Wave 1: Observer infrastructure for bulk operations

- [x] **1.1** Read `y-keyvalue-lww.ts` fully: understand `set()`, `delete()`, observer, `pending` mechanism
- [x] **1.2** Add `DEDUP_ORIGIN` symbol: observer skips re-entrant calls from conflict-resolution deletions
- [x] **1.3** Add `lazy()` utility for observer-scoped caches (`getAllEntries`, `getEntryIndexMap`)
- [x] **1.4** Replace observer `indexOf()` calls with `getEntryIndex()`: uses Map for batches, indexOf for small conflicts
- [x] **1.5** `set()` is UNCHANGED: the O(n²) fix is delivered via `bulkSet()` in Wave 7, not by modifying `set()`
  > **Note**: Originally tried modifying `set()` to skip `deleteEntryByKey`. This caused benchmark regressions for individual updates. The correct approach: leave `set()` alone, add `bulkSet()` that uses the optimized observer path.
- [x] **1.6** All 149 y-keyvalue tests pass, all 40 benchmarks pass (identical to baseline)
- [x] **1.7** Committed

### Wave 2: Move `ingest/` to Breddit app

See `specs/20260412T151815-breddit.md` Phase 1 for the full plan. Summary:

- [x] **2.1** Create `apps/breddit/` scaffold
- [x] **2.2** Move `src/ingest/reddit/` → `apps/breddit/src/lib/workspace/ingest/`
- [x] **2.3** Move `src/ingest/utils/csv.ts` alongside
- [x] **2.4** Remove `ingest` and `ingest/reddit` subpath exports from workspace `package.json`
- [x] **2.5** Verify workspace package tests still pass (613 pass)
- [x] **2.6** Committed (combined with Wave 3-5)

### Wave 3: Move `shared/snakify.ts` to Breddit

- [x] **3.1** Move `src/shared/snakify.ts` → `apps/breddit/src/lib/workspace/ingest/snakify.ts`
- [x] **3.2** ~~Remove `@sindresorhus/slugify` from workspace package.json~~ **SKIP**: used by materializer/markdown, fuji, opensidian-e2e
- [x] **3.3** Add `@sindresorhus/slugify` to breddit's package.json
- [x] **3.4** `bun install` to update lockfile
- [x] **3.5** Committed (combined with Wave 2)
### Wave 4: Remove dead code: `materializer/sqlite/`

- [x] **4.1** Delete `src/extensions/materializer/sqlite/` directory (6 files: 4 source + 2 test)
- [x] **4.2** ~~Remove subpath export~~ **SKIP**: No such export existed
- [x] **4.3** `@electric-sql/pglite` was not in workspace deps. `drizzle-orm` stays (re-exported from root barrel).
- [x] **4.4** All 613 workspace tests pass
- [x] **4.5** Committed (combined with Wave 2-3)

### Wave 5: Remove dead code: `persistence/sqlite.ts`

- [x] **5.1** Delete `src/extensions/persistence/sqlite.ts` (no test file existed)
- [x] **5.2** Remove `extensions/persistence/sqlite` subpath export from `package.json`
- [x] **5.3** All 613 workspace tests pass
- [x] **5.4** Committed (combined with Wave 2-4)

### Wave 6: Merge `shared/standard-schema/` into single file

- [ ] **6.1** Read current 3 files: `index.ts`, `types.ts`, `to-json-schema.ts`
- [ ] **6.2** Merge into single `src/shared/standard-schema.ts` with both the `CombinedStandardSchema` type and `standardSchemaToJsonSchema` function
- [ ] **6.3** Update all internal imports (grep for `shared/standard-schema`)
- [ ] **6.4** Remove the `shared/standard-schema/` directory
- [ ] **6.5** ~~Update any package.json subpath export if one exists~~ **SKIP**: No such export exists
- [ ] **6.6** Run tests, verify no breaks
- [ ] **6.7** Stage and commit

### Wave 7: Bulk import/delete progress-bar API

### Design: Why `set()` eagerly deletes but `bulkSet()` defers

`deleteEntryByKey()` scans the Y.Array to find an entry's index: O(n) per call.
For a single `set()`, that's fine. For 10K `set()` calls in a loop, it's O(n²).

`bulkSet()` skips this per-key scan. Instead, it pushes all entries in one
transaction. When the transaction ends, the observer fires once and:
1. Builds `entryIndexMap` from one `toArray()` call: O(n)
2. Resolves each conflict with O(1) Map lookups
3. Batch-deletes all losers

The observer's conflict resolution already exists for multi-device sync (when
two clients set the same key offline). `bulkSet` reuses that exact path.

Similarly, `bulkDelete()` replaces N individual array scans with one scan that
collects all matching indices, then deletes right-to-left to preserve index
stability.

```
set() per call:   deleteEntryByKey O(n) + push O(1)     → 10K calls = O(n²)
bulkSet() total:  10K pushes O(1) + 1 observer O(n)      → O(n)
delete() per call: deleteEntryByKey O(n)                  → 10K calls = O(n²)
bulkDelete() total: 1 scan O(n) + batch delete O(k)       → O(n)
```

Architecture: Both `bulkSet` and `bulkDelete` get methods on `YKeyValueLww`. `bulkSet` skips `deleteEntryByKey` and lets the observer batch-resolve conflicts using the entryIndexMap from Wave 1. `bulkDelete` does a one-pass scan + batch delete.

- [x] **7.1** Add `bulkSet(entries)` and `bulkDelete(keys)` to `YKeyValueLww`
- [x] **7.2** Add delegation wrappers to `EncryptedYKeyValueLww`
- [x] **7.3** Add `bulkSet` and `bulkDelete` to `TableHelper` type (async, chunked, with progress)
- [x] **7.4** Implement in `create-table.ts` with chunking + `onProgress` + `setTimeout(0)` yielding
- [x] **7.5** Write tests for YKV-level and TableHelper-level bulk operations
- [x] **7.6** Benchmarks pass (all 40)
- [x] **7.7** Added detailed JSDoc on all 4 methods explaining the eager-vs-deferred tradeoff
- [x] **7.8** Committed

## Edge Cases

### Wave 1: `set()` then `delete()` in same transaction

1. `set('foo', newVal)` pushes without deleting old
2. `delete('foo')` calls `deleteEntryByKey('foo')`: but which entry does it find?
3. It could find the OLD entry (correct) or the NEW entry (wrong: it was just pushed)
4. **Mitigation**: `delete()` should check `pending` and remove the pending entry too. The observer will clean up the old array entry.

### Wave 1: Multiple `set()` for same key in one transaction

1. `set('foo', val1)` pushes entry1
2. `set('foo', val2)` pushes entry2
3. Y.Array now has: old-foo, entry1, entry2
4. Observer sees 3 entries for 'foo', keeps highest-ts (entry2), batch-deletes the other 2
5. **This already works**: the observer's conflict resolution handles arbitrary duplicates.

### Wave 4: Drizzle dependency removal

**Resolved**: `drizzle-orm` is re-exported from the workspace root barrel (`eq`, `and`, `sql`, etc.) per the README. Cannot be removed. Only `@electric-sql/pglite` can be removed (unused anywhere in the repo).

### Wave 6: Standard-schema subpath export

**Resolved**: No `shared/standard-schema` subpath export exists in package.json. Safe to merge without export changes.

## Open Questions (Resolved)

1. **Should `delete()` also defer to the observer?**
   - **Decision**: No. Leave as-is (Option A). Single delete is 29.5µs at 10K: negligible.
   - Bulk delete is handled by the new `bulkDelete()` method which does a one-pass scan.
   - Consistency lives at the bulk API level, not the single-op level.

2. **Should removed dead code go to an archive branch?**
   - **Decision**: Just delete (Option A). Git history preserves everything.

3. **Should `bulkSet` wrap in `ydoc.transact()`?**
   - **Decision**: One transaction per chunk. Matches progress-bar pattern, keeps memory bounded.

## Success Criteria

- [ ] Bulk update of 10K existing rows completes in < 150ms (benchmark test)
- [ ] All existing tests pass after each wave
- [ ] No `@epicenter/workspace/ingest` subpath exists in package.json
- [ ] No `@epicenter/workspace/extensions/materializer/sqlite` subpath exists
- [ ] No `@epicenter/workspace/extensions/persistence/sqlite` subpath exists
- [ ] `shared/standard-schema/` directory no longer exists; single file replaces it
- [ ] `bulkSet` and `bulkDelete` methods exist on `TableHelper` with `onProgress` callback
- [ ] `bulkDelete` method exists on `YKeyValueLww` (optimized batch algorithm)
- [ ] `EncryptedYKeyValueLww` delegates `bulkDelete` to inner
- [ ] `snakify.ts` no longer exists in workspace package; `@sindresorhus/slugify` stays (has other consumers)

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts`: the O(n²) bottleneck lives here
- `packages/workspace/src/workspace/create-table.ts`: `TableHelper` implementation, where `bulkSet` goes
- `packages/workspace/src/workspace/types.ts`: `TableHelper` type definition
- `packages/workspace/src/workspace/benchmark.test.ts`: existing benchmarks to verify against
- `packages/workspace/src/ingest/`: dead module to remove
- `packages/workspace/src/extensions/materializer/sqlite/`: dead module to remove
- `packages/workspace/src/extensions/persistence/sqlite.ts`: dead file to remove
- `packages/workspace/src/shared/snakify.ts`: dead utility to remove
- `packages/workspace/src/shared/standard-schema/`: 3 files to merge into 1
- `packages/workspace/package.json`: subpath exports to clean up
