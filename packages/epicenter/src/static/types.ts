/**
 * Shared types for the Static Workspace API.
 *
 * This module contains all type definitions for versioned tables and KV stores.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { Lifecycle } from '../shared/lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES - Building Blocks
// ════════════════════════════════════════════════════════════════════════════

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

/** Result of deleting a single row */
export type DeleteResult =
	| { status: 'deleted' }
	| { status: 'not_found_locally' };

/** Result of updating a single row */
export type UpdateResult<TRow> =
	| { status: 'updated'; row: TRow }
	| NotFoundResult
	| InvalidRowResult;

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Result of getting a KV value */
export type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| {
			status: 'invalid';
			errors: readonly StandardSchemaV1.Issue[];
			value: unknown;
	  }
	| { status: 'not_found'; value: undefined };

/** Change event for KV observation */
export type KvChange<TValue> =
	| { type: 'set'; value: TValue }
	| { type: 'delete' };

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Extract the last element from a tuple, constrained to StandardSchemaV1 */
export type LastSchema<T extends readonly StandardSchemaV1[]> =
	T extends readonly [...StandardSchemaV1[], infer L extends StandardSchemaV1]
		? L
		: T[number];

/**
 * A table definition created by defineTable().version().migrate()
 *
 * @typeParam TVersions - Tuple of StandardSchemaV1 types representing all versions
 */
export type TableDefinition<TVersions extends readonly StandardSchemaV1[]> = {
	schema: StandardSchemaV1<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>> & { id: string };
};

/** Extract the row type from a TableDefinition */
export type InferTableRow<T> =
	T extends TableDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<LastSchema<V>> & { id: string }
		: never;

/** Extract the version union type from a TableDefinition */
export type InferTableVersionUnion<T> =
	T extends TableDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<V[number]>
		: never;

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by defineKv().version().migrate()
 *
 * @typeParam TVersions - Tuple of StandardSchemaV1 types representing all versions
 */
export type KvDefinition<TVersions extends readonly StandardSchemaV1[]> = {
	schema: StandardSchemaV1<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		value: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
};

/** Extract the value type from a KvDefinition */
export type InferKvValue<T> =
	T extends KvDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<LastSchema<V>>
		: never;

/** Extract the version union type from a KvDefinition */
export type InferKvVersionUnion<T> =
	T extends KvDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<V[number]>
		: never;

// ════════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Operations available inside a table batch transaction. */
export type TableBatchTransaction<TRow extends { id: string }> = {
	set(row: TRow): void;
	delete(id: string): void;
};

/** Helper for a single table */
export type TableHelper<TRow extends { id: string }> = {
	// ═══════════════════════════════════════════════════════════════════════
	// PARSE
	// ═══════════════════════════════════════════════════════════════════════

	/** Parse unknown input against the table schema and migrate to latest version. Injects `id` into the input. Does not write. */
	parse(id: string, input: unknown): RowResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// WRITE (always writes latest schema shape)
	// ═══════════════════════════════════════════════════════════════════════

	/** Set a row (insert or replace). Always writes full row. */
	set(row: TRow): void;

	// ═══════════════════════════════════════════════════════════════════════
	// READ (validates + migrates to latest)
	// ═══════════════════════════════════════════════════════════════════════

	/** Get a row by ID. Returns GetResult (valid | invalid | not_found). */
	get(id: string): GetResult<TRow>;

	/** Get all rows with validation status. */
	getAll(): RowResult<TRow>[];

	/** Get all valid rows (skips invalid). */
	getAllValid(): TRow[];

	/** Get all invalid rows with storage keys (for debugging/repair). */
	getAllInvalid(): InvalidRowResult[];

	// ═══════════════════════════════════════════════════════════════════════
	// QUERY
	// ═══════════════════════════════════════════════════════════════════════

	/** Filter rows by predicate (only valid rows). */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/** Find first row matching predicate (only valid rows). */
	find(predicate: (row: TRow) => boolean): TRow | undefined;

	// ═══════════════════════════════════════════════════════════════════════
	// UPDATE
	// ═══════════════════════════════════════════════════════════════════════

	/** Partial update a row by ID. Fetches current, merges partial, and saves. */
	update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/** Delete a row by ID. */
	delete(id: string): DeleteResult;

	/** Delete all rows (table structure preserved). */
	clear(): void;

	// ═══════════════════════════════════════════════════════════════════════
	// BATCH (Y.js transaction for atomicity)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 * - Single undo/redo step
	 * - Observers fire once (not per-operation)
	 * - All changes applied together
	 */
	batch(fn: (tx: TableBatchTransaction<TRow>) => void): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/** Watch for row changes. Returns unsubscribe function. */
	observe(
		callback: (changedIds: Set<string>, transaction: unknown) => void,
	): () => void;

	// ═══════════════════════════════════════════════════════════════════════
	// METADATA
	// ═══════════════════════════════════════════════════════════════════════

	/** Number of rows in table. */
	count(): number;

	/** Check if row exists. */
	has(id: string): boolean;
};

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of table definitions (uses `any` to allow variance in generic parameters) */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

/** Map of KV definitions (uses `any` to allow variance in generic parameters) */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/** Tables helper object with all table helpers */
export type TablesHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	>;
};

/** Operations available inside a KV batch transaction. */
export type KvBatchTransaction<TKvDefinitions extends KvDefinitions> = {
	set<K extends keyof TKvDefinitions & string>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;
	delete<K extends keyof TKvDefinitions & string>(key: K): void;
};

/** KV helper with dictionary-style access */
export type KvHelper<TKvDefinitions extends KvDefinitions> = {
	/** Get a value by key (validates + migrates). */
	get<K extends keyof TKvDefinitions & string>(
		key: K,
	): KvGetResult<InferKvValue<TKvDefinitions[K]>>;

	/** Set a value by key (always latest schema). */
	set<K extends keyof TKvDefinitions & string>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;

	/** Delete a value by key. */
	delete<K extends keyof TKvDefinitions & string>(key: K): void;

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 */
	batch(fn: (tx: KvBatchTransaction<TKvDefinitions>) => void): void;

	/** Watch for changes to a key. Returns unsubscribe function. */
	observe<K extends keyof TKvDefinitions & string>(
		key: K,
		callback: (
			change: KvChange<InferKvValue<TKvDefinitions[K]>>,
			transaction: unknown,
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
> = {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
};

/**
 * A workspace client with actions attached via `.withActions()`.
 *
 * This is an intersection of the base `WorkspaceClient` and `{ actions: TActions }`.
 * It is terminal — no more builder methods are available after `.withActions()`.
 */
export type WorkspaceClientWithActions<
	TId extends string,
	TTableDefs extends TableDefinitions,
	TKvDefs extends KvDefinitions,
	TExtensions extends ExtensionMap,
	TActions extends Actions,
> = WorkspaceClient<TId, TTableDefs, TKvDefs, TExtensions> & {
	actions: TActions;
};

/**
 * Builder returned by createWorkspace() that IS a client AND has .withExtensions() and .withActions().
 *
 * This uses Object.assign to merge the base client with the builder methods,
 * allowing direct use: `createWorkspace(...).tables.posts.set(...)` or
 * chaining: `createWorkspace(...).withExtensions({ sqlite })`.
 */
export type WorkspaceClientBuilder<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
> = WorkspaceClient<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	Record<string, never>
> & {
	/**
	 * Add extensions to the workspace client.
	 *
	 * Extensions receive typed access to ydoc, tables, and kv.
	 * They must return a Lifecycle object (via defineExports).
	 *
	 * @param extensions - Map of extension factories
	 * @returns Workspace client with extensions accessible via `.extensions`
	 */
	withExtensions<TExtensions extends ExtensionMap>(
		extensions: TExtensions,
	): WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TExtensions> & {
		/** Attach actions to the client. Terminal — no more builder methods after this. */
		withActions<TActions extends Actions>(
			factory: (
				client: WorkspaceClient<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TExtensions
				>,
			) => TActions,
		): WorkspaceClientWithActions<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			TExtensions,
			TActions
		>;
	};

	/** Attach actions to the client. Terminal — no more builder methods after this. */
	withActions<TActions extends Actions>(
		factory: (
			client: WorkspaceClient<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				Record<string, never>
			>,
		) => TActions,
	): WorkspaceClientWithActions<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		Record<string, never>,
		TActions
	>;
};

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to extension factory functions.
 *
 * Extensions receive typed access to the workspace's Y.Doc and helpers,
 * allowing them to attach persistence, sync, or other functionality with
 * full type safety.
 *
 * The generic parameters are bound at the workspace level - when you call
 * `createWorkspace(...).withExtensions({ myExtension })`, the context is typed
 * with the workspace's specific table and KV definitions.
 *
 * @typeParam TTableDefinitions - Map of table definitions for this workspace
 * @typeParam TKvDefinitions - Map of KV definitions for this workspace
 */
export type ExtensionContext<
	TTableDefinitions extends TableDefinitions = TableDefinitions,
	TKvDefinitions extends KvDefinitions = KvDefinitions,
> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier */
	id: string;
	/** Typed table helpers for the workspace */
	tables: TablesHelper<TTableDefinitions>;
	/** Typed KV helper for the workspace */
	kv: KvHelper<TKvDefinitions>;
};

/**
 * Factory function that creates an extension with lifecycle hooks.
 *
 * All extensions MUST return an object that satisfies the {@link Lifecycle} protocol:
 * - `whenSynced`: Promise that resolves when the extension is ready
 * - `destroy`: Cleanup function called when the workspace is destroyed
 *
 * Use {@link defineExports} from `shared/lifecycle.ts` to easily create compliant exports.
 *
 * @example Simple extension (works with any workspace)
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return defineExports({
 *     provider,
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 *
 * @example Extension bound to specific workspace types
 * ```typescript
 * const logger: ExtensionFactory<MyTables, MyKv> = ({ tables }) => {
 *   // tables is fully typed as TablesHelper<MyTables>
 *   tables.posts.getAll(); // ← autocomplete works!
 *   return defineExports();
 * };
 * ```
 *
 * @typeParam TTableDefinitions - Table definitions this extension accepts (defaults to any)
 * @typeParam TKvDefinitions - KV definitions this extension accepts (defaults to any)
 * @typeParam TExports - The exports returned by this extension (must extend Lifecycle)
 */
export type ExtensionFactory<
	TTableDefinitions extends TableDefinitions = TableDefinitions,
	TKvDefinitions extends KvDefinitions = KvDefinitions,
	TExports extends Lifecycle = Lifecycle,
> = (context: ExtensionContext<TTableDefinitions, TKvDefinitions>) => TExports;

/**
 * Map of extension factories.
 *
 * Each extension must return a `Lifecycle` (with `whenSynced` and `destroy`).
 * Use `defineExports()` from `shared/lifecycle.ts` to easily create compliant returns:
 *
 * ```typescript
 * import { defineExports } from 'epicenter';
 *
 * const myExtension = () => defineExports({
 *   db: createDatabase(),
 *   destroy: () => db.close(),
 * });
 * // Returns: { db, whenSynced: Promise.resolve(), destroy: closeFn }
 * ```
 */
export type ExtensionMap = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: extension factories are variadic
	(...args: any[]) => Lifecycle
>;

/**
 * Infer exports from an extension map.
 *
 * Extensions return `Lifecycle & CustomExports` via `defineExports()`.
 * This type extracts the full return type of each extension.
 *
 * @typeParam TExtensions - The extension map to infer exports from
 */
export type InferExtensionExports<TExtensions extends ExtensionMap> = {
	[K in keyof TExtensions]: ReturnType<TExtensions[K]>;
};

/** The workspace client returned by createWorkspace() */
export type WorkspaceClient<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TExtensions extends ExtensionMap,
> = {
	/** Workspace identifier */
	id: TId;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Typed table helpers */
	tables: TablesHelper<TTableDefinitions>;
	/** Typed KV helper */
	kv: KvHelper<TKvDefinitions>;
	/** Workspace definitions for introspection */
	definitions: { tables: TTableDefinitions; kv: TKvDefinitions };
	/** Extension exports */
	extensions: InferExtensionExports<TExtensions>;

	/** Cleanup all resources */
	destroy(): Promise<void>;

	/** Async dispose support */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Type alias for any workspace client (used for duck-typing in CLI/server).
 * Includes optional actions property since clients may or may not have actions attached.
 */
export type AnyWorkspaceClient = WorkspaceClient<any, any, any, any> & {
	actions?: Actions;
};
