/**
 * The CRDT's own durable bytes: the update log, its snapshot folding, the outbox and
 * the cursor.
 *
 * The workspace's derived SQL used to live here too and now sits in `./projection.js`.
 * The two shared a file and nothing else: this is what the document IS and what
 * `../sync` reads, while a projection is a cache rebuilt from it at open.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';

import type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
} from './persistence.js';

export type { OutboxEntry } from './persistence.js';

/**
 * How many appends the live log holds before it folds into a snapshot (ADR-0159/0214).
 *
 * The file oscillates rather than growing: only the history file grows
 * monotonically, and it is the one with a pruning pragma and no correctness
 * role.
 */
export const SNAPSHOT_FOLD_THRESHOLD = 64;

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
 * The live store file: the Yjs update log and the workspace projection, together.
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
	// One durable fact beyond the log, the outbox and the cursor: which
	// authority document this replica's state belongs to (ADR-0231). A
	// key-value shape, mirroring the authority's own `_meta`, so a second
	// fact is a row and not a migration.
	database.run(`
		CREATE TABLE IF NOT EXISTS _meta (
			key   TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (key)
		) WITHOUT ROWID, STRICT
	`);
}

/**
 * Hold one locally authored update as unsent, at the id the store assigned.
 *
 * A separate relation rather than a cursor into `_updates`, and that is a
 * correctness requirement rather than a preference: `appendUpdate` collapses
 * `_updates` and renumbers it from 1, so any position recorded against that
 * relation would silently come to mean a different update.
 *
 * The id arrives from the store rather than being minted here, so the
 * in-memory mirror and this relation can never disagree about which entry an
 * acknowledgement names (ADR-0238). Only bytes this device authored are ever
 * enqueued: bytes received from the authority are already in the authority's
 * log, so re-offering them would grow the log with nothing new in it.
 */
export function insertOutbox(
	database: SqliteDatabase,
	id: number,
	update: Uint8Array,
): void {
	database.run('INSERT INTO _outbox (id, bytes) VALUES (?, ?)', [
		id,
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
export function readCursor(database: SqliteDatabase, document: string): number {
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
 * Written WITH the bytes it accounts for, in the same transaction, or after
 * them; never before. `applyRemote` commits both as one step, which is what
 * makes "a durable cursor of zero means no foreign byte was ever applied"
 * true rather than merely likely: a crash between the two halves would
 * otherwise leave a replica holding another document's bytes while presenting
 * the cursor of a fresh install (ADR-0231). The forbidden order would skip an
 * entry, and a skipped entry is invisible forever.
 */
export function writeCursor(
	database: SqliteDatabase,
	document: string,
	seq: number,
): void {
	database.run('INSERT OR REPLACE INTO _cursor (document, seq) VALUES (?, ?)', [
		document,
		seq,
	]);
}

/**
 * The store file format this code writes: the document-identity era.
 *
 * A file's format row is its birth certificate, written in the same
 * transaction that first creates its state. A file holding state WITHOUT it
 * predates the document identity: its bytes may belong to any document and
 * nothing durable can say which, so it is untrusted whole (ADR-0231's
 * deliberate break). There is no migration; the cutover is a wipe.
 */
export const STORE_FORMAT = '2';

/**
 * Enforce the format at open: certify a fresh file, keep a certified one,
 * and wipe a pre-identity one whole.
 *
 * One transaction, so at any crash point the file holds what it held or the
 * empty certified state; either way the next open converges. The wipe is the
 * only in-place deletion in the design, and it exists because this is a
 * format boundary rather than a document boundary: the file that comes out
 * the other side is a NEW file that happens to share a name.
 */
export function adoptStoreFormat(database: SqliteDatabase): void {
	database.transaction(() => {
		const format = database.all<SqliteRow & { value: string }>(
			"SELECT value FROM _meta WHERE key = 'format'",
		)[0]?.value;
		if (format !== undefined) return;
		database.run('DELETE FROM _updates');
		database.run('DELETE FROM _outbox');
		database.run('DELETE FROM _cursor');
		database.run('DELETE FROM _meta');
		database.run("INSERT INTO _meta (key, value) VALUES ('format', ?)", [
			STORE_FORMAT,
		]);
	});
}

/** The format this file was certified under, if any. */
export function readFormat(database: SqliteDatabase): string | undefined {
	return database.all<SqliteRow & { value: string }>(
		"SELECT value FROM _meta WHERE key = 'format'",
	)[0]?.value;
}

/**
 * Which authority document this replica's state belongs to.
 *
 * The membership fact the cursor cannot carry (ADR-0231). The cursor records
 * how far through a delivery log this replica has read; it says nothing about
 * WHICH document its local bytes are entangled with, and both directions of
 * that gap were reproduced as corruption: a crash between applying foreign
 * bytes and advancing the cursor, and a push that landed while the ack died,
 * each leave a committed replica wearing a fresh install's cursor. The
 * identity is stamped at first entanglement (atomically with the first
 * foreign apply, or durably before the first push leaves), never rewritten,
 * and dies with the file, which is exactly when the membership does.
 * `undefined` means this document has never exchanged a byte with any
 * authority. The sync client stamps an empty replica before it applies
 * authority bytes.
 */
export function readDocumentIdentity(
	database: SqliteDatabase,
): string | undefined {
	return database.all<SqliteRow & { value: string }>(
		"SELECT value FROM _meta WHERE key = 'document'",
	)[0]?.value;
}

/**
 * Stamp which document this replica's state belongs to. First write wins:
 * membership never changes in place, only by discarding the file whole.
 */
export function writeDocumentIdentity(
	database: SqliteDatabase,
	id: string,
): void {
	database.run(
		"INSERT OR IGNORE INTO _meta (key, value) VALUES ('document', ?)",
		[id],
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
	database.run('INSERT INTO _updates (document, seq, bytes) VALUES (?, ?, ?)', [
		document,
		nextSeq,
		new Uint8Array(update),
	]);

	const updates = readUpdates(database, document);
	if (updates.length < SNAPSHOT_FOLD_THRESHOLD) return;

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
 * Everything this file durably held at open, materialized once.
 *
 * The store hydrates its document from `updates`, seeds its durable mirror
 * from the rest, and never reads this file again outside a flush (ADR-0238).
 */
export function loadDurableSnapshot(database: SqliteDatabase): DurableSnapshot {
	return {
		updates: readUpdates(database, APP_DOCUMENT).map((stored) =>
			copyBytes(stored.bytes),
		),
		outbox: readOutbox(database),
		cursor: readCursor(database, APP_DOCUMENT),
		identity: readDocumentIdentity(database),
	};
}

/**
 * The SQLite durable engine: one batch, one transaction, in order.
 *
 * Synchronous, which is what lets a verb on Bun or a Durable Object return
 * with its write already durable. Opening applies the schema and enforces the
 * format certificate (ADR-0231's cutover), exactly as every open always has.
 */
export function createSqliteDurablePort({
	database,
	history,
}: {
	database: SqliteDatabase;
	/** Absent means this store keeps no history; collapse then simply deletes. */
	history?: SqliteDatabase;
}): DurablePort & { load(): DurableSnapshot } {
	applyStoreSchema(database);
	adoptStoreFormat(database);
	return {
		load: () => loadDurableSnapshot(database),
		commit(ops: readonly DurableOp[]): void {
			database.transaction(() => {
				for (const op of ops) {
					switch (op.kind) {
						case 'append': {
							appendUpdate({
								database,
								history,
								document: APP_DOCUMENT,
								update: op.bytes,
								takenAt: op.takenAt,
							});
							if (op.outboxId !== undefined) {
								insertOutbox(database, op.outboxId, op.bytes);
							}
							break;
						}
						case 'cursor':
							writeCursor(database, APP_DOCUMENT, op.seq);
							break;
						case 'identity':
							writeDocumentIdentity(database, op.id);
							break;
						case 'dropOutbox':
							dropOutboxThrough(database, op.throughId);
							break;
						case 'replaceOutbox':
							replaceOutboxThrough(database, op.throughId, op.merged);
							break;
					}
				}
			});
		},
	};
}
