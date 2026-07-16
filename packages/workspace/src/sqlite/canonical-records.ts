import type {
	RecordCommand,
	RecordSyncSqlite,
	SqliteRow,
	SqliteValue,
} from '@epicenter/record-sync';
import { foldRow, isAdmissibleCanonicalRow } from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type ConstrainedPatch,
	type CreateInputFor,
	compileTableLens,
	type JsonObject,
	type RecordLensError,
	type RowFor,
	type TableLensDefinition,
	type TableLensDefinitions,
} from './lens-definition.js';

const RECORDS_TABLE = '__epicenter_records';
const MAX_SCAN_LIMIT = 1_000;

export type CanonicalTable<TDefinition extends TableLensDefinition> = {
	/** Read and project one canonical row through this release's lens. */
	get(id: string): Result<RowFor<TDefinition> | null, RecordLensError>;
	/** Read one bounded, row-id ordered page and partition it by conformance. */
	scan(options: { cursor?: string; limit: number }): {
		rows: RowFor<TDefinition>[];
		nonconforming: RecordLensError[];
		nextCursor: string | undefined;
	};
	/** Validate a complete current-lens row and allocate its structural id. */
	create(input: CreateInputFor<TDefinition>): RowFor<TDefinition>;
	/**
	 * Patch only supplied declared keys. A write can repair a row that does not
	 * currently satisfy the complete lens.
	 */
	patch<const TPatch extends Record<string, unknown>>(
		id: string,
		patch: TPatch & ConstrainedPatch<TDefinition, TPatch>,
	): Result<RowFor<TDefinition> | null, RecordLensError>;
	delete(id: string): void;
};

export type CanonicalTables<TTables extends TableLensDefinitions> = {
	[K in keyof TTables]: CanonicalTable<TTables[K]>;
};

export type CanonicalRecordsOptions = {
	/**
	 * Admit one schema-opaque synchronization command in the same SQLite
	 * transaction as its optimistic canonical write. A standalone owner may
	 * omit this hook.
	 */
	admit?(command: RecordCommand): void;
};

/**
 * The synchronous SQLite owner behind async workspace clients and transports.
 * It owns one schema-opaque canonical map and connection-local SQL lenses.
 */
export function createCanonicalRecords<
	const TTables extends TableLensDefinitions,
>(
	sqlite: RecordSyncSqlite,
	definitions: TTables,
	{ admit = () => undefined }: CanonicalRecordsOptions = {},
) {
	assertDefinitions(definitions);
	initializeCanonicalStore(sqlite);
	installTemporaryViews(sqlite, definitions);

	const tables = Object.fromEntries(
		Object.entries(definitions).map(([tableName, definition]) => {
			const lens = compileTableLens(definition);
			const table = {
				get(id: string) {
					const payload = readCanonical(sqlite, tableName, id);
					return payload === null
						? Ok(null)
						: lens.project(tableName, id, payload);
				},
				scan({ cursor = '', limit }: { cursor?: string; limit: number }) {
					assertScanLimit(limit);
					const stored = sqlite.all<{ id: string; payload: string }>(
						`SELECT "row_id" AS "id", "payload" FROM "${RECORDS_TABLE}" WHERE "table_key" = ? AND "row_id" > ? ORDER BY "row_id" LIMIT ?`,
						[tableName, cursor, limit + 1],
					);
					const hasMore = stored.length > limit;
					const page = hasMore ? stored.slice(0, limit) : stored;
					const rows: Record<string, unknown>[] = [];
					const nonconforming: RecordLensError[] = [];
					for (const entry of page) {
						const payload = parseCanonicalPayload(entry.payload);
						const result = lens.project(tableName, entry.id, payload);
						if (result.error === null) rows.push(result.data);
						else nonconforming.push(result.error);
					}
					return {
						rows,
						nonconforming,
						nextCursor: hasMore ? page.at(-1)?.id : undefined,
					};
				},
				create(input: Record<string, unknown>) {
					const payload = lens.validateCreate(input);
					const id = crypto.randomUUID();
					assertAdmissibleCanonicalRow(tableName, id, payload);
					sqlite.transaction(() => {
						admitCommand(admit, {
							kind: 'createRow',
							table: tableName,
							rowId: id,
							value: payload,
						});
						sqlite.run(
							`INSERT INTO "${RECORDS_TABLE}" ("table_key", "row_id", "payload") VALUES (?, ?, ?)`,
							[tableName, id, JSON.stringify(payload)],
						);
					});
					return expectConforming(lens.project(tableName, id, payload));
				},
				patch(id: string, patch: Record<string, unknown>) {
					const normalized = lens.normalizePatch(patch);
					return sqlite.transaction(() => {
						const payload = readCanonical(sqlite, tableName, id);
						if (
							Object.keys(normalized.set).length === 0 &&
							normalized.unset.length === 0
						) {
							return payload === null
								? Ok(null)
								: lens.project(tableName, id, payload);
						}
						const command = {
							kind: 'patchRow',
							table: tableName,
							rowId: id,
							set: normalized.set,
							unset: normalized.unset,
						} satisfies RecordCommand;
						if (payload === null) {
							admitCommand(admit, command);
							return Ok(null);
						}
						const folded = foldRow(payload, command);
						if (folded.kind !== 'row') {
							throw new Error('A live canonical row patch must produce a row');
						}
						const next = folded.value;
						assertAdmissibleCanonicalRow(tableName, id, next);
						admitCommand(admit, command);
						sqlite.run(
							`UPDATE "${RECORDS_TABLE}" SET "payload" = ? WHERE "table_key" = ? AND "row_id" = ?`,
							[JSON.stringify(next), tableName, id],
						);
						return lens.project(tableName, id, next);
					});
				},
				delete(id: string) {
					sqlite.transaction(() => {
						sqlite.run(
							`DELETE FROM "${RECORDS_TABLE}" WHERE "table_key" = ? AND "row_id" = ?`,
							[tableName, id],
						);
						admitCommand(admit, {
							kind: 'deleteRow',
							table: tableName,
							rowId: id,
						});
					});
				},
			};
			return [tableName, table];
		}),
	) as CanonicalTables<TTables>;

	return {
		tables,
		/** Execute one validated read-only SELECT against this connection. */
		sql<TResultSchema extends TSchema>(
			query: string,
			parameters: readonly SqliteValue[],
			resultSchema: TResultSchema,
		): Static<TResultSchema>[] {
			assertSelectStatement(query);
			sqlite.run('PRAGMA query_only = ON');
			try {
				const rows = sqlite.all<SqliteRow>(query, parameters);
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
			} finally {
				sqlite.run('PRAGMA query_only = OFF');
			}
		},
	};
}

export type CanonicalRecords<
	TTables extends TableLensDefinitions = TableLensDefinitions,
> = ReturnType<typeof createCanonicalRecords<TTables>>;

function admitCommand(
	admit: (command: RecordCommand) => void,
	command: RecordCommand,
): void {
	admit(structuredClone(command));
}

function assertAdmissibleCanonicalRow(
	table: string,
	rowId: string,
	value: JsonObject,
): void {
	if (!isAdmissibleCanonicalRow({ table, rowId, value })) {
		throw new RangeError('Canonical row exceeds portable record-sync limits');
	}
}

function initializeCanonicalStore(sqlite: RecordSyncSqlite): void {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS "${RECORDS_TABLE}" (
			"table_key" TEXT NOT NULL,
			"row_id" TEXT NOT NULL,
			"payload" TEXT NOT NULL CHECK(json_valid("payload") AND json_type("payload") = 'object'),
			PRIMARY KEY ("table_key", "row_id")
		) WITHOUT ROWID, STRICT
	`);
}

function installTemporaryViews(
	sqlite: RecordSyncSqlite,
	definitions: TableLensDefinitions,
): void {
	for (const [tableName, definition] of Object.entries(definitions)) {
		const lens = compileTableLens(definition);
		sqlite.run(`DROP VIEW IF EXISTS temp.${quoteIdentifier(tableName)}`);
		const columns = [
			'"row_id" AS "id"',
			...[...lens.fields.values()].map(projectedSqlColumn),
		];
		sqlite.run(
			`CREATE TEMP VIEW ${quoteIdentifier(tableName)} AS SELECT ${columns.join(', ')} FROM "${RECORDS_TABLE}" WHERE "table_key" = ${quoteSqlLiteral(tableName)}`,
		);
	}
}

function projectedSqlColumn(field: {
	name: string;
	kind: import('@epicenter/field').Kind;
}): string {
	const path = quoteSqlLiteral(`$.${field.name}`);
	const jsonTypes = sqlJsonTypes(field.kind).map(quoteSqlLiteral).join(', ');
	return `CASE WHEN json_type("payload", ${path}) IN (${jsonTypes}) THEN json_extract("payload", ${path}) ELSE NULL END AS ${quoteIdentifier(field.name)}`;
}

function sqlJsonTypes(
	kind: import('@epicenter/field').Kind,
): readonly string[] {
	switch (kind) {
		case 'string':
		case 'url':
		case 'date':
		case 'datetime':
		case 'instant':
		case 'select':
		case 'reference':
			return ['text'];
		case 'integer':
			return ['integer'];
		case 'number':
			return ['integer', 'real'];
		case 'boolean':
			return ['true', 'false'];
		case 'tags':
		case 'multiSelect':
			return ['array'];
		case 'json':
			return [
				'null',
				'text',
				'integer',
				'real',
				'true',
				'false',
				'array',
				'object',
			];
		default:
			return kind satisfies never;
	}
}

function readCanonical(
	sqlite: RecordSyncSqlite,
	table: string,
	id: string,
): JsonObject | null {
	const [stored] = sqlite.all<{ payload: string }>(
		`SELECT "payload" FROM "${RECORDS_TABLE}" WHERE "table_key" = ? AND "row_id" = ?`,
		[table, id],
	);
	return stored ? parseCanonicalPayload(stored.payload) : null;
}

function parseCanonicalPayload(payload: string): JsonObject {
	const parsed: unknown = JSON.parse(payload);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Canonical record payload is not a JSON object');
	}
	return parsed as JsonObject;
}

function expectConforming<TResult>(
	result: Result<TResult, RecordLensError>,
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

function assertScanLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT) {
		throw new RangeError(
			`scan limit must be an integer from 1 through ${MAX_SCAN_LIMIT}`,
		);
	}
}

function assertSelectStatement(query: string): void {
	const trimmed = query.trim();
	if (!/^SELECT(?:\s|$)/i.test(trimmed)) {
		throw new Error('sql() accepts only SELECT statements');
	}
	if (trimmed.includes(';')) {
		throw new Error('sql() accepts exactly one statement');
	}
	if (/(?:__epicenter|sqlite_|pragma_)/i.test(trimmed)) {
		throw new Error('sql() cannot access runtime-private storage');
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

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
