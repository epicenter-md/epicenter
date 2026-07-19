import type { SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type CanonicalStore,
	isWorkspaceRowAbsentError,
} from './canonical-store.js';
import {
	type ConstrainedChanges,
	type CreateInputFor,
	compileTableLens,
	type JsonObject,
	type RowFor,
	RowLensError,
	type TableLensDefinition,
	type TableLensDefinitions,
} from './lens-definition.js';

const ROW_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const mintRowId = customAlphabet(ROW_ID_ALPHABET, 24);

export type CanonicalTable<TDefinition extends TableLensDefinition> = {
	/** Read and project one current row through this release's lens. */
	get(id: string): Result<RowFor<TDefinition> | undefined, RowLensError>;
	/** List every current row, partitioned by release-lens conformance. */
	list(): {
		rows: RowFor<TDefinition>[];
		nonconforming: RowLensError[];
	};
	/** Validate complete fields and allocate the row's structural id. */
	create(fields: CreateInputFor<TDefinition>): RowFor<TDefinition>;
	/** Validate and apply supplied absolute field changes. */
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		changes: TChanges & ConstrainedChanges<TDefinition, TChanges>,
	): Result<RowFor<TDefinition> | undefined, RowLensError>;
	delete(id: string): void;
};

export type CanonicalTables<TTables extends TableLensDefinitions> = {
	[K in keyof TTables]: CanonicalTable<TTables[K]>;
};

/** Open one release-local table lens over a schema-opaque canonical store. */
export function createCanonicalRowsView<
	const TTables extends TableLensDefinitions,
>(store: CanonicalStore, definitions: TTables) {
	assertDefinitions(definitions);

	const tables = Object.fromEntries(
		Object.entries(definitions).map(([tableName, definition]) => {
			const lens = compileTableLens(definition);
			const table = {
				get(id: string) {
					const fields = store.read(tableName, id);
					return fields === undefined
						? Ok(undefined)
						: lens.project(tableName, id, fields);
				},
				list() {
					const rows: Record<string, unknown>[] = [];
					const nonconforming: RowLensError[] = [];
					for (const current of listRows(tableName)) {
						const result = lens.project(
							tableName,
							current.rowId,
							current.fields,
						);
						if (result.error === null) rows.push(result.data);
						else nonconforming.push(result.error);
					}
					return { rows, nonconforming };
				},
				create(input: Record<string, unknown>) {
					const fields = lens.validateCreate(input);
					const id = mintRowId();
					const intent = {
						kind: 'create',
						table: tableName,
						rowId: id,
						fields,
					} as const;
					store.admit(intent);
					return expectConforming(lens.project(tableName, id, fields));
				},
				update(id: string, changes: Record<string, unknown>) {
					const normalized = lens.normalizeChanges(changes);
					const current = store.read(tableName, id);
					if (current === undefined) {
						return RowLensError.MissingRow({ table: tableName, id });
					}
					if (
						Object.keys(normalized.set).length === 0 &&
						normalized.unset.length === 0
					) {
						return lens.project(tableName, id, current);
					}
					const intent = {
						kind: 'update',
						table: tableName,
						rowId: id,
						fields: normalized,
					} as const;
					try {
						store.admit(intent);
					} catch (cause) {
						// The row can die between the read above and admission; the
						// owner guard refuses it there, surfaced as the same result.
						if (isWorkspaceRowAbsentError(cause)) {
							return RowLensError.MissingRow({ table: tableName, id });
						}
						throw cause;
					}
					const projected = store.read(tableName, id);
					return projected === undefined
						? RowLensError.MissingRow({ table: tableName, id })
						: lens.project(tableName, id, projected);
				},
				delete(id: string) {
					// The owner guard refuses a delete of an absent row with the
					// named WorkspaceRowAbsentError; there is no silent success.
					store.admit({ kind: 'delete', table: tableName, rowId: id });
				},
			};
			return [tableName, table];
		}),
	) as CanonicalTables<TTables>;

	return {
		tables,
		/** Execute one locally validated SELECT against the raw `records` relation. */
		sql<TResultSchema extends TSchema>(
			query: string,
			parameters: readonly SqliteValue[],
			resultSchema: TResultSchema,
		): Static<TResultSchema>[] {
			const rows = store.sql(query, parameters);
			for (const [index, row] of rows.entries()) {
				if (!Value.Check(resultSchema, row)) {
					const issues = [...Value.Errors(resultSchema, row)]
						.map((issue) => `${issue.instancePath}: ${issue.message}`)
						.join('; ');
					throw new TypeError(
						`SQL row ${index} does not satisfy the result schema: ${issues}`,
					);
				}
			}
			return rows as Static<TResultSchema>[];
		},
	};

	function listRows(table: string): { rowId: string; fields: JsonObject }[] {
		return store.list(table);
	}
}

export type CanonicalRows<
	TTables extends TableLensDefinitions = TableLensDefinitions,
> = ReturnType<typeof createCanonicalRowsView<TTables>>;

function expectConforming<TResult>(
	result: Result<TResult, RowLensError>,
): TResult {
	if (result.error !== null) throw new Error(result.error.message);
	return result.data;
}

function assertDefinitions(definitions: TableLensDefinitions): void {
	if (!isPlainObject(definitions)) {
		throw new TypeError('Table lenses must be a plain object');
	}
	const sqliteNames = new Set<string>();
	for (const [name, definition] of Object.entries(definitions)) {
		assertSqlName(name, 'table name');
		const sqliteName = name.toLowerCase();
		if (sqliteNames.has(sqliteName)) {
			throw new Error(`Table '${name}' collides with another table in SQLite`);
		}
		sqliteNames.add(sqliteName);
		compileTableLens(definition);
	}
}

function assertSqlName(value: string, label: string): void {
	if (
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(value) ||
		value.startsWith('__epicenter_') ||
		value.toLowerCase().startsWith('sqlite_')
	) {
		throw new Error(
			`Invalid ${label} '${value}'; use letters, digits, and underscores and do not use reserved SQLite or internal prefixes`,
		);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
