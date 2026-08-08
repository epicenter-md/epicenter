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
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { type Result, trySync } from 'wellcrafted/result';

import { copyBytes } from '../store/persistence.js';
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
});
export type AuthorityError = InferErrors<typeof AuthorityError>;

/** One entry of the log, reassembled from however many chunks held it. */
export type LogEntry = { seq: number; bytes: Uint8Array };

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
	/** Total stored bytes. The one number worth instrumenting (see below). */
	storedBytes(): Result<number, AuthorityError>;
};

export function applyAuthoritySchema(database: SqliteDatabase): void {
	// `(seq, chunk)` and nothing else. There is no `taken_at`, no client id, no
	// state vector and no baseline flag, because every one of those would be a
	// fact about the bytes and the authority holds none.
	database.run(`
		CREATE TABLE IF NOT EXISTS _log (
			seq   INTEGER NOT NULL,
			chunk INTEGER NOT NULL,
			bytes BLOB    NOT NULL,
			PRIMARY KEY (seq, chunk)
		)
	`);
}

export function openSyncAuthority({
	database,
}: {
	database: SqliteDatabase;
}): SyncAuthority {
	applyAuthoritySchema(database);

	function read<TValue>(run: () => TValue): Result<TValue, AuthorityError> {
		return trySync({
			try: run,
			catch: (cause) => AuthorityError.StorageFailed({ cause }),
		});
	}

	function headSeq(): number {
		return (
			database.all<SqliteRow & { seq: number }>(
				'SELECT COALESCE(MAX(seq), 0) AS seq FROM _log',
			)[0]?.seq ?? 0
		);
	}

	return Object.freeze({
		append(update: Uint8Array): Result<number, AuthorityError> {
			return read(() =>
				database.transaction(() => {
					const seq = headSeq() + 1;
					// Chunking happens at the storage boundary rather than on the wire's
					// terms, so a client that framed its message differently, or an
					// authority whose cap moves, cannot make the stored form wrong.
					const chunks = intoChunks(update, CHUNK_BYTES);
					for (const [index, chunk] of chunks.entries()) {
						database.run(
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
				const positions = database.all<SqliteRow & { seq: number }>(
					'SELECT DISTINCT seq FROM _log WHERE seq > ? ORDER BY seq LIMIT ?',
					[cursor, limit],
				);
				const newest = positions.at(-1)?.seq;
				if (newest === undefined) return [];

				const rows = database.all<
					SqliteRow & { seq: number; chunk: number; bytes: Uint8Array | ArrayBuffer }
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

		/**
		 * The one number to instrument.
		 *
		 * Refusing compaction means the log grows for the life of the application,
		 * and the answer to "and then what" is a new generation rather than a
		 * compaction of this one (see the design record). At the measured rate the
		 * trigger is millennia away, so nothing is built for it; this is how a
		 * decade of warning arrives if the rate is ever wrong.
		 */
		storedBytes: () =>
			read(
				() =>
					database.all<SqliteRow & { bytes: number }>(
						'SELECT COALESCE(SUM(length(bytes)), 0) AS bytes FROM _log',
					)[0]?.bytes ?? 0,
			),
	});
}
