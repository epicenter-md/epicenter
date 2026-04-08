/**
 * Shared types for the Workspace API.
 *
 * This module contains all type definitions for versioned tables and KV stores.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { JsonObject } from 'wellcrafted/json';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { CombinedStandardSchema } from '../shared/standard-schema/types.js';
import type { Timeline } from '../timeline/timeline.js';
import type { EncryptionKeys } from './encryption-key.js';
import type { Extension, MaybePromise } from './lifecycle.js';

// Re-export JSON types for consumers
export type { JsonObject, JsonValue } from 'wellcrafted/json';

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES - Building Blocks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every versioned table row must satisfy.
 *
 * - `id`: Unique identifier for row lookup and identity
 * - `_v`: Schema version number for tracking which version this row conforms to
 *
 * ### Why `_v` instead of `v`
 *
 * The underscore prefix signals "framework metadata, not user data" (same convention
 * as `_id` in MongoDB or `__typename` in GraphQL). Users intuitively avoid
 * underscore-prefixed fields for business data, which prevents accidental collisions
 * with framework internals.
 *
 * Historically, this also avoided collision with the old `EncryptedBlob.v` field.
 * That rationale no longer applies—`EncryptedBlob` is now a branded bare `Uint8Array`
 * detected via `instanceof Uint8Array && value[0] === 1`—but the underscore convention
 * remains good practice for framework metadata regardless.
 *
 * Intersected with `JsonObject` to ensure all field values are JSON-serializable.
 * This guarantees data stored in Yjs can be safely serialized/deserialized.
 *
 * All table rows extend this base shape. Used as a constraint in generic types
 * to ensure rows have the required fields for versioning and identification.
 */
export type BaseRow = { id: string; _v: number } & JsonObject;

/** A row that passed validation. */
export type ValidRowResult<TRow> = { status: 'valid'; row: TRow };

/** A row that exists but failed validation. */
export type InvalidRowResult = {
	status: 'invalid';
	id: string;
	errors: readonly StandardSchemaV1.Issue[];
	row: unknown;
};

/**
 * A row that was not found.
 * Includes `row: undefined` so row can always be destructured regardless of status.
 */
export type NotFoundResult = {
	status: 'not_found';
	id: string;
	row: undefined;
};

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES - Composed Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Result of validating a row.
 * The shape after parsing a row from storage - either valid or invalid.
 */
export type RowResult<TRow> = ValidRowResult<TRow> | InvalidRowResult;

/**
 * Result of getting a single row by ID.
 * Includes not_found since the row may not exist.
 */
export type GetResult<TRow> = RowResult<TRow> | NotFoundResult;

/** Result of updating a single row */
export type UpdateResult<TRow> =
	| { status: 'updated'; row: TRow }
	| NotFoundResult
	| InvalidRowResult;

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Change event for KV observation */
export type KvChange<TValue> =
	| { type: 'set'; value: TValue }
	| { type: 'delete' };

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Extract the last element from a tuple of schemas. */
export type LastSchema<T extends readonly CombinedStandardSchema[]> =
	T extends readonly [
		...CombinedStandardSchema[],
		infer L extends CombinedStandardSchema,
	]
		? L
		: T[number];

/**
 * A table definition created by `defineTable(schema)` or `defineTable(v1, v2, ...).migrate(fn)`
 *
 * @typeParam TVersions - Tuple of schema versions (each must include `{ id: string }`)
 * @typeParam TDocuments - Record of named document configs declared via `.withDocument()`
 */
export type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[],
	TDocuments extends Record<string, DocumentConfig> = Record<string, never>,
> = {
	schema: CombinedStandardSchema<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
	documents: TDocuments;
};

/** Extract the row type from a TableDefinition */
export type InferTableRow<T> = T extends {
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest
	: never;

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT CONFIG TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A named document declared via `.withDocument()`.
 *
 * Maps a document concept (e.g., 'content') to a GUID column and an `onUpdate` callback
 * that fires when the content Y.Doc changes:
 * - `guid`: The column storing the Y.Doc GUID (must be a string column)
 * - `onUpdate`: Zero-argument callback returning `Partial<Omit<TRow, 'id'>>` — the fields
 *   to write when the doc changes. Callers control both the value and which columns to update.
 *
 * @typeParam TGuid - Literal string type of the guid column name
 * @typeParam TRow - The row type of the table (used to type-check `onUpdate` return)
 */
export type DocumentConfig<
	TGuid extends string = string,
	TRow extends BaseRow = BaseRow,
	TAwarenessDefs extends AwarenessDefinitions = Record<string, never>,
> = {
	guid: TGuid;
	/** Called when the content Y.Doc changes. Return the fields to write to the row. */
	onUpdate: () => Partial<Omit<TRow, 'id'>>;
	/** Optional awareness schemas for this document scope. */
	awareness?: TAwarenessDefs;
};

/**
 * Internal registration for a document extension.
 *
 * Stored in an array by `withDocumentExtension()`. Each entry contains
 * the extension key and factory function.
 *
 * At document open time, the runtime calls every registered factory.
 * Factories receive `DocumentContext` with `tableName` and `documentName`
 * and can return `void` to opt out for specific documents.
 */
export type DocumentExtensionRegistration = {
	key: string;
	factory: (context: DocumentContext) =>
		| (Record<string, unknown> & {
				whenReady?: Promise<unknown>;
				dispose?: () => MaybePromise<void>;
				clearLocalData?: () => MaybePromise<void>;
		  })
		| void;
};

/**
 * Extract keys of `TRow` whose value type extends `string`.
 * Used to constrain the `guid` parameter of `.withDocument()`.
 */
export type StringKeysOf<TRow> = {
	[K in keyof TRow & string]: TRow[K] extends string ? K : never;
}[keyof TRow & string];

/**
 * Collect all column names already claimed as `guid` by prior `.withDocument()` calls.
 * Subsequent calls cannot reuse these columns, preventing two documents from sharing
 * a GUID (which would cause storage collisions).
 *
 * With the `onUpdate` callback model, updatedAt columns are no longer claimed —
 * multiple documents can write to the same column via their callbacks (last write wins).
 *
 * Requires `{}` (not `Record<string, never>`) as the initial empty `TDocuments`,
 * so that `keyof {}` = `never` and the union resolves cleanly.
 */
export type ClaimedDocumentColumns<
	TDocuments extends Record<string, DocumentConfig>,
> = TDocuments[keyof TDocuments]['guid'];

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT CLIENT — The document's API surface (mirrors WorkspaceClient)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The full API surface of an open content document.
 *
 * Mirrors `WorkspaceClient` for consistency: the document's core type that
 * `DocumentContext` derives from via `Pick` and `DocumentHandle` derives from
 * via `Omit`. Extends `Timeline` so all content operations (read, write, mode
 * conversion) are available directly.
 *
 * @typeParam TDocExtensions - Accumulated document extension exports
 */
export type DocumentClient<
	TDocExtensions extends Record<string, unknown> = Record<string, never>,
> = Timeline & {
	/** The workspace identifier. */
	id: string;
	/** The table this document belongs to (e.g., 'files', 'notes'). */
	tableName: string;
	/** The document name declared via `.withDocument()` (e.g., 'content', 'body'). */
	documentName: string;
	/**
	 * Self-reference for destructuring convenience.
	 *
	 * The document client IS the timeline (via intersection). This property
	 * allows factories to destructure `({ timeline })` and get the same object.
	 */
	timeline: Timeline;
	/**
	 * Accumulated document extension exports with lifecycle hooks.
	 *
	 * Each entry is optional because extension factories may return `void`
	 * to skip specific documents. Guard access with optional chaining.
	 */
	extensions: {
		[K in keyof TDocExtensions]?: Extension<
			TDocExtensions[K] extends Record<string, unknown>
				? TDocExtensions[K]
				: Record<string, unknown>
		>;
	};
	/** Composite whenReady of all document extensions. */
	whenReady: Promise<void>;
	/** Cleanup all document extension resources. */
	dispose(): Promise<void>;
};

/**
 * Context passed to document extension factories registered via `withDocumentExtension()`.
 *
 * Picks the fields factories need from `DocumentClient` without inheriting the
 * `Timeline` intersection. This preserves the HAS-A relationship (`ctx.timeline`)
 * rather than IS-A (`ctx.read()`), matching how factories actually destructure:
 *
 * ```typescript
 * .withDocumentExtension('persistence', ({ ydoc }) => { ... })
 * .withDocumentExtension('sync', ({ id, tableName, documentName, ydoc }) => { ... })
 * ```
 *
 * Factories inspect `tableName` and `documentName` to decide whether to activate.
 * Return `void` to skip a specific document.
 *
 * @typeParam TDocExtensions - Accumulated document extension exports from prior calls.
 *   Defaults to `Record<string, unknown>` so `DocumentExtensionRegistration` can
 *   store factories with the wide type.
 */
export type DocumentContext<
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
> = Pick<
	DocumentClient<TDocExtensions>,
	| 'id'
	| 'tableName'
	| 'documentName'
	| 'ydoc'
	| 'timeline'
	| 'extensions'
	| 'whenReady'
> & {
	/**
	 * Raw awareness instance for this document scope.
	 *
	 * Uses a minimal wrapper (`{ raw }`) so document and workspace scopes
	 * share the same structural contract for `withExtension()` factories.
	 */
	awareness: { raw: Awareness };
};

/**
 * A handle to an open content Y.Doc, returned by `documents.open()`.
 *
 * Computed from `DocumentClient` minus lifecycle control. The handle IS the
 * timeline—all read, write, and mode conversion methods are available directly.
 * Extension exports are accessed via `handle.extensions`.
 *
 * When `TDocExtensions` is specified (after generic threading), extension access
 * is fully typed. Without generics, extensions are accessible but untyped.
 *
 * @typeParam TDocExtensions - Accumulated document extension exports.
 *   Defaults to `Record<string, unknown>` for untyped access.
 *
 * @example
 * ```typescript
 * const handle = await documents.open(id);
 * handle.read();                          // read from timeline (always string)
 * handle.write('hello');                   // write to timeline (mode-aware)
 * handle.asText();                         // Y.Text for editor binding
 * handle.currentType;                      // current content type
 * handle.extensions.persistence?.whenReady; // extension access
 * ```
 */
export type DocumentHandle<
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
	TAwarenessDefs extends AwarenessDefinitions = Record<string, never>,
> = Omit<DocumentClient<TDocExtensions>, 'dispose'> & {
	/** Typed awareness helper scoped to this document. */
	awareness: AwarenessHelper<TAwarenessDefs>;
};

/**
 * Runtime manager for a table's associated content Y.Docs.
 *
 * Manages Y.Doc creation, provider lifecycle, `updatedAt` auto-bumping,
 * and cleanup on row deletion. Most users access this via
 * `client.documents.files.content`.
 *
 * @typeParam TRow - The row type of the bound table
 *
 * @example
 * ```typescript
 * const handle = await documents.open(row);
 * handle.write('hello');
 * // updatedAt on the row is bumped automatically
 *
 * const text = handle.read();
 * handle.write('new content');
 * await documents.close(row);
 * ```
 */
export type Documents<
	TRow extends BaseRow,
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
	TAwarenessDefs extends AwarenessDefinitions = Record<string, never>,
> = {
	/**
	 * Open a content Y.Doc for a row.
	 *
	 * Creates the Y.Doc if it doesn't exist, wires up providers, and attaches
	 * the updatedAt observer. Idempotent — calling open() twice for the same
	 * row returns the same handle (same Y.Doc).
	 *
	 * @param input - A row (extracts GUID from the bound column) or a GUID string
	 */
	open(
		input: TRow | string,
	): Promise<DocumentHandle<TDocExtensions, TAwarenessDefs>>;

	/**
	 * Close a document — free memory, disconnect providers.
	 * Persisted data is NOT deleted. The doc can be re-opened later.
	 *
	 * @param input - A row or GUID string
	 */
	close(input: TRow | string): Promise<void>;

	/**
	 * Close all open documents. Called automatically by workspace dispose().
	 */
	closeAll(): Promise<void>;
};

/**
 * Does this table definition have a non-empty `documents` record?
 *
 * Used by `DocumentsHelper` to filter the `documents` namespace — only tables
 * with `.withDocument()` declarations appear in `client.documents`.
 */
export type HasDocuments<T> = T extends { documents: infer TDocuments }
	? keyof TDocuments extends never
		? false
		: true
	: false;

/**
 * Extract all document names across all tables.
 *
 * Collects all document names (from `.withDocument()` calls) into a union
 * for type-safe autocomplete in `withDocumentExtension()` factory context.
 *
 * @example
 * ```typescript
 * // Given tables with .withDocument('content') and .withDocument('body'):
 * type Names = AllDocumentNames<typeof tables>;
 * // => 'content' | 'body'
 * ```
 */
export type AllDocumentNames<TTableDefs extends TableDefinitions> = {
	[K in keyof TTableDefs]: TTableDefs[K] extends {
		documents: infer TDocuments;
	}
		? keyof TDocuments & string
		: never;
}[keyof TTableDefs];

/**
 * Extract the document map for a single table definition.
 *
 * Maps each doc name to a `Documents<TLatest>` where `TLatest` is the
 * table's latest row type (inferred from the `migrate` function's return type).
 */
export type DocumentsOf<
	T,
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
> = T extends {
	documents: infer TDocuments;
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest extends BaseRow
		? {
				[K in keyof TDocuments]: Documents<
					TLatest,
					TDocExtensions,
					TDocuments[K] extends DocumentConfig<
						string,
						BaseRow,
						infer TAwarenessDefs
					>
						? TAwarenessDefs
						: Record<string, never>
				>;
			}
		: never
	: never;

/**
 * Top-level document namespace — parallel to `TablesHelper`.
 *
 * Only includes tables that have document configs declared via `.withDocument()`.
 * Tables without documents are filtered out via key remapping.
 *
 * @example
 * ```typescript
 * // Table with .withDocument('content', ...)
 * client.documents.files.content.open(row)
 *
 * // Table without .withDocument() — TypeScript error
 * client.documents.tags // Property 'tags' does not exist
 * ```
 */
export type DocumentsHelper<
	TTableDefinitions extends TableDefinitions,
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
> = {
	[K in keyof TTableDefinitions as HasDocuments<
		TTableDefinitions[K]
	> extends true
		? K
		: never]: DocumentsOf<TTableDefinitions[K], TDocExtensions>;
};

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by `defineKv(schema, defaultValue)`.
 *
 * ## KV vs Tables: Different Data, Different Strategy
 *
 * Tables accumulate rows that must survive schema changes—migration is mandatory.
 * Each row carries a `_v` version discriminant, and `defineTable(v1, v2).migrate(fn)`
 * transforms old rows to the latest shape on read.
 *
 * KV stores hold scalar preferences (toggles, font sizes, selected options) where
 * resetting to default is acceptable. There is no `_v` field, no migration function,
 * and no version history. When a KV schema changes, either:
 * - The old value still validates (e.g., widening an enum)—no action needed
 * - The old value fails validation—`defaultValue` is returned automatically
 *
 * ## The `defaultValue` Contract
 *
 * `defaultValue` is returned whenever `get()` cannot produce a valid value:
 * - **Key missing** — the value has never been set (initial state)
 * - **Validation fails** — the stored value doesn't match the current schema
 *
 * The default is never written to storage. It exists only at read time, which
 * avoids polluting CRDT history and prevents initialization races on multi-device sync.
 *
 * @typeParam TSchema - The schema for this KV entry
 *
 * @example
 * ```typescript
 * // Scalar preference — resets to 'light' if stored value is invalid
 * const theme = defineKv(type("'light' | 'dark' | 'system'"), 'light');
 *
 * // Boolean toggle — resets to false if missing or corrupt
 * const sidebar = defineKv(type('boolean'), false);
 * ```
 */
export type KvDefinition<TSchema extends CombinedStandardSchema> = {
	schema: TSchema;
	defaultValue: StandardSchemaV1.InferOutput<TSchema>;
};

/** Extract the value type from a KvDefinition */
export type InferKvValue<T> =
	T extends KvDefinition<infer TSchema>
		? StandardSchemaV1.InferOutput<TSchema>
		: never;

// ════════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Type-safe table helper for a single workspace table.
 *
 * Provides CRUD operations with schema validation and migration on read.
 * Backed by a YKeyValueLww store with row-level atomicity — `set()` replaces
 * the entire row, and partial updates are done via read-merge-write.
 *
 * ## Row Type
 *
 * `TRow` always extends `{ id: string }` and represents the latest schema
 * version's output type. Old rows are migrated to the latest schema on read.
 *
 * Uses row-level replacement (`set`). Batching is done at the workspace level
 * via `client.batch()`, which wraps `ydoc.transact()`.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */

export type TableHelper<TRow extends BaseRow> = {
	// ═══════════════════════════════════════════════════════════════════════
	// PARSE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Parse unknown input against the table schema and migrate to the latest version.
	 *
	 * Injects `id` into the input before validation. Does not write to storage.
	 * Useful for validating external data (imports, API payloads) before committing.
	 *
	 * @param id - The row ID to inject into the input
	 * @param input - Unknown data to validate against the table schema
	 * @returns `{ status: 'valid', row }` or `{ status: 'invalid', id, errors, row }`
	 */
	parse(id: string, input: unknown): RowResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// WRITE (always writes latest schema shape)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Set a row (insert or replace). Always writes the full row.
	 *
	 * This is row-level atomic — the entire row is replaced in storage.
	 * There is no runtime validation on write; TypeScript enforces the shape.
	 *
	 * @param row - The complete row to write (must include `id`)
	 */
	set(row: TRow): void;

	// ═══════════════════════════════════════════════════════════════════════
	// READ (validates + migrates to latest)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Get a single row by ID.
	 *
	 * Returns a discriminated union:
	 * - `{ status: 'valid', row }` — Row exists and passes schema validation
	 * - `{ status: 'invalid', id, errors, row }` — Row exists but fails validation
	 * - `{ status: 'not_found', id, row: undefined }` — Row doesn't exist
	 *
	 * Old data is migrated to the latest schema version on read.
	 *
	 * @param id - The row ID to look up
	 */
	get(id: string): GetResult<TRow>;

	/**
	 * Get all rows with their validation status.
	 *
	 * Each result is either `{ status: 'valid', row }` or
	 * `{ status: 'invalid', id, errors, row }`. Old data is migrated on read.
	 */
	getAll(): RowResult<TRow>[];

	/**
	 * Get all rows that pass schema validation.
	 *
	 * Invalid rows are silently skipped. Use `getAllInvalid()` to inspect them.
	 */
	getAllValid(): TRow[];

	/**
	 * Get all rows that fail schema validation.
	 *
	 * Useful for debugging data corruption, schema drift, or incomplete migrations.
	 * Returns the raw row data alongside validation errors.
	 */
	getAllInvalid(): InvalidRowResult[];

	// ═══════════════════════════════════════════════════════════════════════
	// QUERY
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Filter valid rows by predicate.
	 *
	 * Invalid rows are silently skipped (never passed to the predicate).
	 *
	 * @param predicate - Function that returns `true` for rows to include
	 * @returns Array of matching valid rows
	 */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/**
	 * Find the first valid row matching a predicate.
	 *
	 * Invalid rows are silently skipped. Returns `undefined` if no match found.
	 *
	 * @param predicate - Function that returns `true` for the desired row
	 * @returns The first matching valid row, or `undefined`
	 */
	find(predicate: (row: TRow) => boolean): TRow | undefined;

	// ═══════════════════════════════════════════════════════════════════════
	// UPDATE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Partial update a row by ID.
	 *
	 * Reads the current row, merges the partial fields, validates the merged
	 * result, and writes it back. Returns the updated row on success.
	 *
	 * @param id - The row ID to update
	 * @param partial - Fields to merge (all fields except `id` are optional)
	 * @returns `{ status: 'updated', row }`, or not_found/invalid if the merge fails
	 */
	update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Delete a single row by ID.
	 *
	 * Fire-and-forget — matches Y.Map.delete() semantics. If the row
	 * doesn't exist locally, this is a silent no-op.
	 *
	 * @param id - The row ID to delete
	 */
	delete(id: string): void;

	/**
	 * Delete all rows from the table.
	 *
	 * The table structure is preserved — observers remain attached and the
	 * table helper continues to work after clearing. Only row data is removed.
	 */
	clear(): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Watch for row changes.
	 *
	 * The callback receives a `ReadonlySet<TRow['id']>` of row IDs that changed. To
	 * determine what happened, call `table.get(id)`:
	 * - `status === 'not_found'` → the row was deleted
	 * - Otherwise → the row was added or updated
	 *
	 * Changes are batched per Y.Transaction. The `origin` parameter exposes
	 * the transaction origin for distinguishing local writes (`null`) from remote syncs.
	 * Encryption lifecycle events (activate/deactivate) pass `undefined`.
	 *
	 * @param callback - Receives changed IDs and optional transaction origin
	 * @returns Unsubscribe function
	 */
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;

	// ═══════════════════════════════════════════════════════════════════════
	// METADATA
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Get the total number of rows in the table.
	 *
	 * Includes both valid and invalid rows.
	 */
	count(): number;

	/**
	 * Check if a row exists by ID.
	 *
	 * @param id - The row ID to check
	 */
	has(id: string): boolean;
};

// ════════════════════════════════════════════════════════════════════════════
// AWARENESS TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of awareness field definitions. Each field has its own CombinedStandardSchema schema. */
export type AwarenessDefinitions = Record<string, CombinedStandardSchema>;

/** Extract the output type of an awareness field's schema. */
export type InferAwarenessValue<T> =
	T extends CombinedStandardSchema<unknown, infer TOutput> ? TOutput : never;

/**
 * The composed state type — all fields optional since peers may not have set every field.
 *
 * Each field's type is inferred from its StandardSchemaV1 schema. Fields are optional
 * because awareness is inherently partial — peers publish what they have.
 */
export type AwarenessState<TDefs extends AwarenessDefinitions> = {
	[K in keyof TDefs]?: InferAwarenessValue<TDefs[K]>;
};

/**
 * Helper for typed awareness access.
 * Wraps the raw y-protocols Awareness instance with schema-validated methods.
 *
 * Uses the record-of-fields pattern (same as tables and KV). Each field has its own
 * StandardSchemaV1 schema. When no fields are defined, `AwarenessHelper<Record<string, never>>`
 * has zero accessible field keys — methods exist but accept no valid arguments.
 *
 * @typeParam TDefs - Record of awareness field definitions (field name → StandardSchemaV1)
 */
export type AwarenessHelper<TDefs extends AwarenessDefinitions> = {
	/**
	 * Set this client's awareness state (merge into current state).
	 * Broadcasts to all connected peers via the awareness protocol.
	 * Accepts partial — only specified fields are set (merged into current state).
	 * No runtime validation — TypeScript catches type errors at compile time.
	 */
	setLocal(state: AwarenessState<TDefs>): void;

	/**
	 * Set a single awareness field.
	 * Maps directly to y-protocols setLocalStateField().
	 *
	 * @param key - The field name to set
	 * @param value - The value for the field (type-checked against the field's schema)
	 */
	setLocalField<K extends keyof TDefs & string>(
		key: K,
		value: InferAwarenessValue<TDefs[K]>,
	): void;

	/**
	 * Get this client's current awareness state.
	 * Returns null if not yet set.
	 */
	getLocal(): AwarenessState<TDefs> | null;

	/**
	 * Get a single local awareness field.
	 * Returns undefined if not set.
	 *
	 * @param key - The field name to get
	 * @returns The field value, or undefined if not set
	 */
	getLocalField<K extends keyof TDefs & string>(
		key: K,
	): InferAwarenessValue<TDefs[K]> | undefined;

	/**
	 * Get all connected clients' awareness states.
	 * Returns Map from Yjs clientID to validated state.
	 * Each field is independently validated against its schema.
	 * Invalid fields are omitted from the result (valid fields still included).
	 * Clients with zero valid fields are excluded entirely.
	 */
	getAll(): Map<number, AwarenessState<TDefs>>;

	/**
	 * Get all remote peers' awareness states.
	 *
	 * Unlike `getAll()`, this method:
	 * - Excludes the local client (self)
	 * - Includes peers with zero valid fields (connected but haven't published identity)
	 *
	 * Use this for presence UIs and peer discovery. Each peer has a `clientId`
	 * plus any validated awareness fields. Peers that haven't set awareness fields
	 * appear with an empty state object—they're connected, just anonymous.
	 *
	 * @example
	 * ```typescript
	 * // Workspace: find all connected desktop clients
	 * const desktops = [...client.awareness.peers()]
	 *   .filter(([, state]) => state.client === 'desktop');
	 *
	 * // Document: show collaborator cursors
	 * for (const [clientId, state] of handle.awareness.peers()) {
	 *   if (state.cursor) renderCursor(clientId, state.cursor, state.color);
	 * }
	 * ```
	 */
	peers(): Map<number, AwarenessState<TDefs>>;

	/**
	 * Watch for awareness changes.
	 * Callback receives a map of clientIDs to change type.
	 * Returns unsubscribe function.
	 */
	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;

	/**
	 * The raw y-protocols Awareness instance.
	 * Escape hatch for advanced use (custom heartbeats, direct protocol access).
	 * Pass to sync providers: createYjsProvider(ydoc, ..., { awareness: ctx.awareness.raw })
	 */
	raw: Awareness;
};

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of table definitions (uses `any` to allow variance in generic parameters) */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any, any>
>;

/** Map of KV definitions (uses `any` to allow variance in generic parameters) */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/**
 * Tables helper — pure CRUD, no document management.
 *
 * Document managers live in the separate `documents` namespace on the client.
 * This type is a plain mapped type over table definitions.
 */
export type TablesHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	>;
};

/**
 * KV helper with dictionary-style access to typed key-value entries.
 *
 * All methods are keyed by the string keys defined in the workspace's `kv` map.
 * Values are validated against their schema on read; invalid or missing values
 * silently fall back to `defaultValue` (see {@link KvDefinition} for the full contract).
 *
 * @example
 * ```typescript
 * // Read — always returns T, never undefined
 * const fontSize = client.kv.get('theme.fontSize');
 *
 * // Write — value is type-checked against the key's schema
 * client.kv.set('theme.fontSize', 16);
 *
 * // React to changes
 * const unsub = client.kv.observe('theme.fontSize', (change) => {
 *   if (change.type === 'set') console.log('New size:', change.value);
 * });
 * ```
 */
export type KvHelper<TKvDefinitions extends KvDefinitions> = {
	/**
	 * Get a KV value by key.
	 *
	 * Always returns a valid `T`—never `undefined`, never a discriminated union.
	 * The return value depends on the state of the underlying Yjs store:
	 *
	 * - **Stored + valid**: returns the stored value as-is
	 * - **Stored + invalid**: returns `defaultValue` (schema mismatch, corrupt data)
	 * - **Missing**: returns `defaultValue` (key never set)
	 *
	 * This is intentionally simpler than table `get()`, which returns a
	 * `{ status, row }` discriminated union. KV entries are scalar preferences
	 * where falling back to a sensible default is always acceptable.
	 */
	get<K extends keyof TKvDefinitions & string>(
		key: K,
	): InferKvValue<TKvDefinitions[K]>;

	/**
	 * Set a KV value by key.
	 *
	 * Writes the value to the Yjs doc via LWW (last-writer-wins) semantics.
	 * No runtime validation—TypeScript enforces the correct type at compile time.
	 * The value is immediately visible to local `get()` calls and propagated
	 * to all connected peers via Yjs sync.
	 */
	set<K extends keyof TKvDefinitions & string>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;

	/**
	 * Delete a KV value by key.
	 *
	 * After deletion, `get()` returns `defaultValue` until a new value is set.
	 * The delete is propagated to all connected peers via Yjs sync.
	 */
	delete<K extends keyof TKvDefinitions & string>(key: K): void;

	/**
	 * Watch for changes to a single KV key. Returns an unsubscribe function.
	 *
	 * The callback fires with `{ type: 'set', value }` when the key is written
	 * or `{ type: 'delete' }` when it's removed. Invalid values (schema mismatch)
	 * are silently skipped—the callback only fires for valid state transitions.
	 *
	 * @param key - The KV key to observe
	 * @param callback - Receives the change event and the transaction origin
	 * @returns Unsubscribe function
	 */
	observe<K extends keyof TKvDefinitions & string>(
		key: K,
		callback: (
			change: KvChange<InferKvValue<TKvDefinitions[K]>>,
			origin?: unknown,
		) => void,
	): () => void;

	/**
	 * Watch for changes to any KV key. Returns unsubscribe function.
	 *
	 * Fires once per Y.Transaction with all changed keys batched into a single Map.
	 * Invalid values and unknown keys are skipped. Only valid, parsed changes
	 * are included in the callback.
	 *
	 * Useful for bulk reactivity (e.g., syncing all settings to a SvelteMap)
	 * without registering per-key observers.
	 *
	 * @param callback - Receives a Map of changed keys to their KvChange, plus the transaction origin
	 * @returns Unsubscribe function
	 */
	observeAll(
		callback: (
			changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
			origin?: unknown,
		) => void,
	): () => void;
};

/**
 * Workspace definition created by defineWorkspace().
 *
 * This is a pure data structure for composability and type inference.
 * Pass to createWorkspace() to instantiate.
 */
export type WorkspaceDefinition<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
> = {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
	/** Record of awareness field schemas. Each field has its own StandardSchemaV1 schema. */
	awareness?: TAwarenessDefinitions;
};

/**
 * Builder returned by `createWorkspace()` and by each `.withExtension()` call.
 *
 * IS a usable client AND has `.withExtension()` + `.withActions()`.
 *
 * ## Why `.withExtension()` is chainable (not a map)
 *
 * Extensions use chainable `.withExtension(key, factory)` calls instead of a single
 * `.withActions({...})` map for a key reason: **extensions build on each other progressively**.
 *
 * Each `.withExtension()` call returns a new builder where the next extension's factory
 * receives the accumulated extensions-so-far as typed context. This means extension N+1
 * can access extension N's exports. You may also be importing extensions you don't fully
 * control, and chaining lets you compose on top of them without modifying their source.
 *
 * Actions, by contrast, use a single `.withActions(factory)` call because:
 * - Actions are always defined by the app author (not imported from external packages)
 * - Actions don't build on each other — they all receive the same finalized client
 * - The ergonomic benefit of declaring all actions in one place outweighs chaining
 *
 * @example
 * ```typescript
 * const client = createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }))
 *   .withActions((client) => ({
 *     createPost: defineMutation({ ... }),
 *   }));
 * ```
 */

export type WorkspaceClientBuilder<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown> = Record<string, never>,
	TDocExtensions extends Record<string, unknown> = Record<string, never>,
	TActions extends Actions = Record<string, never>,
> = WorkspaceClient<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	TExtensions,
	TDocExtensions
> & {
	/** Accumulated actions from `.withActions()` calls. Empty object when none declared. */
	actions: TActions;
	/**
	 * Register an extension for BOTH the workspace Y.Doc AND all content document Y.Docs.
	 *
	 * The factory fires once for the workspace doc (at build time, synchronously) and
	 * once per content doc (at `documents.open()` time). This is the 90% default—use it
	 * for persistence, sync, broadcast, or any extension that should apply everywhere.
	 *
	 * For workspace-only extensions, use {@link withWorkspaceExtension}.
	 * For document-only extensions, use {@link withDocumentExtension}.
	 *
	 * @param key - Unique name for this extension (used as the key in `.extensions`)
	 * @param factory - Factory receiving the client-so-far context, returns flat exports
	 * @returns A new builder with the extension's exports added to both workspace and document types
	 *
	 * @example
	 * ```typescript
	 * const client = createWorkspace(definition)
	 *   .withExtension('persistence', indexeddbPersistence)
	 *   .withExtension('sync', createSyncExtension({ ... }));
	 * ```
	 */
	withExtension<TKey extends string, TExports extends Record<string, unknown>>(
		key: TKey,
		factory: (context: SharedExtensionContext) => TExports & {
			whenReady?: Promise<unknown>;
			dispose?: () => MaybePromise<void>;
			clearLocalData?: () => MaybePromise<void>;
		},
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions &
			Record<
				TKey,
				Extension<Omit<TExports, 'whenReady' | 'dispose' | 'clearLocalData'>>
			>,
		TDocExtensions &
			Record<TKey, Omit<TExports, 'whenReady' | 'dispose' | 'clearLocalData'>>,
		TActions
	>;

	/**
	 * Register an extension for the workspace Y.Doc ONLY.
	 *
	 * The factory fires once at build time for the workspace doc. It does NOT
	 * fire for content documents opened via `documents.open()`. Use this when
	 * an extension needs workspace-specific context (tables, kv, awareness) or
	 * is genuinely workspace-scoped (SQLite index, analytics).
	 *
	 * Most consumers want {@link withExtension} (both scopes) instead.
	 *
	 * @example
	 * ```typescript
	 * createWorkspace(definition)
	 *   .withExtension('persistence', indexeddbPersistence)
	 *   .withWorkspaceExtension('sqliteIndex', createSqliteIndex());
	 * ```
	 */
	withWorkspaceExtension<
		TKey extends string,
		TExports extends Record<string, unknown>,
	>(
		key: TKey,
		factory: (
			context: ExtensionContext<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions,
				TExtensions
			>,
		) => TExports & {
			whenReady?: Promise<unknown>;
			dispose?: () => MaybePromise<void>;
			clearLocalData?: () => MaybePromise<void>;
		},
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions &
			Record<
				TKey,
				Extension<Omit<TExports, 'whenReady' | 'dispose' | 'clearLocalData'>>
			>,
		TDocExtensions,
		TActions
	>;

	/**
	 * Register a document extension that fires when content Y.Docs are opened.
	 *
	 * Document extensions operate on content Y.Docs (not the workspace Y.Doc).
	 * Every registered factory fires for every document opened via `documents.open()`.
	 *
	 * To skip specific documents, inspect `ctx.tableName` or `ctx.documentName`
	 * in your factory and return `void` (the factory's return type allows this).
	 *
	 * @param key - Unique name for this document extension
	 * @param factory - Factory receiving DocumentContext, returns Extension or void to skip
	 *
	 * @example
	 * ```typescript
	 * createWorkspace({ id: 'app', tables: { files, notes } })
	 *   .withExtension('persistence', indexeddbPersistence)
	 *   .withDocumentExtension('sync', (ctx) => {
	 *     if (ctx.documentName === 'thumbnail') return; // skip ephemeral docs
	 *     return ySweetSync(ctx);
	 *   });
	 * ```
	 */
	withDocumentExtension<
		K extends string,
		TDocExports extends Record<string, unknown>,
	>(
		key: K,
		factory: (
			context: DocumentContext<TDocExtensions> & {
				tableName: keyof TTableDefinitions & string;
				documentName: AllDocumentNames<TTableDefinitions>;
			},
		) =>
			| (TDocExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
			  })
			| void,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions,
		TDocExtensions &
			Record<K, Omit<TDocExports, 'whenReady' | 'dispose' | 'clearLocalData'>>,
		TActions
	>;

	/**
	 * Attach actions to the workspace client.
	 *
	 * Non-terminal—the returned builder still supports `.withExtension()` and further
	 * `.withActions()` calls. This allows extension-independent actions to be declared
	 * before extensions in the chain.
	 *
	 * Multiple `.withActions()` calls shallow-merge their action trees (later calls
	 * overwrite earlier keys at the top level).
	 *
	 * @param factory - Receives the client-so-far, returns an actions map
	 * @returns A new builder with actions attached (still chainable)
	 */
	withActions<TNewActions extends Actions>(
		factory: (
			client: WorkspaceClient<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions,
				TExtensions,
				TDocExtensions
			>,
		) => TNewActions,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions,
		TDocExtensions,
		TActions & TNewActions
	>;
};

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to workspace extension factories.
 *
 * This is a `WorkspaceClient` minus lifecycle methods (`dispose`,
 * extension factories receive the full client surface but don't control
 * the workspace's lifecycle. They return their own lifecycle hooks instead.
 *
 * ```typescript
 * .withExtension('persistence', ({ ydoc }) => { ... })
 * .withExtension('sync', ({ ydoc, awareness, whenReady }) => { ... })
 * .withExtension('sqlite', ({ id, tables }) => { ... })
 * ```
 *
 * `whenReady` is the composite promise from all PRIOR extensions — use it to
 * sequence initialization (e.g., wait for persistence before connecting sync).
 *
 * `extensions` provides typed access to prior extensions' exports.
 */
export type ExtensionContext<
	TId extends string = string,
	TTableDefinitions extends TableDefinitions = TableDefinitions,
	TKvDefinitions extends KvDefinitions = KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions = AwarenessDefinitions,
	TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
	WorkspaceClient<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	>,
	'dispose' | typeof Symbol.asyncDispose
>;

/**
 * Context shared by workspace and document extension scopes.
 *
 * Used by `withExtension()`, which registers the same factory for both scopes.
 * This type is intentionally standalone (not `Pick<ExtensionContext, ...>`) because
 * workspace awareness is strongly typed (`AwarenessHelper<TDefs>`) while document
 * awareness uses a scope-specific helper. The only guarantee both scopes share is
 * a raw awareness instance (`{ raw: Awareness }`).
 *
 * If a factory needs workspace-specific fields (tables, full typed awareness, etc.),
 * use `withWorkspaceExtension()`. For document-specific fields (timeline),
 * use `withDocumentExtension()`.
 *
 * ```typescript
 * // Sync needs ydoc + raw awareness — works for both scopes:
 * .withExtension('sync', ({ ydoc, awareness, whenReady }) => {
 *   return createProvider({ doc: ydoc, awareness: awareness.raw, whenReady });
 * })
 * ```
 */
export type SharedExtensionContext = {
	ydoc: Y.Doc;
	awareness: { raw: Awareness };
	whenReady: Promise<void>;
};

/**
 * Factory function that creates an extension.
 *
 * Returns a flat object with custom exports + optional `whenReady` and `dispose`.
 * The framework normalizes defaults via `defineExtension()`.
 *
 * @example Simple extension (works with any workspace)
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     provider,
 *     whenReady: provider.whenReady,
 *     dispose: () => provider.dispose(),
 *   };
 * };
 * ```
 *
 * @typeParam TExports - The consumer-facing exports object type
 */
export type ExtensionFactory<
	TExports extends Record<string, unknown> = Record<string, unknown>,
> = (context: ExtensionContext) => TExports & {
	whenReady?: Promise<unknown>;
	dispose?: () => MaybePromise<void>;
	clearLocalData?: () => MaybePromise<void>;
};

/** The workspace client returned by createWorkspace() */
export type WorkspaceClient<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown>,
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
> = {
	/** Workspace identifier */
	id: TId;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace definitions for introspection */
	definitions: {
		tables: TTableDefinitions;
		kv: TKvDefinitions;
		awareness: TAwarenessDefinitions;
	};
	/** Typed table helpers — pure CRUD, no document management */
	tables: TablesHelper<TTableDefinitions>;
	/** Document managers — only tables with `.withDocument()` appear here */
	documents: DocumentsHelper<TTableDefinitions, TDocExtensions>;
	/** Typed KV helper */
	kv: KvHelper<TKvDefinitions>;
	/** Typed awareness helper — always present, like tables and kv */
	awareness: AwarenessHelper<TAwarenessDefinitions>;
	/**
	 * Extension exports (accumulated via `.withExtension()` calls).
	 *
	 * Each entry is the exports object returned by the extension factory.
	 * Access exports directly — no wrapper:
	 *
	 * ```typescript
	 * client.extensions.persistence.clearLocalData();
	 * client.extensions.sqlite.db.query('SELECT ...');
	 * ```
	 *
	 * Use `client.whenReady` to wait for all extensions to initialize.
	 */
	extensions: TExtensions;

	/**
	 * Execute multiple operations atomically in a single Y.js transaction.
	 *
	 * Groups all table and KV mutations inside the callback into one transaction.
	 * This means:
	 * - Observers fire once (not per-operation)
	 * - Creates a single undo/redo step
	 * - All changes are applied together
	 *
	 * The callback receives nothing because `tables` and `kv` are the same objects
	 * whether you're inside `batch()` or not — `ydoc.transact()` makes ALL operations
	 * on the shared doc atomic automatically. No special transactional wrapper needed.
	 *
	 * **Note**: Yjs transactions do NOT roll back on error. If the callback throws,
	 * any mutations that already executed within the callback are still applied.
	 *
	 * Nested `batch()` calls are safe — Yjs transact is reentrant, so inner calls
	 * are absorbed by the outer transaction.
	 *
	 * @param fn - Callback containing table/KV operations to batch
	 *
	 * @example Single table batching
	 * ```typescript
	 * client.batch(() => {
	 *   client.tables.posts.set({ id: '1', title: 'First' });
	 *   client.tables.posts.set({ id: '2', title: 'Second' });
	 *   client.tables.posts.delete('3');
	 * });
	 * // Observer fires once with all 3 changed IDs
	 * ```
	 *
	 * @example Cross-table + KV batching
	 * ```typescript
	 * client.batch(() => {
	 *   client.tables.tabs.set({ id: '1', url: 'https://...' });
	 *   client.tables.windows.set({ id: 'w1', name: 'Main' });
	 *   client.kv.set('lastSync', new Date().toISOString());
	 * });
	 * // All three writes are one atomic transaction
	 * ```
	 *
	 */
	batch(fn: () => void): void;
	/**
	 * Apply a binary Y.js update to the underlying document.
	 *
	 * Use this to hydrate the workspace from a persisted snapshot (e.g. a `.yjs`
	 * file on disk) without exposing the raw Y.Doc to consumer code.
	 *
	 * @param update - A Uint8Array produced by `Y.encodeStateAsUpdate()` or equivalent
	 */
	loadSnapshot(update: Uint8Array): void;

	/**
	 * Apply encryption keys to all stores.
	 *
	 * Decodes base64 user keys, derives per-workspace keys via HKDF-SHA256,
	 * and activates encryption on all stores. Once activated, stores permanently
	 * refuse plaintext writes — the only reset path is `clearLocalData()`.
	 *
	 * This method is synchronous — HKDF via @noble/hashes and XChaCha20 via
	 * @noble/ciphers are both sync. Call it after persistence is ready but
	 * before connecting sync.
	 *
	 * @param keys - Non-empty array of versioned user keys from the auth session
	 *
	 * @example
	 * ```typescript
	 * await workspace.whenReady;
	 * workspace.applyEncryptionKeys(session.encryptionKeys);
	 * workspace.extensions.sync.connect();
	 * ```
	 */
	applyEncryptionKeys(keys: EncryptionKeys): void;

	/**
	 * Wipe local workspace data.
	 *
	 * Calls extension `clearLocalData()` hooks in LIFO order.
	 */
	clearLocalData(): Promise<void>;

	/**
	 * Resolves when all extensions have finished initializing.
	 *
	 * This is a composite promise—it resolves when every extension's individual
	 * `whenReady` has resolved. Use it as a render gate in UI frameworks to
	 * avoid showing the app before data is loaded.
	 *
	 * @example
	 * ```svelte
	 * {#await client.whenReady}
	 *   <Loading />
	 * {:then}
	 *   <App />
	 * {/await}
	 * ```
	 */
	whenReady: Promise<void>;

	/**
	 * Release all resources—data is preserved on disk.
	 *
	 * Calls `dispose()` on every extension in LIFO order (last registered, first disposed).
	 * Stops observers, closes database connections, disconnects sync providers.
	 *
	 * After calling, the client is unusable.
	 *
	 * Safe to call multiple times (idempotent).
	 */
	dispose(): Promise<void>;

	/** Async dispose support */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Type alias for any workspace client (used for duck-typing in CLI/server).
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly type
export type AnyWorkspaceClient = WorkspaceClient<
	any,
	any,
	any,
	any,
	any,
	any
> & {
	actions?: Actions;
};
