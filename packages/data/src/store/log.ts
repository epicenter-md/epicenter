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
 * How many appends a document's chain holds before it folds into one baseline.
 *
 * It is 1, which means a document is one value: every fold-eligible append
 * collapses immediately and no chain is ever two rows long. That is not a
 * smaller number of the same kind. It is the setting at which the machinery
 * around it stops having anything to do, and it is the step before that
 * machinery is deleted.
 *
 * The dial is the same one every Yjs persistence layer has. `y-indexeddb`
 * appends updates and squashes at `PREFERRED_TRIM_SIZE = 500` by writing
 * `Y.encodeStateAsUpdate(doc)` and deleting what it replaced, which is exactly
 * what `fold` below does. It sits at 500 to avoid re-encoding a whole document
 * often; this sits at 1 because re-encoding one document is cheap when a
 * document is a row's prose or one application's scalar fields, and because
 * paying it buys the deletion of ids, ordering, replay and the chain itself.
 *
 * A syncing store still folds only the acknowledged prefix, so owed appends
 * stay individually addressable for their acknowledgement. That is the last
 * thing keeping a chain plural, and a state vector at the last acknowledged
 * push replaces it (`store.ts` exposes both halves already: `stateVector` and
 * `encodeStateSince`).
 *
 * ## Why it is not 1 yet, with a number rather than an argument
 *
 * It was set to 1 and the whole suite passed, which is a real result: whole
 * state and a chain are the same mechanism and nothing depends on the chain
 * being plural. What passing did not say is what it cost. `transport.test.ts`
 * drives a thousand sends with no idle gap between them, and it is the one
 * place the price is visible:
 *
 * ```txt
 *   threshold 64   the file's suite passes in  7.5 s
 *   threshold  1   the same suite takes       20   s, and one case times out
 * ```
 *
 * Folding at 1 re-encodes the whole document on every acknowledgement instead
 * of every sixty-fourth. That cost is INHERENT to storing a document as one
 * value, not an artifact of this intermediate: the destination writes O(document)
 * per persisted commit too. What makes it acceptable in production is the
 * sender's one-second idle debounce, which this test deliberately does not
 * have.
 *
 * So the number stays at 64 until the swap that pays for it. At 1 today the
 * chain machinery is all still here and 1 buys none of its deletion; it is
 * cost with the benefit still one commit away. The measurement is worth more
 * than the intermediate was.
 */
export const SNAPSHOT_FOLD_THRESHOLD = 64;

/**
 * The application document's name in the log.
 *
 * The log is per-document (ADR-0248): the application document holds every
 * scalar row under this reserved name, and each row's rich document holds its
 * chain under the row's derived address (`{dataId}/{tableName}/{rowId}`).
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
	// Which authority document this replica's state belongs to (ADR-0231).
	// At most one row, ever: the primary key IS the first-write-wins rule, so
	// membership cannot change in place, only by discarding the record whole.
	// It used to share a key-value table with the storage format, and the
	// format left for the address, where a record under another shape is not
	// detected and wiped but simply not addressed.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _identity (
			document TEXT NOT NULL,
			PRIMARY KEY (document)
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
 * The position before the authority's first, for bytes it will never place.
 *
 * Not a sentinel squeezed into a value space. The authority numbers entries
 * `COALESCE(MAX(seq), 0) + 1`, so its first position is 1 and 0 is unreachable
 * by construction (`sync/authority.ts`). What 0 means here is exactly what it
 * reads as: held, and from before anything the authority has.
 *
 * ```txt
 *   NULL          owed. an account replica's edit, waiting for a position.
 *   NO_AUTHORITY  held, and never owed. received bytes whose position is not
 *                 known, and a fold baseline on a store that does not sync.
 *   >= 1          the position the authority's log gave it.
 * ```
 *
 * The distinction that matters is NULL against everything else, because that
 * is the one the sender reads. Re-offering received bytes "would grow the log
 * with nothing new in it", so bytes that arrived must never read as owed.
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
export function readOutbox(
	sqlite: SqliteDatabase,
	syncs: boolean,
): OutboxEntry[] {
	// A store with no authority owes nobody. Its appends carry no position
	// because none exists, which would otherwise read as owed, and nothing
	// would ever read the result: there is no sender.
	if (!syncs) return [];
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

/** Which authority document this replica's state belongs to (ADR-0231). */
export function readDocumentIdentity(
	sqlite: SqliteDatabase,
): string | undefined {
	return sqlite.all<SqliteRow & { document: string }>(
		'SELECT document FROM _identity',
	)[0]?.document;
}

/**
 * Stamp which document this replica's state belongs to. First write wins:
 * membership never changes in place, only by discarding the file whole.
 */
export function writeDocumentIdentity(
	sqlite: SqliteDatabase,
	id: string,
): void {
	sqlite.run('INSERT OR IGNORE INTO _identity (document) VALUES (?)', [id]);
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
	syncs,
}: {
	sqlite: SqliteDatabase;
	document: string;
	id: number;
	update: Uint8Array;
	authoritySeq: number | undefined;
	/** Whether owed appends have to stay individually addressable. */
	syncs: boolean;
}): void {
	sqlite.run(
		'INSERT INTO _updates (document, id, bytes, authoritySeq) VALUES (?, ?, ?, ?)',
		[document, id, new Uint8Array(update), authoritySeq ?? null],
	);
	fold(sqlite, document, syncs);
}

/**
 * Collapse a document's chain into one baseline.
 *
 * The fold used to replace the WHOLE chain and renumber it from 1, and that
 * renumbering is what forced owed work into a relation of its own: a position
 * recorded against a chain that restarts means a different update afterwards.
 * Ids are stable now, so what it collapses is a question of what still has to
 * be addressable.
 *
 * A store that SYNCS folds only the acknowledged prefix. Owed appends stay
 * exactly where they are, because the sender offers them individually and an
 * acknowledgement names them by id. That works because an ack covers
 * `id <= throughId` and every later append takes a higher id, so what the
 * authority holds is always a prefix and what is owed is always a suffix.
 *
 * A store that does not sync folds everything, because nothing reads its owed
 * work: there is no sender to offer it to. Whether a store syncs is a static
 * fact known when it opens (ADR-0239, "a store's kind is its sync value"), so
 * it is a constructor argument rather than a value repeated into every row.
 * It used to be the latter, as a `0` sentinel on the column, which cost every
 * local append a redundant constant and made `authoritySeq` three-valued in a
 * way that would have collided the day a log position started at zero.
 */
function fold(sqlite: SqliteDatabase, document: string, syncs: boolean): void {
	const foldable = syncs
		? sqlite.all<StoredUpdate>(
				'SELECT id AS seq, bytes FROM _updates WHERE document = ? AND authoritySeq IS NOT NULL ORDER BY id',
				[document],
			)
		: readUpdates(sqlite, document);
	if (foldable.length < SNAPSHOT_FOLD_THRESHOLD) return;

	const through = foldable.at(-1)?.seq;
	if (through === undefined) return;
	// Read before the delete, because the rows carrying it are the rows about
	// to go. The baseline inherits the highest position it replaced, so on a
	// syncing store it is not owed and is never offered back; on a store that
	// does not sync there is no position and none is invented.
	const position = syncs
		? (sqlite.all<SqliteRow & { seq: number | null }>(
				'SELECT MAX(authoritySeq) AS seq FROM _updates WHERE document = ?',
				[document],
			)[0]?.seq ?? null)
		: NO_AUTHORITY;
	const compacted = replay(foldable);
	try {
		const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
		sqlite.run(
			syncs
				? 'DELETE FROM _updates WHERE document = ? AND authoritySeq IS NOT NULL'
				: 'DELETE FROM _updates WHERE document = ?',
			[document],
		);
		sqlite.run(
			'INSERT INTO _updates (document, id, bytes, authoritySeq) VALUES (?, ?, ?, ?)',
			[document, through, baseline, position],
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
export function loadDurableSnapshot(
	sqlite: SqliteDatabase,
	syncs: boolean,
): DurableSnapshot {
	return {
		updates: readUpdates(sqlite, APP_DOCUMENT).map((stored) =>
			copyBytes(stored.bytes),
		),
		outbox: readOutbox(sqlite, syncs),
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
	syncs,
}: {
	sqlite: SqliteDatabase;
	/**
	 * Whether this store has an authority to owe work to.
	 *
	 * The fold's only question. A static fact at open (ADR-0239), so it lives
	 * here rather than being repeated into every append as a sentinel.
	 */
	syncs: boolean;
}): DurablePort & { load(): DurableSnapshot } {
	applyStoreSchema(sqlite);
	return {
		load: () => loadDurableSnapshot(sqlite, syncs),
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
								syncs,
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
