/**
 * One document's authority, and every socket attached to it.
 *
 * Compare `hub.ts`, which is 341 lines of membership, admission by identity
 * equality, catch-up from a cursor, chunk reassembly with a buffered-bytes
 * ceiling, a snapshot request-and-offer dance, and refusal frames. This has
 * none of them, and the reason each one is absent is the same: they exist so a
 * byte-blind authority can serve a positional log, and this authority reads.
 *
 * ## Admission is not a thing here
 *
 * The old hub's whole guard was that a replica declares a document identity
 * and is admitted only on equality, because one log described one document and
 * a stale replica must never merge into it. There is one document per object
 * now (ADR-0277), and which one is the address you dialled. A replica holding
 * a superseded generation is talking to a different object entirely, so there
 * is nothing to compare and nothing to refuse.
 *
 * ## Relay is verbatim
 *
 * An update that arrives is sent on to every other socket unchanged, rather
 * than recomputed per peer. It is idempotent, so a peer that already has it
 * applies it again for nothing, and recomputing per peer would cost a diff per
 * connection to save bytes on a message that is already the delta.
 */

import type { DocumentAuthority } from './document-authority.js';
import {
	type DocumentFrame,
	type DocumentSocket,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from './document-frames.js';

export type DocumentHub = {
	/** A socket arrived. Nothing is sent until it says what it has. */
	join(socket: DocumentSocket): void;
	leave(socket: DocumentSocket): void;
	/**
	 * Bytes arrived from one socket.
	 *
	 * `true` when they were a frame this authority took. `false` means the host
	 * should CLOSE that socket rather than log and carry on: under this
	 * protocol a peer only ever sends what the authority told it was missing,
	 * so bytes that will not decode or will not apply mean the peer is out of
	 * step, and a reconnect's handshake is the repair. Returning `false` and
	 * leaving the socket open is how a client comes to believe its work is
	 * pushed while the authority never took it, which is silent divergence with
	 * every surface reading green.
	 */
	receive(socket: DocumentSocket, message: Uint8Array): boolean;
	attached(): number;
};

export function createDocumentHub({
	authority,
}: {
	authority: DocumentAuthority;
}): DocumentHub {
	const sockets = new Set<DocumentSocket>();

	/**
	 * Send, and treat a throwing socket as one that has left.
	 *
	 * A closing WebSocket throws from `send`, and the relay below runs over
	 * every peer: without this, the first socket to go takes the rest of the
	 * loop with it, and every peer after it in iteration order silently misses
	 * an update the authority has already applied.
	 */
	function send(socket: DocumentSocket, frame: DocumentFrame): void {
		try {
			socket.send(encodeDocumentFrame(frame));
		} catch {
			sockets.delete(socket);
		}
	}

	return Object.freeze({
		join(socket) {
			sockets.add(socket);
			// The client opens by announcing, not the server. A server that spoke
			// first would be guessing what the client has, and the guess is the
			// state vector it is about to be told.
		},

		leave(socket) {
			sockets.delete(socket);
		},

		receive(socket, message): boolean {
			const { data: frame, error } = decodeDocumentFrame(message);
			if (error !== null) return false;
			// A socket that left is a socket whose bytes go nowhere, which is the
			// same guard the old hub got from membership.
			if (!sockets.has(socket)) return false;

			switch (frame.kind) {
				case 'step1': {
					// Answer what it lacks, then say what this authority has so the
					// client can answer in turn. Two frames, one round trip, and the
					// order matters only in that the client can apply before it
					// computes.
					send(socket, {
						kind: 'step2',
						update: authority.since(frame.stateVector),
					});
					send(socket, {
						kind: 'step1',
						stateVector: authority.stateVector(),
					});
					return true;
				}
				case 'step2':
				case 'update': {
					const { error: refused } = authority.receive(frame.update);
					// Bytes that will not apply never entered, so there is nothing to
					// relay and nothing to undo. The refusal is the door ADR-0218 said
					// a byte-blind server could not have.
					if (refused !== null) return false;
					for (const other of [...sockets]) {
						if (other === socket) continue;
						send(other, { kind: 'update', update: frame.update });
					}
					return true;
				}
			}
		},

		attached: () => sockets.size,
	});
}
