import type { JsonObject, JsonValue } from '@epicenter/lens';
import type { ParsedLens, ParsedTable } from '@epicenter/lens';
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

/**
 * The one document in the log.
 *
 * An application is one document (ADR-0215), so this column distinguishes
 * nothing today. It is kept because the log's shape survives the browser
 * arriving and a second durable artifact appearing, and dropping a column to
 * save nine bytes a row is the kind of saving that costs a migration later.
 *
 * Named for what it is rather than `index`, which was the name of one half of a
 * split that no longer exists.
 */
export const APP_DOCUMENT = 'app';

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
	database.run(`
		CREATE TABLE IF NOT EXISTS _outbox (
			id    INTEGER NOT NULL CHECK (id > 0),
			bytes BLOB    NOT NULL,
			PRIMARY KEY (id)
		) WITHOUT ROWID, STRICT
	`);
	database.run(`
		CREATE TABLE IF NOT EXISTS _cursor (
			document TEXT    NOT NULL,
			seq      INTEGER NOT NULL CHECK (seq >= 0),
			PRIMARY KEY (document)
		) WITHOUT ROWID, STRICT
	`);
}

/** One unsent entry, at the local position that orders it. */
export type OutboxEntry = { id: number; bytes: Uint8Array };

/**
 * Hold one locally authored update as unsent.
 *
 * A separate relation rather than a cursor into `_updates`, and that is a
 * correctness requirement rather than a preference: `appendUpdate` collapses
 * `_updates` and renumbers it from 1, so any position recorded against that
 * relation would silently come to mean a different update.
 *
 * Only bytes this device authored are ever enqueued. Bytes received from the
 * authority are already in the authority's log, so re-offering them would grow
 * the log with nothing new in it.
 */
export function enqueueOutbox(
	database: SqliteDatabase,
	update: Uint8Array,
): void {
	const nextId =
		database.all<SqliteRow & { id: number }>(
			'SELECT COALESCE(MAX(id), 0) + 1 AS id FROM _outbox',
		)[0]?.id ?? 1;
	database.run('INSERT INTO _outbox (id, bytes) VALUES (?, ?)', [
		nextId,
		new Uint8Array(update),
	]);
}

/** Every unsent entry, oldest first. */
export function readOutbox(database: SqliteDatabase): OutboxEntry[] {
	return database
		.all<SqliteRow & { id: number; bytes: Uint8Array | ArrayBuffer }>(
			'SELECT id, bytes FROM _outbox ORDER BY id',
		)
		.map((row) => ({ id: row.id, bytes: copyBytes(row.bytes) }));
}

/** Replace every entry through `throughId` with one merged entry. */
export function replaceOutboxThrough(
	database: SqliteDatabase,
	throughId: number,
	merged: Uint8Array,
): void {
	database.run('DELETE FROM _outbox WHERE id <= ?', [throughId]);
	database.run('INSERT INTO _outbox (id, bytes) VALUES (?, ?)', [
		throughId,
		new Uint8Array(merged),
	]);
}

/** Forget every entry the authority has taken responsibility for. */
export function dropOutboxThrough(
	database: SqliteDatabase,
	throughId: number,
): void {
	database.run('DELETE FROM _outbox WHERE id <= ?', [throughId]);
}

/**
 * How far through the authority's log this replica has read.
 *
 * A log position, deliberately, and not a state vector. A state vector cannot
 * express deletion, so it can never answer "have I seen everything"; an integer
 * position can, and it is the only thing either side has to agree on.
 *
 * Zero means nothing has been read, which is also what a fresh replica reports.
 */
export function readCursor(
	database: SqliteDatabase,
	document: string,
): number {
	return (
		database.all<SqliteRow & { seq: number }>(
			'SELECT seq FROM _cursor WHERE document = ?',
			[document],
		)[0]?.seq ?? 0
	);
}

/**
 * Record that everything through `seq` has been applied.
 *
 * Written AFTER the bytes it accounts for have committed, never with them. A
 * crash in between leaves the cursor behind the document, so the entry arrives
 * a second time and applies again, which costs nothing because an update is
 * idempotent (`evidence/invariants.test.ts`). The other order would skip an
 * entry, and a skipped entry is invisible forever.
 */
export function writeCursor(
	database: SqliteDatabase,
	document: string,
	seq: number,
): void {
	database.run(
		'INSERT OR REPLACE INTO _cursor (document, seq) VALUES (?, ?)',
		[document, seq],
	);
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
	// KV projects as a one-row relation named `kv`, which the lens reserves as a
	// table name so nothing can collide with it.
	const relations: [string, ParsedTable][] = [
		...(lens.kv === undefined ? [] : ([['kv', lens.kv]] as [string, ParsedTable][])),
		...lens.tables,
	];
	for (const [tableName, table] of relations) {
		const fields = [...table.fields.keys()];
		// A relation whose columns no longer match the lens is DROPPED rather than
		// altered, which is only safe because a projection is a cache the CRDT can
		// always rebuild, and `bindUnknown` rebuilds every table right after this.
		//
		// `CREATE TABLE IF NOT EXISTS` alone was a live bug, and the most ordinary
		// lens change there is triggered it: adding a field left the old relation
		// in place without the new column, so `rebuildProjectedTable` failed with
		// "table notes has no column named pinned". Because `persist` fails closed,
		// that did not stop at the new binding: the binding the app already held
		// started reporting `StorageFailed` for every read and write, and
		// `applyRemote` failed too, so through the transport it was indistinguish-
		// able from a poison pill even though the bytes were fine and every other
		// replica took them.
		if (!columnsMatch(database, tableName, fields)) {
			database.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
		}
		const columns = fields.map((field) => `${quoteIdentifier(field)} ANY`);
		database.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
				id TEXT PRIMARY KEY${columns.length === 0 ? '' : `,\n\t\t\t\t${columns.join(',\n\t\t\t\t')}`}
			) WITHOUT ROWID, STRICT`,
		);
	}
}

/**
 * Whether a projected relation already has exactly the columns a lens declares.
 *
 * A relation that does not exist yet "matches", so a first bind creates it
 * rather than dropping nothing and creating it. Order is compared as a set,
 * because the projection addresses columns by name.
 */
function columnsMatch(
	database: SqliteDatabase,
	tableName: string,
	fields: readonly string[],
): boolean {
	const existing = database.all<SqliteRow & { name: string }>(
		`PRAGMA table_info(${quoteIdentifier(tableName)})`,
	);
	if (existing.length === 0) return true;
	const found = new Set(existing.map((column) => column.name));
	found.delete('id');
	if (found.size !== fields.length) return false;
	return fields.every((field) => found.has(field));
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
