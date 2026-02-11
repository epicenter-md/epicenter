# Ingest Simplification Specification

> Refactor the Reddit ingest implementation to reduce code duplication and improve maintainability.

## Status: Phase 2 Complete

## Background

The MVP implementation in `packages/epicenter/src/ingest/reddit/` is functional but has significant code duplication:

- **~1700 lines** across 6 files
- **Triple schema definition**: CSV validation, row types, and workspace schema all define similar structures
- **14 copy-paste blocks** in index.ts for table imports
- **9 if-statements** for KV inserts

## Goals

1. Reduce total lines by ~400 (from ~1700 to ~1300)
2. Single source of truth for schema definitions
3. Data-driven approach for table imports
4. Maintain type safety and readability

## Non-Goals

1. Change the public API (`importRedditExport`, `previewRedditExport`, `createRedditWorkspace`)
2. Change the workspace schema structure
3. Add new features

---

## Changes

### 1. Add Package Subpath Exports (Quick Win)

**File**: `packages/epicenter/package.json`

```json
{
  "exports": {
    // ... existing exports
    "./ingest": "./src/ingest/index.ts",
    "./ingest/reddit": "./src/ingest/reddit/index.ts"
  }
}
```

### 2. Delete Redundant Row Types (~150 lines)

**File**: `packages/epicenter/src/ingest/reddit/transform.ts`

**Before** (150+ lines of manual type definitions):
```typescript
export type ContentRow = {
  id: string;
  type: 'post' | 'comment' | 'draft';
  permalink: string | null;
  // ... 10 more fields
};

export type VoteRow = { ... };
export type SavedRow = { ... };
// ... 11 more types
```

**After** (derive from workspace schema):
```typescript
import type { InferTableRow } from '../../static/types.js';
import { redditWorkspace } from './workspace.js';

// Types derived from workspace schema - always in sync
type ContentRow = InferTableRow<typeof redditWorkspace.tables.content>;
type VoteRow = InferTableRow<typeof redditWorkspace.tables.votes>;
// ... or just use inline: InferTableRow<typeof redditWorkspace.tables.content>
```

**Note**: Need to verify `InferTableRow` is exported from static API. If not, add it.

### 3. Data-Driven Table Import Loop (~150 lines)

**File**: `packages/epicenter/src/ingest/reddit/index.ts`

**Before** (14 copy-paste blocks, ~170 lines):
```typescript
// TABLE: content
reportProgress('content');
const contentRows = transformContent(data);
workspace.tables.content.batch((tx) => {
  for (const row of contentRows) tx.set(row);
});
stats.tables.content = contentRows.length;

// TABLE: votes
reportProgress('votes');
const voteRows = transformVotes(data);
workspace.tables.votes.batch((tx) => {
  for (const row of voteRows) tx.set(row);
});
stats.tables.votes = voteRows.length;

// ... repeat 12 more times
```

**After** (~25 lines):
```typescript
const tableImports = [
  { name: 'content', transform: transformContent },
  { name: 'votes', transform: transformVotes },
  { name: 'saved', transform: transformSaved },
  { name: 'messages', transform: transformMessages },
  { name: 'chatHistory', transform: transformChatHistory },
  { name: 'subreddits', transform: transformSubreddits },
  { name: 'multireddits', transform: transformMultireddits },
  { name: 'awards', transform: transformAwards },
  { name: 'commerce', transform: transformCommerce },
  { name: 'social', transform: transformSocial },
  { name: 'announcements', transform: transformAnnouncements },
  { name: 'scheduledPosts', transform: transformScheduledPosts },
  { name: 'ipLogs', transform: transformIpLogs },
  { name: 'adsPreferences', transform: transformAdsPreferences },
] as const;

for (const { name, transform } of tableImports) {
  reportProgress(name);
  const rows = transform(data);

  // Type assertion needed due to dynamic table access
  const table = workspace.tables[name as keyof typeof workspace.tables];
  (table as { batch: (fn: (tx: { set: (row: { id: string }) => void }) => void) => void })
    .batch((tx) => {
      for (const row of rows) tx.set(row);
    });

  stats.tables[name] = rows.length;
}
```

### 4. KV Batch Loop (~30 lines)

**File**: `packages/epicenter/src/ingest/reddit/index.ts`

**Before** (9 if-statements):
```typescript
workspace.kv.batch((tx) => {
  if (kvData.accountGender !== null) {
    tx.set('accountGender', kvData.accountGender);
    stats.kv++;
  }
  if (kvData.birthdate !== null) {
    tx.set('birthdate', kvData.birthdate);
    stats.kv++;
  }
  // ... 7 more
});
```

**After**:
```typescript
workspace.kv.batch((tx) => {
  for (const [key, value] of Object.entries(kvData) as [keyof KvData, unknown][]) {
    if (value !== null) {
      tx.set(key, value);
      stats.kv++;
    }
  }
});
```

### 5. Unified Preview Function (~30 lines)

**File**: `packages/epicenter/src/ingest/reddit/index.ts`

**Before** (duplicates transform knowledge):
```typescript
const tables: Record<string, number> = {
  content: data.posts.length + data.comments.length + data.drafts.length,
  votes: data.post_votes.length + data.comment_votes.length + data.poll_votes.length,
  // ... manual calculation for each table
};
```

**After** (reuses tableImports config):
```typescript
const tables: Record<string, number> = {};
for (const { name, transform } of tableImports) {
  tables[name] = transform(data).length;
}
```

---

## Future Considerations (Not in Scope)

### Pipeline Architecture

A more declarative approach for the entire import:

```typescript
type CsvToTableMapping = {
  tableName: string;
  sources: Array<{
    csvKey: keyof ValidatedRedditExport;
    discriminant?: Record<string, unknown>;
    getId: (row: unknown) => string;
    mapFields: (row: unknown) => Record<string, unknown>;
  }>;
};
```

This would make adding new tables a config change rather than code change. However, it's a larger rewrite and the current approach is readable.

### Consolidate CSV Config

Create a single source of truth for CSV→table mappings that both parse.ts and validation.ts reference. Lower priority since the current approach works and changes are rare.

---

## Implementation Plan

1. **Phase 1** (Quick Wins) ✅ COMPLETE
   - ✅ Add package.json exports (`./ingest`, `./ingest/reddit`)
   - ✅ KV batch loop refactor (9 if-statements → 1 loop)
   - ✅ Unified preview function (reuses `tableTransforms` config)
   - ✅ Export `createRedditWorkspace` and `RedditWorkspaceClient` from ingest index
   - **Result**: -28 lines in index.ts

2. **Phase 2** (Major Refactors) ✅ COMPLETE
   - ✅ Data-driven table import loop (14 blocks → 1 loop)
   - ✅ Delete redundant row types (use `InferTableRow` from workspace schema)
   - ✅ Move `tableTransforms` array to transform.ts and export
   - **Result**: -294 net lines (351 removed, 57 added)
     - index.ts: 370 → 188 lines (-182)
     - transform.ts: 637 → 522 lines (-115)

3. **Phase 3** (Optional)
   - Consolidate CSV config
   - Consider pipeline architecture for future importers

---

## Success Metrics

- [x] Total lines reduced from ~1700 to ~1300 (now ~1621 lines, ~320 lines saved)
- [x] All tests pass (import-test.ts produces same results)
- [x] No change to public API
- [x] Type safety maintained
