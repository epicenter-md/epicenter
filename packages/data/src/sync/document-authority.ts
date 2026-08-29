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
 * ## Why the storage is a chain
 *
 * Writing the whole document on every update is O(document) per keystroke's
 * worth of work. Appending makes a write O(update), and folding amortizes the
 * cost. What is gone is the DANCE. The old authority could not fold by itself,
 * so it asked a client for a snapshot and checked the offer covered a position
 * it had sent that connection. This one holds the state it is replacing and
 * owes nobody a proof.
 *
 * One relation, not two, and the folded state is an ordinary row in it. That
 * is the client's shape (ADR-0280) arriving here: two tables meant a
 * `writeState`, a `storedState`, a two-relation byte sum, and a
 * delete-then-write choreography, all to say that one row is special. Nothing
 * that reads needs to know, because Yjs updates are commutative.
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
import { FOLD_FLOOR_BYTES, shouldFold } from './fold.js';
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
	// One relation, and the folded state is an ordinary row in it. This was two
	// tables, `_state` and `_tail`, until the client's record proved the same
	// chain needs one: a fold writes a new row and deletes the rows it covers,
	// and nothing that reads can tell a fold from an update, because Yjs
	// updates are commutative and a reader applies the whole range in order.
	// Two tables meant `writeState`, `storedState`, a two-relation `sumBytes`,
	// and a delete-then-write choreography, all to say "this row is special".
	//
	// Chunked because a document is the largest single value stored here and
	// the only one guaranteed to exceed the Durable Object's 2 MB value cap.
	// The sequence orders reassembly and nothing else: there is no position in
	// the protocol any more, and nobody is ever told this number.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS updates (
			seq   INTEGER NOT NULL,
			chunk INTEGER NOT NULL,
			bytes BLOB    NOT NULL,
			PRIMARY KEY (seq, chunk)
		)
	`);
}

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
	/**
	 * Whether an update was applied to the live document but not stored.
	 *
	 * `receive` applies before it writes, because applying is what decides
	 * whether the bytes are storable. If the write then fails, the document in
	 * memory holds an update the record does not, and every downstream fact
	 * goes wrong at once: `shouldFold` reads storage sums that no longer
	 * describe the document, so the one operation that would repair the
	 * divergence is exactly the one the divergence suppresses, and a
	 * hibernation wake silently reverts the update.
	 *
	 * So a failed write forces a fold, which rewrites the whole document from
	 * memory and is therefore the repair.
	 */
	let unstored = false;

	/** The document, hydrated from storage on first use. */
	function live(): Y.Doc {
		if (document !== undefined) return document;
		const hydrated = new Y.Doc({ gc: true });
		for (const update of storedUpdates()) Y.applyUpdateV2(hydrated, update);
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

			const stored = trySync({
				try: () =>
					sqlite.transaction(() => {
						append(lastSeq() + 1, update);
					}),
				catch: (cause) => DocumentAuthorityError.StorageFailed({ cause }),
			});
			// The bytes are in the live document either way, so a failed write
			// is divergence rather than a refusal, and the caller's `Err` does
			// not undo it. Marking it is what gets it written: the next fold
			// encodes the whole document, including this.
			if (stored.error !== null) unstored = true;
			return stored;
		},

		shouldFold() {
			if (unstored) return true;
			const [state = 0, ...tail] = sequenceBytes();
			return shouldFold(
				state,
				tail.reduce((total, bytes) => total + bytes, 0),
				foldFloorBytes,
			);
		},

		fold() {
			return trySync({
				try: () => {
					// The bound comes before the encode, exactly as it does on the
					// client: anything written while this runs sits above it and
					// survives, and may also already be inside the state, which
					// costs one redundant apply and nothing else.
					const upTo = lastSeq();
					const folded = new Uint8Array(Y.encodeStateAsUpdateV2(live()));
					unstored = false;
					sqlite.transaction(() => {
						append(upTo + 1, folded);
						sqlite.run('DELETE FROM updates WHERE seq <= ?', [upTo]);
					});
				},
				catch: (cause) => DocumentAuthorityError.StorageFailed({ cause }),
			});
		},

		hasUnresolvedDependencies: () => hasPendingStructs(live()),

		storedBytes: () =>
			sequenceBytes().reduce((total, bytes) => total + bytes, 0),

		dispose() {
			document?.destroy();
			document = undefined;
		},
	});

	function append(seq: number, bytes: Uint8Array): void {
		for (const [index, chunk] of intoChunks(bytes, CHUNK_BYTES).entries()) {
			sqlite.run('INSERT INTO updates (seq, chunk, bytes) VALUES (?, ?, ?)', [
				seq,
				index,
				new Uint8Array(chunk),
			]);
		}
	}

	function lastSeq(): number {
		return (
			sqlite.all<SqliteRow & { seq: number }>(
				'SELECT COALESCE(MAX(seq), 0) AS seq FROM updates',
			)[0]?.seq ?? 0
		);
	}

	/** The chain, reassembled from its chunks, in the order it must apply. */
	function storedUpdates(): Uint8Array[] {
		const rows = sqlite.all<
			SqliteRow & { seq: number; bytes: Uint8Array | ArrayBuffer }
		>('SELECT seq, bytes FROM updates ORDER BY seq, chunk');
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

	/**
	 * Each stored update's size, oldest first.
	 *
	 * The first is the state and the rest are the tail, which is the same rule
	 * the client's record uses and the same reason: usually a fold put the
	 * first one there, and on a chain that has never been folded it is simply
	 * the oldest update, where calling it the state is still right because
	 * folding a chain whose first record already dominates it buys nothing.
	 */
	function sequenceBytes(): number[] {
		return sqlite
			.all<SqliteRow & { bytes: number }>(
				'SELECT COALESCE(SUM(length(bytes)), 0) AS bytes FROM updates GROUP BY seq ORDER BY seq',
			)
			.map((row) => row.bytes);
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
