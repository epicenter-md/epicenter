/**
 * Typed SQLite application-data runtime.
 *
 * Workspace definitions are compiled into ordinary SQLite tables. This module
 * owns application DDL, value codecs, typed CRUD, atomic transactions, and
 * post-commit invalidation. It deliberately knows nothing about transports or
 * Yjs child documents.
 */

import type {
	Cells,
	JsonValue,
	Operation,
	RecordSyncSqlite,
	SnapshotRow,
	SqliteRow,
	SqliteValue,
} from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import type {
	CompiledColumn,
	KvDefinition,
	KvDefinitions,
	RowFor,
	TableDefinition,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';

/** Mutable during apply; coordinators inspect operations before committing. */
export type ApplicationMutationContext = {
	readonly operations: readonly Operation[];
};

/**
 * Own the true commit boundary around application SQL and any replica journal.
 * `commit` must call `apply` exactly once and return only after commit succeeds.
 */
export type ApplicationMutationCoordinator = {
	commit<TResult>(
		context: ApplicationMutationContext,
		apply: () => TResult,
	): TResult;
};

export type ApplicationDatabaseOptions = {
	coordinator?: ApplicationMutationCoordinator;
	/** Receives every observer failure. Must not throw. */
	onObserverError(error: unknown): void;
};

export type ApplicationLogicalSnapshot = {
	rows: SnapshotRow[];
};

type TableReads<TRow extends { id: string }> = {
	get(id: TRow['id']): TRow | null;
	list(options?: {
		where?: Partial<TRow>;
		orderBy?: keyof TRow & string;
		desc?: boolean;
		limit?: number;
	}): TRow[];
	has(id: TRow['id']): boolean;
	count(): number;
};

type TableWrites<TRow extends { id: string }> = {
	put(row: TRow): void;
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): TRow | null;
	remove(id: TRow['id']): void;
};

export type ApplicationTable<TRow extends { id: string }> = TableReads<TRow> &
	TableWrites<TRow> & {
		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>) => void,
		): () => void;
	};

export type ApplicationTables<TTables extends TableDefinitions> = {
	[K in keyof TTables]: ApplicationTable<RowFor<TTables[K]>>;
};

export type ApplicationKv<TKv extends KvDefinitions> = {
	get<TKey extends keyof TKv & string>(key: TKey): Static<TKv[TKey]['schema']>;
	set<TKey extends keyof TKv & string>(
		key: TKey,
		value: Static<TKv[TKey]['schema']>,
	): void;
	clear(key: keyof TKv & string): void;
	observe(
		callback: (changedKeys: ReadonlySet<keyof TKv & string>) => void,
	): () => void;
};

export type ApplicationTransaction<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	tables: ApplicationTables<TTables>;
	kv: ApplicationKv<TKv>;
};

type Changes = {
	tables: Map<string, Set<string>>;
	kv: Set<string>;
};

type ColumnCodec = {
	storage: 'TEXT' | 'INTEGER' | 'REAL';
	isNullable: boolean;
	encode(value: unknown): SqliteValue;
	decode(value: SqliteValue): unknown;
};

const KV_TABLE = '__epicenter_kv';
const TOMBSTONE_TABLE = '__epicenter_tombstones';
const META_TABLE = '__epicenter_meta';
const INTERNAL_PREFIX = '__epicenter_';

/** Open typed application tables over an already-open SQLite database. */
export function createApplicationDatabase<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	sqlite: RecordSyncSqlite,
	{
		coordinator = {
			commit<TResult>(
				_context: ApplicationMutationContext,
				apply: () => TResult,
			): TResult {
				return sqlite.transaction(apply);
			},
		},
		onObserverError,
	}: ApplicationDatabaseOptions,
) {
	const tableObservers = new Map<
		string,
		Set<(changedIds: ReadonlySet<string>) => void>
	>();
	const kvObservers = new Set<
		(changedKeys: ReadonlySet<keyof TKv & string>) => void
	>();
	let activeChanges: Changes | undefined;
	let activeOperations: Operation[] | undefined;

	initializeDatabase(sqlite, definition);

	function publish(changes: Changes): void {
		function notify(run: () => void): void {
			try {
				run();
			} catch (cause) {
				try {
					onObserverError(cause);
				} catch {
					// The injected sink is explicitly non-throwing. A broken sink must not
					// turn an already-committed write into an apparent transaction failure.
				}
			}
		}
		for (const [tableName, changedIds] of changes.tables) {
			if (changedIds.size === 0) continue;
			for (const observer of [...(tableObservers.get(tableName) ?? [])]) {
				notify(() => observer(changedIds));
			}
		}
		if (changes.kv.size > 0) {
			const changedKeys = changes.kv as ReadonlySet<keyof TKv & string>;
			for (const observer of [...kvObservers]) {
				notify(() => observer(changedKeys));
			}
		}
	}

	function mutate<TResult>(run: (changes: Changes) => TResult): TResult {
		if (activeChanges) return run(activeChanges);

		const changes: Changes = { tables: new Map(), kv: new Set() };
		const operations: Operation[] = [];
		const result = coordinator.commit({ operations }, () => {
			activeChanges = changes;
			activeOperations = operations;
			try {
				return run(changes);
			} finally {
				activeChanges = undefined;
				activeOperations = undefined;
			}
		});
		publish(changes);
		return result;
	}

	function record(operation: Operation): void {
		if (!activeOperations) {
			throw new Error('Logical operation recorded outside a mutation');
		}
		activeOperations.push(operation);
	}

	const tables = Object.fromEntries(
		Object.entries(definition.tables).map(([tableName, tableDefinition]) => [
			tableName,
			createApplicationTable({
				sqlite,
				tableName,
				definition: tableDefinition,
				mutate,
				record,
				observe(callback) {
					let observers = tableObservers.get(tableName);
					if (!observers) {
						observers = new Set();
						tableObservers.set(tableName, observers);
					}
					observers.add(callback);
					return () => {
						observers?.delete(callback);
						if (observers?.size === 0) tableObservers.delete(tableName);
					};
				},
			}),
		]),
	) as ApplicationTables<TTables>;

	const kv = createApplicationKv({
		sqlite,
		definitions: definition.kv,
		mutate,
		record,
		observe(callback) {
			kvObservers.add(callback);
			return () => kvObservers.delete(callback);
		},
	});

	return {
		tables,
		kv,
		/** Group every enclosed table and KV write into one SQLite transaction. */
		transact<TResult>(
			run: (tx: ApplicationTransaction<TTables, TKv>) => TResult,
		): TResult {
			if (activeChanges) {
				throw new Error('Nested application transactions are not supported');
			}
			return mutate(() => run({ tables, kv }));
		},
		/** Read logical application state, including terminal tombstones. */
		readLogicalSnapshot(): ApplicationLogicalSnapshot {
			return readLogicalSnapshot(sqlite, definition, tables);
		},
	};
}

export type ApplicationDatabase<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = ReturnType<typeof createApplicationDatabase<TTables, TKv>>;

function createApplicationTable<TDefinition extends TableDefinition>({
	sqlite,
	tableName,
	definition,
	mutate,
	record,
	observe,
}: {
	sqlite: RecordSyncSqlite;
	tableName: string;
	definition: TDefinition;
	mutate: <TResult>(run: (changes: Changes) => TResult) => TResult;
	record: (operation: Operation) => void;
	observe: (callback: (changedIds: ReadonlySet<string>) => void) => () => void;
}): ApplicationTable<RowFor<TDefinition>> {
	type TRow = RowFor<TDefinition>;
	const columns = definition.columns as Record<string, TSchema>;
	const compiledColumns = definition.compiledColumns as Record<
		string,
		CompiledColumn
	>;
	const columnNames = Object.keys(columns);
	const codecs = Object.fromEntries(
		Object.entries(compiledColumns).map(([name, column]) => [
			name,
			createColumnCodec(column),
		]),
	) as Record<string, ColumnCodec>;
	const quotedTable = quoteIdentifier(tableName);
	function codecFor(column: string): ColumnCodec {
		const codec = codecs[column];
		if (!codec) throw new Error(`Unknown column '${tableName}.${column}'`);
		return codec;
	}

	function mark(changes: Changes, id: string): void {
		let ids = changes.tables.get(tableName);
		if (!ids) {
			ids = new Set();
			changes.tables.set(tableName, ids);
		}
		ids.add(id);
	}

	function get(id: TRow['id']): TRow | null {
		const rows = sqlite.all<SqliteRow>(
			`SELECT ${columnNames.map(quoteIdentifier).join(', ')} FROM ${quotedTable} WHERE "id" = ?`,
			[id],
		);
		const row = rows[0];
		return row ? decodeRow<TRow>(row, columns, codecs) : null;
	}

	function list(
		options: {
			where?: Partial<TRow>;
			orderBy?: keyof TRow & string;
			desc?: boolean;
			limit?: number;
		} = {},
	): TRow[] {
		const clauses: string[] = [];
		const parameters: SqliteValue[] = [];
		for (const [column, value] of Object.entries(options.where ?? {})) {
			const codec = codecs[column];
			if (!codec) throw new Error(`Unknown column '${tableName}.${column}'`);
			if (value === null) clauses.push(`${quoteIdentifier(column)} IS NULL`);
			else {
				clauses.push(`${quoteIdentifier(column)} = ?`);
				parameters.push(codec.encode(value));
			}
		}

		let sql = `SELECT ${columnNames.map(quoteIdentifier).join(', ')} FROM ${quotedTable}`;
		if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
		if (options.orderBy !== undefined) {
			if (!codecs[options.orderBy]) {
				throw new Error(
					`Unknown order column '${tableName}.${options.orderBy}'`,
				);
			}
			sql += ` ORDER BY ${quoteIdentifier(options.orderBy)}${options.desc ? ' DESC' : ' ASC'}`;
		}
		if (options.limit !== undefined) {
			if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
				throw new Error('list() limit must be a non-negative safe integer');
			}
			sql += ' LIMIT ?';
			parameters.push(options.limit);
		}

		return sqlite
			.all<SqliteRow>(sql, parameters)
			.map((row) => decodeRow<TRow>(row, columns, codecs));
	}

	return {
		get,
		list,
		has(id) {
			return (
				sqlite.all<SqliteRow>(
					`SELECT 1 AS "present" FROM ${quotedTable} WHERE "id" = ? LIMIT 1`,
					[id],
				).length > 0
			);
		},
		count() {
			return (
				sqlite.all<{ count: number }>(
					`SELECT count(*) AS "count" FROM ${quotedTable}`,
				)[0]?.count ?? 0
			);
		},
		put(row) {
			assertRow(definition, row);
			mutate((changes) => {
				if (hasTombstone(sqlite, tableName, row.id)) {
					throw new Error(
						`Cannot put terminally deleted row '${tableName}.${row.id}'`,
					);
				}
				const placeholders = columnNames.map(() => '?').join(', ');
				const updates = columnNames
					.filter((column) => column !== 'id')
					.map(
						(column) =>
							`${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`,
					)
					.join(', ');
				const conflict =
					updates === '' ? 'DO NOTHING' : `DO UPDATE SET ${updates}`;
				sqlite.run(
					`INSERT INTO ${quotedTable} (${columnNames.map(quoteIdentifier).join(', ')}) VALUES (${placeholders}) ON CONFLICT("id") ${conflict}`,
					columnNames.map((column) => codecFor(column).encode(row[column])),
				);
				mark(changes, row.id);
				record({
					kind: 'patchRow',
					table: tableName,
					rowId: row.id,
					cells: Object.fromEntries(
						columnNames
							.filter((column) => column !== 'id')
							.map((column) => [column, row[column]]),
					) as Cells,
				});
			});
		},
		patch(id, cells) {
			const entries = Object.entries(cells);
			if (entries.length === 0) return get(id);
			if (entries.some(([column]) => column === 'id')) {
				throw new Error('patch() cannot change id');
			}
			return mutate((changes) => {
				const current = get(id);
				if (!current) return null;
				const next = { ...current, ...cells };
				assertRow(definition, next);
				const assignments = entries.map(([column]) => {
					if (!codecs[column]) {
						throw new Error(`Unknown column '${tableName}.${column}'`);
					}
					return `${quoteIdentifier(column)} = ?`;
				});
				sqlite.run(
					`UPDATE ${quotedTable} SET ${assignments.join(', ')} WHERE "id" = ?`,
					[
						...entries.map(([column, value]) => codecFor(column).encode(value)),
						id,
					],
				);
				mark(changes, id);
				record({
					kind: 'patchRow',
					table: tableName,
					rowId: id,
					cells: Object.fromEntries(entries) as Cells,
				});
				return next;
			});
		},
		remove(id) {
			mutate((changes) => {
				if (hasTombstone(sqlite, tableName, id)) return;
				sqlite.run(`DELETE FROM ${quotedTable} WHERE "id" = ?`, [id]);
				sqlite.run(
					`INSERT INTO ${quoteIdentifier(TOMBSTONE_TABLE)} ("table_name", "row_id") VALUES (?, ?)`,
					[tableName, id],
				);
				mark(changes, id);
				record({ kind: 'deleteRow', table: tableName, rowId: id });
			});
		},
		observe(callback) {
			return observe(callback as (ids: ReadonlySet<string>) => void);
		},
	};
}

function createApplicationKv<TKv extends KvDefinitions>({
	sqlite,
	definitions,
	mutate,
	record,
	observe,
}: {
	sqlite: RecordSyncSqlite;
	definitions: TKv;
	mutate: <TResult>(run: (changes: Changes) => TResult) => TResult;
	record: (operation: Operation) => void;
	observe: (
		callback: (changedKeys: ReadonlySet<keyof TKv & string>) => void,
	) => () => void;
}): ApplicationKv<TKv> {
	function definitionFor<TKey extends keyof TKv & string>(
		key: TKey,
	): TKv[TKey] {
		const definition = definitions[key];
		if (!definition) throw new Error(`Unknown KV key '${key}'`);
		return definition;
	}

	return {
		get(key) {
			const definition = definitionFor(key);
			const stored = sqlite.all<{ value: string }>(
				`SELECT "value" FROM ${quoteIdentifier(KV_TABLE)} WHERE "key" = ?`,
				[key],
			)[0];
			if (!stored) return checkedDefault(key, definition);
			let value: unknown;
			try {
				value = JSON.parse(stored.value);
			} catch (cause) {
				throw new Error(`Stored KV value '${key}' is not valid JSON`, {
					cause,
				});
			}
			assertColumn(definition.compiledValue, value, `KV value '${key}'`);
			return value as Static<TKv[typeof key]['schema']>;
		},
		set(key, value) {
			const definition = definitionFor(key);
			assertColumn(definition.compiledValue, value, `KV value '${key}'`);
			mutate((changes) => {
				sqlite.run(
					`INSERT INTO ${quoteIdentifier(KV_TABLE)} ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
					[key, JSON.stringify(value)],
				);
				changes.kv.add(key);
				record({
					kind: 'patchRow',
					table: KV_TABLE,
					rowId: key,
					cells: { value: value as JsonValue },
				});
			});
		},
		clear(key) {
			definitionFor(key);
			mutate((changes) => {
				sqlite.run(`DELETE FROM ${quoteIdentifier(KV_TABLE)} WHERE "key" = ?`, [
					key,
				]);
				changes.kv.add(key);
				record({
					kind: 'patchRow',
					table: KV_TABLE,
					rowId: key,
					cells: { value: null },
				});
			});
		},
		observe,
	};
}

function initializeDatabase(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
): void {
	const storedRevision = inspectDatabaseIdentity(sqlite, definition);
	sqlite.transaction(() => {
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(META_TABLE)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(KV_TABLE)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(TOMBSTONE_TABLE)} ("table_name" TEXT NOT NULL, "row_id" TEXT NOT NULL, PRIMARY KEY ("table_name", "row_id"))`,
		);

		// A fresh database is created directly at the current representation. An
		// existing database runs only its missing authored representation steps.
		// Epoch transforms belong to database-boundary import and never run here.
		if (storedRevision !== undefined) {
			for (
				let revision = storedRevision + 1;
				revision <= definition.storageRevision;
				revision++
			) {
				const migration = definition.migrations[revision - 2];
				migration?.apply?.({
					sql(query, ...parameters) {
						return sqlite.all<SqliteRow>(
							query,
							parameters.map(asSqliteValue),
						) as unknown[];
					},
				});
			}
		}

		for (const [tableName, tableDefinition] of Object.entries(
			definition.tables,
		)) {
			if (tableName.startsWith(INTERNAL_PREFIX)) {
				throw new Error(
					`Table name '${tableName}' uses the reserved internal prefix`,
				);
			}
			const columns = tableDefinition.columns as Record<string, TSchema>;
			const compiledColumns = tableDefinition.compiledColumns as Record<
				string,
				CompiledColumn
			>;
			if (!columns.id) throw new Error(`Table '${tableName}' must declare id`);
			const columnDdl = Object.entries(compiledColumns).map(
				([name, column]) => {
					const codec = createColumnCodec(column);
					if (name === 'id') {
						if (codec.storage !== 'TEXT' || codec.isNullable) {
							throw new Error(
								`Table '${tableName}' id must be a non-null TEXT field`,
							);
						}
						return `${quoteIdentifier(name)} TEXT PRIMARY KEY NOT NULL`;
					}
					return `${quoteIdentifier(name)} ${codec.storage}${codec.isNullable ? '' : ' NOT NULL'}`;
				},
			);
			sqlite.run(
				`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columnDdl.join(', ')})`,
			);

			for (const [
				index,
				columns,
			] of tableDefinition.options.indexes.entries()) {
				for (const column of columns) {
					if (!tableDefinition.columns[column]) {
						throw new Error(
							`Index on '${tableName}' names unknown column '${column}'`,
						);
					}
				}
				sqlite.run(
					`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${INTERNAL_PREFIX}idx_${tableName}_${index}`)} ON ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(', ')})`,
				);
			}
		}

		sqlite.run(
			`INSERT INTO ${quoteIdentifier(META_TABLE)} ("key", "value") VALUES ('storage_revision', ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
			[String(definition.storageRevision)],
		);
		writeMeta(sqlite, 'workspace_id', definition.id);
		writeMeta(sqlite, 'schema_identity', definition.schemaIdentity);
	});
}

function inspectDatabaseIdentity(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
): number | undefined {
	const userTables = sqlite.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	const hasMeta = userTables.some(({ name }) => name === META_TABLE);
	if (!hasMeta) {
		if (userTables.length > 0) {
			throw new Error(
				'Workspace database has no identity metadata; refusing to adopt a non-empty database',
			);
		}
		return undefined;
	}

	const storedRevisionText = readMeta(sqlite, 'storage_revision');
	const storedWorkspaceId = readMeta(sqlite, 'workspace_id');
	const storedSchemaIdentity = readMeta(sqlite, 'schema_identity');
	if (
		storedRevisionText === undefined ||
		storedWorkspaceId === undefined ||
		storedSchemaIdentity === undefined
	) {
		throw new Error(
			'Workspace database metadata is incomplete; refusing to adopt an unidentified database',
		);
	}
	const storedRevision = Number(storedRevisionText);
	if (!Number.isSafeInteger(storedRevision) || storedRevision < 1) {
		throw new Error(
			`Invalid stored workspace revision '${storedRevisionText}'`,
		);
	}
	if (storedWorkspaceId !== definition.id) {
		throw new Error(
			`Workspace database belongs to '${storedWorkspaceId}', not '${definition.id}'`,
		);
	}
	if (storedRevision > definition.storageRevision) {
		throw new Error(
			`Workspace database revision ${storedRevision} is newer than this definition's revision ${definition.storageRevision}`,
		);
	}
	for (
		let revision = storedRevision + 1;
		revision <= definition.storageRevision;
		revision++
	) {
		if (definition.migrations[revision - 2]?.epoch !== undefined) {
			throw new Error(
				`Workspace revision ${revision} changes schema epoch; open it through the explicit epoch-upgrade/import flow`,
			);
		}
	}
	if (storedSchemaIdentity !== definition.schemaIdentity) {
		throw new Error(
			'Workspace schema identity does not match the database; refusing typed access',
		);
	}
	return storedRevision;
}

function readLogicalSnapshot<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition<TTables, TKv>,
	tables: ApplicationTables<TTables>,
): ApplicationLogicalSnapshot {
	type SnapshotTable = {
		list(options: {
			orderBy: 'id';
		}): ({ id: string } & Record<string, unknown>)[];
	};
	const rows: SnapshotRow[] = [];
	for (const tableName of Object.keys(definition.tables).toSorted()) {
		const table = (tables as unknown as Record<string, SnapshotTable>)[
			tableName
		];
		if (!table) throw new Error(`Snapshot table '${tableName}' is unavailable`);
		for (const row of table.list({ orderBy: 'id' })) {
			const { id: rowId, ...cells } = row;
			rows.push({
				table: tableName,
				rowId,
				deleted: false,
				cells: cells as Cells,
			});
		}
	}

	rows.push(
		...sqlite
			.all<{ table: string; rowId: string }>(
				`SELECT "table_name" AS "table", "row_id" AS "rowId" FROM ${quoteIdentifier(TOMBSTONE_TABLE)} ORDER BY "table_name", "row_id"`,
			)
			.map(({ table, rowId }) => ({
				table,
				rowId,
				deleted: true as const,
				cells: {},
			})),
	);
	rows.push(
		...sqlite
			.all<{ key: string; value: string }>(
				`SELECT "key", "value" FROM ${quoteIdentifier(KV_TABLE)} ORDER BY "key"`,
			)
			.map(({ key, value }) => {
				const kvDefinition = definition.kv[key];
				if (!kvDefinition)
					throw new Error(`Snapshot contains unknown KV key '${key}'`);
				const decoded: unknown = JSON.parse(value);
				assertColumn(kvDefinition.compiledValue, decoded, `KV value '${key}'`);
				return {
					table: KV_TABLE,
					rowId: key,
					deleted: false as const,
					cells: { value: decoded as JsonValue },
				};
			}),
	);
	rows.sort(
		(left, right) =>
			compareCodeUnits(left.table, right.table) ||
			compareCodeUnits(left.rowId, right.rowId),
	);
	return { rows };
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function readMeta(sqlite: RecordSyncSqlite, key: string): string | undefined {
	return sqlite.all<{ value: string }>(
		`SELECT "value" FROM ${quoteIdentifier(META_TABLE)} WHERE "key" = ?`,
		[key],
	)[0]?.value;
}

function writeMeta(sqlite: RecordSyncSqlite, key: string, value: string): void {
	sqlite.run(
		`INSERT INTO ${quoteIdentifier(META_TABLE)} ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
		[key, value],
	);
}

function asSqliteValue(value: unknown): SqliteValue {
	if (value === null || typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	throw new Error(
		'Migration SQL parameters must be finite numbers, strings, or null',
	);
}

function createColumnCodec(column: CompiledColumn): ColumnCodec {
	const { kind } = column;
	return {
		storage: column.storage,
		isNullable: column.isNullable,
		encode(value) {
			assertColumn(column, value, 'Column value');
			if (value === null) return null;
			switch (kind) {
				case 'boolean':
					return value ? 1 : 0;
				case 'json':
				case 'multiSelect':
				case 'tags':
					return JSON.stringify(value);
				default:
					return value as SqliteValue;
			}
		},
		decode(value) {
			if (value === null) return null;
			let decoded: unknown;
			switch (kind) {
				case 'boolean':
					if (value !== 0 && value !== 1) {
						throw new Error(
							`Stored column '${column.name}' is not a SQLite boolean`,
						);
					}
					decoded = value === 1;
					break;
				case 'json':
				case 'multiSelect':
				case 'tags':
					decoded = JSON.parse(String(value));
					break;
				default:
					decoded = value;
			}
			assertColumn(column, decoded, 'Stored column value');
			return decoded;
		},
	};
}

function decodeRow<TRow extends { id: string }>(
	stored: SqliteRow,
	columns: Record<string, TSchema>,
	codecs: Record<string, ColumnCodec>,
): TRow {
	const row = Object.fromEntries(
		Object.keys(columns).map((column) => [
			column,
			codecForStoredColumn(codecs, column).decode(stored[column] ?? null),
		]),
	);
	return row as TRow;
}

function codecForStoredColumn(
	codecs: Record<string, ColumnCodec>,
	column: string,
): ColumnCodec {
	const codec = codecs[column];
	if (!codec) throw new Error(`Stored row has unknown column '${column}'`);
	return codec;
}

function assertRow<TDefinition extends TableDefinition>(
	definition: TDefinition,
	row: unknown,
): asserts row is RowFor<TDefinition> {
	if (!isRecord(row)) throw new Error('Row must be a plain object');
	const expected = Object.keys(definition.compiledColumns);
	const actual = Object.keys(row);
	if (
		actual.length !== expected.length ||
		expected.some((column) => !Object.hasOwn(row, column))
	) {
		throw new Error('Row must contain exactly the declared columns');
	}
	for (const column of Object.values(definition.compiledColumns)) {
		assertColumn(column, row[column.name], `Row column '${column.name}'`);
	}
}

function checkedDefault<TDefinition extends KvDefinition>(
	key: string,
	definition: TDefinition,
): Static<TDefinition['schema']> {
	const value = definition.defaultValue();
	assertColumn(definition.compiledValue, value, `Default for KV key '${key}'`);
	return value as Static<TDefinition['schema']>;
}

function assertColumn(
	column: CompiledColumn,
	value: unknown,
	label: string,
): void {
	if (column.check(value)) return;
	throw new Error(`${label} failed schema validation`);
}

function hasTombstone(
	sqlite: RecordSyncSqlite,
	tableName: string,
	rowId: string,
): boolean {
	return (
		sqlite.all<SqliteRow>(
			`SELECT 1 AS "present" FROM ${quoteIdentifier(TOMBSTONE_TABLE)} WHERE "table_name" = ? AND "row_id" = ? LIMIT 1`,
			[tableName, rowId],
		).length > 0
	);
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
