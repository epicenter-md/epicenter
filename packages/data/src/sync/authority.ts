/**
 * The authority: an append-only log of opaque bytes, and no Yjs call at all.
 *
 * There are no Yjs imports in this file, and that is the design rather than an
 * accident of the current implementation. It never merges, never compacts,
 * never holds a document, never decodes, and never learns what a row is.
 * Catch-up is "everything after your cursor" and a live relay is the same
 * sentence with a cursor one behind the head, so there is one delivery path
 * rather than two that can disagree.
 *
 * ## Why it does not look at the bytes
 *
 * An earlier version made exactly one Yjs call before storing, `diffUpdateV2`
 * against an empty state vector, and kept only whether it threw. It was removed.
 * The reasons are written down here because "surely the server should check the
 * update is valid" is the obvious thing to propose, and every part of the bill
 * is invisible from the call site:
 *
 * - **It could not be a proof, only a filter.** Whether bytes throw depends on
 *   the structs the RECEIVER already holds, and the authority holds none by
 *   construction, so the receiver's predicate is not available to it at any
 *   price. Swept over every single-byte corruption of a real update, the call
 *   let through 44 poison pills on a full update and 4 on an increment;
 *   integrating into a throwaway `Y.Doc`, the most an authority could possibly
 *   do, still leaked 3 (`evidence/validation.test.ts`).
 * - **It was the most expensive thing here.** 283 MB rss and 45 ms on a 27.7 MB
 *   update, which is MORE than hydrating an entire `Y.Doc` (108 MB, 35 ms),
 *   because it decodes the whole stream and re-encodes a full copy before
 *   discarding it. The cheap-looking call was the ceiling on what one submission
 *   costs the object, and it is the measurement that removed it
 *   (`evidence/bench/validate.ts`).
 * - **It was the only thing coupling this file to Yjs's version.** With it gone,
 *   a Yjs format change cannot make the server refuse a valid client's writes.
 * - **It foreclosed end-to-end encryption**, which is possible exactly as long
 *   as the authority never reads the bytes. That is the reason not to reach for
 *   it again the next time it looks free.
 *
 * Recovery never needed it either. The log is append-only and every entry is
 * individually addressable, so a poison entry is repaired by overwriting that
 * one row's bytes with the 13-byte empty update, a valid no-op that keeps the
 * sequence contiguous and that every replica walks straight past. A replica that
 * cannot apply an entry says so and names the position
 * (`SyncClientError.Unapplyable`); both halves are pinned in
 * `sync/transport.test.ts`. What bounds the damage in the first place is that a
 * partition has one writer principal, so the only party who can author bytes
 * that brick it is the party that owns it.
 *
 * ## Why it refuses to compact
 *
 * Four authority designs were built and withdrawn, all failing at one joint: a
 * log must be compacted, compaction must prove the replacement covers what it
 * replaces, and that proof needs semantics the authority was defined not to
 * have. Refusing compaction removes the requirement rather than satisfying it,
 * and it costs about 4 MB a year against 10 GB of Durable Object SQLite
 * (`evidence/bench/never-compact.ts`). The merge that could not be verified
 * moves to the client, where it needs no verification because a client
 * indisputably owns its own unsent bytes.
 *
 * Do not reintroduce compaction, baselines, or coverage proofs here.
 *
 * The one thing that ever deletes history is not compaction: `replace`
 * (ADR-0231) publishes a caller-supplied state as the workspace's next
 * DOCUMENT, whole log gone, fresh id minted. It needs no coverage proof
 * because it makes no coverage claim; a person took responsibility, the
 * lease (`fromDocument`, `atHead`) is the whole precondition, and the bytes
 * stay as unread as every other byte here.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import { copyBytes } from '../store/log.js';
import { CHUNK_BYTES, intoChunks } from './frames.js';

export const AuthorityError = defineErrors({
	/**
	 * The only way an append can fail, now that nothing inspects the bytes.
	 *
	 * The client hears it as a refusal naming its submission, which is the
	 * point: `workerd` swallows a throw in `webSocketMessage` without closing the
	 * socket, so silence and success are indistinguishable to a client.
	 */
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The authority could not commit to durable storage',
		cause,
	}),
	/**
	 * A snapshot was offered at a position it cannot stand for.
	 *
	 * The condition is COVERAGE, not currency, and the difference is the whole
	 * subtlety. A snapshot at P is used to forget every entry at or before P, so
	 * all it must do is account for those. It does NOT have to be at the head:
	 * requiring that lost a race every time an entry landed between the request
	 * and the offer, and refused a snapshot that was perfectly good.
	 *
	 * So a position is refused for exactly two reasons: it runs past the end of
	 * the log, which means it stands for entries nobody has written; or it is at
	 * or behind the snapshot already held, which would move history backwards.
	 */
	SnapshotRefused: ({
		offered,
		head,
		current,
	}: {
		offered: number;
		head: number;
		current: number;
	}) => ({
		message: `A snapshot at ${offered} is not usable: the log ends at ${head} and the snapshot already covers ${current}`,
		offered,
		head,
		current,
	}),
	/**
	 * A replace's compare-and-swap missed: the current document is not the one
	 * the caller built from.
	 *
	 * The answer carries the current document's id, which is the whole of what
	 * a refused caller needs: a retried replace whose first attempt actually
	 * landed sees the document it published, and a genuine loser sees the one
	 * it must adopt (ADR-0231).
	 */
	DocumentMoved: ({
		fromDocument,
		document,
	}: {
		fromDocument: string;
		document: string;
	}) => ({
		message: `A replace of document '${fromDocument}' was refused: the current document is '${document}'`,
		fromDocument,
		document,
	}),
	/**
	 * A reclaim's lease expired: the log grew past the head it was built from.
	 *
	 * Only a caller that promised "same data" supplies `atHead`, and for that
	 * caller an entry landing mid-swap would be silently lost, which is exactly
	 * the loss the lease exists to make loud (ADR-0231).
	 */
	HeadMoved: ({ atHead, head }: { atHead: number; head: number }) => ({
		message: `A replace leased at head ${atHead} was refused: the log now ends at ${head}`,
		atHead,
		head,
	}),
});
export type AuthorityError = InferErrors<typeof AuthorityError>;

/** One entry of the log, reassembled from however many chunks held it. */
export type LogEntry = { seq: number; bytes: Uint8Array };

/** The state everything after it is relative to. */
export type Snapshot = { position: number; bytes: Uint8Array };

export type SyncAuthority = {
	/**
	 * Give one whole update a position and store it, unread.
	 *
	 * The position is assigned here and returned, so nothing anywhere else has
	 * to guess it or agree about it in advance.
	 */
	append(update: Uint8Array): Result<number, AuthorityError>;
	/** Up to `limit` entries after `cursor`, oldest first. */
	since(cursor: number, limit?: number): Result<LogEntry[], AuthorityError>;
	/** The newest position, or zero for a log nothing has been written to. */
	head(): Result<number, AuthorityError>;
	/** The current snapshot, or undefined for a log nothing has replaced yet. */
	snapshot(): Result<Snapshot | undefined, AuthorityError>;
	/** The position the current snapshot was taken at. Zero when there is none. */
	snapshotPosition(): Result<number, AuthorityError>;
	/**
	 * Replace the snapshot and forget everything it covers.
	 *
	 * Accepted when the position lies inside the log and ahead of the snapshot
	 * already held. The caller owes the other half of the condition, which it
	 * alone can check: that this is a connection the authority has actually SENT
	 * everything through that position. Its own record of what it sent is not a
	 * claim the replica makes, which is the difference between this and the
	 * client-posted baseline that an earlier design died on.
	 */
	replaceSnapshot(
		position: number,
		bytes: Uint8Array,
	): Result<void, AuthorityError>;
	/**
	 * The opaque name of the document this log describes (ADR-0231).
	 *
	 * Minted once at first need and re-minted by every replace, because a
	 * replace publishes a NEW document: the rebuild re-mints every struct
	 * identity, so the visible workspace survives and the Yjs ancestry does
	 * not. Bytes merge only when they name the same document is the
	 * invariant, and this name is how both sides state which document they
	 * mean without anyone reading bytes.
	 */
	document(): Result<string, AuthorityError>;
	/**
	 * Publish the supplied state as this workspace's next DOCUMENT.
	 *
	 * A NEW verb, not a reuse of `replaceSnapshot`: a recap replaces history
	 * within one document and must never stand for entries nobody wrote; a
	 * replace ends the document itself. It deletes the whole log and every
	 * snapshot, files the replacement as the new document's snapshot at
	 * position 1 (each document has its own log, starting over), and mints a
	 * fresh document id, which is what retires every replica of the old one
	 * at its next dial.
	 *
	 * `fromDocument` is compare-and-swap, always: the replace applies only if
	 * that is still the current document, and a miss answers with the current
	 * id. `atHead` is a lease by intent: reclaim supplies the head it built
	 * from and is refused if the tail moved; reset and restore omit it,
	 * because discarding entries is the operation. The whole swap is one
	 * transaction, so a crash leaves either the old document intact or the
	 * new one published, never a mixture.
	 *
	 * Returns the new document's id.
	 */
	replace(args: {
		fromDocument: string;
		bytes: Uint8Array;
		atHead?: number;
	}): Result<string, AuthorityError>;
	/**
	 * Whether the tail has outgrown the snapshot, and is worth replacing at all.
	 *
	 * Snapshotting often keeps storage small and makes every returning replica
	 * re-download the whole state; snapshotting rarely does the reverse.
	 * Triggering when the tail passes the snapshot is the balance point and
	 * bounds both at about twice the state.
	 *
	 * The floor is the honest asterisk on "no number to pick". The ratio is
	 * scale-free, so on a tiny document it fires on the very next update; a live
	 * run snapshotted on nearly every message and stalled. Below the floor there
	 * is nothing worth replacing.
	 */
	shouldSnapshot(): Result<boolean, AuthorityError>;
	/** Total stored bytes, snapshot and tail together. */
	storedBytes(): Result<number, AuthorityError>;
};

export function applyAuthoritySchema(sqlite: SqliteDatabase): void {
	// `(seq, chunk)` and nothing else. There is no `taken_at`, no client id, no
	// state vector and no baseline flag, because every one of those would be a
	// fact about the bytes and the authority holds none.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _log (
			seq   INTEGER NOT NULL,
			chunk INTEGER NOT NULL,
			bytes BLOB    NOT NULL,
			PRIMARY KEY (seq, chunk)
		)
	`);
	// Chunked for the same reason the log is: a snapshot is the largest single
	// value the authority ever stores, and it is the one guaranteed to exceed
	// the cap on any real vault.
	//
	// More than one position is kept on purpose. A snapshot replaces history, so
	// unlike a bad log entry it cannot be repaired by neutralising one row; the
	// previous one is the only way back from a replica that produced a bad one.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _snapshot (
			position INTEGER NOT NULL,
			chunk    INTEGER NOT NULL,
			bytes    BLOB    NOT NULL,
			PRIMARY KEY (position, chunk)
		)
	`);
	// One durable fact beyond the log and the snapshot: the document, the
	// opaque name of the history this log describes (ADR-0231). A key-value
	// shape rather than a one-column table so a new fact is a row and not a
	// migration.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _meta (
			key   TEXT    NOT NULL,
			value NOT NULL,
			PRIMARY KEY (key)
		)
	`);
}

/** How many snapshots are kept: the live one, and one to fall back to. */
const SNAPSHOTS_KEPT = 2;

/**
 * The tail has to be worth replacing before a snapshot is asked for.
 *
 * The one tuned number in the policy, and it exists because "the tail outgrew
 * the snapshot" is scale-free and therefore true almost immediately when
 * everything is tiny. A document of one note has a snapshot of a few hundred
 * bytes, so the very next update outgrows it, and a live run against Cloudflare
 * snapshotted on nearly every message and ground to a halt around the two
 * hundredth. Below this floor the whole log is trivial and replacing it buys
 * nothing.
 */
const SNAPSHOT_FLOOR_BYTES = 64 * 1024;

export function openSyncAuthority({
	sqlite,
	/** Injected so a test can reach the snapshot path without a real vault. */
	snapshotFloorBytes = SNAPSHOT_FLOOR_BYTES,
}: {
	sqlite: SqliteDatabase;
	snapshotFloorBytes?: number;
}): SyncAuthority {
	applyAuthoritySchema(sqlite);

	function read<TValue>(run: () => TValue): Result<TValue, AuthorityError> {
		return trySync({
			try: run,
			catch: (cause) => AuthorityError.StorageFailed({ cause }),
		});
	}

	/**
	 * The newest position, whether it is an entry or the snapshot.
	 *
	 * Both, because a snapshot DELETES the entries it covers, so the log alone
	 * would report a head of zero straight after one and the next append would
	 * reuse positions the replicas have already read.
	 */
	function headSeq(): number {
		const newestEntry =
			sqlite.all<SqliteRow & { seq: number }>(
				'SELECT COALESCE(MAX(seq), 0) AS seq FROM _log',
			)[0]?.seq ?? 0;
		return Math.max(newestEntry, snapshotPositionOf());
	}

	return Object.freeze({
		append(update: Uint8Array): Result<number, AuthorityError> {
			return read(() =>
				sqlite.transaction(() => {
					const seq = headSeq() + 1;
					// Chunking happens at the storage boundary rather than on the wire's
					// terms, so a client that framed its message differently, or an
					// authority whose cap moves, cannot make the stored form wrong.
					const chunks = intoChunks(update, CHUNK_BYTES);
					for (const [index, chunk] of chunks.entries()) {
						sqlite.run(
							'INSERT INTO _log (seq, chunk, bytes) VALUES (?, ?, ?)',
							[seq, index, new Uint8Array(chunk)],
						);
					}
					return seq;
				}),
			);
		},

		since(cursor: number, limit = 64): Result<LogEntry[], AuthorityError> {
			return read(() => {
				// The positions first, so `limit` bounds ENTRIES rather than rows. A
				// limit on rows would return a fraction of a chunked entry and the
				// caller would have no way to know it had been cut.
				const positions = sqlite.all<SqliteRow & { seq: number }>(
					'SELECT DISTINCT seq FROM _log WHERE seq > ? ORDER BY seq LIMIT ?',
					[cursor, limit],
				);
				const newest = positions.at(-1)?.seq;
				if (newest === undefined) return [];

				const rows = sqlite.all<
					SqliteRow & {
						seq: number;
						chunk: number;
						bytes: Uint8Array | ArrayBuffer;
					}
				>(
					'SELECT seq, chunk, bytes FROM _log WHERE seq > ? AND seq <= ? ORDER BY seq, chunk',
					[cursor, newest],
				);
				const entries: LogEntry[] = [];
				let holding: { seq: number; chunks: Uint8Array[] } | undefined;
				for (const row of rows) {
					if (holding === undefined || holding.seq !== row.seq) {
						if (holding !== undefined) entries.push(flush(holding));
						holding = { seq: row.seq, chunks: [] };
					}
					holding.chunks.push(copyBytes(row.bytes));
				}
				if (holding !== undefined) entries.push(flush(holding));
				return entries;
			});

			function flush(held: { seq: number; chunks: Uint8Array[] }): LogEntry {
				let total = 0;
				for (const chunk of held.chunks) total += chunk.length;
				const bytes = new Uint8Array(total);
				let at = 0;
				for (const chunk of held.chunks) {
					bytes.set(chunk, at);
					at += chunk.length;
				}
				return { seq: held.seq, bytes };
			}
		},

		head: () => read(headSeq),

		snapshotPosition: () => read(snapshotPositionOf),

		snapshot(): Result<Snapshot | undefined, AuthorityError> {
			return read(() => {
				const position = snapshotPositionOf();
				if (position === 0) return undefined;
				const rows = sqlite.all<
					SqliteRow & { bytes: Uint8Array | ArrayBuffer }
				>('SELECT bytes FROM _snapshot WHERE position = ? ORDER BY chunk', [
					position,
				]);
				return {
					position,
					bytes: join(rows.map((row) => copyBytes(row.bytes))),
				};
			});
		},

		replaceSnapshot(position, bytes): Result<void, AuthorityError> {
			const { data: head, error } = read(headSeq);
			if (error !== null) return Err(error);
			const { data: current, error: currentError } = read(snapshotPositionOf);
			if (currentError !== null) return Err(currentError);
			// Coverage, not currency. The snapshot is about to stand for every
			// entry at or before `position`, so it must not run past what exists,
			// and it must not walk history backwards.
			if (position > head || position <= current) {
				return AuthorityError.SnapshotRefused({
					offered: position,
					head,
					current,
				});
			}
			return read(() =>
				sqlite.transaction(() => {
					const chunks = intoChunks(bytes, CHUNK_BYTES);
					for (const [index, chunk] of chunks.entries()) {
						sqlite.run(
							'INSERT OR REPLACE INTO _snapshot (position, chunk, bytes) VALUES (?, ?, ?)',
							[position, index, new Uint8Array(chunk)],
						);
					}
					// Everything the snapshot covers is forgotten. This is the line
					// that makes storage constant instead of growing, and it is also
					// what makes a deletion real: a snapshot is current state, so it
					// carries no trace of what was deleted before it.
					sqlite.run('DELETE FROM _log WHERE seq <= ?', [position]);
					const kept = sqlite
						.all<SqliteRow & { position: number }>(
							'SELECT DISTINCT position FROM _snapshot ORDER BY position DESC LIMIT ?',
							[SNAPSHOTS_KEPT],
						)
						.map((row) => row.position);
					const oldest = kept.at(-1);
					if (oldest !== undefined) {
						sqlite.run('DELETE FROM _snapshot WHERE position < ?', [oldest]);
					}
				}),
			);
		},

		document(): Result<string, AuthorityError> {
			return read(() => {
				const existing = documentOf();
				if (existing !== undefined) return existing;
				// Minted lazily at first need, so a databaseId that predates the
				// identity acquires one on its next dial and every replica stamps
				// the same name from then on.
				const minted = crypto.randomUUID();
				sqlite.run(
					"INSERT OR IGNORE INTO _meta (key, value) VALUES ('document', ?)",
					[minted],
				);
				return documentOf() ?? minted;
			});
		},

		replace({ fromDocument, bytes, atHead }): Result<string, AuthorityError> {
			// Minted before the transaction because it is a pure value; compared
			// and written INSIDE it, so the compare and the swap are one step
			// whatever runtime holds this database. A refusal returns before
			// anything is written, so the commit of an empty transaction is the
			// no-op it looks like.
			const minted = crypto.randomUUID();
			const { data: outcome, error } = read(() =>
				sqlite.transaction((): Result<string, AuthorityError> => {
					const document = documentOf();
					if (document !== undefined && document !== fromDocument) {
						return AuthorityError.DocumentMoved({ fromDocument, document });
					}
					const head = headSeq();
					if (atHead !== undefined && atHead !== head) {
						return AuthorityError.HeadMoved({ atHead, head });
					}
					// The old document goes whole: every log entry and EVERY
					// snapshot, including the in-document fallback that
					// `replaceSnapshot` keeps. The authority holds exactly one
					// history, ever, and a retired document retrievable even
					// briefly is the privacy leak ADR-0220's title retired
					// (ADR-0231). Retirement IS this deletion; there is no
					// registry of retired documents, because admission is an
					// equality and an unknown id is already unservable.
					sqlite.run('DELETE FROM _log');
					sqlite.run('DELETE FROM _snapshot');
					// The new document's own log starts over: its state is the
					// snapshot at position 1.
					const chunks = intoChunks(bytes, CHUNK_BYTES);
					for (const [index, chunk] of chunks.entries()) {
						sqlite.run(
							'INSERT INTO _snapshot (position, chunk, bytes) VALUES (?, ?, ?)',
							[1, index, new Uint8Array(chunk)],
						);
					}
					// The fresh name is what retires every replica of the old
					// document at its next dial (ADR-0231).
					sqlite.run(
						"INSERT OR REPLACE INTO _meta (key, value) VALUES ('document', ?)",
						[minted],
					);
					return Ok(minted);
				}),
			);
			if (error !== null) return Err(error);
			return outcome;
		},

		shouldSnapshot(): Result<boolean, AuthorityError> {
			return read(() => {
				const tail = sumBytes('_log');
				if (tail < snapshotFloorBytes) return false;
				return tail > sumBytes('_snapshot');
			});
		},

		/**
		 * The one number to instrument.
		 *
		 * Refusing compaction means the log grows for the life of the application,
		 * and the answer to "and then what" is a new generation rather than a
		 * compaction of this one (see the design record). At the measured rate the
		 * trigger is millennia away, so nothing is built for it; this is how a
		 * decade of warning arrives if the rate is ever wrong.
		 */
		storedBytes: () => read(() => sumBytes('_log') + sumBytes('_snapshot')),
	});

	function sumBytes(relation: '_log' | '_snapshot'): number {
		return (
			sqlite.all<SqliteRow & { bytes: number }>(
				`SELECT COALESCE(SUM(length(bytes)), 0) AS bytes FROM ${relation}`,
			)[0]?.bytes ?? 0
		);
	}

	function snapshotPositionOf(): number {
		return (
			sqlite.all<SqliteRow & { position: number }>(
				'SELECT COALESCE(MAX(position), 0) AS position FROM _snapshot',
			)[0]?.position ?? 0
		);
	}

	function documentOf(): string | undefined {
		return sqlite.all<SqliteRow & { value: string }>(
			"SELECT value FROM _meta WHERE key = 'document'",
		)[0]?.value;
	}
}

/** Concatenate chunks back into the value they were cut from. */
function join(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}
