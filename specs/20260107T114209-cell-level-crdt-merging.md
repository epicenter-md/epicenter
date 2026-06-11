# Cell-Level CRDT Merging for Table Rows

**Status**: IMPLEMENTED (with architecture update)

> **Update (2026-01-08)**: The implementation described here works correctly. A subsequent decision
> was made to consider native Y.Map of Y.Maps as an alternative to the YKeyValue-backed approach,
> with epoch-based compaction handling storage growth. Both approaches achieve cell-level merging;
> the difference is in conflict resolution semantics and implementation complexity.
> See `20260108T084500-ymap-native-storage-architecture.md` for details.

## Problem

Current architecture uses **row-level last-writer-wins (LWW)**. When two users concurrently edit different columns of the same row, one user's changes are lost:

```
User A edits title: { id: 'row-1', title: 'New Title', views: 0 }
User B edits views: { id: 'row-1', title: 'Original', views: 100 }

After sync: { id: 'row-1', title: 'Original', views: 100 }  ← User A's title change LOST
```

This is because each row is stored as a single JSON blob in a YKeyValue. When you call `upsert()` or `update()`, the entire blob is replaced.

## Solution

Change the storage architecture so each **cell** is a separate key in a per-row YKeyValue:

```
Current:
  table (YKeyValue backed by Y.Array)
    └── { key: 'row-1', val: { id, title, views } }  ← entire row is ONE value

Proposed:
  table (Y.Map)
    └── row-1 (YKeyValue backed by Y.Array)
          ├── { key: 'id', val: 'row-1' }
          ├── { key: 'title', val: 'Hello' }
          └── { key: 'views', val: 100 }
```

Now concurrent edits to different columns are different keys → they merge correctly via CRDT.

## Proof of Concept

Test at `packages/epicenter/src/core/tables/create-tables.crdt-sync.test.ts` proves this works:

```
YOUR PROPOSAL (table=Y.Map, row=YKeyValue) - After sync:
  doc1 sees: { title: "Updated by User 1", views: 100 }
  doc2 sees: { title: "Updated by User 1", views: 100 }
✅ CELL-LEVEL MERGING WORKS! Both changes preserved!
```

## Architecture Comparison

| Architecture                             | Concurrent cell edits | Storage efficiency  |
| ---------------------------------------- | --------------------- | ------------------- |
| Current: table=YKeyValue, row=JSON       | ❌ Row-level LWW      | ✅ Best             |
| Y.Map everywhere                         | ✅ Cell-level merge   | ❌ Unbounded growth |
| **Proposed**: table=Y.Map, row=YKeyValue | ✅ Cell-level merge   | ✅ Bounded per-row  |

## Implementation Plan

### Phase 1: Update Storage Structure

**File: `packages/epicenter/src/core/tables/table-helper.ts`**

Current (line ~115):

```typescript
const ytables = ydoc.getMap<Y.Array<{ key: string; val: Row }>>('tables');
```

Change to:

```typescript
const ytables =
	ydoc.getMap<Y.Map<string, Y.Array<{ key: string; val: CellValue }>>>(
		'tables',
	);
```

Structure:

- `ytables` = `Y.Map<tableName, Y.Map<rowId, Y.Array>>`
- Each table = `Y.Map<rowId, Y.Array>` (not YKeyValue at table level)
- Each row = `Y.Array` backing a `YKeyValue<columnName, cellValue>`

### Phase 2: Update CRUD Operations

**`upsert(rowData)`**

- Get or create the row's Y.Array from the table Y.Map
- Wrap with YKeyValue
- For each column in rowData, call `rowKV.set(columnName, value)`

**`update(partialRow)`**

- Get the row's Y.Array (return not_found if missing)
- Wrap with YKeyValue
- For each column in partialRow, call `rowKV.set(columnName, value)`
- Existing columns not in partialRow are preserved automatically

**`get(id)`**

- Get the row's Y.Array
- Wrap with YKeyValue
- Reconstruct row object: `{ id, ...Object.fromEntries(rowKV.map) }`

**`delete(id)`**

- Remove the row's Y.Array from the table Y.Map
- `tableMap.delete(rowId)`

**`getAll()`**

- Iterate table Y.Map entries
- For each, wrap Y.Array with YKeyValue and reconstruct row

### Phase 3: Update Observer/Change Events

The `observeChanges` method needs to observe:

1. Table-level Y.Map for row additions/deletions
2. Each row's YKeyValue for cell-level changes

This is more complex. May need to track row observers and clean them up.

### Phase 4: Migration

Existing data uses the old format. Options:

1. **Breaking change**: Require fresh database
2. **Migration**: Detect old format, convert on load
3. **Versioned storage**: Check format version, support both temporarily

Recommend option 2 for production systems.

## Files to Modify

| File                                                    | Changes                |
| ------------------------------------------------------- | ---------------------- |
| `packages/epicenter/src/core/tables/table-helper.ts`    | Core CRUD operations   |
| `packages/epicenter/src/core/utils/y-keyvalue.ts`       | May need minor updates |
| `packages/epicenter/src/core/tables/core.test.ts`       | Update tests           |
| `packages/epicenter/src/core/tables/core-types.test.ts` | Update type tests      |

## Risks & Considerations

1. **Performance**: Each row now has its own Y.Array overhead. For tables with many rows, this adds memory. Should be acceptable for typical use cases.

2. **Observer complexity**: Tracking changes at cell level requires observing each row's YKeyValue. Need to manage observer lifecycle.

3. **Serialization**: When serializing rows (for SQLite provider, markdown provider), need to reconstruct from YKeyValue format.

4. **Y.Text/Y.Array columns**: These are already stored separately by reference. The new architecture handles them the same way. Store the reference ID as the cell value.

## Success Criteria

- [x] Concurrent edits to different columns of same row merge correctly
- [x] All existing tests pass (after updating for new structure)
- [x] Storage remains bounded (no unbounded growth)
- [x] Providers (SQLite, markdown) continue to work
- [x] Change observers fire correctly for cell-level changes

## Todo

- [x] Update `createTableHelper` storage structure
- [x] Update `upsert` to write cells individually
- [x] Update `update` to write only changed cells
- [x] Update `get` to reconstruct row from cells
- [x] Update `getAll` to iterate and reconstruct
- [x] Update `delete` to remove row from Y.Map
- [x] Update `observeChanges` for cell-level events
- [ ] Add migration logic for existing data (deferred - not needed for initial implementation)
- [x] Update all tests
- [x] Verify providers still work

## Review

### Changes Made

1. **`table-helper.ts`**: Refactored storage from row-level JSON blobs to cell-level YKeyValue entries
   - Added type aliases: `CellEntry`, `RowArray`, `TableMap`, `TablesMap`
   - Changed table structure from `YKeyValue<rowId, Row>` to `Y.Map<rowId, YKeyValue<column, value>>`
   - Added `rowKVCache` WeakMap to cache YKeyValue wrappers per row
   - Added `reconstructRow()` helper to reassemble row objects from cells
   - Updated all CRUD operations to use the new structure
   - Updated `observeChanges` with `pendingAdds` tracking for proper add/update distinction

2. **`create-tables.crdt-sync.test.ts`** (renamed from `cell-level-crdt.test.ts`): New test file proving cell-level merging works
   - Tests concurrent edits to different columns merge correctly
   - Tests concurrent edits to same column use LWW
   - Tests partial updates preserve unmentioned fields

3. **`create-tables.test.ts`** (renamed from `core.test.ts`): Updated test for raw value handling to use new type structure

### Results

- **242 tests pass**, 2 skipped, 0 failures (as of latest run)
- TypeScript type check passes
- Cell-level CRDT merging confirmed working via dedicated test
- Test output confirms: `✅ CELL-LEVEL MERGING WORKS! Both changes preserved!`

### Migration Note

Migration logic for existing data was deferred. New installations will use the new format automatically. For existing users with data, a migration would need to be added if backwards compatibility is required.
