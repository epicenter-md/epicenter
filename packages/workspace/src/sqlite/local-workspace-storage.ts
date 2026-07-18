import type { JsonObject } from '@epicenter/row-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';

const STORAGE_VERSION = 2;
const ROWS_TABLE = 'rows';
const DOCUMENTS_TABLE = 'documents';

/** Open the two-table, local-only Device workspace store. */
export function initializeLocalWorkspaceStorage(sqlite: SqliteDatabase): void {
	sqlite.transaction(() => {
		const incompatibleLegacy = sqlite.all<{ name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name IN (
				'__epicenter_records', '__epicenter_replica_meta'
			 )`,
		);
		if (incompatibleLegacy.length > 0) {
			throw new Error('Incompatible local workspace storage');
		}

		const version =
			sqlite.all<{ user_version: number }>('PRAGMA user_version')[0]
				?.user_version ?? 0;
		if (version === 0) {
			sqlite.run(`
				CREATE TABLE "${ROWS_TABLE}" (
					table_key   TEXT NOT NULL,
					row_id      TEXT NOT NULL,
					fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
					PRIMARY KEY(table_key, row_id)
				) WITHOUT ROWID, STRICT;
				CREATE TABLE "${DOCUMENTS_TABLE}" (
					table_key TEXT NOT NULL,
					row_id    TEXT NOT NULL,
					yjs_state BLOB NOT NULL,
					PRIMARY KEY(table_key, row_id)
				) WITHOUT ROWID, STRICT;
			`);
			sqlite.run(`PRAGMA user_version = ${STORAGE_VERSION}`);
			return;
		}

		if (version === 1) {
			const pendingIntents = sqlite.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM "intents"',
			)[0]?.count;
			const synchronizedReplica = sqlite.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM "replica"',
			)[0]?.count;
			if (pendingIntents !== 0 || synchronizedReplica !== 0) {
				throw new Error('Incompatible local workspace storage');
			}
			sqlite.run('DROP TABLE "intents"');
			sqlite.run('DROP TABLE "replica"');
			sqlite.run(`PRAGMA user_version = ${STORAGE_VERSION}`);
			return;
		}

		if (version !== STORAGE_VERSION) {
			throw new Error('Incompatible local workspace storage');
		}
	});
}

/** Read one row directly from local confirmed storage. */
export function readLocalRow(
	sqlite: SqliteDatabase,
	table: string,
	rowId: string,
): JsonObject | undefined {
	const stored = sqlite.all<{ fields_json: string }>(
		`SELECT fields_json FROM "${ROWS_TABLE}"
		 WHERE table_key = ? AND row_id = ?`,
		[table, rowId],
	)[0];
	return stored ? JSON.parse(stored.fields_json) : undefined;
}

/** List one local table in stable row-id order. */
export function listLocalRows(
	sqlite: SqliteDatabase,
	table: string,
): { rowId: string; fields: JsonObject }[] {
	return sqlite
		.all<{ row_id: string; fields_json: string }>(
			`SELECT row_id, fields_json FROM "${ROWS_TABLE}"
			 WHERE table_key = ? ORDER BY row_id`,
			[table],
		)
		.map(({ row_id, fields_json }) => ({
			rowId: row_id,
			fields: JSON.parse(fields_json),
		}));
}

/** Read the single compact Yjs state owned by a local row. */
export function readLocalDocumentParts(
	sqlite: SqliteDatabase,
	table: string,
	rowId: string,
): Uint8Array[] {
	const stored = sqlite.all<{ yjs_state: Uint8Array | ArrayBuffer }>(
		`SELECT yjs_state FROM "${DOCUMENTS_TABLE}"
		 WHERE table_key = ? AND row_id = ?`,
		[table, rowId],
	)[0];
	if (!stored) return [];
	return [
		stored.yjs_state instanceof Uint8Array
			? stored.yjs_state
			: new Uint8Array(stored.yjs_state),
	];
}
