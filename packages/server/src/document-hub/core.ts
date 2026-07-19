import type { RowAddress } from '@epicenter/row-sync';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	type DocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

export type DocumentHubStore = {
	/** Atomically recheck row liveness and load its document in one snapshot. */
	openIfLive(address: RowAddress): readonly Uint8Array[] | undefined;
	/**
	 * Atomically recheck row liveness, validate the candidate against committed
	 * document state, and append its exact bytes only when it is still live.
	 */
	appendIfLive(
		address: RowAddress,
		update: Uint8Array,
	): 'appended' | 'refused' | 'too-large';
};

export type DocumentHubSocket = {
	send(frame: DocumentFrame): void;
	close(code: number, reason: string): void;
};

const hydrationOrigin = Symbol('document-hub-hydration');
const ORDINARY_CLOSE_CODE = 1000;
const NOT_LIVE_REASON = 'not-live';

/**
 * Own every socket for one route-owned row without retaining document state.
 *
 * This core is intentionally not a workspace multiplexer. Its address is fixed
 * at construction and never appears in a socket lease or protocol frame.
 */
export function createDocumentHubCore({
	address,
	store,
}: {
	address: RowAddress;
	store: DocumentHubStore;
}) {
	const sockets = new Set<DocumentHubSocket>();

	function disconnect(socket: DocumentHubSocket): void {
		sockets.delete(socket);
	}

	function closeSocket(
		socket: DocumentHubSocket,
		code: number,
		reason: string,
	) {
		disconnect(socket);
		tryClose(socket, code, reason);
	}

	function closeAll(): void {
		for (const socket of [...sockets]) {
			closeSocket(socket, ORDINARY_CLOSE_CODE, NOT_LIVE_REASON);
		}
	}

	function requireConnected(socket: DocumentHubSocket): void {
		if (!sockets.has(socket)) {
			throw new TypeError('Document frame requires an active connection');
		}
	}

	return {
		/** Bind one accepted socket and start a symmetric Yjs 14 state exchange. */
		connect(socket: DocumentHubSocket, stateVector: Uint8Array): boolean {
			if (sockets.has(socket)) {
				throw new TypeError('Document socket is already connected');
			}
			Y.decodeStateVector(stateVector);
			const updates = store.openIfLive(address);
			if (updates === undefined) {
				tryClose(socket, ORDINARY_CLOSE_CODE, NOT_LIVE_REASON);
				return false;
			}

			const document = new Y.Doc({ gc: true });
			try {
				for (const update of updates) {
					Y.applyUpdateV2(document, update, hydrationOrigin);
				}
				sockets.add(socket);
				// A half-delivered handshake would strand the peer: it defers its own
				// reply until this response arrives, so a swallowed send failure must
				// close the socket instead of leaving a connection the hub believes
				// is live.
				const handshakeSent =
					trySend(socket, {
						kind: 'sync-request',
						stateVector: Y.encodeStateVector(document),
					}) &&
					trySend(socket, {
						kind: 'sync-response',
						update: Y.encodeStateAsUpdateV2(document, stateVector),
					});
				if (!handshakeSent) {
					closeSocket(socket, ORDINARY_CLOSE_CODE, 'handshake-failed');
					return false;
				}
				return true;
			} finally {
				document.destroy();
			}
		},

		/** Accept one handshake response or later document-local update. */
		receive(
			socket: DocumentHubSocket,
			frame: Extract<DocumentFrame, { kind: 'sync-response' | 'update' }>,
		): void {
			requireConnected(socket);
			// Candidate validation and bounds belong to the store's transaction; a
			// malformed update throws there and the runtime closes with 1002.
			const result = store.appendIfLive(address, frame.update);
			switch (result) {
				case 'refused':
					closeAll();
					return;
				case 'too-large':
					closeSocket(socket, DOCUMENT_BACKSTOP_CLOSE_CODE, 'too-large');
					return;
				case 'appended': {
					const broadcast = { kind: 'update', update: frame.update } as const;
					for (const peer of sockets) {
						if (peer !== socket) trySend(peer, broadcast);
					}
					return;
				}
				default:
					result satisfies never;
			}
		},

		disconnect,

		/** Close every socket after the authority commits row deletion. */
		closeAll,

		get connectionCount(): number {
			return sockets.size;
		},
	};
}

function trySend(socket: DocumentHubSocket, frame: DocumentFrame): boolean {
	try {
		socket.send(frame);
		return true;
	} catch {
		// The runtime-owned close path removes the dead socket's connection.
		return false;
	}
}

function tryClose(
	socket: DocumentHubSocket,
	code: number,
	reason: string,
): void {
	try {
		socket.close(code, reason);
	} catch {
		// The connection is already gone; transport cleanup is best effort.
	}
}
