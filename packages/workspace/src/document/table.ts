/**
 * Table definition types and the `createTable` / `createReadonlyTable`
 * builders. `createWorkspace` (in `./workspace.ts`) consumes these to mount
 * tables onto a workspace root, applying encryption when a keyring is
 * provided.
 *
 * This file also keeps `attachTable` as an internal helper used by
 * package-local benchmarks and the create-table test. It is intentionally
 * NOT exported from the package barrel: public callers go through
 * `createWorkspace`.
 *
 * The library owns `_v` end-to-end: stamped on every write, stripped from
 * every read, refused as a column key at compile time. Users define columns
 * and (for multi-version tables) one migrate function. The user-facing row
 * type contains only the user's columns.
 */

import { type Static, type TObject, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { TableKey } from './keys';
import {
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index';

// ════════════════════════════════════════════════════════════════════════════
// TABLE PARSE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when parsing stored rows against a table's schema.
 *
 * Surfaced by `get()`, `getAll()`, `getAllValid()`, `getAllInvalid()`,
 * `filter()`, `find()`, and `update()`. "Not found" on `get()` / `update()`
 * is *not* an error: it's a legitimate absence and is returned as
 * `data: null` instead.
 */
export const TableParseError = defineErrors({
	/** The row's `_v` did not match any registered schema version. */
	UnknownVersion: ({ id, version }: { id: string; version: unknown }) => ({
		message: `Row '${id}' has unknown _v value: ${String(version)}`,
		id,
		version,
	}),
	/** TypeBox `Value.Check` rejected the row against the matched version. */
	ValidationFailed: ({
		id,
		errors,
		row,
	}: {
		id: string;
		errors: readonly { path: string; message: string }[];
		row: unknown;
	}) => ({
		message: `Row '${id}' failed schema validation: ${errors
			.map((e) => `${e.path}: ${e.message}`)
			.join('; ')}`,
		id,
		errors,
		row,
	}),
	/** The migration function threw while upgrading a valid-at-parse-time row. */
	MigrationFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Row '${id}' could not be migrated: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type TableParseError = InferErrors<typeof TableParseError>;

// ════════════════════════════════════════════════════════════════════════════
// ROW TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every table row must satisfy.
 *
 * `_v` is library state and lives only on the stored payload, never on the
 * user-facing row type. `BaseRow` carries only `id`.
 */
export type BaseRow = { id: string };

// ════════════════════════════════════════════════════════════════════════════
// COLUMN RECORD TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A column record. Every table version is a `Record<string, TSchema>` with
 * a string-ish `id` column. `_v` is library-managed and refused as a column
 * key at compile time via `defineTable`'s parameter constraint.
 *
 * `FlatJsonTSchema` (applied in `defineTable`'s parameter type) enforces
 * every column maps 1:1 to a SQLite column.
 */
export type VersionedColumns = {
	id: TSchema;
	[key: string]: TSchema;
};

/** Convert a column record to its row static type. */
export type RowOf<TCols extends Record<string, TSchema>> = {
	[K in keyof TCols]: Static<TCols[K]>;
};

export type LastVersion<TVersions extends readonly VersionedColumns[]> =
	TVersions extends readonly [...infer _, infer L]
		? L extends VersionedColumns
			? L
			: TVersions[number]
		: TVersions[number];

// ════════════════════════════════════════════════════════════════════════════
// MIGRATE INPUT TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Bounded type-level addition: returns `N + 1` as a literal.
 *
 * Used to map tuple positions (0-indexed) to version numbers (1-indexed) for
 * the migrate function's input discriminator.
 */
type IncrementVersion<
	N extends number,
	Acc extends unknown[] = [],
> = Acc['length'] extends N
	? [...Acc, unknown]['length']
	: IncrementVersion<N, [...Acc, unknown]>;

/**
 * Migrate input: walks the versions tuple and accumulates `{ value, version }`
 * pairs where `version = position + 1`. Distributing this as a union gives
 * TypeScript discriminated narrowing on `switch (version)` in the migrate fn.
 *
 * For `defineTable(v1Cols, v2Cols)`:
 *   MigrateInput = { value: RowOf<v1Cols>; version: 1 }
 *                | { value: RowOf<v2Cols>; version: 2 }
 */
export type MigrateInput<
	TVersions extends readonly VersionedColumns[],
	Acc extends readonly unknown[] = [],
> = TVersions extends readonly [
	infer Head,
	...infer Rest extends readonly VersionedColumns[],
]
	? Head extends VersionedColumns
		? MigrateInput<
				Rest,
				readonly [
					...Acc,
					{
						value: RowOf<Head>;
						version: IncrementVersion<Acc['length'] & number>;
					},
				]
			>
		: never
	: Acc[number];

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION
// ════════════════════════════════════════════════════════════════════════════

/**
 * A table definition created by `defineTable(cols)` (single version) or
 * `defineTable(v1, v2, ...).migrate(fn)` (multi-version).
 *
 * For per-row content (rich text, long-form body), keep the row lean (ids and
 * metadata) and derive the content-doc guid in app code. Browser runtimes can
 * pair the table with a `createDisposableCache(builder)` keyed by row id; daemon
 * projections can open one content doc for one row and destroy it after reading.
 * The table schema does not declare or store body docs.
 */
export type TableDefinition<
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = {
	/** The original variadic versions, in declaration order. */
	versions: TVersions;
	/**
	 * Latest version's row schema as a TypeBox `TObject` (user-facing; no `_v`).
	 *
	 * Use as the runtime schema for full-row action inputs:
	 * ```ts
	 * defineMutation({ input: tables.notes.schema, handler: tables.notes.set });
	 * ```
	 *
	 * Pluck individual column schemas via `.properties.X` for narrow inputs:
	 * ```ts
	 * Type.Object({
	 *   id:    tables.notes.schema.properties.id,
	 *   title: tables.notes.schema.properties.title,
	 * })
	 * ```
	 *
	 * The SQLite DDL generator and markdown materializer both read this field.
	 */
	schema: TObject<LastVersion<TVersions>>;
	/** Upgrade any stored version to the current row in one step. */
	migrate: (input: MigrateInput<TVersions>) => RowOf<LastVersion<TVersions>>;
};

/**
 * Extract the user-facing row type from a TableDefinition.
 *
 * Intersected with `BaseRow` so that `id: string` is guaranteed even when
 * the generic widens (e.g. `TableDefinition<any>` in `TableDefinitions`).
 */
export type InferTableRow<T> =
	T extends TableDefinition<infer TVersions>
		? TVersions extends readonly VersionedColumns[]
			? RowOf<LastVersion<TVersions>> & BaseRow
			: BaseRow
		: never;

/** Map of table definitions (uses `any` to allow variance in generic parameters). */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

// ════════════════════════════════════════════════════════════════════════════
// createTableDefinition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a `TableDefinition` from a list of versions and the migrate function.
 * Called by `defineTable`; exposed for future codegen / encryption helpers
 * that need to assemble a definition directly.
 *
 * @internal
 */
export function createTableDefinition<
	TVersions extends readonly VersionedColumns[],
>(
	versions: TVersions,
	migrate: (input: unknown) => RowOf<LastVersion<TVersions>>,
): TableDefinition<TVersions> {
	const latestColumns = versions[versions.length - 1] as LastVersion<TVersions>;
	return {
		versions,
		schema: Type.Object(latestColumns),
		migrate: migrate as TableDefinition<TVersions>['migrate'],
	};
}

// ════════════════════════════════════════════════════════════════════════════
// TABLE HANDLE TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Type-safe read-only runtime handle for a single workspace table.
 *
 * Mirrors `schema` (the latest version's row TObject) from the definition for
 * ergonomics; the underlying `definition` stays exposed for introspection.
 */
export type ReadonlyTable<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = {
	/** The table name (the Y.Array key this table is bound to). */
	name: string;

	/** The underlying `TableDefinition`. */
	definition: TableDefinition<TVersions>;

	/**
	 * Latest version's row schema (mirrored from `definition.schema`).
	 *
	 * Use as the runtime schema for full-row action inputs, or pluck
	 * individual column schemas via `.properties.X` for narrow inputs.
	 * See `TableDefinition.schema` JSDoc for examples.
	 */
	schema: TObject<LastVersion<TVersions>>;

	get(id: string): Result<TRow | null, TableParseError>;
	getAll(): Array<Result<TRow, TableParseError>>;
	getAllValid(): TRow[];
	getAllInvalid(): TableParseError[];
	filter(predicate: (row: TRow) => boolean): TRow[];
	find(predicate: (row: TRow) => boolean): TRow | undefined;
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;
	count(): number;
	has(id: string): boolean;
};

export type Table<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = ReadonlyTable<TRow, TVersions> & {
	set(row: TRow): void;
	bulkSet(
		rows: TRow[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;
	update(
		id: string,
		partial: Partial<Omit<TRow, 'id'>>,
	): Result<TRow | null, TableParseError>;
	delete(id: string): void;
	bulkDelete(
		ids: string[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;
	clear(): void;
};

/** Map keyed by table name to Table for that table's row type. */
export type Tables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
};

export type ReadonlyTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: ReadonlyTable<
		InferTableRow<TTableDefinitions[K]>
	>;
};

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL: attach (used by package-local benchmarks + tests; NOT exported
// from the public barrel: public callers go through `createWorkspace`)
// ════════════════════════════════════════════════════════════════════════════

export function attachTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.once('destroy', () => ykv[Symbol.dispose]());
	return createTable(ykv, definition, name);
}

// ════════════════════════════════════════════════════════════════════════════
// createTable / createReadonlyTable
// ════════════════════════════════════════════════════════════════════════════

export function createReadonlyTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): ReadonlyTable<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

	const versions = definition.versions as readonly VersionedColumns[];

	/**
	 * Per-version augmented schema (user columns + `_v: Literal(N)`), keyed
	 * by version number (1-indexed = tuple position + 1). Used to validate
	 * stored rows: storage carries `_v`, so we route on it before validating.
	 */
	const versionSchemas = new Map<number, TObject>();
	for (let i = 0; i < versions.length; i++) {
		const versionNumber = i + 1;
		const cols = versions[i]!;
		versionSchemas.set(
			versionNumber,
			Type.Object({ ...cols, _v: Type.Literal(versionNumber) }) as TObject,
		);
	}

	/**
	 * Parse a stored row value. Injects `id` into the input, routes by stored
	 * `_v` to the matching schema, validates, runs migrate, returns the
	 * user-facing row (no `_v`).
	 */
	function parseRow(id: string, input: unknown): Result<TRow, TableParseError> {
		const stored: Record<string, unknown> = {
			...(input as Record<string, unknown>),
			id,
		};
		const version = stored._v;
		const schema =
			typeof version === 'number' ? versionSchemas.get(version) : undefined;
		if (!schema) {
			return TableParseError.UnknownVersion({ id, version });
		}
		if (!Value.Check(schema, stored)) {
			const errors = [...Value.Errors(schema, stored)].map((e) => ({
				path: e.instancePath,
				message: e.message,
			}));
			return TableParseError.ValidationFailed({ id, errors, row: stored });
		}
		try {
			// Strip `_v` from the value passed to migrate. The user's migrate fn
			// works in terms of the version's user-facing columns only.
			const { _v: _, ...value } = stored;
			const migrated = definition.migrate({
				value,
				version,
			} as Parameters<typeof definition.migrate>[0]) as TRow;
			return Ok(migrated);
		} catch (cause) {
			return TableParseError.MigrationFailed({ id, cause });
		}
	}

	return {
		name,
		definition,
		schema: definition.schema,

		get(id: string): Result<TRow | null, TableParseError> {
			const raw = ykv.get(id);
			if (raw === undefined) return Ok(null);
			return parseRow(id, raw);
		},

		getAll(): Array<Result<TRow, TableParseError>> {
			const results: Array<Result<TRow, TableParseError>> = [];
			for (const [key, entry] of ykv.entries()) {
				results.push(parseRow(key, entry.val));
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error) rows.push(data);
			}
			return rows;
		},

		getAllInvalid(): TableParseError[] {
			const invalid: TableParseError[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { error } = parseRow(key, entry.val);
				if (error) invalid.push(error);
			}
			return invalid;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error && predicate(data)) rows.push(data);
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error && predicate(data)) return data;
			}
			return undefined;
		},

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
		): () => void {
			const handler: KvStoreChangeHandler<unknown> = (changes, origin) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, origin);
			};
			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		count(): number {
			return ykv.size;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}

export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
	const readonly = createReadonlyTable(ykv, definition, name);

	const latestVersion = definition.versions.length;
	/** Stamp the latest `_v` onto a row for storage. */
	const stamp = (row: TRow): Record<string, unknown> => ({
		...(row as Record<string, unknown>),
		_v: latestVersion,
	});

	return {
		...readonly,

		set(row: TRow): void {
			ykv.set(row.id, stamp(row));
		},

		async bulkSet(
			rows: TRow[],
			{
				chunkSize = 1000,
				onProgress,
			}: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			} = {},
		): Promise<void> {
			const total = rows.length;
			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: stamp(row) })));
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		update(
			id: string,
			partial: Partial<Omit<TRow, 'id'>>,
		): Result<TRow | null, TableParseError> {
			const { data: current, error } = readonly.get(id);
			if (error) return Err(error);
			if (current === null) return Ok(null);

			// `current` is already the latest-version user-facing row (get()
			// migrates on read), so merging with a partial keeps us in the
			// latest shape. Validate against the latest schema directly: no
			// need to stamp _v, route, and re-migrate just to write back.
			const merged = { ...current, ...partial, id } as TRow;
			if (!Value.Check(definition.schema, merged)) {
				const errors = [...Value.Errors(definition.schema, merged)].map(
					(e) => ({
						path: e.instancePath,
						message: e.message,
					}),
				);
				return TableParseError.ValidationFailed({ id, errors, row: merged });
			}
			ykv.set(merged.id, stamp(merged));
			return Ok(merged);
		},

		delete(id: string): void {
			ykv.delete(id);
		},

		async bulkDelete(
			ids: string[],
			{
				chunkSize = 2500,
				onProgress,
			}: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			} = {},
		): Promise<void> {
			const total = ids.length;
			for (let i = 0; i < total; i += chunkSize) {
				const chunk = ids.slice(i, i + chunkSize);
				ykv.bulkDelete(chunk);
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		clear(): void {
			const keys = Array.from(ykv.entries()).map(([k]) => k);
			ykv.bulkDelete(keys);
		},
	};
}
