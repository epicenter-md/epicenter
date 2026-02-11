# Table-Partitioned Y.Doc Storage

**Created**: 2026-01-28
**Status**: Superseded
**Superseded By**: Option B in `20260127T220000-external-schema-architecture.md`
**Location**: `packages/epicenter/src/cell`

> **Note**: This spec proposed using `Y.Map<Y.Array>` for table partitioning. This approach was
> abandoned because Y.Map uses LWW at the Map level—when two clients independently create a Y.Array
> for the same key, one client's entire Y.Array is lost. The implemented solution uses top-level
> named Y.Arrays via `ydoc.getArray(tableId)` which merge correctly as Yjs shared types.

## Problem

The current cell workspace uses flat arrays with compound keys:

```
Y.Doc
├── Y.Array('cell:cells')   ← ALL cells, keyed by `{tableId}:{rowId}:{fieldId}`
├── Y.Array('cell:rows')    ← ALL rows, keyed by `{tableId}:{rowId}`
└── Y.Array('cell:kv')
```

**Issues:**

1. **O(n) reads**: To get all cells for a single row, we scan the entire workspace's cells array
2. **Key bloat**: Every key includes `tableId:`, wasting storage
3. **No isolation**: All tables share one array—large tables slow down reads for small tables

## Proposed Structure

Partition cells and rows by table using `Y.Map` of `Y.Array`:

```
Y.Doc
├── Y.Map('cells')              ← One Y.Array per table
│   ├── 'posts' → Y.Array       ← YKeyValueLww<CellValue>
│   │   ├── { key: 'row1:title', val: 'Hello', ts: ... }
│   │   ├── { key: 'row1:published', val: true, ts: ... }
│   │   └── ...
│   ├── 'comments' → Y.Array
│   │   └── ...
│   └── ...
│
├── Y.Map('rows')               ← One Y.Array per table
│   ├── 'posts' → Y.Array       ← YKeyValueLww<RowMeta>
│   │   ├── { key: 'row1', val: { order: 1, deletedAt: null }, ts: ... }
│   │   └── ...
│   ├── 'comments' → Y.Array
│   │   └── ...
│   └── ...
│
└── Y.Array('kv')               ← YKeyValueLww<unknown> (unchanged)
    ├── { key: 'theme', val: 'dark', ts: ... }
    └── ...
```

## Key Changes

### 1. Shorter Keys

| Store | Current Key | New Key |
|-------|------------|---------|
| cells | `posts:row1:title` | `row1:title` |
| rows | `posts:row1` | `row1` |
| kv | `theme` | `theme` (unchanged) |

The `tableId` is now encoded in the Y.Map structure, not the key.

### 2. Table-Scoped Operations

```typescript
// Current: scan ALL cells to find one row
function getByRow(tableId: string, rowId: string) {
  const prefix = `${tableId}:${rowId}:`;
  for (const [key, entry] of ykv.map) {  // O(total cells)
    if (key.startsWith(prefix)) { ... }
  }
}

// Proposed: scan only that table's cells
function getByRow(tableId: string, rowId: string) {
  const tableArray = cellsMap.get(tableId);
  const ykv = getOrCreateYkv(tableArray);
  const prefix = `${rowId}:`;
  for (const [key, entry] of ykv.map) {  // O(table cells)
    if (key.startsWith(prefix)) { ... }
  }
}
```

### 3. Dynamic Table Creation

Tables are created on-demand when first accessed:

```typescript
function getTableCells(tableId: string): YKeyValueLww<CellValue> {
  const cellsMap = doc.getMap<Y.Array<YKeyValueLwwEntry<CellValue>>>('cells');

  if (!cellsMap.has(tableId)) {
    cellsMap.set(tableId, new Y.Array());
  }

  return new YKeyValueLww(cellsMap.get(tableId)!);
}
```

## Implementation Details

### File: `keys.ts`

Remove `tableId` from key construction:

```typescript
// Current
export function cellKey(tableId: string, rowId: string, fieldId: string): string {
  return `${tableId}:${rowId}:${fieldId}`;
}

// Proposed
export function cellKey(rowId: string, fieldId: string): string {
  return `${rowId}:${fieldId}`;
}

export function rowKey(rowId: string): string {
  return rowId;  // Just the ID now
}

// Parsing also simplified
export function parseCellKey(key: string): { rowId: string; fieldId: string } {
  const parts = key.split(':');
  if (parts.length !== 2) throw new Error(`Invalid cell key: "${key}"`);
  return { rowId: parts[0]!, fieldId: parts[1]! };
}

export function parseRowKey(key: string): { rowId: string } {
  return { rowId: key };  // Key IS the rowId
}
```

### File: `stores/cells-store.ts`

The store now manages a `Y.Map` of `Y.Array`:

```typescript
export const CELLS_MAP_NAME = 'cells';

type TableCellsCache = Map<string, YKeyValueLww<CellValue>>;

export function createCellsStore(
  cellsMap: Y.Map<Y.Array<YKeyValueLwwEntry<CellValue>>>,
): CellsStore {
  // Cache YKeyValueLww instances per table (avoid recreating on every access)
  const cache: TableCellsCache = new Map();

  function getTableYkv(tableId: string): YKeyValueLww<CellValue> {
    let ykv = cache.get(tableId);
    if (!ykv) {
      // Ensure array exists
      if (!cellsMap.has(tableId)) {
        cellsMap.set(tableId, new Y.Array());
      }
      ykv = new YKeyValueLww(cellsMap.get(tableId)!);
      cache.set(tableId, ykv);
    }
    return ykv;
  }

  function get(tableId: string, rowId: string, fieldId: string): CellValue | undefined {
    return getTableYkv(tableId).get(cellKey(rowId, fieldId));
  }

  function set(tableId: string, rowId: string, fieldId: string, value: CellValue): void {
    validateId(tableId, 'tableId');
    validateId(rowId, 'rowId');
    validateId(fieldId, 'fieldId');
    getTableYkv(tableId).set(cellKey(rowId, fieldId), value);
  }

  function getByRow(tableId: string, rowId: string): Map<string, CellValue> {
    const ykv = getTableYkv(tableId);
    const prefix = `${rowId}:`;
    const results = new Map<string, CellValue>();

    for (const [key, entry] of ykv.map) {
      if (key.startsWith(prefix)) {
        const { fieldId } = parseCellKey(key);
        results.set(fieldId, entry.val);
      }
    }

    return results;
  }

  // ... rest of implementation
}
```

### File: `stores/rows-store.ts`

Similar pattern:

```typescript
export const ROWS_MAP_NAME = 'rows';

export function createRowsStore(
  rowsMap: Y.Map<Y.Array<YKeyValueLwwEntry<RowMeta>>>,
): RowsStore {
  const cache: Map<string, YKeyValueLww<RowMeta>> = new Map();

  function getTableYkv(tableId: string): YKeyValueLww<RowMeta> {
    let ykv = cache.get(tableId);
    if (!ykv) {
      if (!rowsMap.has(tableId)) {
        rowsMap.set(tableId, new Y.Array());
      }
      ykv = new YKeyValueLww(rowsMap.get(tableId)!);
      cache.set(tableId, ykv);
    }
    return ykv;
  }

  function get(tableId: string, rowId: string): RowMeta | undefined {
    return getTableYkv(tableId).get(rowId);  // Key is just rowId now
  }

  function getByTable(tableId: string): Array<{ id: string; meta: RowMeta }> {
    const ykv = getTableYkv(tableId);
    const results: Array<{ id: string; meta: RowMeta }> = [];

    // No prefix filtering needed - entire array is this table's rows
    for (const [rowId, entry] of ykv.map) {
      results.push({ id: rowId, meta: entry.val });
    }

    return results.sort((a, b) => {
      if (a.meta.order !== b.meta.order) return a.meta.order - b.meta.order;
      return a.id.localeCompare(b.id);
    });
  }

  // ... rest of implementation
}
```

### File: `create-cell-workspace.ts`

```typescript
export function createCellWorkspace(
  options: CreateCellWorkspaceOptions,
): CellWorkspaceClient {
  const { id, ydoc: existingYdoc } = options;
  const ydoc = existingYdoc ?? new Y.Doc({ guid: id });

  // Get Y.Maps (these are the containers for per-table arrays)
  const cellsMap = ydoc.getMap<Y.Array<YKeyValueLwwEntry<CellValue>>>('cells');
  const rowsMap = ydoc.getMap<Y.Array<YKeyValueLwwEntry<RowMeta>>>('rows');
  const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');

  // Create stores
  const cells = createCellsStore(cellsMap);
  const rows = createRowsStore(rowsMap);
  const kv = createKvStore(kvArray);

  // ... rest unchanged
}
```

## Y.Map Observation

When a new table is created (new key added to Y.Map), we need to handle it:

```typescript
function createCellsStore(cellsMap: Y.Map<...>): CellsStore {
  const cache = new Map<string, YKeyValueLww<CellValue>>();

  // Observe Y.Map for new tables
  cellsMap.observe((event) => {
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'delete') {
        // Table was deleted, clear cache
        cache.delete(key);
      }
      // 'add' is handled lazily in getTableYkv
    });
  });

  // ...
}
```

## Migration Path

From current flat structure to partitioned:

```typescript
async function migrateToPartitioned(oldDoc: Y.Doc, newDoc: Y.Doc): Promise<void> {
  const oldCells = oldDoc.getArray<YKeyValueLwwEntry<CellValue>>('cell:cells');
  const oldRows = oldDoc.getArray<YKeyValueLwwEntry<RowMeta>>('cell:rows');
  const oldKv = oldDoc.getArray<YKeyValueLwwEntry<unknown>>('cell:kv');

  const newCellsMap = newDoc.getMap<Y.Array<YKeyValueLwwEntry<CellValue>>>('cells');
  const newRowsMap = newDoc.getMap<Y.Array<YKeyValueLwwEntry<RowMeta>>>('rows');
  const newKvArray = newDoc.getArray<YKeyValueLwwEntry<unknown>>('kv');

  newDoc.transact(() => {
    // Migrate cells
    for (const entry of oldCells.toArray()) {
      const { tableId, rowId, fieldId } = parseCellKey(entry.key);  // Old 3-part key

      if (!newCellsMap.has(tableId)) {
        newCellsMap.set(tableId, new Y.Array());
      }

      newCellsMap.get(tableId)!.push([{
        key: `${rowId}:${fieldId}`,  // New 2-part key
        val: entry.val,
        ts: entry.ts,
      }]);
    }

    // Migrate rows
    for (const entry of oldRows.toArray()) {
      const { tableId, rowId } = parseRowKey(entry.key);  // Old 2-part key

      if (!newRowsMap.has(tableId)) {
        newRowsMap.set(tableId, new Y.Array());
      }

      newRowsMap.get(tableId)!.push([{
        key: rowId,  // New simple key
        val: entry.val,
        ts: entry.ts,
      }]);
    }

    // Migrate KV (copy as-is)
    for (const entry of oldKv.toArray()) {
      newKvArray.push([entry]);
    }
  });
}
```

## Performance Analysis

| Operation | Current | Proposed |
|-----------|---------|----------|
| Get cell by key | O(1) | O(1) |
| Get row by key | O(1) | O(1) |
| Get all cells for row | O(total cells) | O(table cells) |
| Get all rows for table | O(total rows) | O(table rows) |
| Create new table | N/A (implicit) | O(1) Y.Map set |
| Storage overhead | 1 array | 2 maps + n arrays |

**When it matters:**
- Workspace with 10 tables, 1000 rows each, 10 fields = 100,000 cells
- Current: Getting one row scans 100,000 entries
- Proposed: Getting one row scans ~10,000 entries (just that table)

## Edge Cases

### Empty Tables

A table exists if it has a key in the Y.Map, even if the array is empty:

```typescript
function tableExists(tableId: string): boolean {
  return cellsMap.has(tableId) || rowsMap.has(tableId);
}

function listTables(): string[] {
  const tables = new Set<string>();
  for (const key of cellsMap.keys()) tables.add(key);
  for (const key of rowsMap.keys()) tables.add(key);
  return Array.from(tables);
}
```

### Deleting Tables

To delete a table, remove it from both maps:

```typescript
function deleteTable(tableId: string): void {
  cellsMap.delete(tableId);
  rowsMap.delete(tableId);
  cache.delete(tableId);  // Clear YKeyValueLww cache
}
```

### YKeyValueLww Caching

We cache `YKeyValueLww` instances per table. This is necessary because:
1. `YKeyValueLww` constructor scans the array and removes duplicates
2. It sets up observers
3. Creating a new instance per operation would be wasteful

The cache should be invalidated when:
- Table is deleted from Y.Map
- Workspace is destroyed

## Open Questions

1. **Should we expose table listing?** The current API doesn't have `listTables()`. With partitioned storage, it's trivial to implement.

2. **Table deletion semantics?** Currently tables are implicit (created on first write). Should we support explicit table deletion?

3. **Cross-table operations?** Rare, but if needed (e.g., move row between tables), requires coordinated writes to two arrays.

## Summary

This change:
- Partitions storage by table using `Y.Map` of `Y.Array`
- Reduces read complexity from O(total) to O(table)
- Shortens keys by removing `tableId` prefix
- Maintains same external API (stores interface unchanged)
- Requires migration for existing workspaces
