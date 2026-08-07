import type { JsonObject, JsonValue } from '@epicenter/lens';
import type { ParsedLens } from '@epicenter/lens/lens';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import * as Y from '@y/y';

/**
 * How many appends the live log holds before it collapses (ADR-0159/0214).
 *
 * The file oscillates rather than growing: only the history file grows
 * monotonically, and it is the one with a pruning pragma and no correctness
 * role.
 */
export const COMPACTION_THRESHOLD = 64;

/** The index document's name in the update log. Rows name their own. */
export const INDEX_DOCUMENT = 'index';

/** `notes/n1` names the document a row inherently owns (ADR-0130/0212). */
export function rowDocumentName(tableName: string, rowId: string): string {
	return `${tableName}/${rowId}`;
}

type StoredUpdate = SqliteRow & {
	seq: number;
	bytes: Uint8Array | ArrayBuffer;
};

/**
 * The live store file: the Yjs update log and the lens projection, together.
 *
 * They share a file rather than merely a directory so that an append and the
 * projection write it implies commit in one transaction. That is what makes
 * `query` always see committed local writes; two files could disagree.
 */
export function applyStoreSchema(database: SqliteDatabase): void {
	database.run(`
		CREATE TABLE IF NOT EXISTS _updates (
			document TEXT    NOT NULL,
			seq      INTEGER NOT NULL CHECK (seq > 0),
			bytes    BLOB    NOT NULL,
			PRIMARY KEY (document, seq)
		) WITHOUT ROWID, STRICT
	`);
}

/**
 * The history file: what collapse superseded (ADR-0214).
 *
 * Collapse is what keeps the live log small, and history is what collapse would
 * otherwise destroy, so collapse copies the rows it is about to delete here
 * first. A crash between the copy and the delete duplicates an entry rather
 * than losing one, which is the direction the primary key makes safe.
 */
export function applyHistorySchema(database: SqliteDatabase): void {
	// Pruning returns disk only with incremental auto-vacuum, and it must be set
	// before the first table is created to take effect.
	database.run('PRAGMA auto_vacuum = INCREMENTAL');
	database.run(`
		CREATE TABLE IF NOT EXISTS _history (
			document TEXT    NOT NULL,
			seq      INTEGER NOT NULL,
			taken_at INTEGER NOT NULL,
			bytes    BLOB    NOT NULL,
			PRIMARY KEY (document, seq)
		) WITHOUT ROWID, STRICT
	`);
}

/**
 * A projection table per lens table: `id` plus one column per declared field.
 *
 * Columns are `ANY` rather than typed from the field's arktype expression. A
 * field is a union as often as not (`'string|null'`), and the projection is a
 * cache the CRDT can always rebuild, so deriving a narrow column type would buy
 * nothing and cost a mapping that has to be right for every expression.
 *
 * The name is quoted but the lens has already refused anything that is not a
 * bare SQL identifier, so quoting is defence rather than permission.
 */
export function applyProjectionSchema(
	database: SqliteDatabase,
	lens: ParsedLens,
): void {
	for (const [tableName, table] of lens.tables) {
		const columns = [...table.fields.keys()].map(
			(field) => `${quoteIdentifier(field)} ANY`,
		);
		database.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
				id TEXT PRIMARY KEY${columns.length === 0 ? '' : `,\n\t\t\t\t${columns.join(',\n\t\t\t\t')}`}
			) WITHOUT ROWID, STRICT`,
		);
	}
}

/**
 * One field's value as the projection stores it.
 *
 * A scalar binds natively so `WHERE title = 'Groceries'` works; an array or
 * object binds as JSON text so `json_each(notes.tags)` works. Nothing ever
 * decodes these back, because the CRDT is the truth and the projection is a
 * cache, so the two encodings can never be confused for one another.
 */
export function projectValue(value: JsonValue | undefined): SqliteValue {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string' || typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return JSON.stringify(value);
}

/** Replace one row in the projection. */
export function upsertProjectedRow(
	database: SqliteDatabase,
	tableName: string,
	fieldNames: readonly string[],
	rowId: string,
	payload: JsonObject,
): void {
	const columns = ['id', ...fieldNames];
	const values: SqliteValue[] = [
		rowId,
		...fieldNames.map((field) => projectValue(payload[field])),
	];
	database.run(
		`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns
			.map(quoteIdentifier)
			.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
		values,
	);
}

/** Remove one row from the projection. A dead row is not a queryable row. */
export function deleteProjectedRow(
	database: SqliteDatabase,
	tableName: string,
	rowId: string,
): void {
	database.run(`DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ?`, [
		rowId,
	]);
}

/** Drop and rebuild one table's projection from the CRDT. */
export function rebuildProjectedTable(
	database: SqliteDatabase,
	tableName: string,
	fieldNames: readonly string[],
	rows: ReadonlyMap<string, JsonObject>,
): void {
	database.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
	for (const [rowId, payload] of rows) {
		upsertProjectedRow(database, tableName, fieldNames, rowId, payload);
	}
}

export function readUpdates(
	database: SqliteDatabase,
	document: string,
): StoredUpdate[] {
	return database.all<StoredUpdate>(
		'SELECT seq, bytes FROM _updates WHERE document = ? ORDER BY seq',
		[document],
	);
}

export function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

/** Replay one stored chain into a fresh document. */
export function replay(updates: readonly StoredUpdate[]): Y.Doc {
	const document = new Y.Doc({ gc: true });
	try {
		for (const update of updates) {
			Y.applyUpdateV2(document, copyBytes(update.bytes));
		}
		return document;
	} catch (cause) {
		document.destroy();
		throw cause;
	}
}

/**
 * Append one update, and collapse the chain when it has grown long enough.
 *
 * Runs inside a transaction the caller owns, so the projection write the caller
 * makes alongside it commits or fails with these bytes. Collapse copies every
 * row it is about to delete into history first, in that order deliberately: a
 * crash after the copy duplicates a history entry, which the primary key
 * absorbs, while the other order would lose one.
 */
export function appendUpdate({
	database,
	history,
	document,
	update,
	takenAt,
}: {
	database: SqliteDatabase;
	/** Absent means this store keeps no history; collapse then simply deletes. */
	history: SqliteDatabase | undefined;
	document: string;
	update: Uint8Array;
	takenAt: number;
}): void {
	const nextSeq =
		database.all<SqliteRow & { seq: number }>(
			'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM _updates WHERE document = ?',
			[document],
		)[0]?.seq ?? 1;
	database.run(
		'INSERT INTO _updates (document, seq, bytes) VALUES (?, ?, ?)',
		[document, nextSeq, new Uint8Array(update)],
	);

	const updates = readUpdates(database, document);
	if (updates.length < COMPACTION_THRESHOLD) return;

	if (history !== undefined) {
		history.transaction(() => {
			for (const superseded of updates) {
				history.run(
					`INSERT OR IGNORE INTO _history (document, seq, taken_at, bytes)
					 VALUES (?, ?, ?, ?)`,
					[document, superseded.seq, takenAt, copyBytes(superseded.bytes)],
				);
			}
		});
	}

	const compacted = replay(updates);
	try {
		const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
		database.run('DELETE FROM _updates WHERE document = ?', [document]);
		database.run(
			'INSERT INTO _updates (document, seq, bytes) VALUES (?, 1, ?)',
			[document, baseline],
		);
	} finally {
		compacted.destroy();
	}
}

/**
 * Quote one SQL identifier.
 *
 * The lens already refuses any table or field name that is not a bare
 * identifier, so this never has real work to do. It stays because the
 * projection builds SQL by concatenation, and a schema that depends on a
 * validator two packages away for its safety should not also depend on nobody
 * ever relaxing that validator.
 */
function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
