# Dynamic Workspace Architecture

**Created**: 2026-01-27
**Status**: Superseded
**Superseded By**: `20260127T220000-external-schema-architecture.md`, `20260128T100000-table-partitioned-storage.md`
**Related**: `packages/epicenter/src/static`, `packages/epicenter/src/core`

> **Note**: This spec documents the original "schema-in-CRDT" approach with 4 flat arrays.
> The architecture has evolved to use **external schema** (JSON files) with **table-partitioned storage** (Y.Map of Y.Array).
> See the superseding specs for the current design. This document is retained for historical context and
> because some concepts (tombstones, fractional indexing, conflict resolution) remain relevant.

## Summary

This specification defines a new **Dynamic Workspace API** for Epicenter that enables Notion-like databases with runtime-editable schemas. It complements the existing **Static Workspace API** (which uses code-defined schemas) by providing a cell-level CRDT storage model built entirely on `YKeyValueLww`.

The key architectural insight is storing **field order on the field definition itself**, eliminating the coordination problem between tables and fields that causes orphaning in naive implementations.

---

## Problem Statement

Epicenter currently has two workspace implementations:

### 1. Static API (`packages/epicenter/src/static`)

- **Mature, simple, well-tested**
- Code-defined schemas with versioning and migrations
- Uses `YKeyValueLww` for storage (rows as atomic values)
- **Limitation**: Schema is fixed at compile time, not editable at runtime

### 2. Core API (`packages/epicenter/src/core`)

- **Complex, partially implemented**
- Runtime-editable schemas (Notion-like)
- Uses nested `Y.Map` for cell-level CRDT granularity
- Head docs, workspace docs, epochs, definition helpers
- **Problems**: Over-engineered, complex sync timing, mixed concerns

### The Gap

We need a **Dynamic Workspace API** that:

1. Supports Notion-like runtime schema editing
2. Uses `YKeyValueLww` throughout (not nested `Y.Map`)
3. Provides cell-level conflict resolution
4. Is simpler than the current core implementation
5. Composes well with the static API for hybrid use cases

---

## Design Goals

1. **Cell-level LWW**: Concurrent edits to different cells in the same row should both succeed
2. **Field-level LWW**: Adding/renaming/reordering fields shouldn't conflict with each other
3. **Zero orphan risk**: No possibility of schema inconsistencies from partial writes
4. **Single-write operations**: Add, edit, reorder, delete a field = 1 write each
5. **YKeyValueLww everywhere**: Consistent storage primitive with proven conflict resolution
6. **Minimal API surface**: Simple CRUD operations, no complex abstractions

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EPICENTER WORKSPACE APIS                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────┐    │
│  │     STATIC API (existing)   │    │      DYNAMIC API (new)          │    │
│  │                             │    │                                 │    │
│  │  • Code-defined schemas     │    │  • Runtime-editable schemas     │    │
│  │  • Versioned migrations     │    │  • Notion-like databases        │    │
│  │  • Row-level LWW            │    │  • Cell-level LWW               │    │
│  │  • YKeyValueLww storage     │    │  • YKeyValueLww storage         │    │
│  │                             │    │                                 │    │
│  │  Use for: App settings,     │    │  Use for: User-created tables,  │    │
│  │  fixed data models          │    │  dynamic content, spreadsheets  │    │
│  └─────────────────────────────┘    └─────────────────────────────────┘    │
│                                                                             │
│                    ┌─────────────────────────────────────────┐              │
│                    │          SHARED FOUNDATION              │              │
│                    │                                         │              │
│                    │  • YKeyValueLww primitive               │              │
│                    │  • Lifecycle protocol                   │              │
│                    │  • Capability system                    │              │
│                    └─────────────────────────────────────────┘              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Storage Model

### Key Insight: Order on Field Definition

The critical design decision is storing `order` directly on each field definition, rather than maintaining a separate `fieldOrder` array on the table. This eliminates orphaning entirely:

| Approach | Add field | Orphan risk | Why |
|----------|-----------|-------------|-----|
| `fieldOrder` on table | 2 writes (field + table) | **High** | Table-level LWW can lose the fieldOrder update |
| `order` on field | 1 write (field only) | **None** | Field is self-contained |

### The 4-Array Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Y.Doc                                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Array('tables')   ←── YKeyValueLww<TableDefinition>                      │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ { key: 'posts',                                                       │ │
│  │   val: {                                                              │ │
│  │     name: 'Blog Posts',                                               │ │
│  │     icon: 'emoji:📝'                                                  │ │
│  │   },                      ← NO fieldOrder here!                       │ │
│  │   ts: 1706200001000 }                                                 │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  Y.Array('fields')   ←── YKeyValueLww<FieldDefinition>                      │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ { key: 'posts:title',                                                 │ │
│  │   val: { name: 'Title', type: 'text', order: 1 },                     │ │
│  │   ts: 1706200001000 }                    ↑ order ON the field         │ │
│  │                                                                       │ │
│  │ { key: 'posts:published',                                             │ │
│  │   val: { name: 'Published', type: 'boolean', order: 2 },              │ │
│  │   ts: 1706200002000 }                                                 │ │
│  │                                                                       │ │
│  │ { key: 'posts:date',                                                  │ │
│  │   val: { name: 'Date', type: 'date', order: 3 },                      │ │
│  │   ts: 1706200003000 }                                                 │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  Y.Array('rows')     ←── YKeyValueLww<RowMeta>                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ { key: 'posts:row_abc', val: { order: 1 }, ts: ... }                  │ │
│  │ { key: 'posts:row_def', val: { order: 2 }, ts: ... }                  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│            ↑ tableId in key enables prefix scanning                        │
│                                                                             │
│  Y.Array('cells')    ←── YKeyValueLww<CellValue>                            │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ { key: 'posts:row_abc:title',     val: 'Hello World', ts: ... }       │ │
│  │ { key: 'posts:row_abc:published', val: true,          ts: ... }       │ │
│  │ { key: 'posts:row_def:title',     val: 'Second Post', ts: ... }       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│            ↑ tableId in key enables efficient cascade delete               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Encoding

| Array | Key Format | Example |
|-------|------------|---------|
| tables | `{tableId}` | `'posts'` |
| fields | `{tableId}:{fieldId}` | `'posts:title'` |
| rows | `{tableId}:{rowId}` | `'posts:row_abc'` |
| cells | `{tableId}:{rowId}:{fieldId}` | `'posts:row_abc:title'` |

**Why tableId in row and cell keys?**
- Enables efficient prefix scanning: `rows.getByPrefix('posts:')` gets all rows for a table
- Cascade delete is trivial: delete everything with prefix `posts:`
- When working with cells, you always know the tableId (you're viewing a specific table)

### Deriving Field Order

Field order is computed by sorting fields by their `order` property:

```typescript
function getOrderedFields(tableId: string): FieldDefinition[] {
  return fields
    .getByPrefix(`${tableId}:`)
    .sort((a, b) => {
      // Primary sort: order value
      if (a.order !== b.order) return a.order - b.order
      // Tiebreaker: field ID (deterministic)
      return a.id.localeCompare(b.id)
    })
}
```

---

## Operations and Write Counts

Every schema operation is a **single write**:

| Operation | Writes | Key affected |
|-----------|--------|--------------|
| Add field | 1 | `fields['{tableId}:{fieldId}']` |
| Rename field | 1 | `fields['{tableId}:{fieldId}']` |
| Change field type | 1 | `fields['{tableId}:{fieldId}']` |
| Reorder field | 1 | `fields['{tableId}:{fieldId}']` (update order) |
| Delete field | 1 | Delete from `fields` |
| Add row | 1 | `rows['{tableId}:{rowId}']` |
| Delete row | 1+ | Delete from `rows` (+ optionally clean up cells) |
| Edit cell | 1 | `cells['{tableId}:{rowId}:{fieldId}']` |

### Fractional Indexing for Reordering

Use fractional numbers to insert between existing positions without rebalancing:

```typescript
// Initial state
fields['posts:title']     = { ..., order: 1 }
fields['posts:published'] = { ..., order: 2 }
fields['posts:date']      = { ..., order: 3 }

// Insert 'author' between 'title' (1) and 'published' (2)
fields['posts:author'] = { name: 'Author', type: 'text', order: 1.5 }

// Insert 'subtitle' between 'title' (1) and 'author' (1.5)
fields['posts:subtitle'] = { name: 'Subtitle', type: 'text', order: 1.25 }

// Resulting order: title (1), subtitle (1.25), author (1.5), published (2), date (3)
```

For practical purposes, floating-point precision is sufficient (IEEE 754 doubles have ~15 significant digits).

---

## Conflict Resolution Scenarios

### Scenario 1: Concurrent Cell Edits (Same Row, Different Fields)

```
Device A                              Device B
────────                              ────────
setCell('row_abc', 'title', 'Hi')     setCell('row_abc', 'published', true)
         │                                      │
         ▼                                      ▼
cells['row_abc:title'] = 'Hi'         cells['row_abc:published'] = true

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

RESULT: Both changes preserved (different keys) ✓
```

### Scenario 2: Concurrent Field Adds

```
Device A                              Device B
────────                              ────────
addField('posts', 'author', ...)      addField('posts', 'category', ...)
         │                                      │
         ▼                                      ▼
fields['posts:author'] = {            fields['posts:category'] = {
  name: 'Author',                       name: 'Category',
  type: 'text',                         type: 'select',
  order: 4                              order: 4
}                                     }

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

RESULT: Both fields exist ✓
        Same order value → tiebreaker sorts alphabetically
        Final order: [..., author, category]
```

### Scenario 3: Concurrent Field Rename vs Add

```
Device A                              Device B
────────                              ────────
renameField('posts:title', 'Name')    addField('posts', 'author', ...)
         │                                      │
         ▼                                      ▼
fields['posts:title'] = {             fields['posts:author'] = {
  name: 'Name',  ← changed              name: 'Author',
  type: 'text',                         type: 'text',
  order: 1                              order: 4
}                                     }

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

RESULT: Both succeed (different keys) ✓
        'title' renamed to 'Name'
        'author' field added
```

### Scenario 4: Concurrent Field Rename (Same Field)

```
Device A                              Device B
────────                              ────────
renameField('posts:title', 'Name')    renameField('posts:title', 'Heading')
ts: 100                               ts: 101

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

RESULT: Device B wins (higher timestamp)
        Field name is 'Heading'
```

---

## Deletion Semantics

### Soft Delete with Tombstones

Tables, fields, and rows use **soft deletion** via a `deletedAt` timestamp:

```typescript
// deletedAt: null     = active (not deleted)
// deletedAt: number   = deleted at this timestamp

type FieldDefinition = {
  name: string
  type: FieldType
  order: number
  deletedAt: number | null  // Always present
  // ...
}
```

**Why tombstones instead of hard delete?**

Hard delete causes the "resurrection problem":
1. Device A deletes field `author`
2. Device B (offline) creates cells for `author`
3. Sync: cells exist but field doesn't → silent data loss

With tombstones:
1. Device A sets `deletedAt: 1706200000` on field `author`
2. Device B creates cells for `author`
3. Sync: field exists with `deletedAt` set, cells exist
4. UI can show: "This field was deleted. Restore it?"

### Delete Operations

```typescript
// Delete a field (soft delete)
function deleteField(tableId: string, fieldId: string): void {
  const field = fields.get(tableId, fieldId)
  if (field) {
    fields.set(tableId, fieldId, { ...field, deletedAt: Date.now() })
  }
}

// Restore a deleted field
function restoreField(tableId: string, fieldId: string): void {
  const field = fields.get(tableId, fieldId)
  if (field && field.deletedAt !== null) {
    fields.set(tableId, fieldId, { ...field, deletedAt: null })
  }
}
```

### Reading Active vs Deleted

When reading, filter by `deletedAt`:

```typescript
function getActiveFields(tableId: string): FieldDefinition[] {
  return fields
    .getByTable(tableId)
    .filter(f => f.deletedAt === null)  // Only active fields
    .sort((a, b) => a.order - b.order)
}

function getDeletedFields(tableId: string): FieldDefinition[] {
  return fields
    .getByTable(tableId)
    .filter(f => f.deletedAt !== null)  // Only deleted fields
}
```

### Cells Are NOT Tombstoned

Cells don't have `deletedAt`. When a field or row is deleted:
- Cells remain in storage (orphaned)
- They're filtered out on read (field/row is deleted)
- If field/row is restored, cells reappear automatically

This avoids the complexity of cell-level tombstones while preserving data for restoration.

### Permanent Deletion (Garbage Collection)

Tombstoned entries can be permanently deleted after a retention period:

```typescript
function garbageCollect(retentionMs: number = 30 * 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - retentionMs  // 30 days ago

  // Find and hard-delete old tombstones
  for (const [key, field] of fields.entries()) {
    if (field.deletedAt !== null && field.deletedAt < cutoff) {
      fields.delete(key)
      // Also delete orphaned cells for this field
      cleanupCellsForField(key)
    }
  }
}
```

GC is optional and should only run when storage space is a concern.

---

## Type Definitions

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA TYPES
// ─────────────────────────────────────────────────────────────────────────────

type FieldType =
  | 'text'
  | 'integer'
  | 'real'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'tags'
  | 'json'

type FieldDefinition = {
  name: string
  type: FieldType
  order: number        // Fractional index for ordering
  deletedAt: number | null  // Tombstone: null = active, timestamp = deleted
  icon?: string | null
  options?: string[]   // For select/tags
  default?: unknown
}

type TableDefinition = {
  name: string
  deletedAt: number | null  // Tombstone: null = active, timestamp = deleted
  icon?: string | null
  // NO fieldOrder - derived from fields
}

type RowMeta = {
  order: number        // Fractional index for ordering within table
  deletedAt: number | null  // Tombstone: null = active, timestamp = deleted
  // Note: tableId is in the key, not the value
}

type CellValue = unknown  // Varies by field type

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT TYPES
// ─────────────────────────────────────────────────────────────────────────────

type DynamicWorkspaceClient = {
  readonly id: string
  readonly ydoc: Y.Doc

  // Low-level store access
  readonly tables: TablesStore
  readonly fields: FieldsStore
  readonly rows: RowsStore
  readonly cells: CellsStore

  // High-level helpers
  getTableWithFields(tableId: string): TableWithFields | null
  getRowsWithCells(tableId: string): RowWithCells[]

  // Batch operations - groups writes into single observer event
  batch<T>(fn: (ws: DynamicWorkspaceClient) => T): T

  // Lifecycle
  readonly whenSynced: Promise<void>
  destroy(): Promise<void>
}
```

---

## Store Interfaces

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// TABLES STORE
// ─────────────────────────────────────────────────────────────────────────────

type TablesStore = {
  get(tableId: string): TableDefinition | undefined
  set(tableId: string, table: TableDefinition): void
  delete(tableId: string): void
  has(tableId: string): boolean
  getAll(): Map<string, TableDefinition>

  // Convenience
  create(tableId: string, options: { name: string; icon?: string }): void
  rename(tableId: string, newName: string): void

  observe(handler: TablesChangeHandler): () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELDS STORE
// ─────────────────────────────────────────────────────────────────────────────

type FieldsStore = {
  get(tableId: string, fieldId: string): FieldDefinition | undefined
  set(tableId: string, fieldId: string, field: FieldDefinition): void
  delete(tableId: string, fieldId: string): void
  has(tableId: string, fieldId: string): boolean

  // Get fields for a table, sorted by order
  getByTable(tableId: string): Array<{ id: string; field: FieldDefinition }>

  // Convenience
  create(tableId: string, fieldId: string, options: {
    name: string
    type: FieldType
    order?: number  // Defaults to max + 1
  }): void
  rename(tableId: string, fieldId: string, newName: string): void
  reorder(tableId: string, fieldId: string, newOrder: number): void

  observe(handler: FieldsChangeHandler): () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// ROWS STORE
// ─────────────────────────────────────────────────────────────────────────────

type RowsStore = {
  get(tableId: string, rowId: string): RowMeta | undefined
  set(tableId: string, rowId: string, meta: RowMeta): void
  delete(tableId: string, rowId: string): void
  has(tableId: string, rowId: string): boolean

  // Get rows for a table, sorted by order (uses prefix scan)
  getByTable(tableId: string): Array<{ id: string; meta: RowMeta }>

  // Convenience
  create(tableId: string, rowId?: string, order?: number): string
  reorder(tableId: string, rowId: string, newOrder: number): void

  observe(handler: RowsChangeHandler): () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// CELLS STORE
// ─────────────────────────────────────────────────────────────────────────────

type CellsStore = {
  get(tableId: string, rowId: string, fieldId: string): CellValue | undefined
  set(tableId: string, rowId: string, fieldId: string, value: CellValue): void
  delete(tableId: string, rowId: string, fieldId: string): void
  has(tableId: string, rowId: string, fieldId: string): boolean

  // Get all cells for a row (direct lookups, not prefix scan)
  getByRow(tableId: string, rowId: string, fieldIds: string[]): Map<string, CellValue>

  observe(handler: CellsChangeHandler): () => void
}
```

---

## Usage Example

```typescript
import { createDynamicWorkspace } from '@epicenter/hq/dynamic'

// Create workspace
const workspace = createDynamicWorkspace({ id: 'my-workspace' })

// Create a table
workspace.tables.create('posts', { name: 'Blog Posts', icon: '📝' })

// Add fields (order is auto-assigned if not specified)
workspace.fields.create('posts', 'title', { name: 'Title', type: 'text' })
workspace.fields.create('posts', 'published', { name: 'Published', type: 'boolean' })
workspace.fields.create('posts', 'date', { name: 'Date', type: 'date' })

// Add a row (returns the generated rowId)
const rowId = workspace.rows.create('posts')
// rowId = 'row_V1StGXR8_Z5j'

// Set cell values (tableId is always required)
workspace.cells.set('posts', rowId, 'title', 'Hello World')
workspace.cells.set('posts', rowId, 'published', false)

// Read table with all fields
const table = workspace.getTableWithFields('posts')
// → {
//     id: 'posts',
//     name: 'Blog Posts',
//     fields: [
//       { id: 'title', name: 'Title', type: 'text', order: 1 },
//       { id: 'published', name: 'Published', type: 'boolean', order: 2 },
//       { id: 'date', name: 'Date', type: 'date', order: 3 }
//     ]
//   }

// Read rows with cells
const rows = workspace.getRowsWithCells('posts')
// → [{ id: 'row_V1StGXR8_Z5j', order: 1, cells: { title: 'Hello World', published: false } }]

// Reorder a field (insert between title and published)
workspace.fields.reorder('posts', 'date', 1.5)

// Delete a field (also deletes cells for that field)
workspace.fields.delete('posts', 'date')

// Delete a table (cascade deletes all fields, rows, and cells)
workspace.tables.delete('posts')
```

---

## Implementation Plan

### Phase 1: Core Types and Stores

**Files to create:**
- `packages/epicenter/src/dynamic/types.ts`
- `packages/epicenter/src/dynamic/stores/tables-store.ts`
- `packages/epicenter/src/dynamic/stores/fields-store.ts`
- `packages/epicenter/src/dynamic/stores/rows-store.ts`
- `packages/epicenter/src/dynamic/stores/cells-store.ts`

**Tasks:**
- [ ] Define TypeScript types
- [ ] Create store wrappers around YKeyValueLww
- [ ] Implement key encoding/decoding utilities
- [ ] Implement derived field ordering (sort by order property)
- [ ] Add unit tests for each store

### Phase 2: Workspace Client

**Files to create:**
- `packages/epicenter/src/dynamic/create-dynamic-workspace.ts`
- `packages/epicenter/src/dynamic/helpers.ts`

**Tasks:**
- [ ] Create `createDynamicWorkspace()` factory
- [ ] Implement `getTableWithFields()` helper
- [ ] Implement `getRowsWithCells()` helper
- [ ] Add lifecycle management (whenSynced, destroy)
- [ ] Add integration tests

### Phase 3: Integration

**Tasks:**
- [ ] Export public API from `@epicenter/hq/dynamic`
- [ ] Ensure compatibility with persistence capability
- [ ] Ensure compatibility with sync capability
- [ ] Write migration guide from core API

---

## Verification Checklist

- [ ] Adding a field is exactly 1 write
- [ ] Renaming a field is exactly 1 write
- [ ] Reordering a field is exactly 1 write
- [ ] Deleting a field works correctly
- [ ] Concurrent field adds both succeed
- [ ] Concurrent field renames (different fields) both succeed
- [ ] Concurrent field renames (same field) resolve via LWW
- [ ] Field ordering is deterministic (order value + fieldId tiebreaker)
- [ ] Orphaned cells are handled appropriately
- [ ] All stores have working observe() methods
- [ ] Persistence and sync capabilities work

---

## Implementation Details

### ID Generation

Use `nanoid` for generating IDs:

```typescript
import { nanoid } from 'nanoid'

// Table IDs: user-provided slugs (e.g., 'posts', 'tasks')
// Field IDs: user-provided slugs (e.g., 'title', 'published')
// Row IDs: auto-generated with prefix
const rowId = `row_${nanoid(12)}`  // e.g., 'row_V1StGXR8_Z5j'
```

Table and field IDs should be user-provided slugs for readability. Row IDs should be auto-generated.

### Key Encoding

Keys use `:` as separator. IDs must not contain `:`.

```typescript
// Key formats
'posts'                      // tables: tableId
'posts:title'                // fields: tableId:fieldId
'posts:row_abc'              // rows:   tableId:rowId
'posts:row_abc:title'        // cells:  tableId:rowId:fieldId

// Invalid - IDs cannot contain ':'
'my:table'    // Ambiguous parsing
```

Validation: Reject IDs containing `:` at creation time.

```typescript
function validateId(id: string, type: string): void {
  if (id.includes(':')) {
    throw new Error(`${type} ID cannot contain ':'`)
  }
}

// Key construction helpers
const fieldKey = (tableId: string, fieldId: string) => `${tableId}:${fieldId}`
const rowKey = (tableId: string, rowId: string) => `${tableId}:${rowId}`
const cellKey = (tableId: string, rowId: string, fieldId: string) => `${tableId}:${rowId}:${fieldId}`
```

### Prefix Scanning vs Direct Lookups

YKeyValueLww maintains an in-memory Map for O(1) lookups.

**Use prefix scanning for:**
- `fields.getByTable('posts')` → scans fields for `posts:*`
- `rows.getByTable('posts')` → scans rows for `posts:*`
- Cascade deletes

**Use direct lookups for cells:**
```typescript
// DON'T scan all cells to find cells for a row
// cells.getByPrefix('posts:row_abc:')  // O(all cells) - slow!

// DO use direct lookups when you know the field IDs
function getCellsForRow(tableId: string, rowId: string, fieldIds: string[]): Map<string, CellValue> {
  const result = new Map()
  for (const fieldId of fieldIds) {
    const key = `${tableId}:${rowId}:${fieldId}`
    const value = cells.get(key)  // O(1)
    if (value !== undefined) {
      result.set(fieldId, value)
    }
  }
  return result
}
```

**Complexity for rendering a table view:**
| Step | Operation | Complexity |
|------|-----------|------------|
| 1 | Get table | O(1) direct lookup |
| 2 | Get fields | O(total fields) prefix scan |
| 3 | Get rows | O(total rows) prefix scan |
| 4 | Get cells | O(rows × fields) direct lookups |

For 1000 rows × 50 fields = 50k direct lookups. Fast.

### Default Order Calculation

When `order` is not specified, append to end:

```typescript
function getNextOrder(tableId: string): number {
  const fields = this.getByTable(tableId)
  if (fields.length === 0) return 1
  const maxOrder = Math.max(...fields.map(f => f.field.order))
  return maxOrder + 1
}
```

### Validation Boundaries

Stores do **not** validate referential integrity. This is intentional for CRDT consistency:

```typescript
// This is ALLOWED - no validation that 'posts' table exists
fields.set('posts:title', { name: 'Title', type: 'text', order: 1 })

// This is ALLOWED - no validation that row or field exists
cells.set('posts:row_abc:title', 'Hello')
```

**Why?** During sync, data may arrive out of order. A cell might arrive before its row or field definition. Validating would reject valid synced data.

**Reading** handles missing references gracefully:
- `getRowsWithCells()` filters cells to only include fields that exist in the schema
- Orphaned data is preserved in storage but not displayed

### Observer Event Shape

```typescript
type ChangeEvent<T> = {
  type: 'add' | 'update' | 'delete'
  key: string
  value?: T          // Present for 'add' and 'update'
  previousValue?: T  // Present for 'update' and 'delete'
}

type ChangeHandler<T> = (changes: ChangeEvent<T>[]) => void

// Usage
fields.observe((changes) => {
  for (const change of changes) {
    if (change.type === 'add') {
      console.log(`Field added: ${change.key}`)
    }
  }
})
```

### Batch Operations

Batch multiple writes into a single Yjs transaction, emitting one observer event:

```typescript
// Without batch: 100 rows × 50 cells = 5000 observer events
for (const data of importedRows) {
  const rowId = workspace.rows.create('posts')
  workspace.cells.set('posts', rowId, 'title', data.title)
  // ... 49 more cells
}

// With batch: 1 observer event total
workspace.batch((ws) => {
  for (const data of importedRows) {
    const rowId = ws.rows.create('posts')
    ws.cells.set('posts', rowId, 'title', data.title)
    // ... 49 more cells
  }
})
```

The callback receives the workspace, making it easy to pass to helper functions:

```typescript
function importRows(ws: DynamicWorkspaceClient, data: Row[]) {
  for (const row of data) {
    const rowId = ws.rows.create('posts')
    ws.cells.set('posts', rowId, 'title', row.title)
  }
}

// Clean separation of concerns
workspace.batch((ws) => importRows(ws, csvData))
```

**Implementation** using Yjs transactions:

```typescript
function batch<T>(fn: (ws: DynamicWorkspaceClient) => T): T {
  let result: T
  ydoc.transact(() => {
    result = fn(this)  // Pass workspace to callback
  })
  return result!
}
```

Yjs `transact()` automatically batches all Y.Array modifications and emits a single update event. Observers receive all changes in one callback.

**Use batch() for:**
- Bulk imports (CSV, JSON)
- Cascade deletes
- Schema migrations
- Any operation that touches multiple entries

### Initialization

On workspace creation, ensure all 4 arrays exist:

```typescript
function createDynamicWorkspace(options: { id: string }): DynamicWorkspaceClient {
  const ydoc = new Y.Doc({ guid: options.id })

  // Get or create arrays - Y.Doc returns existing if already present
  const tablesArray = ydoc.getArray<TableEntry>('dynamic:tables')
  const fieldsArray = ydoc.getArray<FieldEntry>('dynamic:fields')
  const rowsArray = ydoc.getArray<RowEntry>('dynamic:rows')
  const cellsArray = ydoc.getArray<CellEntry>('dynamic:cells')

  // Wrap with YKeyValueLww
  const tables = new YKeyValueLww(tablesArray)
  const fields = new YKeyValueLww(fieldsArray)
  const rows = new YKeyValueLww(rowsArray)
  const cells = new YKeyValueLww(cellsArray)

  // ... create store wrappers
}
```

Array names are prefixed with `dynamic:` to avoid collision with static workspace arrays.

### Concurrent Delete + Edit Scenario

With tombstones, this scenario is handled gracefully:

```
Device A                              Device B
────────                              ────────
deleteField('posts', 'author')        setCell('posts', 'row_abc', 'author', 'Jane')
         │                                      │
         ▼                                      ▼
fields['posts:author'].deletedAt      cells.set('posts:row_abc:author', 'Jane')
  = 1706200000

                    ┌─────────────┐
                    │    SYNC     │
                    └─────────────┘

RESULT:
• fields['posts:author'] EXISTS with deletedAt = 1706200000
• cells['posts:row_abc:author'] = 'Jane' EXISTS
• UI can show: "Field 'author' was deleted. Cell has value 'Jane'. Restore field?"
```

**Benefits of tombstones:**
- Field definition preserved → UI knows the field name and type
- Cell data preserved → no silent data loss
- User can restore the field if desired
- LWW still works: if B's field edit has higher timestamp, `deletedAt` gets overwritten

### Cascade Deletes

Use soft delete (tombstones) and batch for cascade operations:

```typescript
function deleteTable(tableId: string): void {
  const now = Date.now()

  workspace.batch((ws) => {
    // Soft delete table
    const table = ws.tables.get(tableId)
    if (table) {
      ws.tables.set(tableId, { ...table, deletedAt: now })
    }

    // Soft delete all fields for this table
    for (const [key, field] of ws.fields.entries()) {
      if (key.startsWith(`${tableId}:`)) {
        ws.fields.set(key, { ...field, deletedAt: now })
      }
    }

    // Soft delete all rows for this table
    for (const [key, row] of ws.rows.entries()) {
      if (key.startsWith(`${tableId}:`)) {
        ws.rows.set(key, { ...row, deletedAt: now })
      }
    }

    // Cells are NOT tombstoned - filtered out on read
  })
}
```

**Key points:**
- Wrapped in `batch()` → single observer event
- Soft delete with `deletedAt` → reversible
- Cells left as-is → restored automatically if table/row/field restored
- O(n) over each array, but batched

---

## Design Decisions

Decisions made during spec development:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deletion strategy | Tombstones (`deletedAt`) | Prevents resurrection problem, enables restore |
| Field ID collision | Accept as rare | User-provided slugs are readable; collision requires same table + same name + offline |
| Prefix scan performance | Accept O(n) for now | Typical workspaces <10k rows; optimize if needed |
| Cell lookups | Direct O(1) lookups | Use field IDs from schema, not prefix scan |
| Batch operations | Yjs `transact()` | Single observer event for bulk ops |
| Rich text fields | Store `docId` reference | Y.Text in separate Y.Doc |

## Open Questions

1. **Clock skew mitigation**: Consider Hybrid Logical Clocks (HLC) to prevent future-clock dominance. Current YKeyValueLww uses wall clock timestamps which can be manipulated.

2. **Garbage collection policy**: How long to retain tombstoned entries before permanent deletion? 30 days? User-configurable?

3. **Undo/redo semantics**: How should undo work across 4 arrays? Per-array or grouped by user action?

---

## Appendix: Why Not fieldOrder on Table?

The original design considered storing `fieldOrder: string[]` on the table definition. This creates an orphaning problem:

```
Device A                              Device B
────────                              ────────
addField('author')                    renameTable('Blog')
  ├─ fields['posts:author'] ✓           ├─ tables['posts'] = {
  └─ tables['posts'] = {                │    name: 'Blog',
       fieldOrder: [..., 'author'],     │    fieldOrder: [old list]  ← no 'author'!
       ts: 100                          │  }
     }                                  │  ts: 101  ← higher, wins
                                        │
                    ┌─────────┐         │
                    │  SYNC   │ ←───────┘
                    └─────────┘

RESULT:
• fields['posts:author'] EXISTS
• tables['posts'].fieldOrder does NOT include 'author'
• ORPHAN: Field exists but isn't visible!
```

By putting `order` on the field definition itself, this problem is eliminated. The field is self-contained: if it exists, it has an order, and it will appear in the sorted list.

---

## Changelog

- **2026-01-27**: Initial draft
- **2026-01-27**: Refined to use order-on-field model, eliminating orphan risk
- **2026-01-27**: Added tableId to row and cell keys for efficient prefix scanning
- **2026-01-27**: Switched from hard delete to tombstones (`deletedAt`) to prevent resurrection problem
- **2026-01-27**: Added batch operation support (`workspace.batch()`) for bulk writes
- **2026-01-27**: Clarified direct lookups vs prefix scanning for cells
