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
	LogicalRow,
	Operation,
	RecordSyncSqlite,
	SnapshotRow,
	SqliteRow,
	SqliteValue,
} from '@epicenter/record-sync';
import { foldRow } from '@epicenter/record-sync';
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
	/** Permanent durable identity mode for this database file. */
	kind: 'standalone' | 'replica';
	coordinator?: ApplicationMutationCoordinator;
	/** Receives every observer failure. Must not throw. */
	onObserverError(error: unknown): void;
};

export type ApplicationLogicalSnapshot = {
	rows: SnapshotRow[];
};

export type ReplicaProjectionTransaction = {
	/** Fold accepted or pending logical operations without creating outbox work. */
	apply(
		operations: readonly Operation[],
		firstSeenServerSequence: number,
	): void;
	/** Replace accepted logical state before replaying pending outbox operations. */
	replace(rows: readonly SnapshotRow[], snapshotSequence: number): void;
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

export type CommittedApplicationChanges = {
	tables: ReadonlyMap<string, ReadonlySet<string>>;
	kv: ReadonlySet<string>;
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
const QUARANTINE_TABLE = '__epicenter_quarantine';
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
		kind,
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
	const commitObservers = new Set<
		(changes: CommittedApplicationChanges) => void
	>();
	let activeChanges: Changes | undefined;
	let activeOperations: Operation[] | undefined;

	initializeDatabase(sqlite, definition, kind);

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
		if (changes.tables.size > 0 || changes.kv.size > 0) {
			const committed: CommittedApplicationChanges = {
				tables: new Map(
					[...changes.tables].map(([table, ids]) => [table, new Set(ids)]),
				),
				kv: new Set(changes.kv),
			};
			for (const observer of [...commitObservers]) {
				notify(() => observer(committed));
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
		definition,
		identity: {
			kind,
			workspaceId: definition.id,
			schemaIdentity: definition.schemaIdentity,
		},
		kind,
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
		/** Observe one combined table/KV change set after each successful commit. */
		observe(callback: (changes: CommittedApplicationChanges) => void) {
			commitObservers.add(callback);
			return () => commitObservers.delete(callback);
		},
		/** Read logical application state, including terminal tombstones. */
		readLogicalSnapshot(): ApplicationLogicalSnapshot {
			return readLogicalSnapshot(sqlite, definition, tables);
		},
		/**
		 * Run one replica-owned projection transition and publish only after commit.
		 * The caller may update cursor and outbox tables through the same SQLite
		 * connection inside `run`; application callers never receive this surface.
		 */
		applyReplicaTransaction<TResult>(
			run: (projection: ReplicaProjectionTransaction) => TResult,
		): TResult {
			if (activeChanges) {
				throw new Error(
					'Replica projection cannot run inside an application transaction',
				);
			}
			const changes: Changes = { tables: new Map(), kv: new Set() };
			const result = sqlite.transaction(() =>
				run({
					apply(operations, firstSeenServerSequence) {
						for (const operation of operations) {
							applyLogicalOperation({
								sqlite,
								definition,
								operation,
								firstSeenServerSequence,
								changes,
							});
						}
					},
					replace(rows, snapshotSequence) {
						replaceLogicalRows({
							sqlite,
							definition,
							rows,
							snapshotSequence,
							changes,
						});
					},
				}),
			);
			publish(changes);
			return result;
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
				if (hasQuarantinedRow(sqlite, tableName, row.id)) {
					throw new Error(
						`Cannot put quarantined row '${tableName}.${row.id}' through the typed API`,
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
					`DELETE FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
					[tableName, id],
				);
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
				if (hasTombstone(sqlite, KV_TABLE, key)) {
					throw new Error(`Cannot set terminally deleted KV key '${key}'`);
				}
				if (hasQuarantinedRow(sqlite, KV_TABLE, key)) {
					throw new Error(
						`Cannot set quarantined KV key '${key}' through the typed API`,
					);
				}
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
				if (hasTombstone(sqlite, KV_TABLE, key)) return;
				if (hasQuarantinedRow(sqlite, KV_TABLE, key)) {
					throw new Error(
						`Cannot clear quarantined KV key '${key}' through the typed API`,
					);
				}
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
	kind: 'standalone' | 'replica',
): void {
	sqlite.transaction(() => {
		const storedRevision = inspectDatabaseIdentity(sqlite, definition, kind);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(META_TABLE)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(KV_TABLE)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(TOMBSTONE_TABLE)} ("table_name" TEXT NOT NULL, "row_id" TEXT NOT NULL, PRIMARY KEY ("table_name", "row_id"))`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(QUARANTINE_TABLE)} ("table_name" TEXT NOT NULL, "row_id" TEXT NOT NULL, "cells_json" TEXT NOT NULL, "first_seen_sequence" INTEGER NOT NULL, "reason" TEXT NOT NULL, PRIMARY KEY ("table_name", "row_id"))`,
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
		writeMeta(sqlite, 'database_kind', kind);
	});
}

function inspectDatabaseIdentity(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	kind: 'standalone' | 'replica',
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
	const storedKind = readMeta(sqlite, 'database_kind');
	if (
		storedRevisionText === undefined ||
		storedWorkspaceId === undefined ||
		storedSchemaIdentity === undefined ||
		storedKind === undefined
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
	if (storedKind !== kind) {
		throw new Error(
			`Workspace database is '${storedKind}', not '${kind}'; refusing the wrong lifecycle door`,
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
			const { id: rowId, ...storedCells } = row;
			const cells = Object.fromEntries(
				Object.entries(storedCells).filter(([, value]) => value !== null),
			);
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
			.all<{
				table: string;
				rowId: string;
				cellsJson: string;
			}>(
				`SELECT "table_name" AS "table", "row_id" AS "rowId", "cells_json" AS "cellsJson" FROM ${quoteIdentifier(QUARANTINE_TABLE)} ORDER BY "table_name", "row_id"`,
			)
			.map(({ table, rowId, cellsJson }) => ({
				table,
				rowId,
				deleted: false as const,
				cells: JSON.parse(cellsJson) as Cells,
			})),
	);
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

function applyLogicalOperation({
	sqlite,
	definition,
	operation,
	firstSeenServerSequence,
	changes,
}: {
	sqlite: RecordSyncSqlite;
	definition: WorkspaceDefinition;
	operation: Operation;
	firstSeenServerSequence: number;
	changes: Changes;
}): void {
	const current = readProjectionRow(
		sqlite,
		definition,
		operation.table,
		operation.rowId,
	);
	const next = foldRow(current, operation);
	materializeProjectionRow({
		sqlite,
		definition,
		table: operation.table,
		rowId: operation.rowId,
		row: next,
		firstSeenServerSequence,
	});
	markProjectionChange(changes, definition, operation.table, operation.rowId);
}

function replaceLogicalRows({
	sqlite,
	definition,
	rows,
	snapshotSequence,
	changes,
}: {
	sqlite: RecordSyncSqlite;
	definition: WorkspaceDefinition;
	rows: readonly SnapshotRow[];
	snapshotSequence: number;
	changes: Changes;
}): void {
	markEveryProjectionRow(sqlite, definition, changes);
	const identities = new Set<string>();
	for (const row of rows) {
		const identity = JSON.stringify([row.table, row.rowId]);
		if (identities.has(identity)) {
			throw new Error(
				`Logical snapshot repeats row '${row.table}.${row.rowId}'`,
			);
		}
		identities.add(identity);
	}

	for (const table of Object.keys(definition.tables)) {
		sqlite.run(`DELETE FROM ${quoteIdentifier(table)}`);
	}
	sqlite.run(`DELETE FROM ${quoteIdentifier(KV_TABLE)}`);
	sqlite.run(`DELETE FROM ${quoteIdentifier(TOMBSTONE_TABLE)}`);
	sqlite.run(`DELETE FROM ${quoteIdentifier(QUARANTINE_TABLE)}`);

	for (const row of rows) {
		materializeProjectionRow({
			sqlite,
			definition,
			table: row.table,
			rowId: row.rowId,
			row: row.deleted
				? { kind: 'tombstone' }
				: { kind: 'live', cells: row.cells },
			firstSeenServerSequence: snapshotSequence,
		});
		markProjectionChange(changes, definition, row.table, row.rowId);
	}
}

function readProjectionRow(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	table: string,
	rowId: string,
): LogicalRow | undefined {
	if (hasTombstone(sqlite, table, rowId)) return { kind: 'tombstone' };
	const quarantined = sqlite.all<{ cellsJson: string }>(
		`SELECT "cells_json" AS "cellsJson" FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
		[table, rowId],
	)[0];
	if (quarantined) {
		return {
			kind: 'live',
			cells: JSON.parse(quarantined.cellsJson) as Cells,
		};
	}
	if (table === KV_TABLE) {
		const stored = sqlite.all<{ value: string }>(
			`SELECT "value" FROM ${quoteIdentifier(KV_TABLE)} WHERE "key" = ?`,
			[rowId],
		)[0];
		return stored
			? {
					kind: 'live',
					cells: { value: JSON.parse(stored.value) as JsonValue },
				}
			: undefined;
	}
	const tableDefinition = definition.tables[table];
	if (!tableDefinition) return undefined;
	const columns = tableDefinition.columns as Record<string, TSchema>;
	const codecs = codecsFor(tableDefinition);
	const stored = sqlite.all<SqliteRow>(
		`SELECT ${Object.keys(columns).map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} WHERE "id" = ?`,
		[rowId],
	)[0];
	if (!stored) return undefined;
	const { id: _id, ...storedCells } = decodeRow<
		{ id: string } & Record<string, unknown>
	>(stored, columns, codecs);
	const cells = Object.fromEntries(
		Object.entries(storedCells).filter(([, value]) => value !== null),
	);
	return { kind: 'live', cells: cells as Cells };
}

function materializeProjectionRow({
	sqlite,
	definition,
	table,
	rowId,
	row,
	firstSeenServerSequence,
}: {
	sqlite: RecordSyncSqlite;
	definition: WorkspaceDefinition;
	table: string;
	rowId: string;
	row: LogicalRow;
	firstSeenServerSequence: number;
}): void {
	deleteProjectionRow(sqlite, definition, table, rowId);
	if (row.kind === 'tombstone') {
		sqlite.run(
			`INSERT INTO ${quoteIdentifier(TOMBSTONE_TABLE)} ("table_name", "row_id") VALUES (?, ?)`,
			[table, rowId],
		);
		return;
	}

	if (table === KV_TABLE) {
		const kv = definition.kv[rowId];
		const cellNames = Object.keys(row.cells);
		if (kv && cellNames.length === 0) return;
		if (
			kv &&
			cellNames.length === 1 &&
			cellNames[0] === 'value' &&
			kv.compiledValue.check(row.cells.value)
		) {
			sqlite.run(
				`INSERT INTO ${quoteIdentifier(KV_TABLE)} ("key", "value") VALUES (?, ?)`,
				[rowId, JSON.stringify(row.cells.value)],
			);
			return;
		}
	} else {
		const tableDefinition = definition.tables[table];
		if (tableDefinition) {
			const candidate: Record<string, unknown> = { id: rowId, ...row.cells };
			for (const [column, compiled] of Object.entries(
				tableDefinition.compiledColumns,
			)) {
				if (
					column !== 'id' &&
					compiled.isNullable &&
					!Object.hasOwn(candidate, column)
				) {
					candidate[column] = null;
				}
			}
			if (rowConforms(tableDefinition, candidate)) {
				writeTypedProjectionRow(sqlite, table, tableDefinition, candidate);
				return;
			}
		}
	}

	sqlite.run(
		`INSERT INTO ${quoteIdentifier(QUARANTINE_TABLE)} ("table_name", "row_id", "cells_json", "first_seen_sequence", "reason") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("table_name", "row_id") DO UPDATE SET "cells_json" = excluded."cells_json", "reason" = excluded."reason"`,
		[
			table,
			rowId,
			JSON.stringify(row.cells),
			firstSeenServerSequence,
			'row does not conform to this workspace schema',
		],
	);
}

function deleteProjectionRow(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	table: string,
	rowId: string,
): void {
	if (table === KV_TABLE) {
		sqlite.run(`DELETE FROM ${quoteIdentifier(KV_TABLE)} WHERE "key" = ?`, [
			rowId,
		]);
	} else if (definition.tables[table]) {
		sqlite.run(`DELETE FROM ${quoteIdentifier(table)} WHERE "id" = ?`, [rowId]);
	}
	sqlite.run(
		`DELETE FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
		[table, rowId],
	);
	sqlite.run(
		`DELETE FROM ${quoteIdentifier(TOMBSTONE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
		[table, rowId],
	);
}

function rowConforms(
	definition: TableDefinition,
	row: Record<string, unknown>,
): boolean {
	const columns = definition.compiledColumns as Record<string, CompiledColumn>;
	const expected = Object.keys(columns);
	return (
		Object.keys(row).length === expected.length &&
		expected.every(
			(column) =>
				Object.hasOwn(row, column) && columns[column]?.check(row[column]),
		)
	);
}

function codecsFor(definition: TableDefinition): Record<string, ColumnCodec> {
	return Object.fromEntries(
		Object.entries(
			definition.compiledColumns as Record<string, CompiledColumn>,
		).map(([name, column]) => [name, createColumnCodec(column)]),
	);
}

function writeTypedProjectionRow(
	sqlite: RecordSyncSqlite,
	table: string,
	definition: TableDefinition,
	row: Record<string, unknown>,
): void {
	const columns = Object.keys(definition.columns);
	const codecs = codecsFor(definition);
	sqlite.run(
		`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
		columns.map((column) =>
			codecForStoredColumn(codecs, column).encode(row[column]),
		),
	);
}

function markProjectionChange(
	changes: Changes,
	definition: WorkspaceDefinition,
	table: string,
	rowId: string,
): void {
	if (table === KV_TABLE && definition.kv[rowId]) {
		changes.kv.add(rowId);
		return;
	}
	if (!definition.tables[table]) return;
	let ids = changes.tables.get(table);
	if (!ids) {
		ids = new Set();
		changes.tables.set(table, ids);
	}
	ids.add(rowId);
}

function markEveryProjectionRow(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	changes: Changes,
): void {
	for (const table of Object.keys(definition.tables)) {
		for (const { id } of sqlite.all<{ id: string }>(
			`SELECT "id" FROM ${quoteIdentifier(table)}`,
		)) {
			markProjectionChange(changes, definition, table, id);
		}
	}
	for (const { key } of sqlite.all<{ key: string }>(
		`SELECT "key" FROM ${quoteIdentifier(KV_TABLE)}`,
	)) {
		markProjectionChange(changes, definition, KV_TABLE, key);
	}
	for (const { table, rowId } of sqlite.all<{
		table: string;
		rowId: string;
	}>(
		`SELECT "table_name" AS "table", "row_id" AS "rowId" FROM ${quoteIdentifier(QUARANTINE_TABLE)}`,
	)) {
		markProjectionChange(changes, definition, table, rowId);
	}
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

function hasQuarantinedRow(
	sqlite: RecordSyncSqlite,
	tableName: string,
	rowId: string,
): boolean {
	return (
		sqlite.all<SqliteRow>(
			`SELECT 1 AS "present" FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ? LIMIT 1`,
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
