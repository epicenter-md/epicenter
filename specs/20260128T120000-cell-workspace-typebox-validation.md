# Cell Workspace TypeBox Validation

**Created**: 2026-01-28
**Updated**: 2026-01-28
**Status**: Implemented
**Location**: `packages/epicenter/src/cell`

## Overview

Cell workspace provides integrated TypeBox validation with JIT-compiled validators for advisory schema enforcement. Validation is built directly into `TableHelper`, with a unified API that returns result types for reads while allowing unrestricted writes.

## Background

Cell workspace uses external JSON schemas (`SchemaFieldDefinition`) that differ from core's `Field` types. The schema is advisory—validation flags issues but doesn't reject data. This requires:

1. A converter from `SchemaFieldDefinition` → TypeBox
2. All fields treated as optional and nullable (advisory nature)
3. Additional properties allowed (unknown fields pass validation)

## Architecture

### Components

```
cell/
├── converters/
│   └── to-typebox.ts         # SchemaFieldDefinition → TypeBox converter
├── validation-types.ts       # Cell-level result types
├── table-helper.ts           # TableHelper with integrated validation
├── types.ts                  # TableHelper, result types
└── create-cell-workspace.ts  # Factory with schema injection
```

### Result Type Hierarchy

```
Core (row-level)              Cell (cell-level)
─────────────────             ─────────────────
ValidRowResult<T>             ValidCellResult<TValue>
InvalidRowResult              InvalidCellResult
NotFoundResult                NotFoundCellResult
RowResult<T>                  CellResult<TValue>
GetResult<T>                  GetCellResult<TValue>
```

Cell types are exported from `validation-types.ts` alongside re-exports of core types.

## Implementation

### TypeBox Converter

`schemaFieldToTypebox(field)` converts a `SchemaFieldDefinition` to TypeBox:

| FieldType | TypeBox Schema |
|-----------|---------------|
| text, richtext | `Type.Optional(Type.Union([Type.String(), Type.Null()]))` |
| integer | `Type.Optional(Type.Union([Type.Integer(), Type.Null()]))` |
| real | `Type.Optional(Type.Union([Type.Number(), Type.Null()]))` |
| boolean | `Type.Optional(Type.Union([Type.Boolean(), Type.Null()]))` |
| date, datetime | `Type.Optional(Type.Union([Type.String(), Type.Null()]))` |
| select | `Type.Optional(Type.Union([Type.Literal(...), Type.Null()]))` |
| tags | `Type.Optional(Type.Union([Type.Array(...), Type.Null()]))` |
| json | `Type.Optional(Type.Union([Type.Unknown(), Type.Null()]))` |

All fields are wrapped with `Type.Optional()` because missing fields are valid in advisory schemas.

`schemaTableToTypebox(table)` creates a `TObject` with `additionalProperties: true`.

### Unified TableHelper API

`TableHelper` provides integrated validation. All read operations return result types that include both the validation status and the raw value—so you always have access to the data regardless of validity:

```typescript
type TableHelper = {
  readonly tableId: string;
  readonly schema: SchemaTableDefinition;

  // Validated reads (return result types with both status AND value)
  get(rowId, fieldId): GetCellResult<unknown>;
  getRow(rowId): GetResult<RowData>;
  getAll(): RowResult<RowData>[];
  getAllValid(): RowData[];
  getAllInvalid(): InvalidRowResult[];

  // Unrestricted writes (advisory schema)
  set(rowId, fieldId, value): void;
  delete(rowId, fieldId): void;
  deleteRow(rowId): void;
  createRow(rowId?): string;

  // Utilities
  has(rowId, fieldId): boolean;
  getRowIds(): string[];
  observe(handler): () => void;
};
```

Validators are compiled once at construction. Field validators are compiled lazily and cached.

### Schema Handling

- **Defined tables**: Schema comes from `WorkspaceSchema.tables[tableId]`
- **Dynamic tables**: Empty schema `{ name: tableId, fields: {} }` is used, which passes all validation

Schema is always required—there's no `undefined` case to check.

## Usage

### Basic Validation

```typescript
import { createCellWorkspace } from '@epicenter/epicenter/cell';

const workspace = createCellWorkspace({
  id: 'my-workspace',
  definition: {
    name: 'Blog',
    tables: {
      posts: {
        name: 'Posts',
        fields: {
          title: { name: 'Title', type: 'text', order: 1 },
          views: { name: 'Views', type: 'integer', order: 2 },
        },
      },
    },
  },
});

const posts = workspace.table('posts');
const rowId = posts.createRow();
posts.set(rowId, 'title', 'Hello');
posts.set(rowId, 'views', 'not a number'); // Wrong type - writes always succeed

// Validated reads
const cell = posts.get(rowId, 'views');
// { status: 'invalid', key: 'row-1:views', errors: [...], value: 'not a number' }

const row = posts.getRow(rowId);
// { status: 'invalid', id: 'row-1', tableName: 'posts', errors: [...], row: {...} }

// Bulk operations
const allResults = posts.getAll();      // All rows with validation status
const validRows = posts.getAllValid();  // Only valid rows
const invalidRows = posts.getAllInvalid(); // Only invalid with errors

// Access raw value from any result (no separate "raw" API needed)
if (result.status === 'invalid') {
  const rawValue = result.value;  // 'not a number' - always available
}
```

### Direct Helper Access

For programmatic use without workspace:

```typescript
import { createTableHelper } from '@epicenter/epicenter/cell';

const tableHelper = createTableHelper('posts', yarray, tableSchema);
// Schema is required - use { name: 'posts', fields: {} } for dynamic tables
```

## API Reference

### Exports from `@epicenter/epicenter/cell`

**Functions:**
- `createCellWorkspace(options)` - Create workspace client
- `createTableHelper(tableId, yarray, schema)` - Create table helper directly
- `schemaFieldToTypebox(field)` - Single field → TypeBox TSchema
- `schemaTableToTypebox(table)` - Table definition → TypeBox TObject

**Types:**
- `TableHelper` - Unified helper with validation
- `ValidCellResult<T>`, `InvalidCellResult`, `NotFoundCellResult`
- `CellResult<T>`, `GetCellResult<T>`
- Re-exports: `ValidationError`, `ValidRowResult`, `InvalidRowResult`, `NotFoundResult`, `RowResult`, `GetResult`

## Tests

- `converters/to-typebox.test.ts` - Field type conversion
- `validated-table-store.test.ts` - TableHelper validation logic (consolidated API)
- `create-cell-workspace.test.ts` - Workspace integration

```bash
bun test src/cell/  # All cell tests
```

## Design Decisions

1. **Unified API** - Validation is integrated into `TableHelper` rather than a separate wrapper. This eliminates the `table()` vs `validatedTable()` choice and simplifies the API.

2. **Raw escape hatch** - `helper.raw.*` provides unvalidated access when needed (performance-critical code, debugging, migrations).

3. **All fields optional** - Advisory validation means missing fields are valid. `Type.Optional()` wraps all properties.

4. **Additional properties allowed** - `{ additionalProperties: true }` lets unknown fields pass. Data outside schema isn't flagged as invalid.

5. **Schema always required** - Dynamic tables use empty schema `{ name, fields: {} }` rather than `undefined`. This removes null checks throughout the codebase.

6. **Lazy field validator caching** - Row validators compile eagerly (at construction). Field validators compile lazily (on first access per field). Both are cached.

7. **Writes bypass validation** - `set()`, `delete()`, etc. don't validate. This supports CRDT semantics where all writes must succeed for convergence.
