/**
 * The CRDT's own durable bytes: the update log, its snapshot folding, the outbox and
 * the cursor.
 *
 * Everything here is what the document IS and what `../sync` reads. Anything
 * derived from it, an index or an export, is a follower an application
 * composes on the public surface, never a relation kept beside these.
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
 * The durable record: the update log, the outbox, the cursor, the metadata,
 * and the tombstones, in one file so that one flush commits them together.
 */
export function applyStoreSchema(sqlite: SqliteDatabase): void {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _updates (
			document     TEXT    NOT NULL,
			id           INTEGER NOT NULL CHECK (id > 0),
			bytes        BLOB    NOT NULL,
			authoritySeq INTEGER CHECK (authoritySeq IS NULL OR authoritySeq >= 0),
			PRIMARY KEY (document, id)
		) WITHOUT ROWID, STRICT
	`);
	// Owed work is read off the chain, so the query that answers "what do I
	// still owe" has to be an index seek rather than a scan of every update.
	sqlite.run(`
		CREATE INDEX IF NOT EXISTS _updates_owed
			ON _updates (id) WHERE authoritySeq IS NULL
	`);
	// One durable fact beyond the log: which authority document this replica's
	// state belongs to (ADR-0231). A key-value shape, mirroring the authority's
	// own `_meta`, so a second fact is a row and not a migration.
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
 * What `authoritySeq` means, in three values rather than two.
 *
 * `NULL` is the only one that means OWED, and that precision is why a local
 * store works at all: it has no authority, so its bytes are not owed to
 * anyone, and marking them `NULL` would offer them to a server that does not
 * exist and would stop the chain from ever folding.
 *
 * ```txt
 *   NULL          the authority has no position for this. owed.
 *   NO_AUTHORITY  nothing will ever have a position for this. a local
 *                 store's every append, and every fold baseline.
 *   > 0           the position the authority's log gave it.
 * ```
 */
export const NO_AUTHORITY = 0;

/**
 * Every append the authority has no position for, oldest first.
 *
 * The outbox, as a query. It used to be a relation, because the fold
 * renumbered a document's chain from 1 and any position recorded against it
 * silently came to mean a different update. Ids are stable now, so owed work
 * is a property of an append rather than a copy of one, and the same bytes
 * stop being written twice on every local edit.
 */
export function readOutbox(sqlite: SqliteDatabase): OutboxEntry[] {
	return sqlite
		.all<SqliteRow & { document: string; id: number; bytes: Uint8Array }>(
			'SELECT document, id, bytes FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
		)
		.map((row) => ({
			id: row.id,
			document: row.document,
			bytes: copyBytes(row.bytes),
		}));
}

/**
 * How far through the authority's log this replica has read.
 *
 * Derived, and that is the point: a cursor computed from the bytes it accounts
 * for cannot run ahead of them. The rule that used to need one atomic batch to
 * enforce ("with the bytes, never after them") is now unrepresentable.
 *
 * It can lag, when an entry arrived whose sections were all for retired
 * addresses and nothing was stored. That is the safe direction: the entry is
 * received again and applying an update twice is free.
 *
 * Zero means nothing has been read, which is also what a fresh replica and a
 * local store both report.
 */
export function readCursor(sqlite: SqliteDatabase): number {
	return (
		sqlite.all<SqliteRow & { seq: number | null }>(
			'SELECT MAX(authoritySeq) AS seq FROM _updates',
		)[0]?.seq ?? 0
	);
}

/** The highest id any append carries, so the store mints from here. */
export function readLastId(sqlite: SqliteDatabase): number {
	return (
		sqlite.all<SqliteRow & { id: number | null }>(
			'SELECT MAX(id) AS id FROM _updates',
		)[0]?.id ?? 0
	);
}

/**
 * Record that the authority took responsibility through `throughId`, at the
 * position it put those bytes.
 *
 * One statement for what used to be two ops. `dropOutbox` deleted rows from a
 * relation and `cursor` wrote a number; both were reporting that the same
 * bytes reached the same log entry. Only rows still owed are stamped, so a
 * repeated ack is a no-op rather than a rewrite.
 */
export function acknowledge(
	sqlite: SqliteDatabase,
	throughId: number,
	authoritySeq: number,
): void {
	sqlite.run(
		'UPDATE _updates SET authoritySeq = ? WHERE id <= ? AND authoritySeq IS NULL',
		[authoritySeq, throughId],
	);
}

export const STORE_FORMAT = '4';

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
		'SELECT id AS seq, bytes FROM _updates WHERE document = ? ORDER BY id',
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
	id,
	update,
	authoritySeq,
}: {
	sqlite: SqliteDatabase;
	document: string;
	id: number;
	update: Uint8Array;
	authoritySeq: number | undefined;
}): void {
	sqlite.run(
		'INSERT INTO _updates (document, id, bytes, authoritySeq) VALUES (?, ?, ?, ?)',
		[document, id, new Uint8Array(update), authoritySeq ?? null],
	);
	foldSettled(sqlite, document);
}

/**
 * Collapse the part of a document's chain the authority has already taken.
 *
 * The fold used to replace the WHOLE chain and renumber it from 1, and that
 * renumbering is what forced owed work into a relation of its own: a position
 * recorded against a chain that restarts means a different update afterwards.
 *
 * So it folds a PREFIX instead. Acknowledged appends collapse to one baseline
 * carrying their merged state, at the highest id they covered, and owed
 * appends are left exactly where they are. That works because an ack covers
 * `id <= throughId` and every later append takes a higher id, so what the
 * authority holds is always a prefix and what is owed is always a suffix.
 *
 * The baseline is stamped `NO_AUTHORITY` rather than left owed. It is a local
 * compaction of bytes the authority already has; offering it back would push a
 * whole document's state to a log that already contains it.
 */
function foldSettled(sqlite: SqliteDatabase, document: string): void {
	const settled = sqlite.all<StoredUpdate>(
		'SELECT id AS seq, bytes FROM _updates WHERE document = ? AND authoritySeq IS NOT NULL ORDER BY id',
		[document],
	);
	if (settled.length < SNAPSHOT_FOLD_THRESHOLD) return;

	const through = settled.at(-1)?.seq;
	if (through === undefined) return;
	const compacted = replay(settled);
	try {
		const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
		sqlite.run(
			'DELETE FROM _updates WHERE document = ? AND authoritySeq IS NOT NULL',
			[document],
		);
		sqlite.run(
			'INSERT INTO _updates (document, id, bytes, authoritySeq) VALUES (?, ?, ?, ?)',
			[document, through, baseline, NO_AUTHORITY],
		);
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
	// One statement, because owed work is a column on the chain now rather
	// than a second relation that had to be swept alongside it.
	sqlite.run('DELETE FROM _updates WHERE document = ?', [document]);
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
		cursor: readCursor(sqlite),
		identity: readDocumentIdentity(sqlite),
		tombstones: readTombstones(sqlite),
		lastId: readLastId(sqlite),
	};
}

/**
 * The SQLite durable engine: one batch, one transaction, in order.
 *
 * Synchronous, which is what lets a verb on a Durable Object return with its
 * write already durable. Opening applies the schema and enforces the format
 * certificate (ADR-0231's cutover), exactly as every open always has.
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
						case 'append':
							appendUpdate({
								sqlite,
								document: op.document,
								id: op.id,
								update: op.bytes,
								authoritySeq: op.authoritySeq,
							});
							break;
						case 'ack':
							acknowledge(sqlite, op.throughId, op.authoritySeq);
							break;
						case 'identity':
							writeDocumentIdentity(sqlite, op.id);
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
