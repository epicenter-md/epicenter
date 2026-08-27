/**
 * The CRDT's own durable bytes: the update log, its snapshot folding, the outbox and
 * the cursor.
 *
 * The database's derived SQL used to live here too and now sits in `./projection.js`.
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
 * The durable record oscillates rather than growing: a chain that reaches the
 * threshold collapses into one baseline, so nothing here accumulates.
 */
export const SNAPSHOT_FOLD_THRESHOLD = 64;

/**
 * The application document's name in the log.
 *
 * The log is per-document (ADR-0248): the application document holds every
 * scalar row under this reserved name, and each row's rich document holds its
 * chain under the row's derived address (`{databaseId}/{tableName}/{rowId}`).
 * The two spellings cannot collide, because a derived address always carries
 * two slashes and this name carries none.
 */
export const APP_DOCUMENT = 'app';

type StoredUpdate = SqliteRow & {
	seq: number;
	bytes: Uint8Array | ArrayBuffer;
};

/**
 * The live store file: the Yjs update log and the database projection, together.
 *
 * They share a file rather than merely a directory so that an append and the
 * projection write it implies commit in one transaction. That is what makes
 * `query` always see committed local writes; two files could disagree.
 */
export function applyStoreSchema(sqlite: SqliteDatabase): void {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _updates (
			document TEXT    NOT NULL,
			seq      INTEGER NOT NULL CHECK (seq > 0),
			bytes    BLOB    NOT NULL,
			PRIMARY KEY (document, seq)
		) WITHOUT ROWID, STRICT
	`);
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _outbox (
			id       INTEGER NOT NULL CHECK (id > 0),
			document TEXT    NOT NULL,
			bytes    BLOB    NOT NULL,
			PRIMARY KEY (id)
		) WITHOUT ROWID, STRICT
	`);
	sqlite.run(`
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
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _meta (
			key   TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (key)
		) WITHOUT ROWID, STRICT
	`);
	// A retired document address (ADR-0248): a row deletion records one here,
	// atomically with removing the scalar row and the document's chain, and
	// nothing ever removes it. A tombstoned address takes no further bytes, so
	// a late write cannot resurrect a deleted row's document.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _tombstones (
			document TEXT NOT NULL,
			PRIMARY KEY (document)
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
	sqlite: SqliteDatabase,
	id: number,
	document: string,
	update: Uint8Array,
): void {
	sqlite.run('INSERT INTO _outbox (id, document, bytes) VALUES (?, ?, ?)', [
		id,
		document,
		new Uint8Array(update),
	]);
}

/** Every unsent entry, oldest first. */
export function readOutbox(sqlite: SqliteDatabase): OutboxEntry[] {
	return sqlite
		.all<
			SqliteRow & {
				id: number;
				document: string;
				bytes: Uint8Array | ArrayBuffer;
			}
		>('SELECT id, document, bytes FROM _outbox ORDER BY id')
		.map((row) => ({
			id: row.id,
			document: row.document,
			bytes: copyBytes(row.bytes),
		}));
}

/**
 * Replace one document's entries through `throughId` with one merged entry.
 *
 * Per document, because entries for different documents cannot merge into one
 * update; each document's covered entries collapse to a merged entry at that
 * document's own highest covered id, which keeps ids unique and ordered.
 */
export function replaceOutboxThrough(
	sqlite: SqliteDatabase,
	document: string,
	throughId: number,
	merged: Uint8Array,
): void {
	sqlite.run('DELETE FROM _outbox WHERE document = ? AND id <= ?', [
		document,
		throughId,
	]);
	sqlite.run('INSERT INTO _outbox (id, document, bytes) VALUES (?, ?, ?)', [
		throughId,
		document,
		new Uint8Array(merged),
	]);
}

/** Forget every entry the authority has taken responsibility for. */
export function dropOutboxThrough(
	sqlite: SqliteDatabase,
	throughId: number,
): void {
	sqlite.run('DELETE FROM _outbox WHERE id <= ?', [throughId]);
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
export function readCursor(sqlite: SqliteDatabase, document: string): number {
	return (
		sqlite.all<SqliteRow & { seq: number }>(
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
	sqlite: SqliteDatabase,
	document: string,
	seq: number,
): void {
	sqlite.run('INSERT OR REPLACE INTO _cursor (document, seq) VALUES (?, ?)', [
		document,
		seq,
	]);
}

/**
 * The store file format this code writes: the independent-row-document era
 * (ADR-0248), following '2', the document-identity era (ADR-0231).
 *
 * A file's format row is its birth certificate, written in the same
 * transaction that first creates its state. A file certified under another
 * format holds shapes this code no longer reads: '2' kept every row's rich
 * content nested inside the application document and its outbox rows carry no
 * document address, so it is untrusted whole. There is no migration; the
 * cutover is a wipe, and a replica refills from its authority.
 */
export const STORE_FORMAT = '3';

/**
 * Enforce the format at open: certify a fresh file, keep one certified under
 * this format, and wipe any other whole.
 *
 * One transaction, so at any crash point the file holds what it held or the
 * empty certified state; either way the next open converges. The wipe is the
 * only in-place deletion in the design, and it exists because this is a
 * format boundary rather than a document boundary: the file that comes out
 * the other side is a NEW file that happens to share a name.
 */
export function adoptStoreFormat(sqlite: SqliteDatabase): void {
	sqlite.transaction(() => {
		const format = sqlite.all<SqliteRow & { value: string }>(
			"SELECT value FROM _meta WHERE key = 'format'",
		)[0]?.value;
		if (format === STORE_FORMAT) return;
		sqlite.run('DELETE FROM _updates');
		sqlite.run('DELETE FROM _outbox');
		sqlite.run('DELETE FROM _cursor');
		sqlite.run('DELETE FROM _meta');
		sqlite.run('DELETE FROM _tombstones');
		sqlite.run("INSERT INTO _meta (key, value) VALUES ('format', ?)", [
			STORE_FORMAT,
		]);
	});
}

/** The format this file was certified under, if any. */
export function readFormat(sqlite: SqliteDatabase): string | undefined {
	return sqlite.all<SqliteRow & { value: string }>(
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
	sqlite: SqliteDatabase,
): string | undefined {
	return sqlite.all<SqliteRow & { value: string }>(
		"SELECT value FROM _meta WHERE key = 'document'",
	)[0]?.value;
}

/**
 * Stamp which document this replica's state belongs to. First write wins:
 * membership never changes in place, only by discarding the file whole.
 */
export function writeDocumentIdentity(
	sqlite: SqliteDatabase,
	id: string,
): void {
	sqlite.run(
		"INSERT OR IGNORE INTO _meta (key, value) VALUES ('document', ?)",
		[id],
	);
}

export function readUpdates(
	sqlite: SqliteDatabase,
	document: string,
): StoredUpdate[] {
	return sqlite.all<StoredUpdate>(
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
 * Runs inside a transaction the caller owns, so everything the caller writes
 * alongside it commits or fails with these bytes. Collapse replaces the whole
 * chain with one baseline that carries the same state, so what it deletes is
 * superseded rather than lost.
 */
export function appendUpdate({
	sqlite,
	document,
	update,
}: {
	sqlite: SqliteDatabase;
	document: string;
	update: Uint8Array;
}): void {
	const nextSeq =
		sqlite.all<SqliteRow & { seq: number }>(
			'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM _updates WHERE document = ?',
			[document],
		)[0]?.seq ?? 1;
	sqlite.run('INSERT INTO _updates (document, seq, bytes) VALUES (?, ?, ?)', [
		document,
		nextSeq,
		new Uint8Array(update),
	]);

	const updates = readUpdates(sqlite, document);
	if (updates.length < SNAPSHOT_FOLD_THRESHOLD) return;

	const compacted = replay(updates);
	try {
		const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
		sqlite.run('DELETE FROM _updates WHERE document = ?', [document]);
		sqlite.run('INSERT INTO _updates (document, seq, bytes) VALUES (?, 1, ?)', [
			document,
			baseline,
		]);
	} finally {
		compacted.destroy();
	}
}

/**
 * Retire one document address (ADR-0248): tombstone it durably and delete
 * its stored chain and unsent entries. Runs inside the caller's transaction,
 * beside the scalar row removal it composes with.
 */
export function retireDocument(sqlite: SqliteDatabase, document: string): void {
	sqlite.run('INSERT OR IGNORE INTO _tombstones (document) VALUES (?)', [
		document,
	]);
	sqlite.run('DELETE FROM _updates WHERE document = ?', [document]);
	sqlite.run('DELETE FROM _outbox WHERE document = ?', [document]);
}

/** Every durably retired document address. */
export function readTombstones(sqlite: SqliteDatabase): string[] {
	return sqlite
		.all<SqliteRow & { document: string }>('SELECT document FROM _tombstones')
		.map((row) => row.document);
}

/**
 * Everything this file durably held at open, materialized once.
 *
 * The store hydrates its application document from `updates`, seeds its
 * durable mirror from the rest, and never reads this file again outside a
 * flush or a row document's own open (ADR-0238, ADR-0248).
 */
export function loadDurableSnapshot(sqlite: SqliteDatabase): DurableSnapshot {
	return {
		updates: readUpdates(sqlite, APP_DOCUMENT).map((stored) =>
			copyBytes(stored.bytes),
		),
		outbox: readOutbox(sqlite),
		cursor: readCursor(sqlite, APP_DOCUMENT),
		identity: readDocumentIdentity(sqlite),
		tombstones: readTombstones(sqlite),
	};
}

/**
 * The SQLite durable engine: one batch, one transaction, in order.
 *
 * Synchronous, which is what lets a verb on a Durable Object return with its
 * write already durable. Opening applies the schema and enforces the
 * format certificate (ADR-0231's cutover), exactly as every open always has.
 */
export function createSqliteDurablePort({
	sqlite,
}: {
	sqlite: SqliteDatabase;
}): DurablePort & { load(): DurableSnapshot } {
	applyStoreSchema(sqlite);
	adoptStoreFormat(sqlite);
	return {
		load: () => loadDurableSnapshot(sqlite),
		commit(ops: readonly DurableOp[]): void {
			sqlite.transaction(() => {
				for (const op of ops) {
					switch (op.kind) {
						case 'append': {
							appendUpdate({
								sqlite,
								document: op.document,
								update: op.bytes,
							});
							if (op.outboxId !== undefined) {
								insertOutbox(sqlite, op.outboxId, op.document, op.bytes);
							}
							break;
						}
						case 'cursor':
							writeCursor(sqlite, APP_DOCUMENT, op.seq);
							break;
						case 'identity':
							writeDocumentIdentity(sqlite, op.id);
							break;
						case 'dropOutbox':
							dropOutboxThrough(sqlite, op.throughId);
							break;
						case 'replaceOutbox':
							replaceOutboxThrough(
								sqlite,
								op.document,
								op.throughId,
								op.merged,
							);
							break;
						case 'retire':
							retireDocument(sqlite, op.document);
							break;
					}
				}
			});
		},
		readDocument: (document: string) =>
			readUpdates(sqlite, document).map((stored) => copyBytes(stored.bytes)),
		listDocuments: () =>
			sqlite
				.all<SqliteRow & { document: string }>(
					'SELECT DISTINCT document FROM _updates ORDER BY document',
				)
				.map((row) => row.document),
	};
}
