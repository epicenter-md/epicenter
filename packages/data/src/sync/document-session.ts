/**
 * One document, one socket: the client half of the handshake, and nothing else.
 *
 * Compare `client.ts`, which is 603 lines. Almost all of that is bookkeeping a
 * positional log needs and this protocol does not: a cursor, an outbox, the
 * one-submission-at-a-time rule, gap detection, a resync path, chunk
 * reassembly, and a stickily-superseded conclusion drawn from an announcement.
 * None of it appears here, because none of it is missing — the question those
 * mechanisms substituted for is one the authority can now answer.
 *
 * ## The whole of it
 *
 * On attach, say what you have. Whatever comes back, apply. When the document
 * changes locally, send what changed. That is the protocol, and the three
 * message kinds are exactly those three sentences (`document-frames.ts`).
 *
 * ## What it does not own
 *
 * The socket, which a host makes (ADR-0222), and the clock. `persist()` and
 * `flush()` are calls the owner makes on whatever timer it already runs, for
 * the reason `document-replica.ts` gives: writing the whole document per
 * keystroke is O(document) per edit, and the thing that makes that fine is a
 * debounce the owner has anyway. A second, invisible timer in here would be a
 * second clock to reason about.
 */
import {
	type DocumentFrame,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from './document-frames.js';
import type { DocumentReplica } from './document-replica.js';

/** What a host hands over. The library never makes one (ADR-0222). */
export type DocumentSocket = { send(bytes: Uint8Array): void };

export type DocumentSession = {
	/**
	 * A socket is live. Say what this replica holds, which starts the handshake.
	 *
	 * Idempotent in the way that matters: a reconnect re-announces, and an
	 * authority answering a state vector it has already answered sends the
	 * 13-byte no-op.
	 */
	attach(socket: DocumentSocket): void;
	/** The socket is gone. Nothing is owed, because nothing was remembered. */
	detach(): void;
	/** Bytes arrived. Returns whether they were a frame at all. */
	receive(message: Uint8Array): boolean;
	/** Send whatever the peer does not have, now. */
	flush(): void;
	dispose(): void;
};

export function openDocumentSession({
	replica,
}: {
	replica: DocumentReplica;
}): DocumentSession {
	let socket: DocumentSocket | undefined;
	/**
	 * What the peer told us it had, at its last step 1.
	 *
	 * The only state here, and it is not durable on purpose. Losing it means
	 * re-announcing on the next attach, which is one extra handshake; persisting
	 * it would mean a replica could believe something about a peer it has not
	 * spoken to since, which is the class of stale fact the cursor used to be.
	 */
	let peerVector: Uint8Array | undefined;
	let disposed = false;

	function send(frame: DocumentFrame): void {
		socket?.send(encodeDocumentFrame(frame));
	}

	/** Local work goes out as an update against what the peer last claimed. */
	function sendOwed(): void {
		if (socket === undefined || peerVector === undefined) return;
		const update = replica.since(peerVector);
		send({ kind: 'update', update });
		// The peer has it once it is on the wire. If the socket dies in flight
		// the peer's next step 1 says otherwise and it is sent again, which is
		// free: an update is idempotent.
		peerVector = replica.stateVector();
	}

	const session: DocumentSession = Object.freeze({
		attach(next: DocumentSocket) {
			if (disposed) return;
			socket = next;
			peerVector = undefined;
			send({ kind: 'step1', stateVector: replica.stateVector() });
		},

		detach() {
			socket = undefined;
			peerVector = undefined;
		},

		receive(message: Uint8Array): boolean {
			if (disposed) return false;
			const { data: frame, error } = decodeDocumentFrame(message);
			if (error !== null) return false;
			switch (frame.kind) {
				case 'step1':
					// The peer said what it has, so answer with what it lacks and
					// remember the claim. This is also the moment a client learns
					// enough to push: before it, it has nothing to diff against.
					peerVector = frame.stateVector;
					send({ kind: 'step2', update: replica.since(frame.stateVector) });
					sendOwed();
					return true;
				case 'step2':
				case 'update':
					replica.receive(frame.update);
					return true;
			}
		},

		flush: sendOwed,

		dispose() {
			disposed = true;
			socket = undefined;
			peerVector = undefined;
		},
	});
	return session;
}
