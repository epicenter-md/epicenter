/**
 * The CRDT's own durable bytes: the update log, its compaction, the outbox and
 * the cursor.
 *
 * The lens's derived SQL used to live here too and now sits in `./projection.js`.
 * The two shared a file and nothing else: this is what the document IS and what
 * `../sync` reads, while a projection is a cache rebuilt from it at every bind.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
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

