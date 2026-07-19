import {
	foldFields,
	isAdmissibleCanonicalRow,
	parseRowIntent,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import type { JsonObject } from './lens-definition.js';
import { listLocalRows, readLocalRow } from './local-workspace-storage.js';

const ROWS_TABLE = 'rows';

/**
 * Error name stamped on an update or delete refused because its row is not
 * visibly live at admission time. The refusal is atomic with the check, so a
 * row that disappears after a renderer-side read still fails, and the name
 * survives the schema-blind Worker and HTTP carriers.
 */
export const WORKSPACE_ROW_ABSENT_ERROR_NAME = 'WorkspaceRowAbsentError';

/** True when an error means an update or delete lost its race with row deletion. */
export function isWorkspaceRowAbsentError(cause: unknown): boolean {
	return (
		cause instanceof Error && cause.name === WORKSPACE_ROW_ABSENT_ERROR_NAME
	);
}

function rowAbsentError(table: string, rowId: string): Error {
	const error = new Error(`Cannot modify absent row '${table}.${rowId}'`);
	error.name = WORKSPACE_ROW_ABSENT_ERROR_NAME;
	return error;
}

export type CanonicalStoreOptions = {
	/** Synchronized mode admits durable RowIntents instead of mutating confirmed rows. */
	admitIntent?(intent: WireRowIntent): void;
	/** Read confirmed state plus any synchronized optimistic overlay. */
	readCurrentRow?(table: string, rowId: string): JsonObject | undefined;
	onLocalCommit?(): void;
	/**
	 * Delete durable document logs inside the local-mode delete transaction,
	 * so scalar death and document death commit together. Synchronized mode
	 * never calls this; the replica owns its own lifecycle transactions.
	 */
	deleteDocumentRows?(addresses: readonly { table: string; rowId: string }[]): void;
	/** Revoke cached row documents as soon as local deletion changes liveness. */
	onRowsDeleted?(addresses: { table: string; rowId: string }[]): void;
};

/** One schema-opaque canonical row and KV store owned by a Workspace ID. */
export function createCanonicalStore(
	sqlite: SqliteDatabase,
	{
		admitIntent,
		readCurrentRow = (table, rowId) => readLocalRow(sqlite, table, rowId),
		onLocalCommit = () => undefined,
		deleteDocumentRows = () => undefined,
		onRowsDeleted = () => undefined,
	}: CanonicalStoreOptions = {},
) {
	installRecordsRelation();
	const allowedReadTargets = readTargets(
		sqlite.all<SqliteProgramRow>('EXPLAIN SELECT * FROM records'),
	);

	function read(table: string, rowId: string): JsonObject | undefined {
		return readCurrentRow(table, rowId);
	}

	function list(table: string): { rowId: string; fields: JsonObject }[] {
		if (!admitIntent) return listLocalRows(sqlite, table);
		const rowIds = sqlite.all<{ row_id: string }>(
			`SELECT row_id FROM "${ROWS_TABLE}" WHERE table_key = ?
			 UNION
			 SELECT row_id FROM "intents" WHERE table_key = ?
			 ORDER BY row_id`,
			[table, table],
		);
		return rowIds.flatMap(({ row_id: rowId }) => {
			const fields = readCurrentRow(table, rowId);
			return fields === undefined ? [] : [{ rowId, fields }];
		});
	}

	function listAll(): {
		tableKey: string;
		rowId: string;
		fields: JsonObject;
	}[] {
		const addresses = admitIntent
			? sqlite.all<{ table_key: string; row_id: string }>(
					`SELECT table_key, row_id FROM "${ROWS_TABLE}"
					 WHERE table_key <> ?
					 UNION
					 SELECT table_key, row_id FROM "intents"
					 WHERE table_key <> ?
					 ORDER BY table_key, row_id`,
					[RESERVED_KV_TABLE, RESERVED_KV_TABLE],
				)
			: sqlite.all<{ table_key: string; row_id: string }>(
					`SELECT table_key, row_id FROM "${ROWS_TABLE}"
					 WHERE table_key <> ? ORDER BY table_key, row_id`,
					[RESERVED_KV_TABLE],
				);
		return addresses.flatMap(({ table_key: tableKey, row_id: rowId }) => {
			const fields = readCurrentRow(tableKey, rowId);
			return fields === undefined ? [] : [{ tableKey, rowId, fields }];
		});
	}

	function sql(query: string, parameters: readonly SqliteValue[]): SqliteRow[] {
		assertSelectStatement(query);
		assertProgramReadsOnlyRecords(
			sqlite.all<SqliteProgramRow>(`EXPLAIN ${query}`, parameters),
			allowedReadTargets,
		);
		refreshRecordsRelation();
		sqlite.run('PRAGMA query_only = ON');
		try {
			return sqlite.all<SqliteRow>(query, parameters);
		} finally {
			sqlite.run('PRAGMA query_only = OFF');
		}
	}

	function admit(intent: WireRowIntent): void {
		intent = parseRowIntent(intent);
		if (
			intent.kind === 'create' &&
			!isAdmissibleCanonicalRow({
				table: intent.table,
				rowId: intent.rowId,
				fields: intent.fields,
			})
		) {
			throw new RangeError('Canonical row exceeds portable row-sync limits');
		}
		// The one guarded admission boundary shared by local, synchronized, and
		// every transport: an update or delete of an absent row refuses here
		// instead of admitting a speculative intent or silently no-op mutating.
		// The reserved KV map row is immortal and upserts, so it is exempt.
		if (
			(intent.kind === 'update' || intent.kind === 'delete') &&
			!(
				intent.table === RESERVED_KV_TABLE &&
				intent.rowId === RESERVED_KV_ROW_ID
			) &&
			readCurrentRow(intent.table, intent.rowId) === undefined
		) {
			throw rowAbsentError(intent.table, intent.rowId);
		}
		if (admitIntent) {
			admitIntent(structuredClone(intent));
			if (intent.kind === 'delete') {
				onRowsDeleted([{ table: intent.table, rowId: intent.rowId }]);
			}
			return;
		}

		switch (intent.kind) {
			case 'create':
				sqlite.run(
					`INSERT INTO "${ROWS_TABLE}"(table_key, row_id, fields_json)
					 VALUES (?, ?, ?)`,
					[intent.table, intent.rowId, JSON.stringify(intent.fields)],
				);
				onLocalCommit();
				return;
			case 'update': {
				if (
					intent.table === RESERVED_KV_TABLE &&
					intent.rowId === RESERVED_KV_ROW_ID
				) {
					sqlite.transaction(() => {
						const current = readCurrentRow(intent.table, intent.rowId);
						const folded = foldFields(current, intent);
						if (folded.kind !== 'fields') return;
						sqlite.run(
							`INSERT INTO "${ROWS_TABLE}"(table_key, row_id, fields_json)
							 VALUES (?, ?, ?)
							 ON CONFLICT(table_key, row_id) DO UPDATE SET
								fields_json = excluded.fields_json`,
							[intent.table, intent.rowId, JSON.stringify(folded.fields)],
						);
						onLocalCommit();
					});
					return;
				}
				const current = readCurrentRow(intent.table, intent.rowId);
				const folded = foldFields(current, intent);
				if (folded.kind !== 'fields') return;
				sqlite.run(
					`UPDATE "${ROWS_TABLE}" SET fields_json = ?
					 WHERE table_key = ? AND row_id = ?`,
					[JSON.stringify(folded.fields), intent.table, intent.rowId],
				);
				onLocalCommit();
				return;
			}
			case 'delete':
				sqlite.transaction(() => {
					sqlite.run(
						`DELETE FROM "${ROWS_TABLE}"
						 WHERE table_key = ? AND row_id = ?`,
						[intent.table, intent.rowId],
					);
					deleteDocumentRows([{ table: intent.table, rowId: intent.rowId }]);
				});
				onLocalCommit();
				onRowsDeleted([{ table: intent.table, rowId: intent.rowId }]);
				return;
			default:
				intent satisfies never;
				return;
		}
	}

	return { read, list, admit, sql };

	function installRecordsRelation(): void {
		sqlite.run(
			`CREATE TEMP TABLE IF NOT EXISTS records (
				table_key   TEXT NOT NULL,
				row_id      TEXT NOT NULL,
				fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
				PRIMARY KEY(table_key, row_id)
			) WITHOUT ROWID, STRICT`,
		);
	}

	function refreshRecordsRelation(): void {
		const rows = listAll();
		sqlite.transaction(() => {
			sqlite.run('DELETE FROM temp.records');
			for (const row of rows) {
				sqlite.run(
					`INSERT INTO temp.records
						(table_key, row_id, fields_json)
					 VALUES (?, ?, ?)`,
					[row.tableKey, row.rowId, JSON.stringify(row.fields)],
				);
			}
		});
	}
}

export type CanonicalStore = ReturnType<typeof createCanonicalStore>;

type SqliteProgramRow = SqliteRow & {
	opcode: string;
	p2: number;
	p3: number;
};

function assertSelectStatement(query: string): void {
	const trimmed = query.trim();
	if (!/^(?:SELECT|WITH)(?:\s|$)/i.test(trimmed)) {
		throw new Error('sql() accepts only SELECT statements and CTEs');
	}
	if (trimmed.includes(';')) {
		throw new Error('sql() accepts exactly one statement');
	}
}

function readTargets(program: readonly SqliteProgramRow[]): Set<string> {
	return new Set(
		program
			.filter(({ opcode }) => opcode === 'OpenRead')
			.map(({ p2, p3 }) => `${p3}:${p2}`),
	);
}

function assertProgramReadsOnlyRecords(
	program: readonly SqliteProgramRow[],
	allowedReadTargets: ReadonlySet<string>,
): void {
	for (const instruction of program) {
		if (instruction.opcode === 'OpenWrite' || instruction.opcode === 'VOpen') {
			throw new Error('sql() accepts only read-only records queries');
		}
		if (
			instruction.opcode === 'OpenRead' &&
			!allowedReadTargets.has(`${instruction.p3}:${instruction.p2}`)
		) {
			throw new Error('sql() cannot access runtime-private storage');
		}
	}
}
