# External Schema Architecture

**Created**: 2026-01-27
**Updated**: 2026-01-28
**Status**: Implemented
**Location**: `packages/epicenter/src/cell`

## Summary

The Cell Workspace uses **external schema** (passed at creation time) with **top-level named Y.Arrays** for storage. Schema is a "lens" for viewing data - the CRDT stores raw cells without type enforcement.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CELL WORKSPACE ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────┐    ┌─────────────────────────────────┐ │
│  │     DEFINITION (Required)       │    │      DATA (Y.Doc / CRDT)        │ │
│  │                                 │    │                                 │ │
│  │  • Workspace name, icon, desc   │    │  • Cell values only             │ │
│  │  • Table definitions            │    │  • Cell-level LWW               │ │
│  │  • Field names, types, order    │    │  • Syncs between devices        │ │
│  │  • KV definitions               │    │  • No schema validation         │ │
│  │                                 │    │  • Just raw key-value pairs     │ │
│  │  Passed to createCellWorkspace  │    │                                 │ │
│  │  (can be from JSON or code)     │    │  Y.Doc with named Y.Arrays      │ │
│  └─────────────────────────────────┘    └─────────────────────────────────┘ │
│                                                                             │
│              Definition is the LENS through which you VIEW the data         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Y.Doc Storage (Option B - Top-Level Named Y.Arrays)

Each table gets its own top-level Y.Array via `ydoc.getArray(tableId)`. This avoids the Y.Map concurrent creation bug where two clients independently creating Y.Arrays for the same key causes one to lose all data.

```
Y.Doc
├── Y.Array('table:posts')  ← Table data (cells only), prefixed to avoid collisions
│   ├── { key: 'row1:title', val: 'Hello', ts: ... }
│   ├── { key: 'row1:views', val: 100, ts: ... }
│   └── ...
├── Y.Array('table:users')  ← Another table
│   └── ...
└── Y.Array('kv')           ← Workspace-level key-values
    └── { key: 'theme', val: 'dark', ts: ... }
```

### Key Format

Simple two-part keys within each table's Y.Array:
```
{rowId}:{fieldId}
```

Example: `abc123:title`, `abc123:views`, `xyz789:name`

### Why Not Y.Map of Y.Arrays?

We initially tried `Y.Map<Y.Array>` for table partitioning. This fails because:
- When two clients independently create a Y.Array for the same key, Y.Map uses LWW at the Map level
- One client's Y.Array wins entirely, the other loses all its data
- Named Y.Arrays via `ydoc.getArray(name)` merge correctly because they're Yjs shared types

## Definition Format

The definition is required when creating a workspace:

```typescript
type WorkspaceSchema = {
  name: string;
  description?: string;
  icon?: Icon | string | null;
  tables: Record<string, SchemaTableDefinition>;
  kv?: Record<string, SchemaKvDefinition>;
};

type SchemaTableDefinition = {
  name: string;
  icon?: Icon | string | null;
  fields: Record<string, SchemaFieldDefinition>;
};

type SchemaFieldDefinition = {
  name: string;
  type: FieldType;
  order: number;
  icon?: Icon | string | null;
  options?: string[];
  default?: unknown;
};

type FieldType =
  | 'text' | 'integer' | 'real' | 'boolean'
  | 'date' | 'datetime' | 'select' | 'tags'
  | 'json' | 'richtext';
```

## API

### Factory

```typescript
const workspace = createCellWorkspace({
  id: 'my-workspace',
  definition: {
    name: 'My Blog',
    description: 'Personal blog',
    icon: 'emoji:📝',
    tables: {
      posts: {
        name: 'Posts',
        fields: {
          title: { name: 'Title', type: 'text', order: 1 },
          views: { name: 'Views', type: 'integer', order: 2 },
        }
      }
    }
  }
});

// Or with JSON-loaded definition
const definition = JSON.parse(await Bun.file('schema.json').text());
createCellWorkspace({ id: 'blog', definition });
```

### Client

```typescript
type CellWorkspaceClient = {
  // Identity
  readonly id: string;
  readonly ydoc: Y.Doc;

  // Metadata (from definition)
  readonly name: string;
  readonly description: string;
  readonly icon: Icon | string | null;
  readonly definition: WorkspaceSchema;

  // Data access
  table(tableId: string): TableHelper;
  readonly kv: KvStore;

  // Schema validation (uses definition's schema)
  getTypedRows(tableId: string): TypedRowWithCells[];

  // Utilities
  batch<T>(fn: (ws: CellWorkspaceClient) => T): T;
  destroy(): Promise<void>;
};
```

### TableHelper

```typescript
type TableHelper = {
  readonly tableId: string;

  // Cell operations
  get(rowId: string, fieldId: string): CellValue | undefined;
  set(rowId: string, fieldId: string, value: CellValue): void;
  delete(rowId: string, fieldId: string): void;
  has(rowId: string, fieldId: string): boolean;

  // Row operations
  getRow(rowId: string): Record<string, CellValue> | undefined;
  createRow(rowId?: string): string;  // Generate or validate ID only
  deleteRow(rowId: string): void;     // Hard delete - removes all cells

  // Bulk operations
  getRows(): RowData[];     // Returns {id, cells}[] sorted by id
  getRowIds(): string[];    // Returns all row IDs

  // Observation
  observe(handler: ChangeHandler<CellValue>): () => void;
};
```

## Simplifications

### No Reserved Fields

Unlike the original proposal, there are no `_order` or `_deletedAt` reserved fields:
- **Row ordering**: Application-level concern, implement as a regular field if needed
- **Soft delete**: Application-level concern, implement as a `deletedAt` field if needed
- **`deleteRow()`**: Hard delete - removes all cells for the row

This keeps the CRDT layer minimal and focused on cell-level LWW merge semantics.

### No Epochs or Head Doc

With external schema:
- No need for epochs (schema changes are local config changes)
- No need for head doc (workspace identity is in the definition)
- Workspace = single Y.Doc + definition

## Schema as Lens

The schema/definition is **advisory only**. The data doesn't need to comply:

### What happens when data doesn't match schema?

1. **Cell exists but field not in schema**
   - `getTypedRows()` marks it as type `'json'` and puts it in `extraFields`
   - Data preserved, not deleted

2. **Field in schema but cell doesn't exist**
   - `getTypedRows()` puts it in `missingFields`
   - No data created until user edits

3. **Cell type doesn't match field type**
   - `getTypedRows()` marks the cell as `valid: false`
   - Data preserved as-is

4. **Table not in schema but data exists**
   - `table()` still works (creates Y.Array on demand)
   - `getTypedRows()` returns all fields as `'json'` type

### Arbitrary Access

You can access tables and fields not in the definition:

```typescript
// Table not in definition - still works
const arbitrary = workspace.table('notInSchema');
arbitrary.set('row1', 'anyField', 'anyValue');

// getTypedRows returns 'json' type for unknown tables
const rows = workspace.getTypedRows('notInSchema');
// All fields marked as type 'json', all in extraFields
```

## Typed vs Untyped Definitions

### Typed (Code-Defined)

```typescript
const definition = {
  name: 'Blog',
  tables: {
    posts: {
      name: 'Posts',
      fields: {
        title: { name: 'Title', type: 'text', order: 1 },
      }
    }
  }
} as const;

const workspace = createCellWorkspace({ id: 'blog', definition });
// TypeScript knows the schema structure
```

### Untyped (JSON-Loaded)

```typescript
const definition = JSON.parse(await Bun.file('schema.json').text());
const workspace = createCellWorkspace({ id: 'blog', definition });
// Works identically, but TypeScript sees unknown types
```

Both support arbitrary table/field access.

## Usage Example

```typescript
const workspace = createCellWorkspace({
  id: 'blog',
  definition: {
    name: 'My Blog',
    tables: {
      posts: {
        name: 'Posts',
        fields: {
          title: { name: 'Title', type: 'text', order: 1 },
          views: { name: 'Views', type: 'integer', order: 2 },
        }
      }
    }
  }
});

// Access workspace metadata
console.log(workspace.name);        // 'My Blog'
console.log(workspace.description); // ''

// Get table store
const posts = workspace.table('posts');

// Create a row (just generates ID)
const rowId = posts.createRow();

// Set cells
posts.set(rowId, 'title', 'Hello World');
posts.set(rowId, 'views', 100);

// Read back
const row = posts.getRow(rowId);
// { title: 'Hello World', views: 100 }

// Typed rows with validation
const typedRows = workspace.getTypedRows('posts');
// Validates types, identifies missing/extra fields

// Delete row (hard delete)
posts.deleteRow(rowId);
```

## Verification

```bash
cd packages/epicenter
bun test src/cell/
```

All 81 tests pass.

---

## Changelog

- **2026-01-27**: Initial draft with Y.Map of Y.Arrays
- **2026-01-28**: Switched to Option B (top-level named Y.Arrays) to fix concurrent table creation
- **2026-01-28**: Removed `_order` and `_deletedAt` reserved fields
- **2026-01-28**: Made definition required in `createCellWorkspace`
- **2026-01-28**: Added workspace metadata to client (`name`, `description`, `icon`, `definition`)
- **2026-01-28**: Simplified `getTypedRows()` to use definition's schema (no second argument)
