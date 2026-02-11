# RowStore: Add merge() and batch()

**Date**: February 5, 2026
**Status**: Ready for implementation
**Prereq**: The previous refactor already removed the old `batch()` (which duplicated CellStore's `setCell`/`deleteCell`) and the `cells` property. This spec adds back row-level write operations that don't violate layer separation.

## Problem

After the cleanup, RowStore has no way to write data. Callers must drop down to CellStore for every write, even when the intent is clearly row-level ("merge these fields into row X"). This is fine for cell-level work, but awkward for row-level workflows.

## Solution

Add two methods to RowStore:

1. **`merge(rowId, data)`** — Set multiple cells for a row from a partial record. Merge semantics: only touches columns present in `data`, leaves others untouched.
2. **`batch(fn)`** — Execute multiple row-level operations atomically. The transaction exposes `{ merge, delete }` — both row-level. No `setCell`/`deleteCell` (those belong to CellStore).

## Why "merge"

| Name | Problem |
|------|---------|
| `set` | Ambiguous: does it replace the entire row or merge fields? |
| `upsert` | Database term for "insert or update the whole record." We're merging fields, not whole records. |
| `patch` | Implies the resource must already exist. `merge` works whether the row exists or not. |
| **`merge`** | Clear: "merge these key-value pairs into the row." Creates if missing, updates if present. No ambiguity about unmentioned columns. |

## API Design

### New Types

```typescript
/** Operations available inside a row batch transaction. */
export type RowStoreBatchTransaction<T> = {
  /** Merge fields into a row. Only touches columns present in data. */
  merge(rowId: string, data: Record<string, T>): void;
  /** Delete all cells for a row. */
  delete(rowId: string): void;
};
```

### Updated RowStore<T> Type

```typescript
export type RowStore<T> = {
  // ROW READ (unchanged)
  get(rowId: string): Record<string, T> | undefined;
  has(rowId: string): boolean;
  ids(): string[];
  getAll(): Map<string, Record<string, T>>;
  count(): number;

  // ROW WRITE (new)

  /**
   * Merge fields into a row. Only sets columns present in data.
   * Creates the row if it doesn't exist.
   * Leaves unmentioned columns untouched.
   */
  merge(rowId: string, data: Record<string, T>): void;

  // ROW DELETE (unchanged)
  delete(rowId: string): boolean;

  // BATCH (new — row-level only)

  /**
   * Execute multiple row operations atomically in a Y.js transaction.
   * - Single undo/redo step
   * - Observers fire once (not per-operation)
   * - Transaction has { merge, delete } — row-level operations only
   */
  batch(fn: (tx: RowStoreBatchTransaction<T>) => void): void;

  // OBSERVE (unchanged)
  observe(handler: RowsChangedHandler): () => void;
};
```

### Layer Separation

The old `batch` violated layer separation by exposing `setCell`/`deleteCell` — direct duplicates of CellStore methods that bypassed CellStore entirely (calling `ykv.set`/`ykv.delete` directly).

The new API maintains clean separation:

| Layer | Writes | Reads |
|-------|--------|-------|
| **CellStore** | `setCell`, `deleteCell`, `batch({ setCell, deleteCell })` | `getCell`, `hasCell`, `cells()`, `count()` |
| **RowStore** | `merge`, `delete`, `batch({ merge, delete })` | `get`, `has`, `ids`, `getAll`, `count` |

`merge` delegates to `cellStore.setCell()` (not `ykv.set()` directly). `delete` uses `ykv.delete()` as before (it must, since CellStore has no "delete all cells for row" operation — that's a row-level concept).

## Implementation

### In y-row-store.ts

#### 1. Add `RowStoreBatchTransaction<T>` type

```typescript
/** Operations available inside a row batch transaction. */
export type RowStoreBatchTransaction<T> = {
  /** Merge fields into a row. Only touches columns present in data. */
  merge(rowId: string, data: Record<string, T>): void;
  /** Delete all cells for a row. */
  delete(rowId: string): void;
};
```

#### 2. Add `merge` and `batch` to `RowStore<T>` type definition

Add a `ROW WRITE` section with `merge`, and a `BATCH` section with `batch`.

#### 3. Update module doc comment @example

Add `merge` and `batch` examples showing row-level usage:

```typescript
// Merge fields into a row (creates if missing, updates if present)
rows.merge('post-1', { title: 'Hello World', views: 0 });

// Batch row operations (atomic, single observer notification)
rows.batch((tx) => {
  tx.merge('post-1', { title: 'Updated', views: 1 });
  tx.merge('post-2', { title: 'New Post' });
  tx.delete('post-3');
});
```

#### 4. Implement `merge` in `createRowStore` return object

```typescript
merge(rowId, data) {
  doc.transact(() => {
    for (const [columnId, value] of Object.entries(data)) {
      cellStore.setCell(rowId, columnId, value);
    }
  });
},
```

Note: delegates to `cellStore.setCell()`, not `ykv.set()`. CellStore owns key formatting and validation.

#### 5. Implement `batch` in `createRowStore` return object

```typescript
batch(fn) {
  doc.transact(() => {
    fn({
      merge(rowId, data) {
        for (const [columnId, value] of Object.entries(data)) {
          cellStore.setCell(rowId, columnId, value);
        }
      },
      delete(rowId) {
        const prefix = rowPrefix(rowId);
        for (const key of ykv.map.keys()) {
          if (key.startsWith(prefix)) {
            ykv.delete(key);
          }
        }
      },
    });
  });
},
```

### In y-row-store.test.ts

#### 1. Add `describe('Merge', ...)` block after Row Deletion, before Atomic Operations

Tests:

- **merge() sets multiple cells for a row** — Verify `rows.merge('row-1', { title: 'Hello', views: '42' })` then `rows.get('row-1')` returns the merged data.
- **merge() creates a new row if it doesn't exist** — Verify merge on non-existent row creates it.
- **merge() preserves unmentioned columns** — Set `{ a: '1', b: '2' }`, then merge `{ b: '3', c: '4' }`, verify result is `{ a: '1', b: '3', c: '4' }`.
- **merge() fires single observer notification** — Verify one callback for multi-field merge.
- **merge() with empty object is a no-op** — `rows.merge('row-1', {})` shouldn't fire observers or create a row.

#### 2. Add `describe('Batch Operations', ...)` block after Merge, before Atomic Operations

Tests:

- **batch merge sets cells atomically** — Multiple merges in one batch, verify all applied.
- **batch fires single observer notification** — Multiple operations, one callback.
- **batch observer receives all changed row IDs** — Verify the Set contains all affected rows.
- **batch merge and delete in single transaction** — Mix merge + delete, verify both apply, one notification.
- **batch delete of non-existent row is a no-op** — No error, existing rows unaffected.
- **batch with empty callback is a no-op** — No observer fires.

#### 3. Update top doc comment

Add merge and batch to the test list.

#### 4. Keep existing `describe('Atomic Operations via doc.transact()', ...)` block unchanged

These tests verify that `cells.doc.transact()` still works as the escape hatch for mixing CellStore + RowStore operations.

## Verify

```bash
bun test packages/epicenter/src/shared/y-row-store.test.ts
bun test packages/epicenter/src/shared/y-cell-store.test.ts
bun x tsc --noEmit --project packages/epicenter/tsconfig.json
```

## Files Changed

| File | Action |
|------|--------|
| `packages/epicenter/src/shared/y-row-store.ts` | Add `RowStoreBatchTransaction<T>`, `merge`, `batch` |
| `packages/epicenter/src/shared/y-row-store.test.ts` | Add ~11 new tests for merge and batch |

## Files NOT Changed

| File | Reason |
|------|--------|
| `packages/epicenter/src/shared/y-cell-store.ts` | CellStore API unchanged |
| `specs/y-meta-stores.md` | Update separately if desired |

## Usage After Implementation

```typescript
const cells = createCellStore<unknown>(ydoc, 'table:posts');
const rows = createRowStore(cells);

// Row-level writes via RowStore
rows.merge('post-1', { title: 'Hello World', views: 0 });

// Batch row operations
rows.batch((tx) => {
  tx.merge('post-1', { title: 'Updated' });
  tx.merge('post-2', { title: 'New Post', views: 0 });
  tx.delete('post-3');
});

// Cell-level writes still go through CellStore
cells.setCell('post-1', 'draft', true);
cells.deleteCell('post-1', 'views');

// Atomic mixed operations via escape hatch
cells.doc.transact(() => {
  rows.merge('post-2', { title: 'Atomic' });
  cells.deleteCell('post-1', 'draft');
  rows.delete('post-3');
});
```
