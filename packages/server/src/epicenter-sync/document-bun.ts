import {
	DOCUMENT_SUBPROTOCOL,
	type DocumentAddress,
} from '@epicenter/document-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';

import { sanitizeUpgradeSubprotocols } from '../sanitize-upgrade-subprotocols.js';
import {
	createEpicenterDocumentServer,
	type EpicenterDocumentServer,
	type EpicenterDocumentSocket,
} from './document-server.js';

export type BunEpicenterDocumentSocketData = {
	surface: 'epicenter-document';
	principalId: string;
	address: DocumentAddress;
	authorizationExpiresAt: number;
};

/** Create the unmounted Bun transport for the Epicenter document handler. */
export function createBunEpicenterDocumentBinding({
	locateDatabase,
}: {
	locateDatabase(principalId: string): SqliteDatabase;
}) {
	const authorities = new Map<string, EpicenterDocumentServer>();
	const adapters = new WeakMap<
		ServerWebSocket<BunEpicenterDocumentSocketData>,
		EpicenterDocumentSocket
	>();
	const activeSockets = new Set<
		ServerWebSocket<BunEpicenterDocumentSocketData>
	>();
	const expiryTimers = new Map<
		ServerWebSocket<BunEpicenterDocumentSocketData>,
		ReturnType<typeof setTimeout>
	>();

	function authority(principalId: string): EpicenterDocumentServer {
		let opened = authorities.get(principalId);
		if (opened === undefined) {
			opened = createEpicenterDocumentServer({
				database: locateDatabase(principalId),
			});
			authorities.set(principalId, opened);
		}
		return opened;
	}

	function adapter(
		socket: ServerWebSocket<BunEpicenterDocumentSocketData>,
	): EpicenterDocumentSocket {
		let value = adapters.get(socket);
		if (value === undefined) {
			value = {
				send: (data) => socket.send(data),
				close: () => socket.close(),
			};
			adapters.set(socket, value);
		}
		return value;
	}

	const websocket: WebSocketHandler<BunEpicenterDocumentSocketData> = {
		open(socket) {
			activeSockets.add(socket);
			expiryTimers.set(
				socket,
				setTimeout(
					() => socket.close(1000, 'credential-expired'),
					Math.max(0, socket.data.authorizationExpiresAt - Date.now()),
				),
			);
		},
		message(socket, message) {
			if (Date.now() >= socket.data.authorizationExpiresAt) {
				socket.close(1000, 'credential-expired');
				return;
			}
			if (typeof message === 'string') {
				socket.close();
				return;
			}
			authority(socket.data.principalId).receive(
				adapter(socket),
				socket.data.address,
				new Uint8Array(message),
			);
		},
		close(socket) {
			activeSockets.delete(socket);
			clearTimeout(expiryTimers.get(socket));
			expiryTimers.delete(socket);
			authority(socket.data.principalId).disconnect(adapter(socket));
		},
	};

	return {
		handleAuthorizedUpgrade(
			request: Request,
			server: Server<BunEpicenterDocumentSocketData>,
			verified: {
				principalId: string;
				address: DocumentAddress;
				authorizationExpiresAt: number;
			},
		): Response {
			const { principalId, address, authorizationExpiresAt } = verified;
			if (!authority(principalId).admit(address)) {
				return new Response('WebSocket upgrade refused', { status: 404 });
			}
			sanitizeUpgradeSubprotocols(request, DOCUMENT_SUBPROTOCOL);
			const upgraded = server.upgrade(request, {
				data: {
					surface: 'epicenter-document',
					principalId,
					address,
					authorizationExpiresAt,
				},
			});
			return upgraded
				? new Response(null)
				: new Response('Expected WebSocket upgrade', { status: 426 });
		},
		websocket,
		closeRow(principalId: string, address: DocumentAddress): void {
			authorities.get(principalId)?.closeRow(address);
		},
		closeAll(): void {
			for (const socket of activeSockets) socket.close(1001, 'server-shutdown');
			activeSockets.clear();
			for (const timer of expiryTimers.values()) clearTimeout(timer);
			expiryTimers.clear();
		},
	};
}
