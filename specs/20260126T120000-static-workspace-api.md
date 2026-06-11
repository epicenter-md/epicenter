# Static Workspace API Specification

> **Status: Superseded**: This spec was a design document. The API evolved during implementation. The current API uses `createWorkspace(definition)` instead of `workspace.create()`. See `packages/epicenter/src/static/README.md` for the current API.

## Overview

This specification defines the **Static Workspace API** for Epicenter - a composable, type-safe API for defining and creating workspaces with versioned tables and KV stores.

"Static" refers to the schema being defined at compile-time with full TypeScript inference, as opposed to dynamic/runtime schemas (like grids - see Related Specs).

**Location**: `packages/epicenter/src/static/` (proposed)

### Related Specs

- `specs/20260125T120000-versioned-table-kv-specification.md` - Versioned schema internals (YKeyValue, migrate-on-read)
- `specs/20260126T103000-table-api-split.md` - Tables vs Grids distinction
- `specs/20260108T001900-workspace-create-accepts-capabilities.md` - Capabilities API

---

## Design Principles

### 1. Composability at Every Level

The API is designed in layers. Each layer is independently usable:

```
┌─────────────────────────────────────────────────────────────┐
│  defineWorkspace() + workspace.create()                     │  ← High-level
│    Creates Y.Doc internally, binds tables/kv/capabilities   │
├─────────────────────────────────────────────────────────────┤
│  createTables(ydoc, {...}) / createKv(ydoc, {...})          │  ← Mid-level
│    Binds to existing Y.Doc                                  │
├─────────────────────────────────────────────────────────────┤
│  defineTable() / defineKv()                                 │  ← Low-level
│    Pure schema definitions                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2. Naming Convention: `define` vs `create`

| Prefix    | Meaning                 | Side Effects              | Example                                              |
| --------- | ----------------------- | ------------------------- | ---------------------------------------------------- |
| `define*` | Pure schema declaration | None                      | `defineTable()`, `defineKv()`, `defineWorkspace()`   |
| `create*` | Instantiation           | Creates Y.Doc, binds data | `createTables()`, `createKv()`, `workspace.create()` |

### 3. No Wrapper Functions for Composition

Plain objects are used for composition instead of wrapper functions:

```typescript
// ✓ Good - plain object
const workspace = defineWorkspace({
	tables: { posts, users },
	kv: { theme },
});

// ✗ Avoid - unnecessary wrapper
const tablesDef = defineTables({ posts, users }); // Don't do this
```

### 4. Progressive Disclosure

Simple use cases are simple. Advanced use cases are possible:

```typescript
// Simple: High-level API (synchronous)
const client = defineWorkspace({ id, tables, kv }).create();

// Advanced: Bring your own Y.Doc
const ydoc = new Y.Doc();
const tables = createTables(ydoc, { posts });
new IndexeddbPersistence('my-doc', ydoc);
```

---

## API Reference

### Level 1: Schema Definitions (Pure)

#### `defineTable()`

Defines a versioned table schema with migration support.

```typescript
import { defineTable } from 'epicenter/static';
import { type } from 'arktype';

// Shorthand for single version (no migration needed)
const users = defineTable(type({ id: 'string', email: 'string' }));

// Builder pattern for multiple versions with migration
const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '"1"' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
	.migrate((row) => {
		if (row._v === '1') return { ...row, views: 0, _v: '2' as const };
		return row;
	});
```

**Type Signature:**

```typescript
// Shorthand: direct schema → TableDefinition
function defineTable<TSchema extends StandardSchemaV1>(
	schema: StandardSchemaV1.InferOutput<TSchema> extends { id: string }
		? TSchema
		: never,
): TableDefinition<StandardSchemaV1.InferOutput<TSchema> & { id: string }>;

// Builder: no args → TableBuilder
function defineTable(): TableBuilder<[], never>;

type TableBuilder<TVersions extends StandardSchemaV1[], TLatest> = {
	version<TSchema extends StandardSchemaV1>(
		schema: StandardSchemaV1.InferOutput<TSchema> extends { id: string }
			? TSchema
			: never,
	): TableBuilder<
		[...TVersions, TSchema],
		StandardSchemaV1.InferOutput<TSchema>
	>;

	migrate(
		fn: (row: StandardSchemaV1.InferOutput<TVersions[number]>) => TLatest,
	): TableDefinition<StandardSchemaV1.InferOutput<TVersions[number]>, TLatest>;
};

// TVersionUnion = union of all version outputs, TRow = migrated type
type TableDefinition<TVersionUnion, TRow extends { id: string }> = {
	schema: StandardSchemaV1<unknown, TVersionUnion>;
	migrate: (row: TVersionUnion) => TRow;
};
```

**Rules:**

- Schema must include `{ id: string }` (enforced at type level)
- Last `.version()` defines the "latest" schema shape
- `.migrate()` must return the latest schema shape
- Schemas are validated against a union of all versions on read

---

#### `defineKv()`

Defines a versioned KV schema with migration support.

```typescript
import { defineKv } from 'epicenter/static';
import { type } from 'arktype';

// Shorthand for single version (no migration needed)
const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));

// Builder pattern for multiple versions with migration
const theme = defineKv()
	.version(type({ mode: "'light' | 'dark'" }))
	.version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }))
	.migrate((v) => {
		if (!('fontSize' in v)) return { ...v, fontSize: 14 };
		return v;
	});
```

**Type Signature:**

```typescript
// Shorthand: direct schema → KvDefinition
function defineKv<TSchema extends StandardSchemaV1>(
	schema: TSchema,
): KvDefinition<StandardSchemaV1.InferOutput<TSchema>>;

// Builder: no args → KvBuilder
function defineKv(): KvBuilder<[], never>;

type KvBuilder<TVersions extends StandardSchemaV1[], TLatest> = {
	version<TSchema extends StandardSchemaV1>(
		schema: TSchema,
	): KvBuilder<[...TVersions, TSchema], StandardSchemaV1.InferOutput<TSchema>>;

	migrate(
		fn: (value: StandardSchemaV1.InferOutput<TVersions[number]>) => TLatest,
	): KvDefinition<StandardSchemaV1.InferOutput<TVersions[number]>, TLatest>;
};

// TVersionUnion = union of all version outputs, TValue = migrated type
type KvDefinition<TVersionUnion, TValue> = {
	schema: StandardSchemaV1<unknown, TVersionUnion>;
	migrate: (value: TVersionUnion) => TValue;
};
```

---

#### `defineWorkspace()`

Combines table and KV definitions into a workspace schema.

```typescript
import { defineWorkspace } from 'epicenter/static';

const workspace = defineWorkspace({
	id: 'epicenter.whispering',
	tables: { posts, users },
	kv: { theme, sidebar },
});
```

**Type Signature:**

```typescript
function defineWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = {},
	TKvDefinitions extends KvDefinitions = {},
>(config: {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
}): WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions>;

type WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions> = {
	id: TId;
	tableDefinitions: TTableDefinitions;
	kvDefinitions: TKvDefinitions;

	/** Synchronous - returns immediately. Use capability.whenSynced for async initialization. */
	create<TCapabilities extends CapabilityMap = {}>(
		capabilities?: TCapabilities,
	): WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TCapabilities>;
};
```

**Parameters:**

- `id` - Workspace identifier (used as Y.Doc guid, provider keys, etc.)
- `tables` - Map of table definitions (optional)
- `kv` - Map of KV definitions (optional)

---

### Level 2: Workspace Client

#### `workspace.create()`

Creates a workspace client with Y.Doc, tables, KV, and capabilities. **Synchronous**.

```typescript
// No capabilities (in-memory only)
const client = workspace.create();

// With capabilities
const client = workspace.create({
	sqlite,
	persistence,
	websocketSync: websocketSync({ url }),
});

// Wait for capabilities to be ready (optional)
await client.capabilities.persistence.whenSynced;
```

**Returns `WorkspaceClient`:**

```typescript
type WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TCapabilities> = {
	id: TId;
	ydoc: Y.Doc;
	tables: TablesHelper<TTableDefinitions>;
	kv: KvHelper<TKvDefinitions>;
	capabilities: InferCapabilityExports<TCapabilities>;

	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};
```

**Usage:**

```typescript
const client = workspace.create({ sqlite, persistence });

// Client is immediately usable (sync construction)
client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
client.tables.posts.get('1');  // GetResult<Post>

// Type-safe KV access (dictionary-style)
client.kv.set('theme', { mode: 'dark', fontSize: 16 });
client.kv.get('theme');  // KvGetResult<Theme>

// Wait for capabilities if needed (async property pattern)
await client.capabilities.persistence.whenSynced;
await client.capabilities.sqlite.whenSynced;

// Capability exports
client.capabilities.sqlite.db.select()...

// Raw Y.Doc access (escape hatch)
client.ydoc;

// Cleanup
await client.destroy();
```

**Sync construction, async property pattern:**

- `workspace.create()` returns immediately (synchronous)
- Tables and KV are usable right away
- Capabilities expose `.whenSynced` for async initialization
- UI can render immediately, show loading state while waiting for sync

---

### Level 3: Lower-Level APIs

For advanced use cases where you need to bring your own Y.Doc.

#### `createTables()`

Binds table definitions to an existing Y.Doc.

```typescript
import { createTables } from 'epicenter/static';

const ydoc = new Y.Doc({ guid: 'my-doc' });
const tables = createTables(ydoc, { posts, users });

tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
```

**Type Signature:**

```typescript
function createTables<TTableDefinitions extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: TTableDefinitions,
): TablesHelper<TTableDefinitions>;

type TablesHelper<TTableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	>;
};
```

---

#### `createKv()`

Binds KV definitions to an existing Y.Doc.

```typescript
import { createKv } from 'epicenter/static';

const ydoc = new Y.Doc({ guid: 'my-doc' });
const kv = createKv(ydoc, { theme, sidebar });

kv.set('theme', { mode: 'dark', fontSize: 16 });
```

**Type Signature:**

```typescript
function createKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
): KvHelper<TKvDefinitions>;

type KvHelper<TKvDefinitions extends KvDefinitions> = {
	get<K extends keyof TKvDefinitions>(
		key: K,
	): KvGetResult<InferKvValue<TKvDefinitions[K]>>;
	set<K extends keyof TKvDefinitions>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;
	delete<K extends keyof TKvDefinitions>(key: K): void;
	observe<K extends keyof TKvDefinitions>(
		key: K,
		callback: (
			change: KvChange<InferKvValue<TKvDefinitions[K]>>,
			tx: Y.Transaction,
		) => void,
	): () => void;
};
```

---

## Table Helper Methods

Methods available on `tables.{tableName}`:

```typescript
type TableHelper<TRow extends { id: string }> = {
	// ════════════════════════════════════════════════════════════════
	// WRITE (always writes latest schema shape)
	// ════════════════════════════════════════════════════════════════

	/** Set a row (insert or replace). Always writes full row. */
	set(row: TRow): void;

	// ════════════════════════════════════════════════════════════════
	// READ (validates + migrates to latest)
	// ════════════════════════════════════════════════════════════════

	/** Get a row by ID. Returns GetResult (valid | invalid | not_found). */
	get(id: string): GetResult<TRow>;

	/** Get all rows with validation status. */
	getAll(): RowResult<TRow>[];

	/** Get all valid rows (skips invalid). */
	getAllValid(): TRow[];

	/** Get all invalid rows (for debugging/repair). */
	getAllInvalid(): InvalidRowResult[];

	// ════════════════════════════════════════════════════════════════
	// QUERY
	// ════════════════════════════════════════════════════════════════

	/** Filter rows by predicate (only valid rows). */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/** Find first row matching predicate (only valid rows). */
	find(predicate: (row: TRow) => boolean): TRow | null;

	// ════════════════════════════════════════════════════════════════
	// DELETE
	// ════════════════════════════════════════════════════════════════

	/** Delete a row by ID. Fire-and-forget, no-op if missing. */
	delete(id: string): void;

	/** Delete all rows (table structure preserved). */
	clear(): void;

	// ════════════════════════════════════════════════════════════════
	// BATCH (Y.js transaction for atomicity)
	// ════════════════════════════════════════════════════════════════

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 * - Single undo/redo step
	 * - Observers fire once (not per-operation)
	 * - All changes applied together
	 */
	batch(fn: (tx: TableBatchTransaction<TRow>) => void): void;

	// ════════════════════════════════════════════════════════════════
	// OBSERVE
	// ════════════════════════════════════════════════════════════════

	/** Watch for row changes. Returns unsubscribe function. */
	observe(
		callback: (changedIds: Set<string>, tx: Y.Transaction) => void,
	): () => void;

	// ════════════════════════════════════════════════════════════════
	// METADATA
	// ════════════════════════════════════════════════════════════════

	/** Number of rows in table. */
	count(): number;

	/** Check if row exists. */
	has(id: string): boolean;
};

/** Operations available inside a batch transaction. */
type TableBatchTransaction<TRow extends { id: string }> = {
	set(row: TRow): void;
	delete(id: string): void;
};
```

**Key Design Decision: `set` not `upsert`/`insert`/`update`**

There's no distinction between insert and update. `set()` always writes the full row:

- If row exists → replaced
- If row doesn't exist → created

This simplifies the mental model and enables schema versioning (entire row is atomic).

**Key Design Decision: `batch()` not `setMany()`/`deleteMany()`**

Instead of separate "many" methods, we provide a `batch()` method that wraps operations in a Y.js transaction:

```typescript
// ✓ Atomic batch - single transaction, single observer notification
table.batch((tx) => {
	tx.set(row1);
	tx.set(row2);
	tx.delete('old-id');
});

// ✗ Not atomic - multiple transactions, multiple notifications
table.set(row1);
table.set(row2);
table.delete('old-id');
```

Benefits:

- **Explicit atomicity**: Clear when operations are grouped
- **Flexible composition**: Can mix sets and deletes in one transaction
- **Single observer notification**: UI updates once, not N times
- **Single undo/redo step**: Better UX for undo

**Cross-Table Transactions**

For operations spanning multiple tables or tables + KV, use `ydoc.transact()` directly:

```typescript
client.ydoc.transact(() => {
	client.tables.posts.set(post);
	client.tables.users.set(user);
	client.kv.set('lastModified', { timestamp: Date.now(), _v: '1' });
});
```

---

## KV Helper Methods

Methods available on `kv` (dictionary-style access):

```typescript
type KvHelper<TKvDefinitions extends KvDefinitions> = {
	/** Get a value by key (validates + migrates). */
	get<K extends keyof TKvDefinitions>(
		key: K,
	): KvGetResult<InferKvValue<TKvDefinitions[K]>>;

	/** Set a value by key (always latest schema). */
	set<K extends keyof TKvDefinitions>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;

	/** Delete a value by key. */
	delete<K extends keyof TKvDefinitions>(key: K): void;

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 */
	batch(fn: (tx: KvBatchTransaction<TKvDefinitions>) => void): void;

	/** Watch for changes to a specific key. */
	observe<K extends keyof TKvDefinitions>(
		key: K,
		callback: (
			change: KvChange<InferKvValue<TKvDefinitions[K]>>,
			tx: Y.Transaction,
		) => void,
	): () => void;
};

/** Operations available inside a KV batch transaction. */
type KvBatchTransaction<TKvDefinitions extends KvDefinitions> = {
	set<K extends keyof TKvDefinitions>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;
	delete<K extends keyof TKvDefinitions>(key: K): void;
};

type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| {
			status: 'invalid';
			errors: readonly StandardSchemaV1.Issue[];
			value: unknown;
	  }
	| { status: 'not_found' };
```

---

## Capabilities vs Raw Providers

### When to Use Capabilities

Capabilities wrap providers and receive context with `ydoc`, `tables`, `kv`:

```typescript
const client = await workspace.create({
  sqlite,      // Materializes tables to SQLite
  persistence, // Persists Y.Doc to disk
});

// Capability exports are type-safe
client.capabilities.sqlite.db.select()...
```

Use capabilities when:

- The provider needs access to tables/kv (e.g., SQLite materializer)
- You want type-safe exports on `client.capabilities`
- The capability is part of the workspace lifecycle (auto-cleanup on destroy)

### When to Use Raw Providers

Use raw Yjs providers directly on `client.ydoc`:

```typescript
const client = await workspace.create();

// Raw providers - standard Yjs pattern
new IndexeddbPersistence(client.id, client.ydoc);
createYSweetProvider(client.ydoc, url);

// Type-safe access still works
client.tables.posts.set({ id: '1', title: 'Hello' });
```

Use raw providers when:

- The provider only needs Y.Doc (no tables/kv context)
- You want standard Yjs provider patterns
- You're integrating with existing Yjs ecosystem tools

---

## File Organization

### Proposed Structure

```
packages/epicenter/src/static/
├── index.ts                    # Public exports
├── define-table.ts             # defineTable() builder
├── define-kv.ts                # defineKv() builder
├── define-workspace.ts         # defineWorkspace() + workspace.create()
├── create-tables.ts            # createTables() lower-level API
├── create-kv.ts                # createKv() lower-level API + KvHelper implementation
├── table-helper.ts             # TableHelper implementation
├── types.ts                    # Shared types
└── schema-union.ts             # Standard Schema union validation
```

### Exports

```typescript
// packages/epicenter/src/static/index.ts

// Schema definitions (pure)
export { defineTable } from './define-table';
export { defineKv } from './define-kv';
export { defineWorkspace } from './define-workspace';

// Lower-level APIs (for existing Y.Doc)
export { createTables } from './create-tables';
export { createKv } from './create-kv';

// Types
export type {
	TableDefinition,
	KvDefinition,
	Workspace,
	WorkspaceClient,
	TableHelper,
	KvHelper,
	GetResult,
	RowResult,
	KvGetResult,
	// ...
} from './types';
```

---

## Testing Strategy

The layered API enables clean unit testing:

### Test Schema Definitions

```typescript
import { defineTable } from 'epicenter/static';

test('defineTable creates valid definition', () => {
	const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

	// Verify schema validates correctly
	const result = posts.schema['~standard'].validate({ id: '1', title: 'Hi' });
	expect(result).not.toHaveProperty('issues');
	expect(posts.migrate({ id: '1', title: 'Hi' })).toEqual({
		id: '1',
		title: 'Hi',
	});
});
```

### Test Tables with In-Memory Y.Doc

```typescript
import { createTables } from 'epicenter/static';
import * as Y from 'yjs';

test('tables set and get', () => {
	const ydoc = new Y.Doc();
	const tables = createTables(ydoc, { posts });

	tables.posts.set({ id: '1', title: 'Hello', _v: '1' });

	const result = tables.posts.get('1');
	expect(result.status).toBe('valid');
	expect(result.row.title).toBe('Hello');
});
```

### Test Migrations

```typescript
test('migrates old schema to latest', () => {
	const ydoc = new Y.Doc();
	const tables = createTables(ydoc, { posts });

	// Simulate old data (v1 schema)
	const rawTables = ydoc.getMap('tables');
	// ... insert v1 data directly ...

	// Read should migrate
	const result = tables.posts.get('1');
	expect(result.status).toBe('valid');
	expect(result.row._v).toBe('2'); // Migrated to v2
	expect(result.row.views).toBe(0); // Default from migration
});
```

### Test Workspace with Capabilities

```typescript
test('workspace with sqlite capability', async () => {
	const workspace = defineWorkspace({
		id: 'test',
		tables: { posts },
	});

	// Synchronous creation
	const client = workspace.create({ sqlite });

	// Wait for SQLite to be ready
	await client.capabilities.sqlite.whenSynced;

	client.tables.posts.set({ id: '1', title: 'Hello' });

	// Verify SQLite materialization
	const rows = client.capabilities.sqlite.db.select().from(postsTable).all();

	expect(rows).toHaveLength(1);

	await client.destroy();
});
```

---

## Migration from Current API

### From `createTableHelpers`

```typescript
// Before
const tableHelpers = createTableHelpers({ ydoc, tableDefinitions });
tableHelpers.posts.upsert({ id: '1', title: 'Hi' });

// After
const tables = createTables(ydoc, { posts });
tables.posts.set({ id: '1', title: 'Hi', _v: '1' });
```

### From Current Workspace API

```typescript
// Before (if using old patterns)
const client = await workspace.withCapabilities({ sqlite }).create();

// After (synchronous creation)
const client = workspace.create({ sqlite });
await client.capabilities.sqlite.whenSynced; // If you need to wait
```

---

## Open Questions

### 1. Naming: "static" or something else?

**Current**: `epicenter/static`

**Concern**: "Static" might imply compile-time only, but workspaces are created at runtime.

**Alternatives**:

- `epicenter/schema` - Emphasizes schema-defined
- `epicenter/typed` - Emphasizes type safety
- Just `epicenter` - If this is the main/default API

**Decision**: Keep `epicenter/static` for now. Can revisit later.

---

### 2. Synchronous workspace creation with async lifecycle

**Decision**: `workspace.create()` is **synchronous**. Capabilities handle async work via lifecycle exports.

```typescript
// Synchronous creation
const client = workspace.create({
	sqlite,
	persistence,
});

// Capabilities return whenSynced for async lifecycle
await client.capabilities.persistence.whenSynced;
await client.capabilities.sqlite.whenSynced;

// Or wait for all capabilities
await Promise.all([
	client.capabilities.persistence.whenSynced,
	client.capabilities.sqlite.whenSynced,
]);
```

**Why synchronous construction?**

- Simpler mental model
- Client is immediately usable (reads/writes work, just may not be synced yet)
- Follows "sync construction, async property" pattern (see `.claude/skills/sync-construction-async-property-ui-render-gate-pattern/`)
- UI can render immediately, then show loading state while waiting for sync

**Capability lifecycle exports (REQUIRED):**

All capabilities MUST return an object satisfying the `Lifecycle` protocol from `core/lifecycle.ts`:

```typescript
type Lifecycle = {
	whenSynced: Promise<unknown>; // REQUIRED: Resolves when capability is fully initialized
	destroy: () => MaybePromise<void>; // REQUIRED: Cleanup on workspace destroy
};

// Capability factory type enforces Lifecycle
type CapabilityFactory<TExports extends Lifecycle = Lifecycle> = (
	context: CapabilityContext,
) => TExports;
```

Use `defineExports()` from `core/lifecycle.ts` to create compliant exports with sensible defaults:

```typescript
import { defineExports } from 'epicenter';

// Simple capability (no async, no cleanup)
const simple: CapabilityFactory = () => defineExports();
// → { whenSynced: Promise.resolve(), destroy: () => {} }

// Capability with async initialization
const withAsync: CapabilityFactory = ({ ydoc }) => {
	const provider = new SomeProvider(ydoc);
	return defineExports({
		whenSynced: provider.connected,
		destroy: () => provider.disconnect(),
	});
};

// Capability with additional exports
const withExports: CapabilityFactory<{ db: Database } & Lifecycle> = () => {
	const db = new Database(':memory:');
	return defineExports({
		db,
		whenSynced: db.initialize(),
		destroy: () => db.close(),
	});
};
```

---

### 3. Single version tables (no migration)

**Decision**: Implemented shorthand syntax for single-version definitions.

When there's only one version, you can pass the schema directly:

```typescript
// Shorthand (single version)
const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number', _v: '1' }));
```

The shorthand:

- Accepts a schema directly as the first argument
- Creates an identity migration function automatically
- Produces equivalent output to the builder pattern
- Works with any Standard Schema v1 compliant schema

Use the builder pattern when you need multiple versions with custom migration logic.

---

### 4. KV default values

**Decision**: Use the validator's built-in default support. No separate `.default()` method needed.

ArkType (and other Standard Schema libraries) support default values:

```typescript
import { type } from 'arktype';

// ArkType: Use '=' for defaults
const theme = defineKv()
	.version(
		type({
			mode: "'light' | 'dark' = 'light'",
			fontSize: 'number = 14',
		}),
	)
	.migrate((v) => v);

// Zod: Use .default()
const theme = defineKv()
	.version(
		z.object({
			mode: z.enum(['light', 'dark']).default('light'),
			fontSize: z.number().default(14),
		}),
	)
	.migrate((v) => v);
```

**How it works:**

- On read, if value is `not_found`, return `{ status: 'not_found' }`
- App code decides whether to use schema defaults or handle missing state differently
- Schema defaults are applied during validation, so partial data gets filled in

```typescript
const result = kv.get('theme');
if (result.status === 'not_found') {
	// First time - set initial value (schema defaults will apply)
	kv.set('theme', { mode: 'light' }); // fontSize: 14 applied by schema default
}
```

---

### 5. Schema library examples

**Decision**: Include examples for all major Standard Schema libraries.

```typescript
// ════════════════════════════════════════════════════════════════════
// ArkType (recommended - best TypeScript inference)
// ════════════════════════════════════════════════════════════════════
import { type } from 'arktype';

const posts = defineTable()
	.version(type({ id: 'string', title: 'string' }))
	.version(type({ id: 'string', title: 'string', views: 'number' }))
	.migrate((row) => {
		if (!('views' in row)) return { ...row, views: 0 };
		return row;
	});

// ════════════════════════════════════════════════════════════════════
// Zod
// ════════════════════════════════════════════════════════════════════
import { z } from 'zod';

const posts = defineTable()
	.version(z.object({ id: z.string(), title: z.string() }))
	.version(z.object({ id: z.string(), title: z.string(), views: z.number() }))
	.migrate((row) => {
		if (!('views' in row)) return { ...row, views: 0 };
		return row;
	});

// ════════════════════════════════════════════════════════════════════
// Valibot
// ════════════════════════════════════════════════════════════════════
import * as v from 'valibot';

const posts = defineTable()
	.version(v.object({ id: v.string(), title: v.string() }))
	.version(v.object({ id: v.string(), title: v.string(), views: v.number() }))
	.migrate((row) => {
		if (!('views' in row)) return { ...row, views: 0 };
		return row;
	});

// ════════════════════════════════════════════════════════════════════
// TypeBox
// ════════════════════════════════════════════════════════════════════
import { Type } from 'typebox';

const posts = defineTable()
	.version(Type.Object({ id: Type.String(), title: Type.String() }))
	.version(
		Type.Object({
			id: Type.String(),
			title: Type.String(),
			views: Type.Number(),
		}),
	)
	.migrate((row) => {
		if (!('views' in row)) return { ...row, views: 0 };
		return row;
	});
```

All libraries work because `defineTable().version()` accepts any Standard Schema v1 compliant schema.

---

### 6. The `id` parameter format

**Current**: `id: 'epicenter.whispering'`

**Used for**:

- Y.Doc guid (unless overridden)
- Capability storage paths (e.g., `~/.epicenter/{id}/`)
- Provider connection identifiers
- Debugging/logging

**Format restrictions**:

- Must be a valid file path segment (no `/`, `\`, `:`, etc.)
- Recommended: lowercase, dots or hyphens for namespacing
- Examples: `myapp.workspace`, `blog-posts`, `user-123-settings`

---

### 7. Error scenarios

**Migration throws:**

```typescript
.migrate((row) => {
  if (row._v === '1') throw new Error('Cannot migrate v1');
  return row;
});
```

On read, if migration throws:

- Return `{ status: 'invalid', error: MigrationError }`
- Do NOT crash the app
- Row is accessible via `getAllInvalid()` for debugging

**Invalid data on write:**

- Writes are NOT validated (performance)
- Trust the TypeScript types
- Invalid data will fail on next read

**Validation fails on read:**

- Return `{ status: 'invalid', errors: readonly StandardSchemaV1.Issue[] }`
- Original data accessible via `result.row` (untyped)

---

### 8. Conflict resolution (LWW)

Row-level Last-Writer-Wins behavior:

```
Client A: set({ id: '1', title: 'A', views: 10 }) at t=1
Client B: set({ id: '1', title: 'B', views: 20 }) at t=2

After sync: { id: '1', title: 'B', views: 20 }  // B wins entirely
```

**Important**: This is different from cell-level CRDT (where A's views and B's title could both win). Entire row is atomic.

See `specs/20260125T120000-versioned-table-kv-specification.md` for why this tradeoff is made (enables schema versioning).

---

### 9. Where do Grids live?

Grids (cell-level dynamic tables) are a separate concept. Options:

| Option | Location                           | Pros                   | Cons                      |
| ------ | ---------------------------------- | ---------------------- | ------------------------- |
| A      | `epicenter/grid`                   | Clear separation       | Another import path       |
| B      | Separate package `@epicenter/grid` | Independent versioning | More packages to maintain |
| C      | Same package, different export     | Single install         | Might confuse users       |

**Recommendation**: Option A (`epicenter/grid`) - keeps them together but clearly separated.

---

### 10. Result type definitions

```typescript
// Table read results - building blocks
type ValidRowResult<TRow> = { status: 'valid'; row: TRow };

type InvalidRowResult = {
	status: 'invalid';
	id: string;
	errors: readonly StandardSchemaV1.Issue[];
	row: unknown;
};

type NotFoundResult = { status: 'not_found'; id: string };

// Table read results - composed
type RowResult<TRow> = ValidRowResult<TRow> | InvalidRowResult;

type GetResult<TRow> = RowResult<TRow> | NotFoundResult;

// delete() returns void: fire-and-forget, matches Y.Map.delete() semantics

// KV results
type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| {
			status: 'invalid';
			errors: readonly StandardSchemaV1.Issue[];
			value: unknown;
	  }
	| { status: 'not_found' };
```

---

### 11. Version discriminator (`_v`)

The `_v` field shown in examples is **recommended but optional**:

```typescript
// Recommended: explicit version field
.version(type({ id: 'string', title: 'string', _v: '"1"' }))
.version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
.migrate((row) => {
  if (row._v === '1') return { ...row, views: 0, _v: '2' as const };
  return row;
});

// Also works: no version field (check field presence)
.version(type({ id: 'string', title: 'string' }))
.version(type({ id: 'string', title: 'string', views: 'number' }))
.migrate((row) => {
  if (!('views' in row)) return { ...row, views: 0 };
  return row;
});
```

See `specs/20260125T120000-versioned-table-kv-specification.md` for detailed rationale.

---

### 12. KV schema best practices

**Recommendation**: KV values should use object syntax with a version discriminant, just like tables.

Even for simple values, wrapping in an object with a `_v` field enables future schema evolution:

```typescript
// ✓ Recommended: object with version discriminant
const theme = defineKv(
	type({
		mode: "'light' | 'dark'",
		_v: '"1"',
	}),
);

// Later, can evolve to:
const theme = defineKv()
	.version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
	.version(
		type({
			mode: "'light' | 'dark' | 'system'",
			fontSize: 'number',
			_v: '"2"',
		}),
	)
	.migrate((v) => {
		if (v._v === '1')
			return {
				...v,
				mode: v.mode === 'dark' ? 'dark' : 'light',
				fontSize: 14,
				_v: '2' as const,
			};
		return v;
	});
```

**Why not primitive values?**

```typescript
// ✗ Avoid: primitive value
const fontSize = defineKv(type('number')); // Just stores 14

// Problem: How do you migrate from number to { size: number, unit: 'px' | 'rem' }?
// There's no version field to check.
```

**Benefits of object syntax:**

1. **Explicit versioning**: `_v` field makes version detection reliable
2. **Future-proof**: Can always add fields without breaking migrations
3. **Consistent pattern**: Same approach for tables and KV reduces cognitive load
4. **Debugging**: Easier to inspect stored data and understand its schema version

**Naming convention**: Use `_v` with string literal types (`'"1"'`, `'"2"'`, etc.) for consistency with tables.

---

## TODO

- [x] Implement `defineTable()` with TypeScript inference
- [x] Implement `defineKv()` with TypeScript inference
- [x] Implement `defineWorkspace()` and `workspace.create()`
- [x] Implement `createTables()` with YKeyValue storage
- [x] Implement `createKv()` with YKeyValue storage
- [x] Implement Standard Schema union validation
- [x] Add comprehensive tests for migration scenarios
- [x] Update package exports
- [ ] Write migration guide for existing users

---

## Implementation Review

### Completed: 2026-01-26

Implementation completed in branch `feat/static-workspace-api` with 11 commits.

### File Structure

```
packages/epicenter/src/static/
├── index.ts           # Public exports
├── types.ts           # All shared types (GetResult, RowResult, TableDefinition, etc.)
├── schema-union.ts    # createUnionSchema()
├── define-table.ts    # defineTable() builder
├── define-kv.ts       # defineKv() builder
├── table-helper.ts    # TableHelper implementation (CRUD operations)
├── create-tables.ts   # createTables() factory
├── create-kv.ts       # createKv() factory + KvHelper implementation (get/set/observe)
├── define-workspace.ts # defineWorkspace() + workspace.create()
└── *.test.ts          # Per-module test files
```

### Key Implementation Details

1. **Schema Union Validation** (`schema-union.ts`)
   - `createUnionSchema()` creates a Standard Schema v1 compliant union
   - Tries each schema in order until one validates
   - Only supports synchronous schemas (throws TypeError for async)

2. **Table Storage** (`create-tables.ts`)
   - Each table stored in `table:{tableName}` Y.Array
   - Uses existing `YKeyValue` class from `core/utils/y-keyvalue.ts`
   - Bounded memory via append-and-cleanup strategy

3. **KV Storage** (`create-kv.ts`)
   - All KV values stored in shared `kv` Y.Array
   - Each key is a separate entry in the YKeyValue store

4. **Workspace Client** (`define-workspace.ts`)
   - Synchronous construction (no await needed)
   - Capabilities receive `{ ydoc, tables, kv }` context
   - `destroy()` calls capability destroy functions in reverse order
   - Supports `Symbol.asyncDispose` for `await using` syntax

### Test Coverage

92 tests across 7 test files:

- **schema-union.test.ts** (4 tests): First match, second match, no match, async rejection
- **define-table.test.ts** (9 tests): Shorthand syntax, builder syntax, schema patterns with/without `_v`
- **define-kv.test.ts** (10 tests): Shorthand syntax, builder syntax, schema patterns
- **create-tables.test.ts** (14 tests): CRUD operations, migration scenarios
- **create-kv.test.ts** (4 tests): set/get/delete, not_found handling, migration on read
- **define-workspace.test.ts** (6 tests): Creation, client access, capabilities, destroy, empty workspace
- **table-helper.test.ts** (45 tests): Comprehensive unit tests for TableHelper
  - Set operations (single, batch, overwrite)
  - Get operations (valid, invalid, not_found, getAllValid, getAllInvalid)
  - Query operations (filter, find with predicates, invalid row handling)
  - Delete operations (single, batch, mixed batch, clear)
  - Observer pattern (callbacks, batch notifications, unsubscribe)
  - Metadata operations (count, has)
  - Migration (old data, current version passthrough)

### Deviations from Spec

1. **`find()` returns `undefined` instead of `null`**: More idiomatic TypeScript
2. **No `name` parameter in `defineTable()`/`defineKv()`**: The spec showed optional name parameter but implementation doesn't require it (name comes from the key in the definition map)

### Remaining Work

- Migration guide for existing users (deferred to separate PR)

---

## Update: 2026-01-27 - Capability Lifecycle and Schema-Generic Design

### Design Decision: Schema-Generic Capabilities

We chose the **schema-generic factory** pattern for capabilities. This means:

1. Capabilities are defined without knowing the specific workspace schema
2. The workspace binds the specific table/kv types when `workspace.create()` is called
3. `InferCapabilityExports` only needs ONE generic parameter

### Why Schema-Generic? (Variance Explanation)

The alternative (capabilities parameterized by table/kv types) creates a **contravariance problem**:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        TYPE FLOW DIRECTION                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   COVARIANT (OUT) = "Produces" = Can infer FROM                          │
│   ────────────────────────────────────────────►                          │
│                                                                          │
│   CONTRAVARIANT (IN) = "Consumes" = CANNOT infer FROM                    │
│   ◄────────────────────────────────────────────                          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

CapabilityFactory signature:
   (context: CapabilityContext<TTableDefs, TKvDefs>) => TExports
         ▲                                               │
         │                                               │
   CONTRAVARIANT (IN)                              COVARIANT (OUT)
   Cannot infer TTableDefs                         Can infer TExports
```

If `TTableDefs` appears in a function **parameter** (contravariant), you can't infer it reliably. The schema-generic approach sidesteps this by making the factory generic at the call site.

### Changes Made

1. **Capability Lifecycle Enforcement**

   All capabilities MUST return an object satisfying the `Lifecycle` protocol:

   ```typescript
   type Lifecycle = {
	whenSynced: Promise<unknown>; // REQUIRED
	destroy: () => MaybePromise<void>; // REQUIRED
   };
   ```

2. **Schema-Generic CapabilityFactory**

   Capabilities are generic at the call site, not at definition:

   ```typescript
   // CapabilityFactory is generic over exports only
   export type CapabilityFactory<TExports extends Lifecycle = Lifecycle> = <
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
   >(
	context: CapabilityContext<TTableDefinitions, TKvDefinitions>,
   ) => TExports;
   ```

3. **Simplified CapabilityMap and InferCapabilityExports**

   ```typescript
   // Map is simple - no schema generics needed
   export type CapabilityMap = Record<string, CapabilityFactory<Lifecycle>>;

   // InferCapabilityExports only needs TCapabilities!
   export type InferCapabilityExports<TCapabilities extends CapabilityMap> = {
	[K in keyof TCapabilities]: TCapabilities[K] extends CapabilityFactory<
		infer TExports
	>
		? TExports
		: Lifecycle;
   };
   ```

### Usage Example

```typescript
import { defineWorkspace, defineTable, defineExports } from 'epicenter/static';
import type { CapabilityFactory } from 'epicenter/static';
import { type } from 'arktype';

// Define workspace with typed tables
const posts = defineTable(
	type({ id: 'string', title: 'string', views: 'number' }),
);
const workspace = defineWorkspace({
	id: 'blog',
	tables: { posts },
	kv: {},
});

// Capability is schema-generic - works with ANY workspace
const persistence: CapabilityFactory<
	{ provider: IndexeddbPersistence } & Lifecycle
> = ({ ydoc }) => {
	const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
	return defineExports({
		provider,
		whenSynced: provider.whenSynced,
		destroy: () => provider.destroy(),
	});
};

// When passed to workspace.create(), context.tables is typed!
const client = workspace.create({ persistence });

// Wait for capability to be ready
await client.capabilities.persistence.whenSynced;

// Cleanup
await client.destroy();
```

### Benefits

1. **Simple Inference**: `InferCapabilityExports` needs only ONE generic
2. **Reusable Capabilities**: Same capability works with any workspace
3. **No Variance Issues**: Avoids contravariance problems entirely
4. **Full Type Safety**: Context is still fully typed at the call site
5. **Lifecycle Guarantees**: Framework can reliably call `whenSynced` and `destroy` on all capabilities
6. **Consistent Pattern**: Same lifecycle protocol used by extensions in `core/docs/workspace-doc.ts`
