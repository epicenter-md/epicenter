# Extension Context Redesign

## Problem Statement

The current `ExtensionContext` exposes both typed helpers (`tables`, `kv`) and raw Y.Maps (`tablesMap`, `kvMap`, `schemaMap`) at the same level, creating ambiguity about which API is preferred. This "flippable" feeling makes the API harder to understand and use correctly.

Additionally, schema operations are exposed as standalone functions (`getSchema`, `mergeSchema`, `observeSchema`) rather than as a cohesive helper like `tables` and `kv`.

## Goals

1. **Clear hierarchy**: Primary API (`tables`, `kv`, `schema`) with explicit escape hatches (`raw`)
2. **Consistent patterns**: All three (tables, kv, schema) follow similar API shapes
3. **Granular schema editing**: Support CRUD operations at the field level for Notion-like UIs
4. **Gradual migration**: Implement in small, non-breaking steps

## Current ExtensionContext

```typescript
type ExtensionContext<TTableDefinitionMap, TKvDefinitionMap> = {
  ydoc: Y.Doc;
  workspaceId: string;
  epoch: number;
  extensionId: string;

  // Typed helpers
  tables: Tables<TTableDefinitionMap>;
  kv: Kv<TKvDefinitionMap>;

  // Raw Y.Maps (same level as helpers - confusing)
  schemaMap: SchemaMap;
  kvMap: KvMap;
  tablesMap: TablesMap;

  // Schema functions (not a cohesive helper)
  getSchema(): WorkspaceSchemaMap;
  mergeSchema<...>(schema): void;
  observeSchema(callback): () => void;
};
```

## Proposed ExtensionContext

```typescript
type ExtensionContext<TTableDefinitionMap, TKvDefinitionMap> = {
	// Core identifiers
	ydoc: Y.Doc;
	workspaceId: string;
	epoch: number;
	extensionId: string;

	// Primary API (typed helpers with nested raw escape hatches)
	tables: Tables<TTableDefinitionMap>; // Has raw, each table has raw
	kv: Kv<TKvDefinitionMap>; // Has raw
	schema: Schema; // NEW: cohesive helper with $raw
};
```

## API Design

### Design Principles

1. **`$` prefix reserved for type inference and schema escape hatches**:
   - `$inferRow` / `$inferValue` = type inference (compile-time only)
   - `schema.$raw` = schema escape hatch (intentionally keeps $ prefix)

2. **Regular methods for utilities and escape hatches** (no `$` prefix):
   - `raw` - escape hatch for tables/kv (direct Y.Map access)
   - `definitions` - static metadata
   - `defined()` - collection iteration
   - `zip()` - pairing with configs
   - `toJSON()` - serialization

3. **Consistent naming**:
   - `observe()` for watching changes (rename from `observeChanges`)
   - `get()` / `set()` / `delete()` / `has()` for CRUD

---

## Detailed API Specifications

### `tables` API

```typescript
tables: {
  // Metadata
  definitions: TableDefinitionMap;

  // Collection utilities
  defined(): TableHelper[];
  zip<T>(configs: T): ZippedResult[];

  // Mutations
  clearAll(): void;

  // Escape hatch
  raw: TablesMap;                        // Y.Map<TableMap>

  // Per-table access
  [tableName]: TableHelper & {
    // Existing methods...
    name: string;
    schema: FieldSchemaMap;

    // CRUD
    get(id: string): GetResult<Row>;
    getAll(): RowResult<Row>[];
    getAllValid(): Row[];
    getAllInvalid(): InvalidRowResult[];
    upsert(row: Row): void;
    upsertMany(rows: Row[]): void;
    update(partial: PartialRow): UpdateResult;
    updateMany(partials: PartialRow[]): UpdateManyResult;
    delete(id: string): DeleteResult;
    deleteMany(ids: string[]): DeleteManyResult;
    clear(): void;

    // Query
    has(id: string): boolean;
    count(): number;
    filter(predicate): Row[];
    find(predicate): Row | null;

    // Observation (rename from observeChanges)
    observe(callback): () => void;

    // Escape hatch
    raw: TableMap;                       // Y.Map<RowMap> for this table

    // Type inference
    $inferRow: Row;
  };
};
```

### `kv` API

```typescript
kv: {
  // Metadata
  definitions: KvDefinitionMap;

  // Collection utilities
  defined(): KvHelper[];
  toJSON(): Record<string, Value>;

  // Mutations
  clearAll(): void;

  // Escape hatch
  raw: KvMap;                            // Y.Map<KvValue>

  // Per-key access
  [keyName]: KvHelper & {
    // Existing methods...
    name: string;
    field: FieldSchema;

    // CRUD
    get(): KvGetResult<Value>;
    set(value: Value): void;
    reset(): void;

    // Observation (rename from observeChanges)
    observe(callback): () => void;

    // Type inference
    $inferValue: Value;

    // Note: No per-key $raw (values are primitives, not Y.Maps)
  };
};
```

### `schema` API (NEW)

```typescript
schema: {
  // Top-level operations
  get(): WorkspaceSchemaMap;             // Snapshot of entire schema
  merge(schema: PartialSchema): void;    // Merge definitions (existing mergeSchema)
  observe(callback): () => void;         // Watch any schema change

  // Escape hatch
  $raw: SchemaMap;                       // Y.Map (root schema map)

  // Table schemas
  tables: {
    // Collection CRUD
    get(name: string): TableDefinition | undefined;
    getAll(): Record<string, TableDefinition>;
    set(name: string, definition: TableDefinition): void;
    delete(name: string): void;
    has(name: string): boolean;
    keys(): string[];

    // Observation
    observe(callback): () => void;

    // Escape hatch
    $raw: Y.Map;                         // Y.Map for tables schema section

    // Per-table schema access (dynamic proxy)
    [tableName]: {
      // Full definition
      get(): TableDefinition;

      // Field CRUD
      fields: {
        get(name: string): FieldSchema | undefined;
        getAll(): FieldSchemaMap;
        set(name: string, schema: FieldSchema): void;
        delete(name: string): void;
        has(name: string): boolean;
        keys(): string[];
        observe(callback): () => void;
        $raw: Y.Map;                     // Y.Map for this table's fields
      };

      // Metadata CRUD
      metadata: {
        get(): TableMetadata;            // { name, icon?, description? }
        set(meta: Partial<TableMetadata>): void;
        observe(callback): () => void;
      };

      // Escape hatch
      $raw: Y.Map;                       // Y.Map for this table's schema
    };
  };

  // KV schemas
  kv: {
    // Collection CRUD
    get(name: string): KvDefinition | undefined;
    getAll(): Record<string, KvDefinition>;
    set(name: string, definition: KvDefinition): void;
    delete(name: string): void;
    has(name: string): boolean;
    keys(): string[];

    // Observation
    observe(callback): () => void;

    // Escape hatch
    $raw: Y.Map;                         // Y.Map for kv schema section
  };
};
```

---

## Usage Examples

### Extension using primary API

```typescript
const myExtension: ExtensionFactory = ({ tables, kv, schema }) => {
	// Use typed helpers (recommended)
	const posts = tables.posts.getAllValid();
	const theme = kv.theme.get();

	// Watch for changes
	tables.posts.observe((changes) => {
		/* ... */
	});
	kv.theme.observe((change) => {
		/* ... */
	});

	// Schema operations for dynamic UI
	schema.tables.tasks.fields.set('priority', integer({ default: 0 }));
	schema.tables.tasks.metadata.set({ name: 'My Tasks' });
};
```

### Extension needing Y.js access (rare)

```typescript
const advancedExtension: ExtensionFactory = ({ tables, ydoc }) => {
	// Bulk operation in single transaction
	ydoc.transact(() => {
		const posts = tables.posts;
		// Operations within transaction...
	});

	// For fine-grained Y.js events, use ydoc directly
	const yarray = ydoc.getArray('posts');
	yarray.observeDeep((events) => {
		// Y.js-level events...
	});
};
```

### Notion-like column management

```typescript
// Add a column to a table
schema.tables.tasks.fields.set('dueDate', date({ nullable: true }));

// Remove a column
schema.tables.tasks.fields.delete('dueDate');

// Rename table
schema.tables.tasks.metadata.set({ name: 'Project Tasks' });

// Watch for schema changes (update UI)
schema.tables.tasks.fields.observe((changes) => {
	for (const [fieldName, change] of changes) {
		if (change.action === 'add') refreshColumnHeaders();
		if (change.action === 'delete') removeColumnFromView(fieldName);
	}
});
```

---

## Implementation Plan

### Phase 1: Add `raw` escape hatches (non-breaking)

1. Add `raw` to `tables` (collection level)
2. Add `raw` to each `TableHelper` (per-table level)
3. Add `raw` to `kv` (collection level)

**Changes**:

- `create-tables.ts`: Add `raw: ytables` to return object
- `table-helper.ts`: Add `raw` property exposing the table's Y.Map
- `kv/core.ts`: Add `raw: ykvMap` to return object

### Phase 2: Create `schema` helper (non-breaking)

1. Create `createSchema()` function similar to `createTables()` / `createKv()`
2. Implement `schema.tables` and `schema.kv` sub-helpers
3. Implement per-table `fields` and `metadata` helpers
4. Add to ExtensionContext

**New files**:

- `core/schema/schema-helper.ts`
- `core/schema/table-schema-helper.ts`
- `core/schema/kv-schema-helper.ts`

### Phase 3: Update ExtensionContext (non-breaking)

1. Add `schema` to ExtensionContext
2. Keep existing `schemaMap`, `kvMap`, `tablesMap`, `getSchema`, `mergeSchema`, `observeSchema` for backward compatibility
3. Mark old properties as deprecated

### Phase 4: Rename `observeChanges` to `observe` (breaking)

1. Rename in `TableHelper`
2. Rename in `KvHelper`
3. Update all tests and extensions

### Phase 5: Remove deprecated properties (breaking)

1. Remove `schemaMap`, `kvMap`, `tablesMap` from ExtensionContext
2. Remove `getSchema`, `mergeSchema`, `observeSchema` from ExtensionContext
3. Update all extensions to use new API

### Phase 6: Rename `$definitions`, `$all`, `$zip`, `$toJSON`, `$raw` (breaking)

1. Remove `$` prefix from utility methods (keep `$raw` for schema only)
2. Rename `$all()` to `defined()` for clarity
3. Update all usages

---

## Migration Guide (for Phase 5)

| Old API                       | New API                  |
| ----------------------------- | ------------------------ |
| `ctx.tablesMap`               | `ctx.tables.raw`         |
| `ctx.kvMap`                   | `ctx.kv.raw`             |
| `ctx.schemaMap`               | `ctx.schema.$raw`        |
| `ctx.getSchema()`             | `ctx.schema.get()`       |
| `ctx.mergeSchema(s)`          | `ctx.schema.merge(s)`    |
| `ctx.observeSchema(cb)`       | `ctx.schema.observe(cb)` |
| `table.observeChanges(cb)`    | `table.observe(cb)`      |
| `kvHelper.observeChanges(cb)` | `kvHelper.observe(cb)`   |
| `tables.$definitions`         | `tables.definitions`     |
| `tables.$all()`               | `tables.defined()`       |
| `tables.$zip()`               | `tables.zip()`           |
| `tables.posts.$raw`           | `tables.posts.raw`       |
| `kv.$definitions`             | `kv.definitions`         |
| `kv.$all()`                   | `kv.defined()`           |
| `kv.$toJSON()`                | `kv.toJSON()`            |

---

## Open Questions

1. **Dynamic table access on `schema.tables`**: Should `schema.tables.posts` be a Proxy that lazily creates helpers, or should we require `schema.tables.get('posts')`?
   - Proxy: More ergonomic, matches `tables.posts` pattern
   - Explicit: Simpler implementation, clearer that it's schema not data

2. **Observation callback signatures**: Should `schema.tables.observe()` match the same signature pattern as `tables.posts.observe()`?

3. **Field schema updates**: When a field schema changes, should we validate existing data against the new schema? Or is that a separate concern?

---

## Checklist

- [x] Phase 1: Add `raw` escape hatches
  - [x] `tables.raw`
  - [x] `tables.[name].raw`
  - [x] `kv.raw`
  - [x] Tests for `raw` access
- [x] Phase 2: Create `schema` helper
  - [x] `createSchema()` function
  - [x] `schema.get()`, `schema.merge()`, `schema.observe()`
  - [x] `schema.tables` sub-helper with CRUD operations
  - [x] `schema.tables.table(name).fields` sub-helper for granular field editing
  - [x] `schema.tables.table(name).metadata` sub-helper
  - [x] `schema.kv` sub-helper with CRUD operations
  - [x] `schema.$raw` and all sub-helper `$raw` properties
  - [x] Tests for schema helper (25 tests)
- [x] Phase 3: Update ExtensionContext
  - [x] Add `schema` property to `ExtensionContext` type
  - [x] Create schema helper in `createWorkspaceDoc` and pass to extensions
  - [x] Add `schema` to `WorkspaceDoc` return type
  - [x] Mark deprecated properties with `@deprecated` JSDoc
- [ ] Phase 2: Create `schema` helper
  - [ ] `createSchema()` function
  - [ ] `schema.get()`, `schema.merge()`, `schema.observe()`
  - [ ] `schema.tables` sub-helper
  - [ ] `schema.tables.[name].fields` sub-helper
  - [ ] `schema.tables.[name].metadata` sub-helper
  - [ ] `schema.kv` sub-helper
  - [ ] `schema.$raw`
- [ ] Phase 3: Update ExtensionContext
  - [ ] Add `schema` property
  - [ ] Deprecate old properties
- [ ] Phase 4: Rename `observeChanges` to `observe`
- [ ] Phase 5: Remove deprecated properties
- [ ] Phase 6: Remove `$` prefix from utilities
