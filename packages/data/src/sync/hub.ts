/**
 * Who is connected, and what each of them has been sent.
 *
 * The whole of the authority's connection behaviour, with no runtime in it. A
 * Durable Object is a thirty-line adapter over this, and the tests drive the
 * same object through a pair of in-process sockets, so what is tested and what
 * is deployed are the same code rather than two things that agree today.
 *
 * ## Catch-up and live relay are one path
 *
 * There is one verb, `deliver`, and it means "everything after your cursor".
 * A device returning from a week offline and a device being handed the update
 * someone typed a moment ago run the same loop with different starting numbers.
 * A second path for the live case is where a transport grows a rule that is
 * true only when it is warm.
 *
 * Since ADR-0231 the log describes exactly one document, and the authority
 * names it as the first frame on every connection. Bytes merge only when
 * they name the same document, so admission is one equality; a replica of a
 * replaced document is never admitted to the relay membership, which is the
 * whole guard.
 */
import { Ok, type Result } from 'wellcrafted/result';

import type { SyncAuthority } from './authority.js';
import {
	CHUNK_BYTES,
	type ChunkCollector,
	createChunkCollector,
	decodeFrame,
	encodeFrame,
	intoChunks,
	type OfferFrame,
} from './frames.js';

/**
 * One attached replica, from the hub's point of view.
 *
 * `cursor` is how far this connection has been SENT, which the hub owns and
 * moves. It is not the replica's own durable cursor: the replica moves that one
 * only after bytes commit, so the two differ for exactly as long as a message
 * is in flight, and it is the replica's that survives a crash.
 */
export type HubConnection = {
	send(bytes: Uint8Array): void;
	cursor: number;
	/**
	 * Which document this replica declared on its dial, or undefined for one
	 * that has never been entangled with any (ADR-0231).
	 *
	 * The membership fact, and the whole of admission: equal to the
	 * authority's current document proceeds, different is retired. Undefined
	 * is servable only at cursor zero (a replica with no reading to resume);
	 * an undeclared nonzero cursor is a protocol that no longer exists and is
	 * never admitted.
	 */
	document: string | undefined;
};

/**
 * What admission decided, which is everything (ADR-0231).
 *
 * `bootstrap` names the current document to a pristine replica, and that is
 * all it does: no history, no membership. The replica persists the ID and
 * reconnects with it; every byte of state moves on that admitted connection,
 * so "a replica exchanges workspace updates only when its persisted document
 * ID equals the authority's current ID" is true without an exception for
 * first contact. `admitted` is membership: catch-up ran and the connection
 * now receives relays and may push. `retired` means this connection cannot sync the
 * current document (its declared identity differs, or it declared nothing
 * while claiming a reading position): the announcement was sent and the
 * connection was never registered, so the hub relays nothing to it and
 * `receive` drops anything from it; the caller should close the socket.
 * `unavailable` means the document could not be named: fail closed, no
 * frame, no membership, and the caller closes, because admitting unchecked
 * could seat a stale replica and an announcement the authority did not
 * actually make must never be sent.
 */
export type Admission = 'bootstrap' | 'admitted' | 'retired' | 'unavailable';

export type SyncHub = {
	/**
	 * A replica attached at its cursor: the one door.
	 *
	 * The authority names its document first, on every connection; equality
	 * with the replica's declared identity is the sole condition for syncing
	 * an existing local document. An identity-less cursor-zero connection only
	 * bootstraps, then reconnects with its stored identity. Membership is what
	 * makes both contamination directions
	 * impossible without guards: an unregistered connection is sent no
	 * history and its pushes land nowhere.
	 */
	join(connection: HubConnection): Admission;
	/** Bytes arrived from a replica. */
	receive(connection: HubConnection, message: Uint8Array): Result<void, never>;
	leave(connection: HubConnection): void;
	attached(): number;
};

export function createSyncHub({
	authority,
	/** Entries per read. Bounds one catch-up read, not the catch-up itself. */
	batch = 64,
	/**
	 * The ceiling on chunks held for submissions that are still incomplete.
	 *
	 * Reassembly is in memory, so a client that opens a submission and never
	 * finishes it is asking the authority to hold bytes indefinitely. Past this
	 * the partial is dropped and the client is refused, which it can act on
	 * because it still owes the work.
	 */
	maxBufferedBytes = 64 * 1024 * 1024,
}: {
	authority: SyncAuthority;
	batch?: number;
	maxBufferedBytes?: number;
}): SyncHub {
	const connections = new Map<HubConnection, ChunkCollector>();

	/**
	 * Bring a connection up to the snapshot if it is behind one.
	 *
	 * The snapshot covers everything at or before its position, so a replica
	 * behind it can never be served from the tail: those entries are gone. It
	 * adopts the snapshot instead and its cursor jumps there in one step.
	 *
	 * Adopting is a MERGE, not a replacement. The snapshot preserves struct
	 * identities, so a replica arriving with unsent offline work keeps it and
	 * pushes it afterwards like any other local write.
	 */
	function catchUpToSnapshot(connection: HubConnection): void {
		const { data: snapshot, error } = authority.snapshot();
		if (error !== null || snapshot === undefined) return;
		if (connection.cursor >= snapshot.position) return;
		const chunks = intoChunks(snapshot.bytes, CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			connection.send(
				encodeFrame({
					kind: 'snapshot',
					position: snapshot.position,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
		}
		connection.cursor = snapshot.position;
	}

	/** Send everything after this connection's cursor, up to `ceiling`. */
	function deliver(connection: HubConnection, ceiling?: number): void {
		catchUpToSnapshot(connection);
		for (;;) {
			const { data: entries, error } = authority.since(
				connection.cursor,
				batch,
			);
			if (error !== null) return;
			if (entries.length === 0) return;
			for (const entry of entries) {
				if (ceiling !== undefined && entry.seq > ceiling) return;
				const chunks = intoChunks(entry.bytes, CHUNK_BYTES);
				for (const [index, chunk] of chunks.entries()) {
					connection.send(
						encodeFrame({
							kind: 'entry',
							seq: entry.seq,
							chunk: index,
							chunks: chunks.length,
							bytes: chunk,
						}),
					);
				}
				connection.cursor = entry.seq;
			}
			if (entries.length < batch) return;
		}
	}

	return Object.freeze({
		join(connection): Admission {
			// The name is read before anything is sent, so an unreadable
			// authority answers with silence rather than with a fact it cannot
			// stand behind.
			const { data: document, error: documentError } = authority.document();
			if (documentError !== null) return 'unavailable';
			// The authority names its document first, on every connection: a
			// fresh replica stamps this name at its first entanglement, and a
			// stamped one compares it. The invariant is one sentence: bytes
			// merge only when they name the same document (ADR-0231).
			connection.send(encodeFrame({ kind: 'document', id: document }));
			if (connection.document === undefined) {
				if (connection.cursor !== 0) return 'retired';
				// The announcement is the whole of bootstrap. The authority cannot
				// prove a client is pristine, so it hands over nothing but the name;
				// the client stamps it only when its own durable state is empty,
				// then reconnects through the equality door, and the state arrives
				// on that admitted connection like anyone else's catch-up.
				return 'bootstrap';
			}
			if (connection.document !== document) return 'retired';
			connections.set(
				connection,
				createChunkCollector({ limitBytes: maxBufferedBytes }),
			);
			deliver(connection);
			return 'admitted';
		},

		leave(connection) {
			connections.delete(connection);
		},

		attached: () => connections.size,

		receive(connection, message) {
			const collector = connections.get(connection);
			if (collector === undefined) return Ok(undefined);

			const { data: frame, error } = decodeFrame(message);
			if (error !== null) return Ok(undefined);
			if (frame.kind === 'offer')
				return takeOffer(connection, collector, frame);
			if (frame.kind !== 'push') return Ok(undefined);

			// The only refusal about CONTENT that survives, and it is about framing
			// rather than about meaning: a submission that changes its chunk count
			// mid-flight, or one that would push the buffered partials past the
			// limit. The authority itself never reads the bytes, so "these are not a
			// valid update" is not a thing anything here can say.
			const { data: whole, error: chunkError } = collector.accept(frame);
			if (chunkError !== null) {
				connection.send(
					encodeFrame({
						kind: 'refuse',
						submission: frame.submission,
						reason: chunkError.reason,
					}),
				);
				return Ok(undefined);
			}
			if (whole === undefined) return Ok(undefined);

			const { data: seq, error: appendError } = authority.append(whole);
			if (appendError !== null) {
				// Storage failed, and it is said out loud on the socket naming the
				// submission. A throw here would be swallowed by `workerd` without
				// closing the socket, and the client would hold the work forever
				// believing it was in transit. That is the entire reason a refusal is
				// a frame, and it stays true for a failure the server did not choose.
				connection.send(
					encodeFrame({
						kind: 'refuse',
						submission: frame.submission,
						reason: appendError.message,
					}),
				);
				return Ok(undefined);
			}

			// Anything this connection has not been sent yet goes out BEFORE its
			// ack, so an ack is always exactly one past what the replica holds. The
			// replica checks that, and a check that can be met by construction is
			// worth arranging rather than asserting and hoping.
			deliver(connection, seq - 1);
			connection.cursor = seq;
			connection.send(
				encodeFrame({ kind: 'ack', submission: frame.submission, seq }),
			);

			for (const other of connections.keys()) {
				if (other !== connection) deliver(other);
			}
			askForSnapshot(connection);
			return Ok(undefined);
		},
	});

	/**
	 * Ask a connection for a snapshot, when it is the one that can give one.
	 *
	 * Only a connection at the head qualifies, so the request goes to a replica
	 * that will pass the accept condition rather than to one that will be
	 * refused. Asking is all the authority does; it cannot produce a snapshot
	 * itself without understanding the bytes, which is the point.
	 */
	function askForSnapshot(connection: HubConnection): void {
		const { data: wanted, error } = authority.shouldSnapshot();
		if (error !== null || !wanted) return;
		const { data: head, error: headError } = authority.head();
		if (headError !== null || head === 0) return;
		if (connection.cursor !== head) return;
		connection.send(encodeFrame({ kind: 'wanted', position: head }));
	}

	function takeOffer(
		connection: HubConnection,
		collector: ChunkCollector,
		frame: OfferFrame,
	): Result<void, never> {
		const { data: whole, error } = collector.accept(frame);
		if (error !== null || whole === undefined) return Ok(undefined);

		// The half of the accept condition only the hub can check, and the half
		// that separates this from the client-posted baseline an earlier design
		// died on. `connection.cursor` is the authority's OWN record of what it
		// has sent this socket, not a claim the replica makes about itself.
		//
		// `>=` rather than `===`, because entries keep arriving: a replica asked
		// for a snapshot at 815 may have been sent 816 by the time its offer
		// lands, and its snapshot still accounts for everything through 815,
		// which is all it is used for. Requiring equality refused good snapshots
		// under ordinary traffic.
		if (connection.cursor < frame.position) {
			connection.send(
				encodeFrame({
					kind: 'refuse',
					submission: frame.position,
					reason: `a snapshot at ${frame.position} came from a connection sent only through ${connection.cursor}`,
				}),
			);
			return Ok(undefined);
		}

		// And the half the authority checks: that this is also the head.
		const { error: replaceError } = authority.replaceSnapshot(
			frame.position,
			whole,
		);
		if (replaceError !== null) {
			connection.send(
				encodeFrame({
					kind: 'refuse',
					submission: frame.position,
					reason: replaceError.message,
				}),
			);
		}
		return Ok(undefined);
	}
}
