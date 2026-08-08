/**
 * The authority: an append-only log of opaque bytes, and one Yjs call.
 *
 * It never merges, never compacts, never holds a document, and never learns
 * what a row is. Catch-up is "everything after your cursor" and a live relay is
 * the same sentence with a cursor one behind the head, so there is one delivery
 * path rather than two that can disagree.
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
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import { copyBytes } from '../store/persistence.js';
import { CHUNK_BYTES, intoChunks } from './frames.js';

export const AuthorityError = defineErrors({
	/**
	 * The bytes did not survive a decode, so they are not stored.
	 *
	 * The client hears this as a refusal naming its submission, which is the
	 * point: `workerd` swallows a throw in `webSocketMessage` without closing
	 * the socket, so silence and success are indistinguishable to a client.
	 */
	Unreadable: ({ reason }: { reason: string }) => ({
		message: `The authority refused these bytes: ${reason}`,
		reason,
	}),
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
	 * Validate one whole update, give it a position, and store it.
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

/**
 * An empty document's state vector: one varint, saying zero clients.
 *
 * Written out rather than produced by `Y.encodeStateVector(new Y.Doc())`, and
 * that is a `workerd` requirement rather than a micro-optimisation. Constructing
 * a `Y.Doc` mints a clientID through `crypto.getRandomValues`, and generating
 * random values in global scope is a disallowed operation in a Worker, so the
 * module simply fails to load. Pinned against the library in
 * `evidence/invariants.test.ts`.
 *
 * It also makes the file's central claim literally true: nothing here ever
 * constructs a document.
 */
const EMPTY_STATE_VECTOR = new Uint8Array([0]);

/**
 * The authority's one Yjs call, kept only as a yes or no.
 *
 * `diffUpdateV2` rather than `encodeStateVectorFromUpdateV2`, which is what an
 * earlier draft of this design named. The state-vector call reads far enough to
 * recover the clocks and then stops, so an update truncated by ONE byte passes
 * it and throws on every device that applies it, which is the exact failure the
 * check exists to prevent. Measured against every single-byte corruption and
 * every tail truncation of a real update, the state-vector call lets through
 * 108 poison pills where this one lets through 44, and on an incremental send
 * 103 against 4 (`evidence/validation.test.ts`, `evidence/bench/validate.ts`).
 *
 * **This is a filter and not a proof, and the difference is load-bearing.** No
 * check the authority can run closes the poison pill, including integrating
 * into a throwaway `Y.Doc`, which leaks 3 where this leaks 4 on the shape the
 * transport actually carries. Whether bytes throw depends on the structs the
 * RECEIVER already holds, and the authority holds none by construction, so the
 * receiver's predicate is not available to it at any price. What actually
 * bounds the damage is that a partition has one writer principal, so the only
 * party who can author bytes that brick it is the party that owns it.
 *
 * It is still worth making the filter the best available one, because it costs
 * one call and no document, and it turns every accidental truncation into a
 * refusal the client can see and retry.
 */
function readable(update: Uint8Array): Result<void, AuthorityError> {
	const { error } = trySync({
		try: () =>
			Y.diffUpdateV2(
				update as Uint8Array<ArrayBuffer>,
				EMPTY_STATE_VECTOR as Uint8Array<ArrayBuffer>,
			),
		catch: (cause) =>
			AuthorityError.Unreadable({
				reason: cause instanceof Error ? cause.message : String(cause),
			}),
	});
	if (error !== null) return Err(error);
	return Ok(undefined);
}

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
			const { error } = readable(update);
			if (error !== null) return Err(error);

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
