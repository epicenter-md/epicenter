# Native Y.Map Storage Architecture with Epoch-Based Compaction

**Date**: 2026-01-08
**Status**: APPROVED
**Supersedes**: `20260107T020000-ykeyvalue-lww-timestamps.md` (deferred, not cancelled)

## Executive Summary

After extensive benchmarking and analysis, we recommend using **native Y.Map of Y.Maps** for table storage instead of implementing custom LWW timestamps in YKeyValue. The epoch system provides natural compaction boundaries, making the simpler native approach viable.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DECISION: Use Y.Map of Y.Maps + Epoch-Based Compaction                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  • Zero custom CRDT code                                                    │
│  • Battle-tested YJS internals                                              │
│  • Free compaction via encodeStateAsUpdate() or epoch bump                  │
│  • Cell-level merging works natively                                        │
│  • Predictable LWW timestamps: DEFERRED until users complain                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Problem Statement

We evaluated three approaches for table storage with cell-level CRDT merging:

1. **Y.Map of Y.Maps** (native YJS)
2. **YKeyValue** (current) - Y.Array with `{key, val}` entries
3. **YKeyValue-LWW** (proposed) - Y.Array with `{key, val, ts, by}` entries

The key questions:

- Which approach balances simplicity, storage efficiency, and conflict resolution?
- How does the epoch system affect the compaction story?

## Benchmark Results

### Storage Format Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  APPROACH 1: Y.Map of Y.Maps (Native YJS)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Doc                                                                      │
│    └── Y.Map("tables")                                                      │
│          └── Y.Map("posts")           ← Table                               │
│                ├── "post-1" → Y.Map   ← Row                                 │
│                │               ├── "id" → "post-1"                          │
│                │               ├── "title" → "Hello"    ← Cells             │
│                │               └── "views" → 100                            │
│                └── "post-2" → Y.Map                                         │
│                                                                             │
│  Entry format: Native Y.Map key-value pairs                                 │
│  Conflict resolution: YJS LWW per key (client ID based)                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  APPROACH 2: YKeyValue (Current Implementation)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Doc                                                                      │
│    └── Y.Map("tables")                                                      │
│          └── Y.Map("posts")           ← Table                               │
│                ├── "post-1" → Y.Array ← Row                                 │
│                │               ├── {key:"id", val:"post-1"}                 │
│                │               ├── {key:"title", val:"Hello"}               │
│                │               └── {key:"views", val:100}                   │
│                └── "post-2" → Y.Array                                       │
│                                                                             │
│  Entry format: { key: string, val: T }                                      │
│  Conflict resolution: Rightmost entry wins (positional)                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  APPROACH 3: YKeyValue-LWW (Proposed, Now Deferred)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Doc                                                                      │
│    └── Y.Map("tables")                                                      │
│          └── Y.Map("posts")           ← Table                               │
│                ├── "post-1" → Y.Array ← Row                                 │
│                │               ├── {key:"id", val:"post-1", ts:1000, by:100}│
│                │               ├── {key:"title", val:"Hello", ts:1001, by:100}
│                │               └── {key:"views", val:100, ts:1002, by:100}  │
│                └── "post-2" → Y.Array                                       │
│                                                                             │
│  Entry format: { key: string, val?: T, ts: number, by: number }             │
│  Conflict resolution: Higher timestamp wins (time-based)                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Storage Size After 1000 Updates (10 keys × 100 updates each)

| Approach                     | Size         | Ratio vs Y.Map | Notes                      |
| ---------------------------- | ------------ | -------------- | -------------------------- |
| Y.Map of Y.Maps              | 18,719 bytes | 1.00x          | Retains update history     |
| YKeyValue (current)          | 10,083 bytes | 0.54x          | Cleanup removes duplicates |
| YKeyValue-LWW (no compact)   | 93,856 bytes | 5.01x          | Every update adds record   |
| YKeyValue-LWW (with compact) | ~2,155 bytes | 0.12x          | After periodic compaction  |

### Realistic Usage Scenarios

| Scenario             | Description          | Y.Map Size  | Verdict              |
| -------------------- | -------------------- | ----------- | -------------------- |
| Blog posts           | 100 posts, 110 edits | **59 KB**   | Acceptable           |
| User settings        | 1 user, 100 changes  | **1.6 KB**  | Excellent            |
| Collab spreadsheet   | 10 rows, 100 edits   | **3.2 KB**  | Excellent            |
| Worst case (counter) | 1 key, 1000 updates  | **17.5 KB** | Use external counter |

### Conflict Resolution Predictability

| Approach      | "Later Edit" Wins | Behavior                        |
| ------------- | ----------------- | ------------------------------- |
| Y.Map         | ~60%              | Unpredictable (client ID based) |
| YKeyValue     | ~55%              | Unpredictable (rightmost wins)  |
| YKeyValue-LWW | **100%**          | Deterministic (timestamp wins)  |

## The Epoch System Changes Everything

The epoch system (from `20260108T062000-local-first-workspace-discovery.md`) provides **free compaction** at the workspace level:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  EPOCH-BASED COMPACTION                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  File Structure:                                                            │
│  ───────────────                                                            │
│     {guid}.yjs          ← Head doc (epoch pointer only)                     │
│     {guid}_0.yjs        ← Old epoch (can be archived/deleted)               │
│     {guid}_1.yjs        ← Current epoch (active data)                       │
│                                                                             │
│  Two Compaction Mechanisms:                                                 │
│  ──────────────────────────                                                 │
│                                                                             │
│  1. IN-PLACE SNAPSHOT (No epoch bump):                                      │
│     const snapshot = Y.encodeStateAsUpdate(dataDoc);                        │
│     const freshDoc = new Y.Doc({ guid: `${guid}-${epoch}` });               │
│     Y.applyUpdate(freshDoc, snapshot);                                      │
│     // Save freshDoc to file - history is stripped!                         │
│                                                                             │
│  2. EPOCH BUMP (Schema migration, hard reset):                              │
│     headMap.set('epoch', currentEpoch + 1);                                 │
│     // Old epoch file becomes orphaned, new epoch starts fresh              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: `Y.encodeStateAsUpdate()` outputs current state WITHOUT tombstone history. This is native YJS functionality. No custom code required.

## Decision Matrix

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TRADE-OFF COMPARISON                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                     Y.Map        YKeyValue       YKeyValue-LWW              │
│                    (native)      (current)        (proposed)                │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Custom CRDT code      NONE          ~180 lines      ~200+ lines            │
│                                                                             │
│  Compaction         BUILT-IN        Cleanup on      CUSTOM required         │
│                     (snapshot)       access         (race condition risk)   │
│                                                                             │
│  Battle-tested         ✅              ✅               ❌                   │
│                     Core YJS       Community       Custom impl              │
│                                                                             │
│  Cell-level merge      ✅              ✅               ✅                   │
│                                                                             │
│  Predictable winner    ❌              ❌               ✅                   │
│                     (client ID)   (rightmost)     (timestamp)               │
│                                                                             │
│  Clock skew handling   N/A            N/A          YOUR PROBLEM             │
│                                                                             │
│  Epoch integration     ✅              ✅               ✅                   │
│                     (free!)        (free!)         (free!)                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why Predictable Winner Matters Less Than You Think

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FOR A SAME-CELL CONFLICT TO OCCUR:                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     User A                              User B                              │
│        │                                   │                                │
│        │  ──── OFFLINE ────                │                                │
│        │                                   │                                │
│        ▼                                   ▼                                │
│   Edit post-1.title               Edit post-1.title    ← SAME cell!        │
│        │                                   │                                │
│        │  ──── SYNC ────                   │                                │
│        │                                   │                                │
│        └───────────┬───────────────────────┘                                │
│                    ▼                                                        │
│              ONE WINS                                                       │
│                                                                             │
│  This requires:                                                             │
│    1. Same row        (unlikely in most apps)                               │
│    2. Same column     (even more unlikely)                                  │
│    3. While offline   (rare for web apps)                                   │
│    4. Conflicting     (not complementary edits)                             │
│                                                                             │
│  In practice: <1% of edits hit this case                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  WHAT HAPPENS 99% OF THE TIME:                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     User A                              User B                              │
│        │                                   │                                │
│        ▼                                   ▼                                │
│   Edit post-1.title               Edit post-1.views    ← DIFFERENT cells   │
│        │                                   │                                │
│        └───────────┬───────────────────────┘                                │
│                    ▼                                                        │
│         BOTH CHANGES MERGE ✅                                               │
│                                                                             │
│  Y.Map handles this PERFECTLY with zero custom code.                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Complexity Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Y.Map of Y.Maps Implementation                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  const table = ydoc.getMap('posts');                                        │
│  const row = table.get(id) ?? new Y.Map();                                  │
│  row.set('title', 'Hello');                                                 │
│  table.set(id, row);                                                        │
│                                                                             │
│  Lines of wrapper code: ~30                                                 │
│  Custom CRDT logic: NONE                                                    │
│  Compaction needed: NO (use encodeStateAsUpdate or epoch bump)              │
│  Clock synchronization: NO                                                  │
│  Battle-tested: YES (core YJS)                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  YKeyValue-LWW Implementation                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Required components:                                                       │
│  • Record type: { key, val?, ts, by }                                       │
│  • isNewer(a, b) comparison function                                        │
│  • createMonotonicClock() with observe()                                    │
│  • processRecord() for incremental winner tracking                          │
│  • compact() with race condition handling                                   │
│  • scheduleCompact() with debouncing                                        │
│  • Observer to skip compaction transactions                                 │
│                                                                             │
│  Lines of code: ~200+                                                       │
│  Custom CRDT logic: isNewer(), processRecord()                              │
│  Compaction needed: YES (or unbounded growth)                               │
│  Clock synchronization: YES (monotonic clock)                               │
│  Battle-tested: NO (custom implementation)                                  │
│                                                                             │
│  Potential bugs to handle:                                                  │
│  • Compaction race conditions during sync                                   │
│  • Clock skew (user's clock 1 year in future)                               │
│  • Tombstone resurrection edge cases                                        │
│  • Observer ordering during transaction batching                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Recommendation

### Primary Choice: Y.Map of Y.Maps

Use native Y.Map of Y.Maps for all table storage.

**Storage architecture:**

```typescript
// Structure
Y.Map<tableName, Y.Map<rowId, Y.Map<columnName, cellValue>>>;

// Usage
const tables = ydoc.getMap('tables');
const posts = tables.get('posts') ?? new Y.Map();
const row = posts.get(rowId) ?? new Y.Map();
row.set('title', 'Hello World');
posts.set(rowId, row);
tables.set('posts', posts);
```

**Compaction strategy:**

```typescript
// Option 1: In-place snapshot (periodic, e.g., on app close)
async function compactWorkspace(workspace: Workspace) {
	const snapshot = Y.encodeStateAsUpdate(workspace.dataDoc);
	const freshDoc = new Y.Doc({ guid: workspace.dataDoc.guid });
	Y.applyUpdate(freshDoc, snapshot);
	await writeBinaryFile(workspace.dataPath, Y.encodeStateAsUpdate(freshDoc));
}

// Option 2: Epoch bump (for schema migrations, hard resets)
async function bumpEpoch(workspace: Workspace) {
	const newEpoch = workspace.epoch + 1;
	workspace.headMap.set('epoch', newEpoch);
	// Old epoch file becomes orphaned, new epoch starts fresh
}
```

### Deferred: YKeyValue-LWW Timestamps

The LWW timestamp implementation (`20260107T020000-ykeyvalue-lww-timestamps.md`) is **NOT cancelled**, just **deferred**.

**When to revisit:**

1. Users complain about conflict resolution being "wrong"
2. Same-cell conflicts become common in a specific use case
3. Debugging requires predictable "who won and why"

**Migration path:**

```
Today:     Y.Map of Y.Maps + epochs (simple, works)
                   │
                   ▼
If needed: Add LWW timestamps as opt-in per table
           (only for tables with high conflict rates)

The epoch system means you can MIGRATE incrementally.
Bump epoch, change storage format for one table, done.
```

## Files Affected

### Modify

- `packages/epicenter/src/core/tables/table-helper.ts` - Change from YKeyValue to Y.Map
- `packages/epicenter/src/core/tables/create-tables.ts` - Update table creation

### No Changes Needed

- `packages/epicenter/src/core/utils/y-keyvalue.ts` - Keep for KV store (different use case)
- `packages/epicenter/src/core/kv/kv-helper.ts` - Unaffected (still uses YKeyValue)

### Documentation Updates

- `docs/articles/ykeyvalue-meta-data-structure.md` - Add section on Y.Map alternative
- `docs/articles/y-lwwmap-last-write-wins-alternative.md` - Add epoch-based compaction note
- `specs/20260107T020000-ykeyvalue-lww-timestamps.md` - Mark as DEFERRED

## Test Files Created

The following benchmark tests were created during this analysis:

1. **`y-keyvalue-benchmark.test.ts`**: Comprehensive comparison of all three approaches
   - Storage format inspection
   - Size comparison after many updates
   - Conflict resolution predictability tests
   - Compaction effectiveness tests

2. **`ymap-simplicity-case.test.ts`**: Case study for Y.Map simplicity
   - Realistic usage scenarios (blog posts, settings, collab docs)
   - Implementation complexity comparison
   - Conflict frequency analysis

## Success Criteria

- [ ] Table storage uses Y.Map of Y.Maps pattern
- [ ] Cell-level CRDT merging works (verified by existing tests)
- [ ] Epoch-based compaction mechanism documented
- [ ] In-place snapshot compaction implemented (optional, for optimization)
- [ ] Existing tests pass with new storage format
- [ ] Documentation updated to reflect decision

## References

- `specs/20260108T062000-local-first-workspace-discovery.md` - Epoch system
- `specs/20260107T020000-ykeyvalue-lww-timestamps.md` - LWW proposal (deferred)
- `specs/20260107T010300-ykeyvalue-conflict-resolution-analysis.md` - Conflict analysis
- `specs/20260107T114209-cell-level-crdt-merging.md` - Cell-level merging proof
- `docs/articles/ykeyvalue-meta-data-structure.md` - YKeyValue internals
- `docs/articles/y-lwwmap-last-write-wins-alternative.md` - LWW alternative
- DeepWiki YJS documentation - Y.Map performance characteristics
