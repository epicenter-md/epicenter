# Table-Level Document API (`.withDocument()` + `createDocumentBinding()`)

> **Note**: The `.docs` access pattern described here was replaced by `client.documents`: see specs/20260221T204200-documents-top-level-namespace.md

**Date**: 2026-02-17
**Status**: Design in progress (v2: revised from document handle to document binding)

## Problem

Content doc stores. Where a table column stores a GUID referencing a separate Y.Doc: are defined and wired manually, outside the workspace schema. The `ContentDocStore` type lives in `packages/filesystem/`, created via `createContentDocStore()`, and requires manual wiring between "I wrote to this doc" and "bump the `updatedAt` column on the corresponding row."

This means:

1. **Manual wiring**: Every app must create and manage the store separately from the workspace.
2. **No type safety**: Nothing connects `id` to "document reference" or `updatedAt` to "bump on change."
3. **Lifecycle fragmentation**: Workspace `destroy()` and content doc `destroyAll()` are separate.
4. **No automatic `updatedAt` bumping**: Apps must manually track when content docs change and update the corresponding row.
5. **No row deletion cleanup**: When a row is deleted, its content doc is orphaned: providers keep running, persistence is never cleaned up.
6. **Not reusable**: New apps with document-backed tables must reimplement from scratch.

## Overview

The design has three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  defineTable().withDocument('content', { guid, updatedAt })     │
│  ↓ pure declaration, no runtime, no side effects               │
├─────────────────────────────────────────────────────────────────┤
│  createDocumentBinding({ ... })                                 │
│  ↓ runtime: creates the bidirectional binding                  │
│  ↓ standalone function, usable without createWorkspace()        │
├─────────────────────────────────────────────────────────────────┤
│  createWorkspace(): wires everything automatically             │
│  ↓ reads .withDocument() from table defs                        │
│  ↓ collects onDocumentOpen from extensions as provider factories    │
│  ↓ calls createDocumentBinding() internally                     │
│  ↓ attaches result under .docs on the table helper              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decision: Definition-Time API

### `.withDocument()` chained on `defineTable()`: named, chainable

Each `.withDocument()` call declares one **document binding** with a **name**, a **guid** column (stores the Y.Doc GUID), and an **updatedAt** column (tracks modification time). The name is always required. It becomes a property under `.docs` on the table helper at runtime (e.g., `table.docs.content`). A table can chain multiple `.withDocument()` calls.

The name is a "phantom key". It does not exist as a column in the schema. It groups two real columns (the GUID reference and the modification timestamp) under a single named concept.

```typescript
// Single doc per table (filesystem case)
const filesTable = defineTable(
	type({ id: FileId, name: 'string', updatedAt: 'number', _v: '1' }),
).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

// Multiple docs per table
const notesTable = defineTable(
	type({
		id: 'string',
		bodyDocId: 'string',
		coverDocId: 'string',
		bodyUpdatedAt: 'number',
		coverUpdatedAt: 'number',
		_v: '1',
	}),
)
	.withDocument('body', { guid: 'bodyDocId', updatedAt: 'bodyUpdatedAt' })
	.withDocument('cover', { guid: 'coverDocId', updatedAt: 'coverUpdatedAt' });

// Table without docs: unchanged
const tagsTable = defineTable(type({ id: 'string', label: 'string', _v: '1' }));

// Multi-version table with doc
const posts = defineTable(
	type({ id: 'string', docId: 'string', modifiedAt: 'number', _v: '1' }),
).withDocument('content', { guid: 'docId', updatedAt: 'modifiedAt' });
```

### Why this approach

| Criteria                | Assessment                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type safety**         | Post-schema, TypeScript knows all column names. `guid` and `updatedAt` are constrained to `keyof SchemaOutput & string`. Autocomplete works. |
| **Co-location**         | Doc binding lives with the table definition, next to the columns it references.                                                              |
| **Portability**         | Move a table to another workspace: doc bindings come with it.                                                                               |
| **Multiple docs**       | Chain `.withDocument()` multiple times. Each call adds a named binding.                                                                      |
| **Consistency**         | `defineTable` already has `.version().migrate()`. `.withDocument()` extends the builder naturally.                                           |
| **No breaking changes** | `defineWorkspace` unchanged. Tables without `.withDocument()` unchanged.                                                                     |

### `.withDocument()` signature

```typescript
.withDocument<TName extends string>(
  name: TName,
  binding: {
    /** Column storing the Y.Doc GUID. Must be a string column. */
    guid: StringKeysOf<LatestRow>;
    /** Column to bump when the doc changes. Must be a number column. */
    updatedAt: NumberKeysOf<LatestRow>;
  }
)
```

Both `guid` and `updatedAt` are always required, no defaults. This avoids silent wrong behavior when a table has multiple string or number columns.

### Naming decisions

| Decision                             | Choice            | Reasoning                                                                                                                 |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Method name**                      | `.withDocument()` | Clarity over brevity. Definition-time API written once per table.                                                         |
| **GUID binding key**                 | `guid`            | Matches Yjs terminology (`new Y.Doc({ guid })`). Aligns with existing `Guid` branded type in the codebase.                |
| **Timestamp binding key**            | `updatedAt`       | Universal convention. Describes exactly what the column tracks.                                                           |
| **Name required?**                   | Always            | The name becomes the `.docs` property key. No unnamed/default docs.                                                       |
| **Defaults for `guid`/`updatedAt`?** | None              | Every table has an `id` column, so defaulting `guid` to `'id'` would silently succeed even when wrong. Explicit is safer. |

### Type-level design

```typescript
type DocBinding<TGuid extends string, TUpdatedAt extends string> = {
	guid: TGuid;
	updatedAt: TUpdatedAt;
};

// TableDefinition gains an optional TDocs parameter (default: empty)
type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<{
		id: string;
		_v: number;
	}>[],
	TDocs extends Record<string, DocBinding<string, string>> = Record<
		string,
		never
	>,
> = {
	schema: CombinedStandardSchema;
	migrate: (row: VersionUnion) => LatestRow;
	docs: TDocs;
};

// .withDocument() accumulates into TDocs:
// Before: TableDefinition<V, {}>
// After .withDocument('content', { guid: 'id', updatedAt: 'updatedAt' }):
//   TableDefinition<V, { content: DocBinding<'id', 'updatedAt'> }>
// After another .withDocument('cover', ...):
//   TableDefinition<V, { content: ..., cover: DocBinding<'coverDocId', 'coverUpdatedAt'> }>
```

---

## Decision: Runtime: `createDocumentBinding()` as a Standalone Factory

### The shift from the original design

The original spec proposed a `DocumentHandle`: an object with `ensure`/`destroy` methods that lived as a property on the table helper. This was a one-directional API: you ask for a doc, you get a doc.

The revised design is a **document binding**: a bidirectional link between a table row and its content Y.Doc. The binding:

1. Provides methods to interact with the document (`open`, `read`, `write`)
2. **Watches content docs → automatically bumps `updatedAt` on the row** when the document changes
3. **Watches the table → automatically cleans up documents** when rows are deleted
4. Manages Y.Doc creation and provider lifecycle for each content doc

### Why a standalone function

The codebase follows a consistent pattern: `define*` = pure declaration, `create*` = runtime instantiation. `createDocumentBinding()` follows this pattern. It's a lower-level escape hatch, like `createTables()` and `createKv()`:

- Most users never call it directly (they use `createWorkspace()` which wires it automatically)
- Advanced users who have a shared Y.Doc or need control can use it standalone

### `createDocumentBinding()` signature

```typescript
function createDocumentBinding<
	TRow extends { id: string; _v: number },
>(config: {
	/** Column name storing the Y.Doc GUID. */
	guidKey: StringKeysOf<TRow>;
	/** Column name to bump when the doc changes. */
	updatedAtKey: NumberKeysOf<TRow>;
	/** The table helper: needed to bump updatedAt and observe row deletions. */
	tableHelper: TableHelper<TRow>;
	/** Provider factories for each content doc (persistence, sync, etc.). */
	providerFactories?: ProviderFactory[];
	/**
	 * Called when a row is deleted from the table.
	 * Receives the GUID of the associated document.
	 * Default: destroy (free memory, preserve persisted data).
	 */
	onRowDeleted?: (this: DocumentBinding<TRow>, guid: string) => void;
}): DocumentBinding<TRow>;
```

### `DocumentBinding<TRow>`: the returned object

```typescript
type DocumentBinding<TRow extends { id: string; _v: number }> = {
	/**
	 * Open a content Y.Doc for a row.
	 *
	 * Creates the Y.Doc if it doesn't exist, wires up providers, and attaches
	 * the updatedAt observer. Idempotent: calling open() twice for the same
	 * row returns the same Y.Doc.
	 *
	 * The returned Y.Doc is fully hydrated (providers have loaded).
	 *
	 * @param input - A row (extracts GUID from the bound column) or a GUID string
	 */
	open(input: TRow): Promise<Y.Doc>;
	open(input: string): Promise<Y.Doc>;

	/**
	 * Read document content as plain text.
	 *
	 * Convenience method: opens the doc (if not already open) and reads
	 * the text content. For domain-specific reading (binary, richtext,
	 * spreadsheet), use open() and work with the Y.Doc directly.
	 *
	 * @param input - A row or GUID string
	 */
	read(input: TRow): Promise<string>;
	read(input: string): Promise<string>;

	/**
	 * Write plain text to a document.
	 *
	 * Convenience method: opens the doc (if not already open) and replaces
	 * the text content. The updatedAt observer fires automatically.
	 * For domain-specific writing, use open() and work with the Y.Doc directly.
	 *
	 * @param input - A row or GUID string
	 * @param text - The text content to write
	 */
	write(input: TRow, text: string): Promise<void>;
	write(input: string, text: string): Promise<void>;

	/**
	 * Destroy a document: free memory, disconnect providers.
	 * Persisted data is NOT deleted. The doc can be re-opened later.
	 *
	 * Same semantics as workspace `destroy()`: tear down runtime, keep data.
	 *
	 * @param input - A row or GUID string
	 */
	destroy(input: TRow): Promise<void>;
	destroy(input: string): Promise<void>;

	/**
	 * Purge a document: destroy AND delete all persisted data.
	 * This is permanent. The document cannot be recovered.
	 *
	 * Calls clearData() on providers that support it. Providers without
	 * clearData are simply destroyed (memory freed, data preserved).
	 *
	 * @param input - A row or GUID string
	 */
	purge(input: TRow): Promise<void>;
	purge(input: string): Promise<void>;

	/**
	 * Destroy all open documents. Called automatically by workspace destroy().
	 * Not typically called by user code directly.
	 */
	destroyAll(): Promise<void>;

	/** Extract the GUID from a row (reads the bound guid column). */
	guidOf(row: TRow): string;

	/** Extract the updatedAt value from a row (reads the bound updatedAt column). */
	updatedAtOf(row: TRow): number;
};
```

### The three primary methods: `open`, `read`, `write`

All three go through the same path: ensure the Y.Doc exists, wire providers, attach the `updatedAt` observer.

```typescript
const content = client.tables.files.docs.content;

// open(): raw Y.Doc access for full control
const doc = await content.open(row);
doc.getText('body').insert(0, 'hello');
// updatedAt observer fires → row.updatedAt bumped automatically

// read(): convenience, returns text
const text = await content.read(row);

// write(): convenience, replaces text
await content.write(row, 'hello world');
// updatedAt observer fires → row.updatedAt bumped automatically
```

`read()` and `write()` are plain-text operations. For domain-specific content (binary, richtext, spreadsheets, timeline modes), use `open()` and work with the Y.Doc directly. Apps can build their own wrappers on top. The same way `ContentOps` wraps `createContentDocStore` today with `readAsString()`, `readAsBuffer()`, `pushText()`, etc.

### Internal state: why an in-memory map is necessary

The binding maintains an internal `Map<string, DocEntry>`. This is an **implementation detail**: users don't interact with it. The map exists for three reasons:

1. **Idempotency**: `open('abc')` called twice must return the same Y.Doc. Creating two Y.Docs with the same GUID produces two separate in-memory objects that diverge before providers can reconcile: that's broken.
2. **Observer tracking**: Each open doc has an `updatedAt` observer. The map tracks these so they can be removed on `destroy()`.
3. **Provider tracking**: Each open doc has its own providers (persistence, sync). The map tracks these for `destroy()` (disconnect) and `purge()` (clearData + disconnect).

```typescript
type DocEntry = {
	ydoc: Y.Doc;
	lifecycles: DocumentLifecycle[];
	unobserve: () => void; // removes the updatedAt observer
	whenReady: Promise<Y.Doc>;
};
```

`destroyAll()` iterates the map and destroys each doc. It exists for workspace lifecycle (called by `client.destroy()`), not for direct user use.

### Full usage examples

```typescript
const client = createWorkspace(workspace)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('sync', createSyncExtension({ url: 'ws://...' }));

// ── Single doc table ────────────────────────────────────────
const result = client.tables.files.get(fileId);
if (result.status === 'valid') {
	// Open the Y.Doc: providers are wired, updatedAt observer is attached
	const ydoc = await client.tables.files.docs.content.open(result.row);

	// Work with it directly
	ydoc.getText('body').insert(0, 'hello');
	// → updatedAt on the row is bumped automatically

	// Or use convenience methods
	const text = await client.tables.files.docs.content.read(result.row);
	await client.tables.files.docs.content.write(result.row, 'new content');
}

// ── Multi-doc table ─────────────────────────────────────────
const note = client.tables.notes.get(noteId);
if (note.status === 'valid') {
	const bodyDoc = await client.tables.notes.docs.body.open(note.row);
	const coverDoc = await client.tables.notes.docs.cover.open(note.row);
}

// ── GUID-only access (no row needed) ────────────────────────
const ydoc = await client.tables.files.docs.content.open(fileId);

// ── Destructure for reuse ───────────────────────────────────
const { content } = client.tables.files.docs;
const ydoc1 = await content.open(id1);
const ydoc2 = await content.open(id2);

// ── Explicitly destroy (free memory, keep persisted data) ───
await content.destroy(id1);

// ── Row deletion triggers automatic cleanup ─────────────────
client.tables.files.delete(fileId);
// → binding's table observer fires
// → onRowDeleted callback runs (default: destroy)

// ── Table without docs: .docs is undefined ─────────────────
client.tables.tags.docs; // ← TypeScript error: property 'docs' does not exist
```

### Standalone usage (without `createWorkspace()`)

```typescript
import { createDocumentBinding, createTables } from '@epicenter/workspace/static';

const ydoc = new Y.Doc({ guid: 'my-workspace' });
const tables = createTables(ydoc, { files: filesTable });

const contentBinding = createDocumentBinding({
	guidKey: 'id',
	updatedAtKey: 'updatedAt',
	tableHelper: tables.files,
	providerFactories: [
		({ ydoc }) => {
			const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
			return { whenReady: idb.whenSynced, destroy: () => idb.destroy() };
		},
	],
	onRowDeleted(guid) {
		this.purge(guid);
	},
});

const doc = await contentBinding.open(someFileRow);
```

---

## Decision: Bidirectional Observation

The binding establishes two automatic observations:

### 1. Content doc → row `updatedAt` (auto-bump)

When a content Y.Doc changes (from any source: local edit, `write()`, or sync from another peer), the binding automatically updates the `updatedAt` column on the corresponding row.

```
Content Y.Doc changes
  → binding's ydoc.on('update') fires
  → tableHelper.update(rowId, { [updatedAtKey]: Date.now() })
  → row now reflects the latest modification time
```

This enables other parts of the app to observe the table and know when content has changed, without polling the Y.Doc directly.

#### Transaction origin tagging

The `updatedAt` bump is tagged with a specific transaction origin so table observers can distinguish it from user-initiated row changes:

```typescript
const DOCUMENT_BINDING_ORIGIN = Symbol('document-binding');

// Inside the binding, when bumping updatedAt:
workspaceYdoc.transact(() => {
	tableHelper.update(rowId, { [updatedAtKey]: Date.now() });
}, DOCUMENT_BINDING_ORIGIN);
```

This origin is exported so consumers can filter:

```typescript
client.tables.files.observe((changedIds, transaction) => {
	if (transaction.origin === DOCUMENT_BINDING_ORIGIN) {
		// This change was an updatedAt bump from a content doc edit.
		// React accordingly (e.g., update a "last modified" display).
		return;
	}
	// This was a direct row change (rename, move, etc.)
});
```

### 2. Row deletion → document cleanup

The binding observes the table for deletions and automatically triggers cleanup:

```
Row deleted from table
  → binding's tableHelper.observe() fires
  → tableHelper.get(id) returns not_found
  → onRowDeleted(guid) callback runs
  → default: destroy the document (free memory, preserve persisted data)
```

The `onRowDeleted` callback receives `this` bound to the binding itself, so it can call `this.destroy(guid)` or `this.purge(guid)`:

```typescript
// Default behavior (safe: preserves data for undo, sync, etc.)
onRowDeleted(guid) {
	this.destroy(guid);
}

// Aggressive behavior (purges persisted data: permanent)
onRowDeleted(guid) {
	this.purge(guid);
}

// Custom behavior (app-specific logic)
onRowDeleted(guid) {
	if (someCondition) {
		this.purge(guid);     // permanent delete
	} else {
		this.destroy(guid);   // soft delete, data survives
	}
}
```

### Why infinite loops are not a framework concern

The content Y.Doc and the workspace Y.Doc are **separate Y.Docs**. Changes to one do not trigger observers on the other:

```
Content Y.Doc changes → observer bumps updatedAt on workspace Y.Doc
                         ↑                                    │
                         │                                    ▼
                     (different doc)              workspace Y.Doc table
                         │                        observers fire
                         │                                    │
                         └────── does NOT write ──────────────┘
                                 back to content Y.Doc
```

The observation is one-directional at the framework level: content doc → row. The only way to create a loop is if **userland code** observes the table and writes back to the content doc. The transaction origin tag (`DOCUMENT_BINDING_ORIGIN`) lets userland code guard against this.

---

## Decision: `destroy()` vs `purge()`: Two Levels of Cleanup

Content documents need two distinct cleanup operations because CRDTs operate in distributed, collaborative environments where "delete" has nuance.

**Naming alignment**: `destroy()` here means the same thing as workspace `destroy()`: tear down the runtime, keep persisted data. This consistency is intentional. `purge()` is the escalation: it's the truly destructive operation that deletes persisted data permanently.

### `destroy(guid)`: free memory, preserve data

- Disconnects providers (stops sync, closes IndexedDB connections)
- Destroys the in-memory Y.Doc
- Removes the `updatedAt` observer
- Persisted data is **untouched** (IndexedDB entries, filesystem files, server-side state all remain)
- The document can be re-opened later: `open()` will reload from persistence

This is the safe default for row deletion because:

- **Undo**: User might undo the delete. If data was purged, undo has nothing to restore.
- **Sync**: Another device might still reference this row. CRDT merge needs the data.
- **Soft delete**: The row might have a `trashedAt` column (like `filesTable` does). Trashing shouldn't destroy content permanently.

### `purge(guid)`: destroy AND delete persisted data

- Everything from `destroy()`, PLUS
- Calls `clearData()` on each provider lifecycle that supports it
- Permanent: the document cannot be recovered

This uses a `DocumentLifecycle` type. An extension of the base `Lifecycle` with an optional `clearData` method. `clearData` is intentionally NOT on the base `Lifecycle` type because it's a destructive capability that only makes sense for per-document persistence, not workspace-level extensions.

```typescript
type DocumentLifecycle = Lifecycle & {
	/**
	 * Optional: delete all persisted data for this lifecycle.
	 * Called internally by the binding's purge() method: user code
	 * never calls clearData() directly.
	 * Providers that don't persist data can omit this.
	 */
	clearData?: () => MaybePromise<void>;
};
```

Not every provider needs `clearData()`. A sync provider might not have local data to clear. It just disconnects. An IndexedDB provider would delete the database entry. When `clearData()` is absent, the provider is simply destroyed (memory freed, data preserved).

### Purge without open: open-then-purge

If `purge(guid)` is called for a document that isn't currently in memory (not in the internal map), there are no provider lifecycles to call `clearData()` on. The binding handles this with **open-then-purge**: `purge()` internally calls `open()` first, waits for providers to initialize, then immediately calls `clearData()` and tears down.

```typescript
async purge(guid: string): Promise<void> {
	// Ensure the doc is open (wires providers, loads from persistence)
	await this.open(guid);

	const entry = docs.get(guid);
	if (!entry) return;

	// clearData first (while providers are still connected)
	await Promise.allSettled(
		entry.lifecycles
			.filter(l => l.clearData)
			.map(l => l.clearData!())
	);

	// Then tear down (same as destroy)
	await Promise.allSettled(entry.lifecycles.map(l => l.destroy()));
	entry.unobserve();
	entry.ydoc.destroy();
	docs.delete(guid);
}
```

This is correct and simple: one code path regardless of whether the doc was already open. The "waste" of loading data just to delete it is negligible (individual document blobs, not the whole database). If profiling later shows trash-emptying is slow, a static `purgeByGuid` method can be added to providers without changing the public API.

### When to use which

| Scenario                 | Operation               | Reasoning                                       |
| ------------------------ | ----------------------- | ----------------------------------------------- |
| User closes a tab/file   | `destroy()`             | Free memory, user might reopen                  |
| User moves file to trash | `destroy()`             | Soft delete: undo possible                     |
| User empties trash       | `purge()`               | Permanent: purge everything                    |
| Workspace shuts down     | `destroyAll()`          | Free all memory, data persists for next session |
| App-specific logic       | `onRowDeleted` callback | App decides based on its own semantics          |

---

## Decision: Runtime Access Pattern: `.docs` Sub-Namespace on Table Helper

Document bindings live under a **`.docs` property** on the table helper. Each binding name becomes a key inside `.docs`. This cleanly separates table CRUD methods (verbs) from document bindings (nouns): no naming conflicts possible.

```typescript
// CRUD (existing, unchanged):
client.tables.files.get(fileId);
client.tables.files.set(row);
client.tables.files.getAllValid();

// Document bindings (new, under .docs):
client.tables.files.docs.content.open(row);
client.tables.files.docs.content.read(row);
client.tables.files.docs.content.write(row, text);
client.tables.files.docs.content.destroy(row);
```

Tab-completing `client.tables.files.` shows table methods only. Tab-completing `client.tables.files.docs.` shows document bindings only:

```
// client.tables.files.
get, set, delete, clear, count, has, filter, find, observe, parse, docs, ...

// client.tables.files.docs.
content
```

### Why `.docs` instead of direct properties

The `.docs` namespace avoids an entire category of problems:

1. **Zero collision risk**: document binding names never conflict with current or future table method names. No reserved name list to maintain.
2. **Self-documenting**: `.docs` signals "these are document bindings" to someone reading code for the first time.
3. **Clean autocomplete**: table methods and document bindings are separated in IDE suggestions.
4. **Destructuring is equivalent**: `const { content } = client.tables.files.docs` is the same ergonomics as destructuring from the table directly.

Tables without `.withDocument()` don't have a `.docs` property at all: TypeScript errors if you try to access it.

### Table helper type with bindings

```typescript
type TablesHelperWithDocs<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	> &
		DocsPropertyOf<TTableDefinitions[K]>;
};

// DocsPropertyOf adds a `docs` property only when TDocs is non-empty:
type DocsPropertyOf<T> =
	T extends TableDefinition<infer V, infer TDocs>
		? keyof TDocs extends never
			? {} // no .withDocument() → no .docs property
			: {
					docs: {
						[K in keyof TDocs]: DocumentBinding<
							InferTableRow<TableDefinition<V>>
						>;
					};
				}
		: {};
```

### Patterns considered and rejected

| Pattern                           | Example                               | Why rejected                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct properties on table helper | `files.content.open(row)`             | Mixes nouns (binding names) with verbs (table methods) at the same level. Requires maintaining a `ReservedTableMethodNames` blocklist that grows over time. Naming a doc `"update"` or `"filter"` silently collides. |
| `.doc('name')` method             | `files.doc('content').open(row)`      | Indirection: returns something accessible as a property. Loses type-safe autocomplete on binding names.                                                                                                             |
| Top-level `client.docs`           | `client.docs.files.content.open(row)` | Disconnects doc access from the table. Can't destructure a table and get both CRUD and docs.                                                                                                                         |
| Row enrichment                    | `row.content.open()`                  | See [Appendix: Row Enrichment Evaluation](#appendix-row-enrichment-evaluation).                                                                                                                                      |

---

## Decision: Document Provider Wiring: `onDocumentOpen` on Extension

### Problem

Content docs need persistence and sync, just like the workspace doc. The core question: **where does the developer configure persistence and sync for content docs?**

### How we arrived at the answer

| Approach                          | Concepts to learn                   | Why rejected                                              |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| `.withDocumentProvider()`         | Extensions + Document Providers (2) | Developer says "persistence" and "sync" twice. Redundant. |
| "Layers" replace extensions       | Layers (1 new, replaces extensions) | Replaces a well-understood concept for no gain.           |
| Separate `.persist()` / `.sync()` | Persist + Sync + Extensions (3)     | Hardcodes infrastructure into the API.                    |
| **`onDocumentOpen` on Extension** | **Extensions (1, same as today)**   | **Winner. Zero new concepts.**                            |

### The design: `onDocumentOpen` on Extension

Extensions gain one optional field: `onDocumentOpen`. If present, the framework calls it whenever `open()` creates a new content Y.Doc. If absent, the extension is workspace-only. The developer writes **zero extra lines**: content docs automatically get persistence + sync from the same extensions that handle the workspace doc.

#### Extension type change

```typescript
type Extension<T extends Record<string, unknown> = Record<string, never>> = {
	exports?: T;
	whenReady?: Promise<unknown>;
	destroy?: () => MaybePromise<void>;

	/**
	 * Optional handler for content Y.Docs created by open().
	 *
	 * Called synchronously when a document binding's open() creates a new Y.Doc.
	 * Returns lifecycle hooks for this specific content doc.
	 * The framework iterates extensions in chain order: ordering is automatic.
	 */
	onDocumentOpen?: (context: DocumentContext) => DocumentLifecycle | void;
};
```

#### `DocumentContext` type

```typescript
type DocumentContext = {
	/** The content Y.Doc being created. */
	ydoc: Y.Doc;

	/**
	 * Composite whenReady of all PRIOR extensions' onDocumentOpen results.
	 * Named `whenReady` for consistency with `client.whenReady`: same
	 * pattern: the extension decides whether to await it or ignore it.
	 */
	whenReady: Promise<void>;

	/**
	 * Which table + binding this doc belongs to.
	 * Enables per-binding behavior (e.g., skip sync for cover images).
	 */
	binding: {
		tableName: string;
		documentName: string;
	};
};
```

#### What extension authors write

```typescript
// IndexedDB persistence: handles workspace AND content docs
function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }): Extension {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return {
		exports: { clearData: () => idb.clearData() },
		whenReady: idb.whenSynced,
		destroy: () => idb.destroy(),

		onDocumentOpen({ ydoc: contentDoc }) {
			const docIdb = new IndexeddbPersistence(contentDoc.guid, contentDoc);
			return {
				whenReady: docIdb.whenSynced,
				destroy: () => docIdb.destroy(),
				clearData: () => docIdb.clearData(),
			};
		},
	};
}

// Sync: handles workspace AND content docs
function createSyncExtension(config: { url: string }): ExtensionFactory {
	return (client) => {
		const provider = createSyncProvider({ doc: client.ydoc, url: config.url });
		return {
			exports: { provider },
			whenReady: client.whenReady.then(() => provider.connect()),
			destroy: () => provider.destroy(),

			onDocumentOpen({ ydoc: contentDoc, whenReady }) {
				const docProvider = createSyncProvider({
					doc: contentDoc,
					url: config.url,
				});
				return {
					whenReady: whenReady.then(() => docProvider.connect()),
					destroy: () => docProvider.destroy(),
					// No clearData: sync provider has no local data to purge
				};
			},
		};
	};
}

// SQLite: workspace only, no onDocumentOpen
function sqliteExtension(ctx): Extension {
	const db = new Database(':memory:');
	return {
		exports: { db },
		whenReady: db.init(),
		destroy: () => db.close(),
	};
}
```

#### How ordering works

When `open()` creates a content Y.Doc, the framework iterates extensions in chain order:

```
Extension chain: persistence → sync → sqlite

open() creates Y.Doc:
  1. persistence.onDocumentOpen({ ydoc, whenReady: Promise.resolve() })
     → returns { whenReady: idbSynced, destroy, clearData }
  2. sync.onDocumentOpen({ ydoc, whenReady: idbSynced })
     → awaits idbSynced, then connects WebSocket
     → returns { whenReady: connected, destroy }
  3. sqlite has no onDocumentOpen → skipped
  4. Attach updatedAt observer to the Y.Doc
  5. await all whenReady → return hydrated Y.Doc
```

#### How `open()` runs `onDocumentOpen` internally

```typescript
async open(guid: string): Promise<Y.Doc> {
	const existing = docs.get(guid);
	if (existing) return existing.whenReady;

	const ydoc = new Y.Doc({ guid, gc: false });
	const lifecycles: DocumentLifecycle[] = [];

	// Iterate extensions in chain order.
	// IMPORTANT: Everything between docs.get() and docs.set() must be synchronous.
	// An await here would create a window where concurrent open() calls bypass
	// the cache and create duplicate Y.Docs for the same GUID.
	// onDocumentOpen hooks are called synchronously: their async work is tracked
	// via whenReady promises, not awaited inline.
	for (const ext of registeredExtensions) {
		if (!ext.onDocumentOpen) continue;

		const whenReady = lifecycles.length === 0
			? Promise.resolve()
			: Promise.all(lifecycles.map(l => l.whenReady)).then(() => {});

		const result = ext.onDocumentOpen({
			ydoc,
			whenReady,
			binding: { tableName, documentName },
		});

		if (result) lifecycles.push(result);
	}

	// Attach updatedAt observer
	const unobserve = observeDocForUpdatedAt(ydoc, guid);

	// Cache entry is set SYNCHRONOUSLY before any promise resolution.
	// Concurrent calls to open(same-guid) will hit the cache on line 2.
	const whenReady = lifecycles.length === 0
		? Promise.resolve(ydoc)
		: Promise.all(lifecycles.map(l => l.whenReady))
			.then(() => ydoc)
			.catch(async (err) => {
				// If any provider's whenReady rejects, clean up everything:
				// even providers that succeeded. Matches the Lifecycle guarantee:
				// "destroy() will be called even if whenReady rejects."
				await Promise.allSettled(lifecycles.map(l => l.destroy()));
				unobserve();
				ydoc.destroy();
				docs.delete(guid);
				throw err;
			});

	docs.set(guid, { ydoc, lifecycles, unobserve, whenReady });
	return whenReady;
}
```

#### Concurrent `open()` safety

JavaScript is single-threaded. The entire path from `docs.get()` (cache miss) through the `onDocumentOpen` loop to `docs.set()` runs synchronously, no `await` yields control. This means two concurrent `open(same-guid)` calls are safe:

```
Call 1: docs.get() → miss → new Y.Doc → onDocumentOpen loop → docs.set() → return promise
Call 2: docs.get() → HIT (call 1 already set it) → return same promise
```

The invariant: **never put an `await` between `docs.get()` and `docs.set()`**. All `onDocumentOpen` hooks run synchronously; their async initialization is tracked via `whenReady` promises, not awaited inline.

#### Error handling in `onDocumentOpen`

Two failure modes, both handled:

**1. `onDocumentOpen` hook throws synchronously** (e.g., provider constructor fails):

The `open()` implementation wraps the loop in try/catch. If hook N throws, hooks 1..N-1 that already succeeded are destroyed, the Y.Doc is destroyed, and the error propagates. No stale map entry.

```typescript
// Inside the loop: if an onDocumentOpen hook throws:
try {
	for (const ext of registeredExtensions) {
		// ...
		const result = ext.onDocumentOpen({ ydoc, whenReady, binding });
		if (result) lifecycles.push(result);
	}
} catch (err) {
	await Promise.allSettled(lifecycles.map((l) => l.destroy()));
	unobserve();
	ydoc.destroy();
	throw err;
}
```

**2. `whenReady` rejects asynchronously** (e.g., IndexedDB fails to load):

The `.catch()` on the composite `whenReady` promise cleans up all providers, removes the observer, destroys the Y.Doc, and removes the map entry. A subsequent `open()` call will start fresh.

This matches the existing `Lifecycle` guarantee: "destroy() will be called even if whenReady rejects."

#### Per-binding granularity

Extensions can inspect `binding` and skip specific document types:

```typescript
onDocumentOpen({ ydoc, whenReady, binding }) {
	// Skip sync for cover images: large, don't need real-time
	if (binding.tableName === 'notes' && binding.documentName === 'cover') {
		return; // void → no lifecycle for this doc from this extension
	}
	const provider = createSyncProvider({ doc: ydoc });
	return {
		whenReady: whenReady.then(() => provider.connect()),
		destroy: () => provider.destroy(),
	};
}
```

---

## Decision: `createWorkspace()` Wiring

When `createWorkspace()` detects tables with `.withDocument()` bindings, it:

1. Collects `onDocumentOpen` callbacks from all extensions (in chain order)
2. For each table with doc bindings, calls `createDocumentBinding()` with:
   - The binding config from the table definition
   - The table helper (already created by `createTables()`)
   - The collected `onDocumentOpen` callbacks as provider factories
3. Creates a `.docs` object on each table helper containing the named bindings
4. Wires `destroyAll()` into `client.destroy()` for lifecycle cascade

---

## Implementation Plan

- [ ] **1. Type infrastructure**
  - [ ] 1.1 Add `DocBinding<TGuid, TUpdatedAt>` type
  - [ ] 1.2 Add `TDocs` generic parameter to `TableDefinition` (default `Record<string, never>`)
  - [ ] 1.3 Add `DocumentBinding<TRow>` type (open/read/write/destroy/purge/guidOf/updatedAtOf)
  - [ ] 1.4 Add `DocumentLifecycle` type (`Lifecycle & { clearData? }`: NOT on base Lifecycle)
  - [ ] 1.5 Add `DocsPropertyOf` conditional type (adds `.docs` only when TDocs is non-empty)
  - [ ] 1.6 Extend `TablesHelper`: `.docs` property via intersection when table has bindings

- [ ] **2. `defineTable().withDocument()`**
  - [ ] 2.1 Shorthand path: `defineTable(schema).withDocument(name, config)` returns augmented definition
  - [ ] 2.2 Builder path: `.version().migrate().withDocument(name, config)` chains after terminal
  - [ ] 2.3 Chaining: `.withDocument().withDocument()` accumulates into `TDocs`
  - [ ] 2.4 Runtime: attach `docs` record to the returned definition object
  - [ ] 2.5 Verify `.docs` namespace type inference works (no collision checks needed)

- [ ] **3. `createDocumentBinding()` runtime**
  - [ ] 3.1 Implement `createDocumentBinding()` with internal `Map<string, DocEntry>`
  - [ ] 3.2 Implement `open()`: create Y.Doc, run provider factories, attach updatedAt observer, cache in map
  - [ ] 3.3 Implement `read()`: open + read Y.Text as string
  - [ ] 3.4 Implement `write()`: open + replace Y.Text content
  - [ ] 3.5 Implement `destroy()`: disconnect providers, remove observer, destroy Y.Doc, remove from map
  - [ ] 3.6 Implement `purge()`: call clearData on providers that support it, then destroy
  - [ ] 3.7 Implement `destroyAll()`: iterate map, destroy each
  - [ ] 3.8 Implement table observer for row deletion → `onRowDeleted` callback
  - [ ] 3.9 Implement content doc observer for updatedAt auto-bump with `DOCUMENT_BINDING_ORIGIN`
  - [ ] 3.10 Export `DOCUMENT_BINDING_ORIGIN` symbol for consumer use

- [ ] **4. `onDocumentOpen` on Extension**
  - [ ] 4.1 Add `DocumentContext` type (`ydoc`, `whenReady`, `binding`)
  - [ ] 4.2 Add optional `onDocumentOpen` field to `Extension` type
  - [ ] 4.3 Add `DocumentLifecycle` to `lifecycle.ts` (`Lifecycle & { clearData? }`, separate from base)
  - [ ] 4.4 Add `onDocumentOpen` to `indexeddbPersistence` in `extensions/sync/web.ts`
  - [ ] 4.5 Add `onDocumentOpen` to `createSyncExtension` in `extensions/sync.ts`
  - [ ] 4.6 Update `workspacePersistence` in Epicenter app with `onDocumentOpen`

- [ ] **5. Wire into `createWorkspace()`**
  - [ ] 5.1 Detect doc bindings in table definitions
  - [ ] 5.2 Collect `onDocumentOpen` callbacks from extensions (in chain order)
  - [ ] 5.3 Call `createDocumentBinding()` for each binding, passing collected callbacks as provider factories
  - [ ] 5.4 Create `.docs` object on table helpers with named bindings
  - [ ] 5.5 Wire `destroyAll()` into `client.destroy()` for lifecycle cascade

- [ ] **6. Tests**
  - [ ] 6.1 `defineTable(schema).withDocument()` type inference and autocomplete
  - [ ] 6.2 Invalid column names produce compile errors
  - [ ] 6.3 `.docs` property only exists on tables with `.withDocument()`
  - [ ] 6.4 Multi-version tables with `.withDocument()`
  - [ ] 6.5 Multiple `.withDocument()` chains on same table
  - [ ] 6.6 Tables without `.withDocument()` don't have `.docs` property
  - [ ] 6.7 `open()` returns Y.Doc with `gc: false`
  - [ ] 6.8 `open()` is idempotent (same GUID → same Y.Doc)
  - [ ] 6.9 `open()` accepts row and string overloads
  - [ ] 6.10 `read()` returns string content
  - [ ] 6.11 `write()` replaces text content
  - [ ] 6.12 Content doc change → `updatedAt` bumped on row automatically
  - [ ] 6.13 `updatedAt` bump uses `DOCUMENT_BINDING_ORIGIN` transaction origin
  - [ ] 6.14 Row deletion → `onRowDeleted` callback fires
  - [ ] 6.15 Default `onRowDeleted` calls `destroy()`
  - [ ] 6.16 Custom `onRowDeleted` can call `purge()`
  - [ ] 6.17 `destroy()` frees memory, doc can be re-opened from persistence
  - [ ] 6.18 `purge()` calls `clearData()` on providers that support it
  - [ ] 6.19 `purge()` gracefully handles providers without `clearData()`
  - [ ] 6.20 Workspace `destroy()` cascades to `destroyAll()` on all bindings
  - [ ] 6.21 Extensions' `onDocumentOpen` called in chain order (persistence before sync)
  - [ ] 6.22 Second extension's `onDocumentOpen` receives `whenReady` that resolves after first
  - [ ] 6.23 Extension without `onDocumentOpen` → skipped for content docs
  - [ ] 6.24 No extensions with `onDocumentOpen` → bare Y.Doc, instant resolution
  - [ ] 6.25 `onDocumentOpen` receives correct `binding.tableName` and `binding.documentName`
  - [ ] 6.26 `onDocumentOpen` returning `void` → skips lifecycle for that doc

- [ ] **7. Migrate filesystem package** (follow-up)
  - [ ] 7.1 Update `filesTable` to use `.withDocument('content', { guid: 'id', updatedAt: 'updatedAt' })`
  - [ ] 7.2 Refactor `ContentOps` to use the document binding instead of standalone store
  - [ ] 7.3 Update `fs-explorer` app
  - [ ] 7.4 Deprecate standalone `createContentDocStore`

---

## Open Questions

1. **Observer debouncing**: Should the `updatedAt` auto-bump fire on every Y.Doc transaction, or be debounced? If a user types 100 characters, that's potentially 100 `updatedAt` writes. Debouncing (e.g., trailing 500ms) would be more practical but means `updatedAt` is eventually-consistent. Needs evaluation during implementation.

2. **Local vs remote changes**: Should the `updatedAt` observer fire when sync delivers remote changes? If yes, device A edits → syncs to device B → B bumps its own `updatedAt` → that syncs back to A. If no, `updatedAt` only reflects local edits: simpler but means different devices may have different `updatedAt` values.

3. **`read()`/`write()` text format**: Currently defined as plain-text operations. Should they use a specific Y.Text key (e.g., `'body'`)? Should they interact with the timeline system used by `ContentOps`? Leaning toward minimal: apps build domain-specific wrappers on top.

4. **Batch `open()`**: Should `open()` accept an array of rows/GUIDs for batch loading? Current design is single-item only. Batch loading would allow internal dedup and parallel provider initialization. Can be added later without breaking changes.

---

## Appendix: Row Enrichment Evaluation

During design, we evaluated an alternative where document bindings would be **non-enumerable properties on rows** (using `Object.defineProperty` with `enumerable: false`) instead of properties on the table helper.

### The appeal

Row enrichment provides proximity: `row.content.open()` instead of `table.content.open(row)`. The row "carries its own doc access."

### Implementation: `Object.defineProperty` with `enumerable: false`

This was the only viable approach. A regular property with custom `toJSON()` fails: `toJSON()` only controls `JSON.stringify`, not spread/`Object.keys`/iteration. Non-enumerable properties are invisible across all enumeration contexts:

| Operation             | Behavior                |
| --------------------- | ----------------------- |
| `JSON.stringify(row)` | Hidden (not enumerated) |
| `{...row}`            | Hidden (not copied)     |
| `Object.keys(row)`    | Hidden                  |
| `row.content`         | Accessible              |

### Why it was rejected

1. **TypeScript/runtime mismatch**: `{...row}` loses non-enumerable properties at runtime, but TypeScript still shows them on the spread result. `copy.content.open()` compiles fine but throws `TypeError: Cannot read properties of undefined` at runtime.

2. **Wrapping tax**: Every method that returns rows (`get`, `getAllValid`, `filter`, `find`, `observe` callbacks) must attach non-enumerable properties. Missing one means `row.content` is silently `undefined`. This is a maintenance invariant across every current and future row-returning method.

3. **Two access patterns**: GUID-only access, `destroyAll()`, and destructuring all still need a table-level binding. Row enrichment supplements but cannot replace it: resulting in two ways to do the same thing.

4. **Observation complexity**: `observe()` callbacks fire with raw Y.Map events. Enrichment must happen inside every observation path.

The table-level binding with destructuring covers every case uniformly:

```typescript
const { content } = client.tables.files.docs;
const doc = await content.open(row); // with a row
const doc2 = await content.open(fileId); // with just a GUID
await content.destroyAll(); // lifecycle management
```

---

## Appendix: Design Journey

### v1: Document Handle (original)

A `DocumentHandle` with `ensure()`/`destroy()` methods as a direct property on the table helper. One-directional: you ask for a doc, you get a doc. `updatedAt` bumping was manual. Row deletion cleanup was not addressed.

### v2: Document Binding (current)

Reviewing v1 surfaced two gaps:

1. **Why should `updatedAt` be manual?** The binding knows which column to bump and can observe the Y.Doc. Making it automatic eliminates bugs from forgetting to bump `updatedAt` after writes.

2. **What happens when a row is deleted?** Without automatic cleanup, content docs are orphaned: providers keep running, persisted data grows, nothing reclaims resources.

These gaps led to the document binding: a bidirectional lifecycle manager tying the content doc's lifecycle to the row's lifecycle. The `destroy()` vs `purge()` distinction emerged from recognizing that CRDTs need nuanced cleanup. You can't always hard-delete when a row disappears, because undo, sync, and soft-delete patterns require data to survive. `destroy()` is intentionally aligned with workspace `destroy()` (tear down runtime, keep data) while `purge()` is the escalation for permanent deletion.

`createDocumentBinding()` became a standalone export following the `define*`/`create*` convention: most users never call it, but advanced users have an escape hatch.

## References

- `packages/epicenter/src/static/define-table.ts`: Add `.withDocument()` method
- `packages/epicenter/src/static/types.ts`: Add doc-related types, `DocumentBinding`, `DocumentContext`
- `packages/epicenter/src/static/create-workspace.ts`: Wire bindings into client, collect `onDocumentOpen` from extensions
- `packages/epicenter/src/static/create-tables.ts`: Detect doc bindings, create bindings
- `packages/epicenter/src/static/table-helper.ts`: Attach `.docs` namespace with document bindings
- `packages/epicenter/src/static/create-document-binding.ts`: New file: the standalone factory function
- `packages/epicenter/src/shared/lifecycle.ts`: `Extension` gains `onDocumentOpen`; add `DocumentLifecycle` (`Lifecycle & { clearData? }`, NOT on base Lifecycle)
- `packages/epicenter/src/extensions/sync.ts`: Add `onDocumentOpen` to `createSyncExtension`
- `packages/epicenter/src/extensions/sync/web.ts`: Add `onDocumentOpen` to `indexeddbPersistence`
- `packages/filesystem/src/content-doc-store.ts`: Existing pattern to generalize
- `packages/filesystem/src/content-ops.ts`: Existing domain-specific wrapper (reference for `read`/`write`)
- `packages/filesystem/src/types.ts`: `ContentDocStore` type (reference)
- `packages/filesystem/src/file-table.ts`: First table to migrate
