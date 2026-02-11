# Grid Workspace API Specification

**Status**: Implemented (2026-01-30)

Unify Cell and Dynamic workspace systems into a single **Grid Workspace** API with cell-level CRDT storage, external schema validation, and optional HeadDoc integration for time travel.

## Background

Currently there are three workspace systems in `packages/epicenter/src/`:

| System  | Location       | Schema                   | Storage    | HeadDoc |
| ------- | -------------- | ------------------------ | ---------- | ------- |
| Static  | `src/static/`  | TypeScript + migrations  | Row-level  | No      |
| Cell    | `src/cell/`    | External JSON            | Cell-level | Yes     |
| Dynamic | `src/dynamic/` | In Y.Doc (user-editable) | Cell-level | No      |

**Problem**: Cell and Dynamic are nearly identical (both cell-level CRDT), differing only in schema location. This creates maintenance burden and confusion.

**Solution**: Merge Cell + Dynamic into **Grid Workspace** — a single API with:

- Cell-level CRDT storage (like both)
- External schema with validation (like Cell, not Dynamic)
- Optional HeadDoc for time travel (unified across both)

## Goals

1. **Unify Cell + Dynamic** into a single Grid Workspace API
2. **Optional HeadDoc** — if provided, enables time travel and epochs; if absent, enables garbage collection
3. **External schema always** — definition passed in, schema editing happens externally (JSON file, database), then client is recreated
4. **Validation on read** — Cell's approach (advisory validation, not enforcement)
5. **Builder pattern** — `.withExtensions()` for type-safe extension setup

## Non-Goals

- Schema editing via API (removed from Dynamic)
- Row-level storage (that's Static's domain)
- Migration system (that's Static's domain)

## API Design

### Creation

```typescript
// Without HeadDoc (simple, GC enabled)
const client = createGridWorkspace({
	id: 'my-workspace',
	definition,
}).withExtensions({
	persistence,
	sqlite,
});

// With HeadDoc (time travel enabled, GC disabled)
const client = createGridWorkspace({
	id: 'my-workspace',
	definition,
	headDoc,
}).withExtensions({
	persistence,
	sqlite,
});
```

### CreateGridWorkspaceOptions

```typescript
type CreateGridWorkspaceOptions = {
	/** Unique identifier for the workspace */
	id: string;

	/** Workspace definition (schema for tables and KV) - always required */
	definition: WorkspaceDefinition;

	/** Optional HeadDoc for time travel support */
	headDoc?: {
		workspaceId: string;
		getEpoch(): number;
	};

	/** Optional existing Y.Doc to use instead of creating new */
	ydoc?: Y.Doc;
};
```

### HeadDoc Behavior

| HeadDoc | Y.Doc GUID              | Garbage Collection | Time Travel |
| ------- | ----------------------- | ------------------ | ----------- |
| Absent  | `{workspaceId}`         | Enabled            | No          |
| Present | `{workspaceId}-{epoch}` | Disabled           | Yes         |

### GridWorkspaceBuilder

```typescript
type GridWorkspaceBuilder<TTableDefs> = {
	/**
	 * Add extensions that receive typed context based on the definition.
	 * Extensions can access `table('posts')` with type safety.
	 */
	withExtensions<TExtensions extends ExtensionFactoryMap<TTableDefs>>(
		extensions: TExtensions,
	): GridWorkspaceClient<TTableDefs, InferExtensionExports<TExtensions>>;
};
```

### GridWorkspaceClient

```typescript
type GridWorkspaceClient<TTableDefs, TExtensions = {}> = {
	// ═══════════════════════════════════════════════════════════════
	// IDENTITY
	// ═══════════════════════════════════════════════════════════════
	/** Workspace identifier (no epoch suffix) */
	id: string;
	/** Current epoch number (0 if no HeadDoc) */
	epoch: number;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;

	// ═══════════════════════════════════════════════════════════════
	// METADATA (from definition)
	// ═══════════════════════════════════════════════════════════════
	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace */
	icon: Icon | null;
	/** The full workspace definition (access schema here) */
	definition: WorkspaceDefinition;

	// ═══════════════════════════════════════════════════════════════
	// DATA ACCESS
	// ═══════════════════════════════════════════════════════════════
	/**
	 * Get a table helper. Creates the underlying Y.Array if it doesn't exist.
	 * Table helpers are cached - calling with same tableId returns same instance.
	 */
	table<K extends TTableDefs[number]['id']>(tableId: K): GridTableHelper;
	table(tableId: string): GridTableHelper;

	/** KV store for workspace-level values */
	kv: KvStore;

	// ═══════════════════════════════════════════════════════════════
	// LIFECYCLE
	// ═══════════════════════════════════════════════════════════════
	/** Batch multiple writes into a single Y.Doc transaction */
	batch<T>(fn: (ws: GridWorkspaceClient<TTableDefs, TExtensions>) => T): T;

	/** Resolves when all extensions are synced/ready */
	whenSynced: Promise<void>;

	/** Destroy the workspace client and release resources */
	destroy(): Promise<void>;

	/** Extension exports */
	extensions: TExtensions;
};
```

### GridTableHelper

```typescript
type GridTableHelper = {
	/** The table identifier */
	tableId: string;
	/** The schema definition for this table */
	schema: TableDefinition;

	// ═══════════════════════════════════════════════════════════════
	// CELL OPERATIONS (validated)
	// ═══════════════════════════════════════════════════════════════
	/** Get a validated cell value */
	getCell(rowId: string, fieldId: string): GetCellResult<unknown>;
	/** Set a cell value */
	setCell(rowId: string, fieldId: string, value: CellValue): void;
	/** Delete a cell value (hard delete) */
	deleteCell(rowId: string, fieldId: string): void;
	/** Check if a cell exists */
	hasCell(rowId: string, fieldId: string): boolean;

	// ═══════════════════════════════════════════════════════════════
	// ROW OPERATIONS (validated)
	// ═══════════════════════════════════════════════════════════════
	/** Get a validated row */
	getRow(rowId: string): GetResult<RowData>;

	/**
	 * Create a new row.
	 * @overload Just ID
	 * @overload Options object with optional ID and initial cells
	 */
	createRow(rowId?: string): string;
	createRow(opts: { id?: string; cells?: Record<string, CellValue> }): string;

	/** Set all cells for a row at once (replaces existing cells) */
	setRow(rowId: string, cells: Record<string, CellValue>): void;

	/** Delete a row (hard delete - removes all cells) */
	deleteRow(rowId: string): void;

	// ═══════════════════════════════════════════════════════════════
	// BULK OPERATIONS (validated)
	// ═══════════════════════════════════════════════════════════════
	/** Get all rows with validation results */
	getAll(): RowResult<RowData>[];
	/** Get all valid rows (filters out invalid ones) */
	getAllValid(): RowData[];
	/** Get all invalid rows with error details */
	getAllInvalid(): InvalidRowResult[];
	/** Get all row IDs */
	getRowIds(): string[];

	// ═══════════════════════════════════════════════════════════════
	// OBSERVATION
	// ═══════════════════════════════════════════════════════════════
	/** Observe changes to cells */
	observe(handler: ChangeHandler<CellValue>): () => void;
};
```

### Extension System

Extensions receive typed context and must satisfy the Lifecycle protocol:

```typescript
type ExtensionContext<TTableDefs> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier (no epoch suffix) */
	workspaceId: string;
	/** Current epoch number */
	epoch: number;
	/** Get a table helper by ID (typed based on definition) */
	table<K extends TTableDefs[number]['id']>(tableId: K): GridTableHelper;
	table(tableId: string): GridTableHelper;
	/** KV store for workspace-level values */
	kv: KvStore;
	/** The full workspace definition */
	definition: WorkspaceDefinition;
	/** This extension's ID (the key in the extensions map) */
	extensionId: string;
};

type ExtensionFactory<TTableDefs, TExports extends Lifecycle = Lifecycle> = (
	context: ExtensionContext<TTableDefs>,
) => TExports;

type ExtensionFactoryMap<TTableDefs> = Record<
	string,
	ExtensionFactory<TTableDefs, Lifecycle>
>;
```

### Validation Types

Reuse from Cell workspace:

```typescript
type GetCellResult<T> =
	| { status: 'valid'; value: T; type: FieldType }
	| {
			status: 'invalid';
			value: unknown;
			type: FieldType;
			error: ValidationError;
	  }
	| { status: 'not_found' };

type GetResult<T> =
	| { status: 'valid'; row: T }
	| { status: 'invalid'; id: string; error: ValidationError }
	| { status: 'not_found'; id: string };

type RowResult<T> =
	| { status: 'valid'; row: T }
	| { status: 'invalid'; id: string; error: ValidationError };

type InvalidRowResult = {
	id: string;
	error: ValidationError;
};
```

### KvStore

```typescript
/** Result of getting a KV value with validation. */
type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| { status: 'invalid'; key: string; errors: ValidationError[]; value: unknown }
	| { status: 'not_found'; key: string; value: undefined };

type KvStore = {
	/** Get a validated value by key */
	get(key: string): KvGetResult<unknown>;
	/** Get a raw value by key (no validation) */
	getRaw(key: string): unknown | undefined;
	/** Set a value */
	set(key: string, value: unknown): void;
	/** Delete a value (hard delete) */
	delete(key: string): void;
	/** Check if a key exists */
	has(key: string): boolean;
	/** Get all key-value pairs with validation results */
	getAll(): KvResult<unknown>[];
	/** Get all valid key-value pairs */
	getAllValid(): Map<string, unknown>;
	/** Get all invalid key-value pairs with error details */
	getAllInvalid(): InvalidKvResult[];
	/** Observe changes */
	observe(handler: ChangeHandler<unknown>): () => void;
};
```

## Implementation Plan

### Phase 1: Create Grid Workspace (New)

1. Create `src/grid/` directory
2. Implement `create-grid-workspace.ts` with builder pattern
3. Implement `grid-table-helper.ts` with cell operations
4. Implement types in `types.ts`
5. Copy and adapt validation logic from Cell
6. Add HeadDoc toggle for Y.Doc GUID generation

### Phase 2: Migrate Extensions

1. Ensure existing Cell extensions work with Grid (same context shape)
2. Update extension type imports

### Phase 3: Update Static (Optional HeadDoc)

1. Add optional `headDoc` parameter to `workspace.create()`
2. Change Y.Doc GUID from `{id}` to `{id}-{epoch}` when HeadDoc present
3. Disable GC when HeadDoc present

### Phase 4: Deprecate Cell + Dynamic

1. Mark Cell exports as deprecated with migration notes
2. Mark Dynamic exports as deprecated
3. Update documentation

### Phase 5: Cleanup (Future)

1. Remove Cell code after migration period
2. Remove Dynamic code after migration period

## File Structure

```
packages/epicenter/src/grid/
├── index.ts                      # Public exports
├── types.ts                      # Type definitions
├── create-grid-workspace.ts      # Factory + builder
├── grid-table-helper.ts          # Table operations
├── stores/
│   ├── cells-store.ts            # Cell CRDT storage (from Dynamic)
│   └── kv-store.ts               # KV storage (from Cell)
├── validation.ts                 # Cell validation logic
├── keys.ts                       # Key generation utilities
└── extensions.ts                 # Extension types + context
```

## Migration Guide

### From Cell to Grid

```typescript
// Before (Cell)
import { createCellWorkspace } from '@epicenter/hq/cell';

const client = createCellWorkspace({
	headDoc,
	definition,
}).withExtensions({ persistence });

// After (Grid)
import { createGridWorkspace } from '@epicenter/hq/grid';

const client = createGridWorkspace({
	id: headDoc.workspaceId, // Extract ID
	definition,
	headDoc, // Optional now
}).withExtensions({ persistence });
```

### From Dynamic to Grid

```typescript
// Before (Dynamic)
import { createDynamicWorkspace } from '@epicenter/hq/dynamic';

const workspace = createDynamicWorkspace({ id: 'my-workspace' });
workspace.tables.create('posts', { name: 'Posts' });
workspace.fields.create('posts', 'title', { type: 'text' });

// After (Grid)
import { createGridWorkspace } from '@epicenter/hq/grid';

// Define schema externally (JSON file, database, etc.)
const definition = {
	name: 'My Workspace',
	tables: [
		{
			id: 'posts',
			name: 'Posts',
			fields: [{ id: 'title', type: 'text', name: 'Title' }],
		},
	],
	kv: [],
};

const client = createGridWorkspace({
	id: 'my-workspace',
	definition,
}).withExtensions({});
```

## Testing Strategy

1. **Unit tests**: Each method on GridTableHelper
2. **Integration tests**: Full workspace lifecycle with extensions
3. **HeadDoc toggle tests**: Verify Y.Doc GUID and GC behavior
4. **Validation tests**: Port from Cell's existing test suite
5. **Migration tests**: Ensure Cell → Grid produces same behavior

## Open Questions

1. **Should `createRow` support both overloads or just options object?**
   - Decision: Both overloads for flexibility

2. **Do we need `getAllWithCellValidation()` on table helper?**
   - Decision: Defer — can add later if needed

3. **Should Static also move to builder pattern?**
   - Decision: No — keep `workspace.create({ capabilities })` for simplicity; just add optional `headDoc`

## References

- Current Cell implementation: `packages/epicenter/src/cell/`
- Current Dynamic implementation: `packages/epicenter/src/dynamic/`
- Current Static implementation: `packages/epicenter/src/static/`
- HeadDoc implementation: `packages/epicenter/src/core/docs/head-doc.ts`
