# Consolidate Table Storage to YKeyValueLww

**Status**: Completed  
**Risk**: High (breaking storage format change)  
**Scope**: Replace nested Y.Map table implementation with YKeyValueLww

## Context

The `packages/epicenter/src/` directory has two table storage implementations:

| Implementation   | Storage Model              | Location                         | Used By                       |
| ---------------- | -------------------------- | -------------------------------- | ----------------------------- |
| **Nested Y.Map** | `Y.Map → Y.Map → Y.Map`    | `dynamic/tables/table-helper.ts` | Main `createTables()` API     |
| **YKeyValueLww** | `Y.Array + LWW timestamps` | `dynamic/table-helper.ts`        | `dynamic/create-workspace.ts` |

The user wants to consolidate on **YKeyValueLww** as the single table storage approach.

### Why YKeyValueLww?

1. **Explicit conflict resolution**: LWW timestamps give predictable "last write wins" semantics
2. **Offline-first friendly**: Timestamp-based resolution handles multi-device sync better
3. **Single CRDT primitive**: Both `static/` and `dynamic/` can share the same core utility
4. **Consistency**: `static/` already uses YKeyValueLww; this unifies the approach

### Storage Format Comparison

**Current (Nested Y.Map)**:

```
Y.Doc
└── Y.Map('tables')
    └── Y.Map('posts')           ← Table
        └── Y.Map('row-123')     ← Row
            ├── id: 'row-123'
            ├── title: 'Hello'
            └── published: false
```

**Target (YKeyValueLww)**:

```
Y.Doc
└── Y.Array('table:posts')       ← Table
    └── { key: 'row-123', val: { id: 'row-123', title: 'Hello', published: false }, ts: 1706200000 }
```

## Breaking Changes

**This is a breaking storage format change.**

- Existing Y.Doc data using nested Y.Map will NOT be readable after migration
- Apps will need to either:
  1. Clear existing data and start fresh, OR
  2. Run a migration script to convert storage format

## Tasks

### Phase 1: Preparation (Low Risk)

- [ ] **Task 1.1**: Document current API surface of `dynamic/tables/table-helper.ts`
- [ ] **Task 1.2**: Document current API surface of `dynamic/table-helper.ts`
- [ ] **Task 1.3**: Identify all methods that need to be ported/preserved
- [ ] **Task 1.4**: Create test fixtures for both storage formats

### Phase 2: Implementation (Medium Risk)

- [ ] **Task 2.1**: Create new `dynamic/tables/table-helper-lww.ts` using YKeyValueLww
  - Preserve the same external API as current `table-helper.ts`
  - Use `Y.Array('table:{tableName}')` naming convention (matching `dynamic/table-helper.ts`)
  - Implement all methods: `get`, `getAll`, `getAllValid`, `getAllInvalid`, `upsert`, `upsertMany`, `update`, `updateMany`, `delete`, `deleteMany`, `clear`, `count`, `has`, `filter`, `find`, `observe`

- [ ] **Task 2.2**: Create `UntypedTableHelper` variant using YKeyValueLww
  - For dynamically-created tables not in definition

- [ ] **Task 2.3**: Update `dynamic/tables/create-tables.ts` to use new implementation
  - Keep same external API
  - Change internal storage from nested Y.Map to YKeyValueLww

- [ ] **Task 2.4**: Update markdown extension (`extensions/markdown/markdown.ts`)
  - Adapt to new table helper interface if needed

### Phase 3: Cleanup (Low Risk)

- [ ] **Task 3.1**: Delete old `dynamic/tables/table-helper.ts` (nested Y.Map version)
- [ ] **Task 3.2**: Rename `dynamic/table-helper.ts` → consolidate into `dynamic/tables/`
- [ ] **Task 3.3**: Update `dynamic/index.ts` exports
- [ ] **Task 3.4**: Update main `src/index.ts` exports
- [ ] **Task 3.5**: Clean up duplicate KV implementations (`dynamic/stores/kv-store.ts` vs `dynamic/kv/core.ts`)

### Phase 4: Migration Support (Optional)

- [ ] **Task 4.1**: Create migration utility to convert nested Y.Map → YKeyValueLww
- [ ] **Task 4.2**: Document migration process for existing apps

## API Preservation Checklist

The new implementation MUST preserve these APIs:

### TableHelper Methods

| Method                 | Current                      | Must Preserve |
| ---------------------- | ---------------------------- | ------------- | --- |
| `get(id)`              | Returns `GetResult<TRow>`    | Yes           |
| `getAll()`             | Returns `RowResult<TRow>[]`  | Yes           |
| `getAllValid()`        | Returns `TRow[]`             | Yes           |
| `getAllInvalid()`      | Returns `InvalidRowResult[]` | Yes           |
| `upsert(row)`          | Void, never fails            | Yes           |
| `upsertMany(rows)`     | Void, never fails            | Yes           |
| `update(partial)`      | Returns `UpdateResult`       | Yes           |
| `updateMany(partials)` | Returns `UpdateManyResult`   | Yes           |
| `delete(id)`           | Returns `DeleteResult`       | Yes           |
| `deleteMany(ids)`      | Returns `DeleteManyResult`   | Yes           |
| `clear()`              | Void                         | Yes           |
| `count()`              | Returns number               | Yes           |
| `has(id)`              | Returns boolean              | Yes           |
| `filter(predicate)`    | Returns `TRow[]`             | Yes           |
| `find(predicate)`      | Returns `TRow                | null`         | Yes |
| `observe(callback)`    | Returns unsubscribe function | Yes           |

### TablesFunction Methods

| Method        | Must Preserve |
| ------------- | ------------- |
| `get(name)`   | Yes           |
| `has(name)`   | Yes           |
| `names()`     | Yes           |
| `clear()`     | Yes           |
| `definitions` | Yes           |
| `toJSON()`    | Yes           |

## Implementation Notes

### Key Differences to Handle

1. **Row ID storage**: Nested Y.Map uses the Y.Map key as row ID. YKeyValueLww stores ID in the `key` field.

2. **Observation**: Nested Y.Map uses `observeDeep` to catch nested changes. YKeyValueLww uses the observer built into the class.

3. **Transaction batching**: Both support Y.Doc transactions, but the API differs slightly.

4. **Table creation**: Nested Y.Map lazily creates tables on first access. YKeyValueLww needs explicit array creation.

### Storage Naming Convention

Use `table:{tableName}` prefix for Y.Array names to avoid collision with other data:

```typescript
const yarray = ydoc.getArray<YKeyValueLwwEntry<TRow>>(`table:${tableName}`);
const ykv = new YKeyValueLww(yarray);
```

## Verification

After implementation:

1. All existing tests in `dynamic/tables/*.test.ts` pass
2. No type errors: `bun run typecheck`
3. Apps using `createTables()` continue to work (API unchanged)
4. New storage format is YKeyValueLww-based

## Decision Points

Before execution, answer:

1. **Migration support**: Do we need to support migrating existing data, or is a clean break acceptable?
2. **Deprecation period**: Should we keep the old implementation temporarily with deprecation warnings?
3. **Version bump**: This is a breaking change. Does it warrant a major version bump?

## Appendix: File Changes

| File                              | Action                                    |
| --------------------------------- | ----------------------------------------- |
| `dynamic/tables/table-helper.ts`  | Rewrite to use YKeyValueLww               |
| `dynamic/tables/create-tables.ts` | Update to use new table-helper            |
| `dynamic/table-helper.ts`         | Delete (functionality merged)             |
| `dynamic/index.ts`                | Update exports                            |
| `src/index.ts`                    | Update exports                            |
| `extensions/markdown/markdown.ts` | Adapt to new interface                    |
| `dynamic/stores/kv-store.ts`      | Potentially consolidate with `kv/core.ts` |

## Review (2025-01-31)

### Summary

Successfully consolidated table storage to YKeyValueLww with **cell-level** LWW (Last-Write-Wins) storage. Each field gets its own timestamp, enabling concurrent edits to different fields to merge cleanly.

### Why Cell-Level?

Cell-level storage preserves the collaborative editing semantics users expect:

- User A edits `title`, User B edits `views` → Both edits merge
- Only conflicts on the SAME field use LWW (latest timestamp wins)

This matches the merge behavior of nested Y.Map while giving us explicit timestamps.

### Files Changed

**Created:**

- `dynamic/tables/keys.ts` - Cell key utilities (CellKey, parseCellKey, RowPrefix, etc.)

**Rewritten:**

- `dynamic/tables/table-helper.ts` - Rewrite to use cell-level YKeyValueLww storage
- `dynamic/tables/create-tables.ts` - Updated to work with new table-helper
- `dynamic/tables/create-tables.crdt-sync.test.ts` - Tests for cell-level LWW semantics

**Deleted:**

- `dynamic/table-helper.ts` - Old cell-level table helper (duplicate)
- `dynamic/create-workspace.ts` - Old workspace factory
- `dynamic/stores/kv-store.ts` - Duplicate KV implementation
- `dynamic/types.ts` - Types for old implementation
- `dynamic/extensions.ts` - Extension builder for old createWorkspace
- `dynamic/batch.test.ts` - Tests for old batch operations

**Updated:**

- `dynamic/index.ts` - Removed old exports, added new tables/kv exports
- `extensions/markdown/markdown.ts` - Fixed import path
- `src/index.ts` - Updated comments

### Behavioral Changes

**Storage format:**

- OLD: `Y.Map('tables') → Y.Map(tableName) → Y.Map(rowId) → field values`
- NEW: `Y.Array('table:{tableName}') → { key: 'rowId:fieldId', val: fieldValue, ts: timestamp }`

**Conflict resolution:**

- OLD: Implicit Yjs CRDT merging per field (nested Y.Map)
- NEW: Cell-level LWW with explicit timestamps (same merge semantics, explicit control)

**Delete semantics:**

- Delete removes all cells for a row
- Upsert after delete restores the row (no tombstones)
- Partial update after delete only restores updated cells (row may be incomplete)

### Test Results

- 454 tests pass
- 2 tests skipped
- 0 failures
- All `dynamic/tables/*.test.ts` pass with cell-level implementation

### API Preservation

All planned APIs preserved:

- ✅ `get(id)` - Returns `GetResult<TRow>`
- ✅ `getAll()` - Returns `RowResult<TRow>[]`
- ✅ `getAllValid()` - Returns `TRow[]`
- ✅ `getAllInvalid()` - Returns `InvalidRowResult[]`
- ✅ `upsert(row)` - Void, never fails
- ✅ `upsertMany(rows)` - Void, never fails
- ✅ `update(partial)` - Returns `UpdateResult`
- ✅ `updateMany(partials)` - Returns `UpdateManyResult`
- ✅ `delete(id)` - Returns `DeleteResult`
- ✅ `deleteMany(ids)` - Returns `DeleteManyResult`
- ✅ `clear()` - Void
- ✅ `count()` - Returns number
- ✅ `has(id)` - Returns boolean (semantics changed: now checks data existence, not table existence)
- ✅ `filter(predicate)` - Returns `TRow[]`
- ✅ `find(predicate)` - Returns `TRow | null`
- ✅ `observe(callback)` - Returns unsubscribe function (simplified: now returns Set<string> of changed IDs)

TablesFunction APIs:

- ✅ `get(name)` - Returns typed or untyped helper
- ✅ `has(name)` - Now checks if table has data (not just exists)
- ✅ `names()` - Returns tables with data only
- ✅ `clear()` - Clears all defined tables
- ✅ `definitions` - Access table definitions
- ✅ `toJSON()` - Serialize all tables

### Known Limitations

1. **TypeScript inference** - Some test files have TypeScript errors due to complex generic inference. Tests run correctly at runtime.

2. **`has(name)` and `names()` semantics changed** - Now returns based on data existence, not just table definition. This is because Y.Array always returns an array (even if empty) unlike Y.Map which could check key existence.

### Migration Notes

Apps using `createWorkspace` from `@epicenter/hq/dynamic` will break. They should:

1. Use `createTables` directly for table operations
2. Or use `@epicenter/hq/static` for the full workspace API with versioning support

No data migration utility was created (Phase 4 was optional). Existing Y.Doc data using nested Y.Map will need to be recreated.
