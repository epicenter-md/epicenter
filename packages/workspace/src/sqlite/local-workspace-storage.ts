import type { JsonObject } from '@epicenter/row-sync';
import {
	type SqliteDatabase,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';

const STORAGE_VERSION = 3;
const ROWS_TABLE = 'rows';
export const LOCAL_WORKSPACE_STORAGE_SCHEMA_OBJECTS = [
	{ type: 'table', name: ROWS_TABLE },
] as const;
const CREATE_ROWS_TABLE = `
	CREATE TABLE "${ROWS_TABLE}" (
		table_key   TEXT NOT NULL,
		row_id      TEXT NOT NULL,
		fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
		PRIMARY KEY(table_key, row_id)
	) WITHOUT ROWID, STRICT
`;

function normalizedSchemaSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function listUserObjects(sqlite: SqliteDatabase): { name: string }[] {
	return sqlite.all<{ name: string }>(
		`SELECT name FROM sqlite_master
		 WHERE type IN ('table', 'index', 'trigger', 'view')
		   AND name NOT LIKE 'sqlite_%'
		 ORDER BY type, name`,
	);
}

function hasCurrentRowsSchema(sqlite: SqliteDatabase): boolean {
	const rowsObjects = sqlite.all<{ name: string; sql: string | null }>(
		`SELECT name, sql FROM sqlite_master
		 WHERE (type = 'table' AND name = ?)
		    OR (type IN ('index', 'trigger') AND tbl_name = ?)`,
		[ROWS_TABLE, ROWS_TABLE],
	);
	return (
		rowsObjects.length === 1 &&
		rowsObjects[0]?.name === ROWS_TABLE &&
		rowsObjects[0].sql !== null &&
		normalizedSchemaSql(rowsObjects[0].sql) ===
			normalizedSchemaSql(CREATE_ROWS_TABLE)
	);
}

/**
 * Open the local-only Device workspace store.
 *
 * Scalar rows live here; row documents live in the workspace's SQLite
 * update log (`workspace_document_updates`), owned by the document log in
 * the same file. There is no migration path: an unrecognized version fails
 * loudly instead of being read through a compatibility branch.
 */
export function initializeLocalWorkspaceStorage(sqlite: SqliteDatabase): void {
	if (inspectLocalWorkspaceStorage(sqlite) === 'current') return;
	sqlite.transaction(() => {
		sqlite.run(CREATE_ROWS_TABLE);
		sqlite.run(`PRAGMA user_version = ${STORAGE_VERSION}`);
	});
}

/** Classify Device scalar storage without changing it. */
export function inspectLocalWorkspaceStorage(
	sqlite: SqliteDatabase,
): 'empty' | 'current' {
	const version =
		sqlite.all<{ user_version: number }>('PRAGMA user_version')[0]
			?.user_version ?? 0;
	if (version === 0) {
		const existing = listUserObjects(sqlite);
		if (existing.length === 0) return 'empty';
		throw new StorageUpgradeRequiredError(
			'Device workspace storage',
			`version zero contains existing objects: ${existing
				.map(({ name }) => name)
				.join(', ')}`,
		);
	}

	if (version !== STORAGE_VERSION) {
		throw new StorageUpgradeRequiredError(
			'Device workspace storage',
			`expected format ${STORAGE_VERSION}, found ${version}`,
		);
	}
	if (!hasCurrentRowsSchema(sqlite)) {
		throw new StorageUpgradeRequiredError(
			'Device workspace storage',
			'format marker is current but the owned rows schema is not exact',
		);
	}
	return 'current';
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
