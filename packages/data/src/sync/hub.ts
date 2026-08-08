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
};

export type SyncHub = {
	/** A replica attached at its cursor. Everything after it goes out now. */
	join(connection: HubConnection): void;
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

	/** Send everything after this connection's cursor, up to `ceiling`. */
	function deliver(connection: HubConnection, ceiling?: number): void {
		for (;;) {
			const { data: entries, error } = authority.since(connection.cursor, batch);
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
		join(connection) {
			connections.set(
				connection,
				createChunkCollector({ limitBytes: maxBufferedBytes }),
			);
			deliver(connection);
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
			connection.send(encodeFrame({ kind: 'ack', submission: frame.submission, seq }));

			for (const other of connections.keys()) {
				if (other !== connection) deliver(other);
			}
			return Ok(undefined);
		},
	});
}
