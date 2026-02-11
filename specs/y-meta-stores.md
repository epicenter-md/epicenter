# YKeyValue Meta Data Structures

Intermediate storage abstractions between `YKeyValueLww` and higher-level APIs.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Higher-Level APIs                          │
│  ┌──────────────────────┐    ┌──────────────────────────────┐  │
│  │  static/TableHelper  │    │   dynamic/TableHelper        │  │
│  │  (schema validation, │    │  (schema validation,         │  │
│  │   versioned rows)    │    │   field types, Notion-like)  │  │
│  └──────────┬───────────┘    └────────────┬─────────────────┘  │
└─────────────┼────────────────────────────┼──────────────────────┘
              │                            │
┌─────────────┼────────────────────────────┼──────────────────────┐
│             │                            │                      │
│             │              ┌─────────────┴─────────────┐        │
│             │              │        YRowStore          │  NEW   │
│             │              │   (wrapper over cells)    │  LAYER │
│             │              │   Adds row operations     │        │
│             │              └─────────────┬─────────────┘        │
│             │                            │                      │
│             │                            ▼                      │
│             │              ┌─────────────────────────┐          │
│             │              │       YCellStore        │   NEW    │
│             │              │   (pure cell primitive) │   LAYER  │
│             │              │   Schema-free storage   │          │
│             │              └─────────────┬───────────┘          │
│             │                            │                      │
│             ▼                            ▼                      │
│       ┌──────────────────────────────────────┐                  │
│       │           YKeyValueLww               │                  │
│       │     (Low-level CRDT primitive)       │                  │
│       └──────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

## Three Storage Patterns

| Pattern | Storage Model | Use Case |
|---------|---------------|----------|
| **Direct YKeyValueLww** | Whole rows keyed by ID | `static/TableHelper` - fixed schemas, replace entire row |
| **YCellStore** | Individual cells keyed by `rowId:columnId` | Cell-level granularity, concurrent field edits |
| **YRowStore** | Wrapper over YCellStore | `dynamic/TableHelper` - row operations on cell storage |

### When to Use Each

- **Direct YKeyValueLww**: When you have a fixed schema and always write complete rows. Simpler, less overhead.
- **YCellStore + YRowStore**: When you need cell-level conflict resolution (User A edits `title`, User B edits `views` → both merge).

---

## Design Principles

### 1. Schema Decoupled

Neither store does validation. They're pure storage primitives. Schema validation belongs in higher-level APIs (TableHelper).

### 2. Single Responsibility

- `YCellStore` - ONLY cells
- `YRowStore` - ONLY row operations (wraps cells)
- `TableHelper` - schema validation and business logic

### 3. Composition Over Features

`YRowStore` takes a `YCellStore` as its only argument. No duplicate storage, just a different view.

### 4. No Bulk APIs

No `setMany`, `deleteMany`, `updateMany`. Instead, a single `.batch()` method provides a type-safe transaction callback.

### 5. Factory Functions

Follow codebase pattern. Return plain objects, not classes.

### 6. Escape Hatches

Expose underlying primitives for advanced use cases.

---

## File Locations

```
packages/epicenter/src/shared/
├── y-keyvalue/
│   ├── y-keyvalue-lww.ts      # Existing - low-level CRDT
│   └── y-keyvalue.ts          # Existing - simpler variant
├── y-cell-store.ts            # NEW - pure cell primitive
├── y-cell-store.test.ts       # NEW
├── y-row-store.ts             # NEW - wrapper over CellStore
└── y-row-store.test.ts        # NEW
```

---

# YCellStore Specification

**File:** `packages/epicenter/src/shared/y-cell-store.ts`

**Purpose:** Schema-agnostic sparse grid storage. Cells stored with compound keys `rowId:columnId`. Pure cell primitive - no row operations.

## Key Format

```typescript
const SEPARATOR = ':' as const;

// Cell key: "rowId:columnId"
// rowId MUST NOT contain ':'
// columnId MAY contain ':' (separator is first occurrence only)
```

## Types

```typescript
import type * as Y from 'yjs';
import type { YKeyValueLww } from './y-keyvalue/y-keyvalue-lww.js';

/** A single cell's location and value. */
export type Cell<T> = {
  rowId: string;
  columnId: string;
  value: T;
};

/** Change event for a single cell. */
export type CellChange<T> =
  | { action: 'add'; rowId: string; columnId: string; value: T }
  | { action: 'update'; rowId: string; columnId: string; oldValue: T; value: T }
  | { action: 'delete'; rowId: string; columnId: string; oldValue: T };

/** Handler for cell change events. */
export type CellChangeHandler<T> = (
  changes: CellChange<T>[],
  transaction: Y.Transaction,
) => void;

/** Operations available inside a batch transaction. */
export type CellStoreBatchTransaction<T> = {
  setCell(rowId: string, columnId: string, value: T): void;
  deleteCell(rowId: string, columnId: string): void;
};

/** Pure cell-level storage primitive. */
export type CellStore<T> = {
  // ═══════════════════════════════════════════════════════════════════
  // CELL CRUD
  // ═══════════════════════════════════════════════════════════════════

  /** Set a single cell value. */
  setCell(rowId: string, columnId: string, value: T): void;

  /** Get a single cell value. Returns undefined if not found. */
  getCell(rowId: string, columnId: string): T | undefined;

  /** Check if a cell exists. */
  hasCell(rowId: string, columnId: string): boolean;

  /** Delete a single cell. Returns true if existed. */
  deleteCell(rowId: string, columnId: string): boolean;

  // ═══════════════════════════════════════════════════════════════════
  // BATCH
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Execute multiple operations atomically in a Y.js transaction.
   * - Single undo/redo step
   * - Observers fire once (not per-operation)
   * - All changes applied together
   */
  batch(fn: (tx: CellStoreBatchTransaction<T>) => void): void;

  // ═══════════════════════════════════════════════════════════════════
  // ITERATION & METADATA
  // ═══════════════════════════════════════════════════════════════════

  /** Iterate all cells with parsed components. */
  cells(): IterableIterator<Cell<T>>;

  /** Total number of cells. */
  count(): number;

  /** Delete all cells. */
  clear(): void;

  // ═══════════════════════════════════════════════════════════════════
  // OBSERVE
  // ═══════════════════════════════════════════════════════════════════

  /** Watch for cell changes. Returns unsubscribe function. */
  observe(handler: CellChangeHandler<T>): () => void;

  // ═══════════════════════════════════════════════════════════════════
  // ESCAPE HATCH
  // ═══════════════════════════════════════════════════════════════════

  /** The underlying YKeyValueLww for advanced use cases. */
  readonly ykv: YKeyValueLww<T>;

  /** The Y.Doc for transaction control. */
  readonly doc: Y.Doc;
};
```

## Factory Function

```typescript
/**
 * Create a schema-agnostic cell store backed by YKeyValueLww.
 *
 * @param ydoc - The Y.Doc to store data in
 * @param arrayKey - The key name for the Y.Array (e.g., 'table:posts')
 */
export function createCellStore<T>(
  ydoc: Y.Doc,
  arrayKey: string,
): CellStore<T>;
```

## Implementation Notes

### 1. Key Utilities (Private)

```typescript
const SEPARATOR = ':';

function cellKey(rowId: string, columnId: string): string {
  if (rowId.includes(SEPARATOR)) {
    throw new Error(`rowId cannot contain '${SEPARATOR}': "${rowId}"`);
  }
  return `${rowId}${SEPARATOR}${columnId}`;
}

function parseCellKey(key: string): { rowId: string; columnId: string } {
  const idx = key.indexOf(SEPARATOR);
  if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
  return {
    rowId: key.slice(0, idx),
    columnId: key.slice(idx + 1),
  };
}
```

### 2. Constructor Creates YKeyValueLww Internally

```typescript
export function createCellStore<T>(ydoc: Y.Doc, arrayKey: string): CellStore<T> {
  const yarray = ydoc.getArray<YKeyValueLwwEntry<T>>(arrayKey);
  const ykv = new YKeyValueLww<T>(yarray);

  return {
    setCell(rowId, columnId, value) {
      ykv.set(cellKey(rowId, columnId), value);
    },

    getCell(rowId, columnId) {
      return ykv.get(cellKey(rowId, columnId));
    },

    hasCell(rowId, columnId) {
      return ykv.has(cellKey(rowId, columnId));
    },

    deleteCell(rowId, columnId) {
      const key = cellKey(rowId, columnId);
      if (!ykv.has(key)) return false;
      ykv.delete(key);
      return true;
    },

    batch(fn) {
      ydoc.transact(() => {
        fn({
          setCell: (rowId, columnId, value) => ykv.set(cellKey(rowId, columnId), value),
          deleteCell: (rowId, columnId) => ykv.delete(cellKey(rowId, columnId)),
        });
      });
    },

    *cells() {
      for (const [key, entry] of ykv.entries()) {
        const { rowId, columnId } = parseCellKey(key);
        yield { rowId, columnId, value: entry.val };
      }
    },

    count() {
      return ykv.map.size;
    },

    clear() {
      const keys = Array.from(ykv.map.keys());
      ydoc.transact(() => {
        for (const key of keys) {
          ykv.delete(key);
        }
      });
    },

    observe(handler) {
      const ykvHandler = (changes: Map<string, YKeyValueLwwChange<T>>, transaction: Y.Transaction) => {
        const cellChanges: CellChange<T>[] = [];

        for (const [key, change] of changes) {
          const { rowId, columnId } = parseCellKey(key);

          if (change.action === 'add') {
            cellChanges.push({ action: 'add', rowId, columnId, value: change.newValue });
          } else if (change.action === 'update') {
            cellChanges.push({ action: 'update', rowId, columnId, oldValue: change.oldValue, value: change.newValue });
          } else if (change.action === 'delete') {
            cellChanges.push({ action: 'delete', rowId, columnId, oldValue: change.oldValue });
          }
        }

        if (cellChanges.length > 0) {
          handler(cellChanges, transaction);
        }
      };

      ykv.observe(ykvHandler);
      return () => ykv.unobserve(ykvHandler);
    },

    ykv,
    doc: ydoc,
  };
}
```

---

# YRowStore Specification

**File:** `packages/epicenter/src/shared/y-row-store.ts`

**Purpose:** Row operations wrapper over `CellStore`. Provides row reconstruction, row deletion, and row-level observation. Does NOT store anything itself - delegates to the underlying `CellStore`.

## Types

```typescript
import type * as Y from 'yjs';
import type { CellStore } from './y-cell-store.js';

/** Handler for row-level change notifications (deduplicated from cells). */
export type RowsChangedHandler = (
  changedRowIds: Set<string>,
  transaction: Y.Transaction,
) => void;

/** Row operations wrapper over CellStore. */
export type RowStore<T> = {
  // ═══════════════════════════════════════════════════════════════════
  // ROW READ
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Reconstruct a row from its cells.
   * Returns undefined if no cells exist for this row.
   * O(n) where n = total cells in store.
   */
  get(rowId: string): Record<string, T> | undefined;

  /** Check if any cells exist for a row. O(n) worst case, early-exits. */
  has(rowId: string): boolean;

  /** Get all row IDs that have at least one cell. O(n) with deduplication. */
  ids(): string[];

  /** Get all rows reconstructed from cells. O(n) single pass. */
  getAll(): Map<string, Record<string, T>>;

  /** Number of unique rows. */
  count(): number;

  // ═══════════════════════════════════════════════════════════════════
  // ROW DELETE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Delete all cells for a row.
   * Returns true if any cells existed.
   * O(n) scan + k deletions where k = cells in row.
   */
  delete(rowId: string): boolean;

  // ═══════════════════════════════════════════════════════════════════
  // OBSERVE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Watch for row-level changes (deduplicated from cell changes).
   * Callback receives Set of row IDs that had any cell change.
   * Returns unsubscribe function.
   */
  observe(handler: RowsChangedHandler): () => void;

  // ═══════════════════════════════════════════════════════════════════
  // UNDERLYING STORE
  // ═══════════════════════════════════════════════════════════════════

  /** The underlying CellStore for cell-level operations. */
  readonly cells: CellStore<T>;
};
```

## Factory Function

```typescript
/**
 * Create a row operations wrapper over an existing CellStore.
 *
 * @param cellStore - The CellStore to wrap
 */
export function createRowStore<T>(cellStore: CellStore<T>): RowStore<T>;
```

## Implementation Notes

### 1. Row Prefix Utility (Private)

```typescript
const SEPARATOR = ':';

function rowPrefix(rowId: string): string {
  return `${rowId}${SEPARATOR}`;
}

function extractRowId(key: string): string {
  const idx = key.indexOf(SEPARATOR);
  return key.slice(0, idx);
}
```

### 2. Full Implementation

```typescript
export function createRowStore<T>(cellStore: CellStore<T>): RowStore<T> {
  const { ykv, doc } = cellStore;

  return {
    get(rowId) {
      const prefix = rowPrefix(rowId);
      const cells: Record<string, T> = {};
      let found = false;

      for (const [key, entry] of ykv.map) {
        if (key.startsWith(prefix)) {
          const columnId = key.slice(prefix.length);
          cells[columnId] = entry.val;
          found = true;
        }
      }

      return found ? cells : undefined;
    },

    has(rowId) {
      const prefix = rowPrefix(rowId);
      for (const key of ykv.map.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },

    ids() {
      const seen = new Set<string>();
      for (const key of ykv.map.keys()) {
        seen.add(extractRowId(key));
      }
      return Array.from(seen);
    },

    getAll() {
      const rows = new Map<string, Record<string, T>>();

      for (const [key, entry] of ykv.map) {
        const rowId = extractRowId(key);
        const columnId = key.slice(rowId.length + 1); // +1 for separator

        const existing = rows.get(rowId) ?? {};
        existing[columnId] = entry.val;
        rows.set(rowId, existing);
      }

      return rows;
    },

    count() {
      const seen = new Set<string>();
      for (const key of ykv.map.keys()) {
        seen.add(extractRowId(key));
      }
      return seen.size;
    },

    delete(rowId) {
      const prefix = rowPrefix(rowId);
      const keysToDelete: string[] = [];

      for (const key of ykv.map.keys()) {
        if (key.startsWith(prefix)) {
          keysToDelete.push(key);
        }
      }

      if (keysToDelete.length === 0) return false;

      doc.transact(() => {
        for (const key of keysToDelete) {
          ykv.delete(key);
        }
      });

      return true;
    },

    observe(handler) {
      return cellStore.observe((changes, transaction) => {
        const rowIds = new Set(changes.map(c => c.rowId));
        if (rowIds.size > 0) {
          handler(rowIds, transaction);
        }
      });
    },

    cells: cellStore,
  };
}
```

---

# Usage Examples

## Cell-Level Operations (YCellStore Only)

```typescript
import { createCellStore } from '../shared/y-cell-store.js';

const cells = createCellStore<unknown>(ydoc, 'table:posts');

// Single cell operations
cells.setCell('row-1', 'title', 'Hello');
cells.setCell('row-1', 'views', 42);
cells.getCell('row-1', 'title'); // 'Hello'

// Batch operations (atomic, single observer notification)
cells.batch((tx) => {
  tx.setCell('row-1', 'title', 'Updated');
  tx.setCell('row-2', 'title', 'New Row');
  tx.deleteCell('row-1', 'views');
});

// Observe cell changes
const unsubscribe = cells.observe((changes, transaction) => {
  for (const change of changes) {
    console.log(change.action, change.rowId, change.columnId);
  }
});

// Iterate all cells
for (const { rowId, columnId, value } of cells.cells()) {
  console.log(`${rowId}.${columnId} = ${value}`);
}
```

## Row-Level Operations (YCellStore + YRowStore)

```typescript
import { createCellStore } from '../shared/y-cell-store.js';
import { createRowStore } from '../shared/y-row-store.js';

// Create both stores
const cells = createCellStore<unknown>(ydoc, 'table:posts');
const rows = createRowStore(cells);

// Write via cells (cell-level granularity)
cells.batch((tx) => {
  tx.setCell('post-1', 'title', 'Hello World');
  tx.setCell('post-1', 'views', 0);
  tx.setCell('post-1', 'published', false);
});

// Read via rows (reconstructed)
const post = rows.get('post-1');
// { title: 'Hello World', views: 0, published: false }

// Row existence check
rows.has('post-1'); // true
rows.has('post-999'); // false

// All row IDs
rows.ids(); // ['post-1']

// Delete entire row (all cells)
rows.delete('post-1'); // true

// Observe at row level (deduplicated)
const unsubscribe = rows.observe((changedRowIds, transaction) => {
  for (const rowId of changedRowIds) {
    const row = rows.get(rowId);
    console.log('Changed:', rowId, row);
  }
});
```

## Static Pattern (Direct YKeyValueLww)

The `static/TableHelper` continues to use `YKeyValueLww` directly for whole-row storage:

```typescript
// In packages/epicenter/src/static/table-helper.ts

import { YKeyValueLww } from '../shared/y-keyvalue/y-keyvalue-lww.js';

export function createTableHelper(ykv: YKeyValueLww<unknown>, definition) {
  return {
    set(row) {
      ykv.set(row.id, row);  // Whole row, single key
    },

    get(id) {
      const raw = ykv.get(id);  // Whole row returned
      return parseRow(id, raw);
    },

    // ... validation, migration, etc.
  };
}
```

## Dynamic Pattern (YCellStore + YRowStore)

```typescript
// In packages/epicenter/src/dynamic/tables/table-helper.ts

import { createCellStore } from '../../shared/y-cell-store.js';
import { createRowStore } from '../../shared/y-row-store.js';

export function createTableHelper({ ydoc, tableDefinition }) {
  const cells = createCellStore<unknown>(ydoc, TableKey(tableDefinition.id));
  const rows = createRowStore(cells);

  return {
    upsert(row) {
      cells.batch((tx) => {
        for (const [columnId, value] of Object.entries(row)) {
          tx.setCell(row.id, columnId, value);
        }
      });
    },

    update(partialRow) {
      if (!rows.has(partialRow.id)) {
        return { status: 'not_found_locally' };
      }
      cells.batch((tx) => {
        for (const [columnId, value] of Object.entries(partialRow)) {
          tx.setCell(partialRow.id, columnId, value);
        }
      });
      return { status: 'applied' };
    },

    get(id) {
      const raw = rows.get(id);
      if (!raw) return { status: 'not_found', id, row: undefined };
      return validateRow(id, raw);
    },

    delete(id) {
      return rows.delete(id)
        ? { status: 'deleted' }
        : { status: 'not_found_locally' };
    },

    observe(callback) {
      return rows.observe(callback);
    },

    // Access underlying stores for advanced use
    cells,
    rows,
  };
}
```

---

# Testing Requirements

## y-cell-store.test.ts

1. **Cell CRUD**: `setCell`, `getCell`, `hasCell`, `deleteCell`
2. **Key validation**: `rowId` with `:` throws error
3. **Batch operations**: multiple cell operations atomically
4. **Observer fires once per batch**: not per operation
5. **Change types**: `add`, `update`, `delete` events with correct `rowId`/`columnId`
6. **Iteration**: `cells()` yields all cells with parsed components
7. **Count accuracy**: after various operations
8. **Clear**: removes all cells
9. **Escape hatch**: `ykv` and `doc` accessible

## y-row-store.test.ts

1. **Row reconstruction**: `get()` assembles cells correctly
2. **Row existence**: `has()` returns true only if cells exist
3. **Row IDs**: `ids()` returns deduplicated list
4. **Get all rows**: `getAll()` reconstructs all rows
5. **Row count**: `count()` matches unique row count
6. **Row deletion**: `delete()` removes all cells for row
7. **Observe dedupe**: `observe()` fires with Set of changed row IDs
8. **Underlying access**: `cells` property gives CellStore
9. **Empty row**: `get()` returns undefined, `has()` returns false
10. **Sparse rows**: rows with different columns work correctly

---

# Implementation Checklist

- [ ] Create `packages/epicenter/src/shared/y-cell-store.ts`
- [ ] Create `packages/epicenter/src/shared/y-cell-store.test.ts`
- [ ] Create `packages/epicenter/src/shared/y-row-store.ts`
- [ ] Create `packages/epicenter/src/shared/y-row-store.test.ts`
- [ ] Run tests: `bun test y-cell-store && bun test y-row-store`
- [ ] Export from index (if needed)
- [ ] Update `dynamic/tables/table-helper.ts` to use new stores (future task)

---

# Design Decisions

## Why No `setRow()` on YRowStore?

The semantics are ambiguous:
- Should it **merge** with existing cells? (What about columns not in the new row?)
- Should it **replace** all cells? (Delete first, then set?)

Explicit is better. Use `cells.batch()` for writes:

```typescript
// REPLACE row (delete old, add new)
rows.delete(id);
cells.batch((tx) => {
  for (const [col, val] of Object.entries(newRow)) {
    tx.setCell(id, col, val);
  }
});

// MERGE row (only update specified cells)
cells.batch((tx) => {
  for (const [col, val] of Object.entries(partialRow)) {
    tx.setCell(id, col, val);
  }
});
```

## Why Separate YCellStore and YRowStore?

1. **Single responsibility**: CellStore handles cells, RowStore handles row patterns
2. **Composition**: RowStore wraps CellStore, no duplicate storage
3. **Flexibility**: Use CellStore alone for pure cell operations
4. **Testing**: Each layer testable in isolation

## Why Does Static Use YKeyValueLww Directly?

For fixed schemas where you always write complete rows, cell-level storage adds unnecessary overhead:
- More keys to manage
- Row reconstruction on every read
- No benefit if concurrent field edits aren't needed

Direct `YKeyValueLww` with whole rows is simpler and faster for this use case.

## Why Three Observer Layers?

The observer API has three distinct levels with progressive information reduction:

```
YKeyValueLww.observe()  →  Map<"rowId:columnId", Change>  (full details)
       ↓ transforms
CellStore.observe()     →  CellChange[] with rowId, columnId, action, values
       ↓ deduplicates
RowStore.observe()      →  Set<string> of affected row IDs only
```

**This layered design:**

1. **Lets consumers subscribe at the appropriate granularity**
   - Need to highlight specific cells? Use `cellStore.observe()`
   - Just need to invalidate rows? Use `rowStore.observe()`

2. **Keeps each layer testable in isolation**
   - CellStore tests don't need row semantics
   - RowStore tests don't need cell-level assertions

3. **Follows the escape hatch principle**
   - `rowStore.cells` gives access to CellStore
   - `cellStore.ykv` gives access to YKeyValueLww
   - Advanced consumers can subscribe to multiple layers simultaneously

4. **Matches Yjs conventions**
   - Single observer fire per transaction (batched)
   - Unsubscribe function returned
   - Transaction object passed for origin checking

**When to use each:**

| Layer | Observer Returns | Use When |
|-------|------------------|----------|
| `ykv.observe()` | `Map<key, Change>` | Building custom abstractions, need raw CRDT access |
| `cellStore.observe()` | `CellChange[]` | Need exact cell coordinates, action type, old/new values |
| `rowStore.observe()` | `Set<rowId>` | Just need to know which rows changed (invalidation, re-render)
