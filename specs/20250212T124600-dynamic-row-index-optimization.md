# Dynamic API Row Index Optimization

**Status:** Completed (via refactoring)
**Created:** 2025-02-12
**Author:** Claude (via conversation with Braden)

## Summary

Enhance the existing dynamic API's `YKeyValueLww` to include an in-memory row index, improving row-level operations from O(n) to O(1) or O(m) without changing the underlying storage format or conflict resolution semantics.

## TL;DR

**The Problem:** Current dynamic API stores cells flat (`row-1:title`, `row-1:views`). Row-level operations require O(n) scans.

**The Solution:** Add an in-memory `Map<rowId, Set<cellKey>>` index that's maintained alongside the existing `Map<cellKey, entry>`.

**The Benefit:**
- `has(rowId)`: O(n) → O(1)
- `count()`: O(n) → O(1)
- `get(rowId)`: O(n) → O(m) where m = fields in row
- `delete(rowId)`: O(n) → O(m)

**No changes to:** Storage format, sync behavior, LWW conflict resolution, or any external API.

## Problem Statement

The current dynamic API stores data at cell granularity:

```
Y.Array('table:posts')
  { key: 'row-1:title', val: 'Hello', ts: 1706200000 }
  { key: 'row-1:views', val: 100, ts: 1706200001 }
  { key: 'row-2:title', val: 'Second', ts: 1706200002 }
  ...
```

The `YKeyValueLww` maintains an in-memory `Map<cellKey, entry>` for O(1) cell lookups. However, row-level operations require scanning all cells:

| Operation | Current Complexity | Why |
|-----------|-------------------|-----|
| Get row by ID | O(n) | Must scan all keys for `rowId:*` prefix |
| Check row exists | O(n) | Must scan until first match |
| Count rows | O(n) | Must collect all unique rowIds |
| Delete row | O(n) | Must find all cells to delete |
| Get all rows | O(n) | Must group all cells by rowId |

Where `n` = total cells in the table.

## Proposed Solution

Add a secondary in-memory index that maps `rowId → Set<cellKey>`:

```
EXISTING (unchanged):
map: Map<string, YKeyValueLwwEntry<T>>
  'row-1:title' → { key, val: 'Hello', ts: ... }
  'row-1:views' → { key, val: 100, ts: ... }
  'row-2:title' → { key, val: 'Second', ts: ... }

NEW:
rowIndex: Map<string, Set<string>>
  'row-1' → Set { 'row-1:title', 'row-1:views' }
  'row-2' → Set { 'row-2:title' }
```

### Performance After Change

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Get row by ID | O(n) | O(m) | n → m (m = fields in row) |
| Check row exists | O(n) | O(1) | Significant |
| Count rows | O(n) | O(1) | Significant |
| Delete row | O(n) | O(m) | n → m |
| Get all rows | O(n) | O(n) | Same (must visit all cells) |
| Write cell | O(1) | O(1) | Same (+ index update) |
| Delete cell | O(1) | O(1) | Same (+ index update) |

Where:
- `n` = total cells in the table
- `m` = fields in a specific row (typically 5-20)

## Design Decisions

### One Index Is Enough

We only need ONE additional index: `Map<rowId, Set<cellKey>>`.

**Why this is sufficient:**

| Operation | Uses Index? | How |
|-----------|-------------|-----|
| Get row | Yes | `rowIndex.get(rowId)` → iterate cell keys |
| Has row | Yes | `rowIndex.has(rowId)` |
| Count rows | Yes | `rowIndex.size` |
| Delete row | Yes | `rowIndex.get(rowId)` → delete each |
| Write cell | Updates index | `rowIndex.get(rowId).add(cellKey)` |
| Delete cell | Updates index | `rowIndex.get(rowId).delete(cellKey)` |
| Get cell | No | Uses existing `map.get(cellKey)` |
| Get all rows | No* | Still O(n), but could use index to avoid re-grouping |

*`getAll()` is already O(n) and that's fine - you're touching all data anyway.

**Indexes we DON'T need:**

- **Field index** (`fieldId → Set<cellKey>`): Rarely query "all titles across all rows"
- **Value index**: Would require config, complex to maintain
- **Table index**: Each table has its own YKeyValueLww, no cross-table queries

### Why This Index Structure?

**Alternative considered: `Map<rowId, Map<fieldId, entry>>`**

This would give direct access to cells within a row, but:
- Duplicates data already in the main `map`
- More memory overhead
- More complex to keep in sync

**Chosen: `Map<rowId, Set<cellKey>>`**

- Minimal memory overhead (just stores key strings)
- No data duplication (values stay in main map)
- Simple to maintain (add/remove from Set)
- Sufficient for all needed operations

### Why Not Change Storage Format?

We explored alternatives like nested Y.Map structures, but:

1. **Cell-level LWW is valuable**: Timestamp-based "latest edit wins" gives users intuitive conflict resolution
2. **Backward compatible**: Existing data continues to work
3. **Proven correctness**: The current storage format and LWW logic is well-tested
4. **Minimal risk**: Adding an index is additive, not a rewrite

### Index Consistency

The index is derived entirely from the main `map`. It must be updated:

1. **On construction**: Scan existing entries to build initial index
2. **On observer callback**: Update index for adds/deletes
3. **On pending entries**: Include pending writes in index lookups

The single-writer architecture (observer is sole writer to `map`) simplifies this - we only need to update the index in the observer.

## Implementation Plan

### Phase 1: Add Row Index to YKeyValueLww

**File:** `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts`

```typescript
export class YKeyValueLww<T> {
  readonly yarray: Y.Array<YKeyValueLwwEntry<T>>;
  readonly doc: Y.Doc;
  readonly map: Map<string, YKeyValueLwwEntry<T>>;

  // NEW: Secondary index for row-level operations
  // Maps rowId → Set of full cell keys belonging to that row
  readonly rowIndex: Map<string, Set<string>> = new Map();

  private pending: Map<string, YKeyValueLwwEntry<T>> = new Map();

  // NEW: Pending row index for entries not yet in main index
  private pendingRowIndex: Map<string, Set<string>> = new Map();

  // ... existing code ...
}
```

### Phase 2: Build Initial Index on Construction

In the constructor, after building the main `map`:

```typescript
constructor(yarray: Y.Array<YKeyValueLwwEntry<T>>) {
  // ... existing map building code ...

  // Build row index from map
  for (const key of this.map.keys()) {
    this.addToRowIndex(key);
  }

  // ... existing observer setup ...
}

private addToRowIndex(cellKey: string): void {
  const rowId = this.extractRowId(cellKey);
  if (!this.rowIndex.has(rowId)) {
    this.rowIndex.set(rowId, new Set());
  }
  this.rowIndex.get(rowId)!.add(cellKey);
}

private removeFromRowIndex(cellKey: string): void {
  const rowId = this.extractRowId(cellKey);
  const keys = this.rowIndex.get(rowId);
  if (keys) {
    keys.delete(cellKey);
    if (keys.size === 0) {
      this.rowIndex.delete(rowId);
    }
  }
}

// Use existing extractRowId from shared/cell-keys.ts
import { extractRowId } from '../shared/cell-keys.js';
```

### Phase 3: Update Index in Observer

Modify the existing observer to maintain the row index:

```typescript
yarray.observe((event, transaction) => {
  // ... existing change handling ...

  // Handle deletions - update row index
  event.changes.deleted.forEach((deletedItem) => {
    deletedItem.content.getContent().forEach((entry: YKeyValueLwwEntry<T>) => {
      if (this.map.get(entry.key) === entry) {
        this.map.delete(entry.key);
        this.removeFromRowIndex(entry.key);  // NEW
        changes.set(entry.key, { action: 'delete', oldValue: entry.val });
      }
    });
  });

  // ... existing add handling ...

  // For adds that become the winner:
  if (!existing) {
    this.map.set(newEntry.key, newEntry);
    this.addToRowIndex(newEntry.key);  // NEW
    // ... existing change tracking ...
  } else if (newEntry.ts > existing.ts) {
    // New entry wins - index already has the key, no change needed
    this.map.set(newEntry.key, newEntry);
    // ... existing change tracking ...
  }

  // ... rest of observer ...
});
```

### Phase 4: Handle Pending Entries

The `pending` map holds entries written but not yet processed by observer. We need a parallel `pendingRowIndex`:

```typescript
set(key: string, val: T): void {
  const entry: YKeyValueLwwEntry<T> = { key, val, ts: this.getTimestamp() };

  this.pending.set(key, entry);
  this.addToPendingRowIndex(key);  // NEW

  // ... existing yarray operations ...
}

private addToPendingRowIndex(cellKey: string): void {
  const rowId = this.extractRowId(cellKey);
  if (!this.pendingRowIndex.has(rowId)) {
    this.pendingRowIndex.set(rowId, new Set());
  }
  this.pendingRowIndex.get(rowId)!.add(cellKey);
}

// In observer, when clearing pending:
if (this.pending.get(newEntry.key) === newEntry) {
  this.pending.delete(newEntry.key);
  this.removeFromPendingRowIndex(newEntry.key);  // NEW
}
```

### Phase 5: Add Row-Level Query Methods

```typescript
/**
 * Check if a row exists (has any cells). O(1).
 *
 * Checks both confirmed (map) and pending entries.
 */
hasRow(rowId: string): boolean {
  return this.rowIndex.has(rowId) || this.pendingRowIndex.has(rowId);
}

/**
 * Count total rows. O(1).
 *
 * Note: Counts rows with at least one cell. A row with all cells
 * deleted is not counted.
 */
countRows(): number {
  // Combine confirmed and pending, avoiding double-count
  const allRowIds = new Set([
    ...this.rowIndex.keys(),
    ...this.pendingRowIndex.keys(),
  ]);
  return allRowIds.size;
}

/**
 * Get all cell keys for a row. O(1).
 *
 * Returns undefined if row doesn't exist.
 * Combines confirmed and pending entries.
 */
getRowKeys(rowId: string): Set<string> | undefined {
  const confirmed = this.rowIndex.get(rowId);
  const pending = this.pendingRowIndex.get(rowId);

  if (!confirmed && !pending) return undefined;

  const combined = new Set<string>();
  if (confirmed) for (const key of confirmed) combined.add(key);
  if (pending) for (const key of pending) combined.add(key);
  return combined;
}

/**
 * Get all values for a row as a Map<fieldId, value>. O(m).
 *
 * m = number of fields in the row.
 * Returns undefined if row doesn't exist.
 */
getRow(rowId: string): Map<string, T> | undefined {
  const keys = this.getRowKeys(rowId);
  if (!keys) return undefined;

  const row = new Map<string, T>();
  for (const cellKey of keys) {
    const fieldId = cellKey.substring(rowId.length + 1); // Skip "rowId:"
    const value = this.get(cellKey); // Uses existing get() which checks pending
    if (value !== undefined) {
      row.set(fieldId, value);
    }
  }
  return row;
}

/**
 * Delete all cells for a row. O(m).
 *
 * m = number of fields in the row.
 */
deleteRow(rowId: string): void {
  const keys = this.getRowKeys(rowId);
  if (!keys) return;

  this.doc.transact(() => {
    for (const cellKey of keys) {
      this.delete(cellKey);
    }
  });
}

/**
 * Get all unique row IDs. O(1).
 */
getAllRowIds(): Set<string> {
  const allRowIds = new Set<string>();
  for (const rowId of this.rowIndex.keys()) allRowIds.add(rowId);
  for (const rowId of this.pendingRowIndex.keys()) allRowIds.add(rowId);
  return allRowIds;
}
```

### Phase 6: Update TableHelper to Use New Methods

**File:** `packages/epicenter/src/dynamic/tables/table-helper.ts`

The `TableHelper` should delegate to these new `YKeyValueLww` methods:

```typescript
// Before (O(n)):
has(id: Id): boolean {
  const prefix = RowPrefix(id);
  for (const key of ykv.map.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// After (O(1)):
has(id: Id): boolean {
  return ykv.hasRow(id);
}

// Before (O(n)):
count(): number {
  return this.collectRows().size;
}

// After (O(1)):
count(): number {
  return ykv.countRows();
}
```

## Specific Code Changes in TableHelper

The following functions in `packages/epicenter/src/dynamic/tables/table-helper.ts` will benefit from this optimization:

### `has(id: Id)` - Lines 332-338

**Before (O(n)):**
```typescript
has(id: Id): boolean {
  const prefix = RowPrefix(id);
  for (const key of ykv.map.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
```

**After (O(1)):**
```typescript
has(id: Id): boolean {
  return ykv.hasRow(id);
}
```

### `count()` - Lines 392-394

**Before (O(n)):**
```typescript
count(): number {
  return collectRows().size;  // collectRows() iterates all cells
}
```

**After (O(1)):**
```typescript
count(): number {
  return ykv.countRows();
}
```

### `reconstructRow(rowId: Id)` - Lines 204-216

**Before (O(n)):**
```typescript
function reconstructRow(rowId: Id): Record<string, unknown> | undefined {
  const prefix = RowPrefix(rowId);
  const cells: Record<string, unknown> = {};
  let found = false;
  for (const [key, entry] of ykv.map) {
    if (key.startsWith(prefix)) {
      const { columnId } = parseCellKey(key);
      cells[columnId] = entry.val;
      found = true;
    }
  }
  return found ? cells : undefined;
}
```

**After (O(m)):**
```typescript
function reconstructRow(rowId: Id): Record<string, unknown> | undefined {
  const row = ykv.getRow(rowId);
  if (!row) return undefined;
  return Object.fromEntries(row);
}
```

### `deleteRowCells(rowId: Id)` - Lines 236-244

**Before (O(n)):**
```typescript
function deleteRowCells(rowId: Id): boolean {
  const prefix = RowPrefix(rowId);
  const keys = Array.from(ykv.map.keys());
  const keysToDelete = keys.filter((key) => key.startsWith(prefix));
  for (const key of keysToDelete) {
    ykv.delete(key);
  }
  return keysToDelete.length > 0;
}
```

**After (O(m)):**
```typescript
function deleteRowCells(rowId: Id): boolean {
  const keys = ykv.getRowKeys(rowId);
  if (!keys || keys.size === 0) return false;
  ykv.deleteRow(rowId);
  return true;
}
```

---

## API Changes

### YKeyValueLww (New Methods)

| Method | Signature | Complexity | Description |
|--------|-----------|------------|-------------|
| `hasRow` | `(rowId: string) => boolean` | O(1) | Check if row exists |
| `countRows` | `() => number` | O(1) | Count unique rows |
| `getRowKeys` | `(rowId: string) => Set<string> \| undefined` | O(1) | Get cell keys for row |
| `getRow` | `(rowId: string) => Map<string, T> \| undefined` | O(m) | Get all cell values for row |
| `deleteRow` | `(rowId: string) => void` | O(m) | Delete all cells for row |
| `getAllRowIds` | `() => Set<string>` | O(1) | Get all row IDs |

### Memory Overhead

For a table with `r` rows and `c` cells:

- `rowIndex`: O(r) Map entries + O(c) Set entries (strings referencing existing keys)
- `pendingRowIndex`: Typically O(1) to O(10) - pending entries are transient

Estimated overhead: ~50-100 bytes per row (Map entry + Set overhead) + ~20 bytes per cell (Set entry with string pointer).

For 10,000 rows with 5 fields each:
- Rows: 10,000 × 75 bytes ≈ 750 KB
- Cells: 50,000 × 20 bytes ≈ 1 MB
- Total index overhead: ~1.75 MB

This is acceptable for the performance gains.

## Testing Strategy

### Unit Tests for YKeyValueLww

1. **Index building on construction**
   - Empty array → empty index
   - Pre-populated array → correct index
   - Array with duplicate keys (losers) → index reflects winners only

2. **Index updates on mutations**
   - `set()` new cell → index updated
   - `set()` existing cell → index unchanged (same key)
   - `delete()` cell → index updated, row removed if last cell

3. **Index consistency with pending**
   - `set()` inside transaction → pending index updated
   - After transaction → main index updated, pending cleared
   - `get()` during transaction → sees pending entries

4. **Row-level operations**
   - `hasRow()` for existing/non-existing rows
   - `countRows()` accuracy
   - `getRow()` returns all cells
   - `deleteRow()` removes all cells

5. **Edge cases**
   - Row ID containing special characters (but not `:`)
   - Single-cell rows
   - Rows with many cells (100+)
   - Concurrent modifications from multiple clients

### Integration Tests

1. **Sync scenarios**
   - Two clients, one adds row, other sees it
   - Two clients, both add cells to same row, merge correctly
   - Delete row on one client, syncs to other

2. **Performance benchmarks**
   - Compare `hasRow()` before/after for tables with 1K, 10K, 100K cells
   - Compare `countRows()` before/after
   - Compare `getRow()` before/after

## Migration

**No migration needed.** This is a purely additive change:

- Storage format unchanged
- Existing data works without modification
- Index is built from existing data on construction
- New methods are optional (existing code continues to work)

## Open Questions

1. **Should `getRow()` return a plain object or Map?**
   - Map is more consistent with internal representation
   - Plain object might be more ergonomic for consumers
   - Decision: Start with Map, consider adding `getRowAsObject()` if needed

2. **Should we expose `rowIndex` publicly?**
   - Pro: Allows advanced use cases
   - Con: Breaks encapsulation, harder to change later
   - Decision: Keep private, expose only through methods

3. **Should `deleteRow()` be atomic?**
   - Current implementation uses `transact()` for atomicity
   - This means observers fire once for all deletions
   - Decision: Yes, keep atomic (already implemented this way)

## Future Considerations

### Additional Indexes

If profiling reveals other bottlenecks, consider:

- **Field index**: `fieldId → Set<cellKey>` for "find all titles" queries
- **Value index**: For specific high-cardinality fields (would require config)

These are NOT recommended initially - add only if profiling shows need.

### Table-Level Index

Currently each table has its own `YKeyValueLww`. If cross-table queries become important, a workspace-level index could help. Not needed for current use cases.

## Implementation Checklist

- [ ] **Phase 1:** Add `rowIndex` and `pendingRowIndex` properties to `YKeyValueLww`
- [ ] **Phase 2:** Build initial `rowIndex` in constructor (after map is built)
- [ ] **Phase 3:** Update `rowIndex` in observer (on add/delete)
- [ ] **Phase 4:** Update `pendingRowIndex` in `set()` and clear in observer
- [ ] **Phase 5:** Add new methods: `hasRow()`, `countRows()`, `getRowKeys()`, `getRow()`, `deleteRow()`, `getAllRowIds()`
- [ ] **Phase 6:** Update `table-helper.ts` to use new methods
- [ ] **Phase 7:** Write tests for new functionality
- [ ] **Phase 8:** Run benchmarks comparing before/after

## Files to Modify

1. `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts`
   - Add row index properties
   - Add index maintenance in constructor and observer
   - Add new row-level query methods

2. `packages/epicenter/src/dynamic/tables/table-helper.ts`
   - Update `has()` to use `ykv.hasRow()`
   - Update `count()` to use `ykv.countRows()`
   - Update `reconstructRow()` to use `ykv.getRow()`
   - Update `deleteRowCells()` to use `ykv.deleteRow()`

3. `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.test.ts` (or create)
   - Test index building on construction
   - Test index updates on mutations
   - Test row-level query methods
   - Test edge cases (empty rows, special characters)

## References

- `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts` - Current implementation
- `packages/epicenter/src/dynamic/tables/table-helper.ts` - TableHelper that uses YKeyValueLww
- `packages/epicenter/src/shared/cell-keys.ts` - Key format utilities (CellKey, RowPrefix, extractRowId, etc.)

---

## Resolution

**Status: Completed via refactoring (2026-02-13)**

Instead of adding a new `rowIndex` inside `YKeyValueLww`, the optimization was achieved by composing over existing abstractions:

### What Was Done

1. **Moved `y-cell-store.ts` and `y-row-store.ts`** from `shared/` to `dynamic/tables/`: they were dynamic-API-specific, not shared primitives.

2. **Refactored `table-helper.ts`** to compose over `CellStore` + `RowStore` instead of raw `YKeyValueLww`. The `RowStore` already maintains a `Map<rowId, Map<columnId, value>>` in-memory index updated reactively via observers.

3. **Result**: All row-level operations now use the `RowStore` index:
   - `has(id)`: O(1) via `rowStore.has()`
   - `count()`: O(1) via `rowStore.count()`
   - `get(id)`: O(m) via `rowStore.get()` where m = fields per row
   - `delete(id)`: O(m) via `rowStore.delete()`

### Why This Approach

- `CellStore` and `RowStore` already existed with comprehensive test suites (40+ and 90+ tests)
- No changes to `YKeyValueLww`: it stays a generic key-value primitive
- Better separation of concerns: each layer has a single responsibility
- Net reduction of 53 lines of code in `table-helper.ts`

### Commits

1. `refactor(epicenter): move cell-store and row-store from shared/ to dynamic/tables/`
2. `refactor(epicenter): compose table-helper over CellStore + RowStore for O(1) row index`
