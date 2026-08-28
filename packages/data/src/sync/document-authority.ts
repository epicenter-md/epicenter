/**
 * The authority for one Yjs document: it holds the document, and it reads it.
 *
 * Beside `authority.ts` rather than replacing it (ADR-0277). That file is an
 * append-only log of opaque bytes and its first paragraph is the reason: it
 * never decodes, which keeps end-to-end encryption possible. ADR-0004 decided
 * on 2026-06-15 that Epicenter does not buy that option, and this is what the
 * server becomes once it is not being paid for.
 *
 * ## What holding the document buys
 *
 * One question, and everything downstream of not being able to answer it. A
 * Yjs peer asks "here is my state vector, what am I missing"; a byte-blind
 * authority cannot, so the transport grew an integer log position, a cursor to
 * hold it, an outbox because a position is not a receipt, contiguity checks
 * because positions must not skip, a resync path because a gap wedges a replica
 * silently, and a snapshot request-and-offer dance because the authority could
 * not compact what it could not read. `since()` below is that question,
 * answered in one line.
 *
 * ## Why a `Y.Doc` and not merged bytes
 *
 * A server can serve a diff from stored bytes alone, with `diffUpdateV2`, and
 * it was the first thing tried. `evidence/bench/validate.ts`, measured for a
 * different purpose, says not to: on a 27.7 MB update `diffUpdateV2` cost
 * 45 ms and 283 MB, while `applyUpdateV2` into a document cost 35 ms and
 * 108 MB. Holding the document is cheaper than repeatedly diffing bytes, and it
 * is what makes validation a proof rather than a filter.
 *
 * The document is hydrated on first use and dropped when this object is. A
 * Durable Object that hibernates discards it and rebuilds it on the next
 * message, which is one `applyUpdateV2` over the stored state.
 *
 * ## Why the storage still has a tail
 *
 * Writing the whole document on every update is O(document) per keystroke's
 * worth of work. A short tail of applied updates makes a write O(update), and
 * folding it into the state amortizes the cost. What is gone is the DANCE. The
 * old authority could not fold by itself, so it asked a client for a snapshot
 * and checked the offer covered a position it had sent that connection. This
 * one holds the state it is replacing and owes nobody a proof.
 *
 * ## Folding is asked for, not done on the way past
 *
 * `receive` does not fold, and that is the one thing this file learned from a
 * design it is not otherwise related to. `7452f8d47b` added alarm-based
 * compaction to the superseded sync rooms and wrote down why inline was wrong:
 * it spends CPU during a disconnect, it cannot be cancelled, and there is no
 * pre-hibernation hook to defer it to. Its answer was a Durable Object alarm
 * thirty seconds after the last client leaves, cancelled if one reconnects,
 * which is long enough to ride out a refresh and short enough to fire before
 * the roughly sixty-second eviction window.
 *
 * So `fold()` is a verb the host calls and `shouldFold()` is this file's
 * opinion about whether it is worth calling. The library says what is worth
 * doing and the host says when, which is the same split ADR-0222 made for
 * sockets.
 *
 * One thing that design deferred is available here for free. It refused an
 * update-count threshold because "a threshold needs a persistent counter that
 * resets on hibernation". This threshold is read out of storage rather than
 * counted in memory, so it survives hibernation, eviction and a cold start
 * without anyone maintaining it.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, type Result, trySync } from 'wellcrafted/result';

import { copyBytes } from '../store/log.js';
import { CHUNK_BYTES, intoChunks } from './frames.js';

export const DocumentAuthorityError = defineErrors({
	/**
	 * Bytes that are not a Yjs update.
	 *
	 * The refusal ADR-0218 correctly said a byte-blind server could not make.
	 * Its argument was that inspecting bytes "could not be a proof, only a
	 * filter", and it is right for a server holding no structs: whether an
	 * update integrates depends on what the receiver already has. This receiver
	 * has it, so the question is answerable and the answer is enforced at the
	 * door instead of repaired later.
	 */
	Unapplyable: ({ cause }: { cause: unknown }) => ({
		message: 'These bytes are not an update this document can apply',
		cause,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The authority could not commit to durable storage',
		cause,
	}),
});
export type DocumentAuthorityError = InferErrors<typeof DocumentAuthorityError>;

export type DocumentAuthority = {
	/** What this authority holds, as the peer question's other half. */
	stateVector(): Uint8Array;
	/** Everything a peer at `peerVector` does not have. Sync step 2. */
	since(peerVector?: Uint8Array): Uint8Array;
	/** Take an update, durably. Refuses bytes that will not apply. */
	receive(update: Uint8Array): Result<void, DocumentAuthorityError>;
	/**
	 * Whether the document is holding updates whose dependencies never arrived.
	 *
	 * An alarm rather than a state, exactly as it is on the client. Under the
	 * sync protocol a peer sends what THIS authority said it lacked, so the
	 * dependencies are satisfied by construction; true here means something
	 * upstream sent bytes it had no business sending.
	 */
	hasUnresolvedDependencies(): boolean;
	/**
	 * Whether the tail has outgrown the state, and is worth folding at all.
	 *
	 * Read out of storage, so it is true of the record rather than of this
	 * instance: a freshly woken object answers the same as the one that
	 * hibernated. The floor is the honest asterisk on "no number to pick" —
	 * "the tail outgrew the state" is scale-free, so on a small document it is
	 * true on the very next update.
	 */
	shouldFold(): boolean;
	/**
	 * Replace the state with the document and forget the tail.
	 *
	 * Safe to call at any time and safe to call when `shouldFold()` is false;
	 * it is only ever wasteful, never wrong.
	 */
	fold(): Result<void, DocumentAuthorityError>;
	/** Total stored bytes, state and tail together. */
	storedBytes(): number;
	dispose(): void;
};

export function applyDocumentAuthoritySchema(sqlite: SqliteDatabase): void {
	// The folded document. Chunked because a document is the largest single
	// value stored here and the only one guaranteed to exceed the 2 MB cap.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _state (
			chunk INTEGER NOT NULL,
			bytes BLOB    NOT NULL,
			PRIMARY KEY (chunk)
		)
	`);
	// Updates applied since the last fold. There is no seq in the protocol any
	// more; this one orders reassembly at open and nothing else, which is why it
	// is an autoincrementing detail rather than a position anybody is told.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _tail (
			seq   INTEGER NOT NULL,
			chunk INTEGER NOT NULL,
			bytes BLOB    NOT NULL,
			PRIMARY KEY (seq, chunk)
		)
	`);
}

/**
 * Below this the whole tail is trivial and folding it buys nothing.
 *
 * The same floor and the same reason as the authority it replaces: "the tail
 * outgrew the state" is scale-free, so on a small document it is true on the
 * very next update and a live run folds on nearly every message.
 */
const FOLD_FLOOR_BYTES = 64 * 1024;

export function openDocumentAuthority({
	sqlite,
	/** Injected so a test can reach the fold without a large document. */
	foldFloorBytes = FOLD_FLOOR_BYTES,
}: {
	sqlite: SqliteDatabase;
	foldFloorBytes?: number;
}): DocumentAuthority {
	applyDocumentAuthoritySchema(sqlite);

	let document: Y.Doc | undefined;

	/** The document, hydrated from storage on first use. */
	function live(): Y.Doc {
		if (document !== undefined) return document;
		const hydrated = new Y.Doc({ gc: true });
		const state = storedState();
		if (state.length > 0) Y.applyUpdateV2(hydrated, state);
		for (const update of tailUpdates()) Y.applyUpdateV2(hydrated, update);
		document = hydrated;
		return hydrated;
	}

	return Object.freeze({
		stateVector: () => new Uint8Array(Y.encodeStateVector(live())),

		since: (peerVector) =>
			new Uint8Array(Y.encodeStateAsUpdateV2(live(), peerVector)),

		receive(update) {
			// Applied before it is stored, because applying is what decides
			// whether it is storable. A throw here is the door.
			const applied = trySync({
				try: () => Y.applyUpdateV2(live(), update),
				catch: (cause) => DocumentAuthorityError.Unapplyable({ cause }),
			});
			if (applied.error !== null) return Err(applied.error);

			return trySync({
				try: () =>
					sqlite.transaction(() => {
						const seq =
							(sqlite.all<SqliteRow & { seq: number }>(
								'SELECT COALESCE(MAX(seq), 0) AS seq FROM _tail',
							)[0]?.seq ?? 0) + 1;
						appendToTail(seq, update);
					}),
				catch: (cause) => DocumentAuthorityError.StorageFailed({ cause }),
			});
		},

		shouldFold() {
			const tail = sumBytes('_tail');
			return tail >= foldFloorBytes && tail > sumBytes('_state');
		},

		fold() {
			return trySync({
				try: () => {
					const folded = new Uint8Array(Y.encodeStateAsUpdateV2(live()));
					sqlite.transaction(() => {
						sqlite.run('DELETE FROM _state');
						writeState(folded);
						sqlite.run('DELETE FROM _tail');
					});
				},
				catch: (cause) => DocumentAuthorityError.StorageFailed({ cause }),
			});
		},

		hasUnresolvedDependencies: () => hasPendingStructs(live()),

		storedBytes: () => sumBytes('_state') + sumBytes('_tail'),

		dispose() {
			document?.destroy();
			document = undefined;
		},
	});

	function writeState(bytes: Uint8Array): void {
		for (const [index, chunk] of intoChunks(bytes, CHUNK_BYTES).entries()) {
			sqlite.run('INSERT INTO _state (chunk, bytes) VALUES (?, ?)', [
				index,
				new Uint8Array(chunk),
			]);
		}
	}

	function appendToTail(seq: number, bytes: Uint8Array): void {
		for (const [index, chunk] of intoChunks(bytes, CHUNK_BYTES).entries()) {
			sqlite.run('INSERT INTO _tail (seq, chunk, bytes) VALUES (?, ?, ?)', [
				seq,
				index,
				new Uint8Array(chunk),
			]);
		}
	}

	function storedState(): Uint8Array {
		return join(
			sqlite
				.all<SqliteRow & { bytes: Uint8Array | ArrayBuffer }>(
					'SELECT bytes FROM _state ORDER BY chunk',
				)
				.map((row) => copyBytes(row.bytes)),
		);
	}

	function tailUpdates(): Uint8Array[] {
		const rows = sqlite.all<
			SqliteRow & { seq: number; bytes: Uint8Array | ArrayBuffer }
		>('SELECT seq, bytes FROM _tail ORDER BY seq, chunk');
		const updates: Uint8Array[] = [];
		let holding: { seq: number; chunks: Uint8Array[] } | undefined;
		for (const row of rows) {
			if (holding === undefined || holding.seq !== row.seq) {
				if (holding !== undefined) updates.push(join(holding.chunks));
				holding = { seq: row.seq, chunks: [] };
			}
			holding.chunks.push(copyBytes(row.bytes));
		}
		if (holding !== undefined) updates.push(join(holding.chunks));
		return updates;
	}

	function sumBytes(relation: '_state' | '_tail'): number {
		return (
			sqlite.all<SqliteRow & { bytes: number }>(
				`SELECT COALESCE(SUM(length(bytes)), 0) AS bytes FROM ${relation}`,
			)[0]?.bytes ?? 0
		);
	}
}

/**
 * Whether a document is holding updates whose dependencies never arrived.
 *
 * `store.pendingStructs` is internal, and the same reader exists in `store.ts`
 * for the same reason: Yjs buffers an update it cannot integrate and returns
 * normally, with no error, no event and no public reader, so this is the only
 * observable symptom of silent loss. Pinned by a test on both sides, because an
 * rc can move it.
 */
function hasPendingStructs(document: Y.Doc): boolean {
	const store = (
		document as unknown as {
			store?: { pendingStructs?: unknown; pendingDs?: unknown };
		}
	).store;
	return (
		(store?.pendingStructs ?? null) !== null ||
		(store?.pendingDs ?? null) !== null
	);
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 0) return new Uint8Array();
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
