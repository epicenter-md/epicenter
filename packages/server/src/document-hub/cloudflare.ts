import type { RowAddress } from '@epicenter/row-sync';
import {
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import type { DocumentHubStore } from './core.js';
import { createDocumentHubCore, type DocumentHubSocket } from './core.js';

const TABLE_HEADER = 'x-epicenter-document-table';
const ROW_HEADER = 'x-epicenter-document-row';
const WORKSPACE_HEADER = 'x-epicenter-document-workspace';
const AUTHORIZATION_EXPIRES_HEADER = 'x-epicenter-authorization-expires-at';

const ORDINARY_CLOSE_CODE = 1000;

type DocumentAttachment = {
	version: 1;
	/** The negotiated document subprotocol, verified before any frame decode. */
	subprotocol: string;
	workspaceId: string;
	table: string;
	rowId: string;
	acceptedAt: number;
	authorizationExpiresAt: number;
	connected: boolean;
};

function addressKey(workspaceId: string, { table, rowId }: RowAddress): string {
	return JSON.stringify([workspaceId, table, rowId]);
}

function isAttachment(value: unknown): value is DocumentAttachment {
	if (!value || typeof value !== 'object') return false;
	const attachment = value as Partial<DocumentAttachment>;
	return (
		attachment.version === 1 &&
		typeof attachment.subprotocol === 'string' &&
		typeof attachment.workspaceId === 'string' &&
		typeof attachment.table === 'string' &&
		typeof attachment.rowId === 'string' &&
		typeof attachment.acceptedAt === 'number' &&
		typeof attachment.authorizationExpiresAt === 'number' &&
		typeof attachment.connected === 'boolean'
	);
}

function readableBytes(message: ArrayBuffer | string): Uint8Array {
	if (typeof message === 'string')
		throw new TypeError('Document frames are binary');
	return new Uint8Array(message);
}

/**
 * Hibernation-aware document sockets hosted inside the account authority DO.
 *
 * The attachment's complete structured address is the only routing fact. Open
 * documents are few by product premise, so fanout and restore enumerate the
 * actor's sockets directly; no tag index exists.
 */
export class CloudflareWorkspaceDocumentRuntime {
	private readonly hubs = new Map<
		string,
		ReturnType<typeof createDocumentHubCore>
	>();
	private readonly sockets = new WeakMap<WebSocket, DocumentHubSocket>();

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly resolveStore: (workspaceId: string) => DocumentHubStore,
	) {
		for (const socket of ctx.getWebSockets()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			const attachment = socket.deserializeAttachment();
			if (!isAttachment(attachment)) {
				socket.close(1011, 'invalid-document-attachment');
				continue;
			}
			// Every restored document socket closes retryably: a crash between
			// commit and broadcast leaves a restored peer permanently behind, and a
			// mid-handshake peer waits on a reply this actor no longer owes, so the
			// reconnect state-vector exchange owns repair. Hibernation absorbs idle
			// transport acceptance, never document-session continuity.
			socket.close(ORDINARY_CLOSE_CODE, 'restart-resync');
		}
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response(null, { status: 405 });
		}
		const table = request.headers.get(TABLE_HEADER);
		const rowId = request.headers.get(ROW_HEADER);
		const workspaceId = request.headers.get(WORKSPACE_HEADER);
		const authorizationExpiresAt = Number(
			request.headers.get(AUTHORIZATION_EXPIRES_HEADER),
		);
		if (
			!table ||
			!rowId ||
			!workspaceId ||
			!Number.isSafeInteger(authorizationExpiresAt) ||
			authorizationExpiresAt <= Date.now()
		) {
			return new Response(null, { status: 500 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		const attachment: DocumentAttachment = {
			version: 1,
			subprotocol: DOCUMENT_SUBPROTOCOL,
			workspaceId,
			table,
			rowId,
			acceptedAt: Date.now(),
			authorizationExpiresAt,
			connected: false,
		};
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);
		await this.ensureExpiryAlarm();
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: { 'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL },
		});
	}

	webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
		const attachment = socket.deserializeAttachment();
		if (!isAttachment(attachment)) {
			socket.close(1011, 'invalid-document-attachment');
			return;
		}
		if (attachment.subprotocol !== DOCUMENT_SUBPROTOCOL) {
			// A deploy changed the document protocol under a surviving socket;
			// never feed its frames to the current decoder.
			this.disconnect(socket, attachment);
			socket.close(ORDINARY_CLOSE_CODE, 'stale-subprotocol');
			return;
		}
		if (Date.now() >= attachment.authorizationExpiresAt) {
			this.disconnect(socket, attachment);
			socket.close(ORDINARY_CLOSE_CODE, 'credential-expired');
			return;
		}
		try {
			const frame = decodeDocumentFrame(readableBytes(message));
			const address = { table: attachment.table, rowId: attachment.rowId };
			const hub = this.hub(attachment.workspaceId, address);
			if (!attachment.connected) {
				if (frame.kind !== 'sync-request') {
					throw new TypeError('First document frame must be sync-request');
				}
				if (hub.connect(this.socket(socket), frame.stateVector)) {
					socket.serializeAttachment({ ...attachment, connected: true });
				}
				return;
			}
			if (frame.kind === 'sync-request') {
				throw new TypeError('Document handshake is already complete');
			}
			hub.receive(this.socket(socket), frame);
		} catch {
			this.disconnect(socket, attachment);
			socket.close(1002, 'invalid-document-frame');
		}
	}

	webSocketClose(socket: WebSocket): void {
		const attachment = socket.deserializeAttachment();
		if (isAttachment(attachment)) this.disconnect(socket, attachment);
	}

	webSocketError(socket: WebSocket): void {
		this.webSocketClose(socket);
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		let nextExpiry: number | undefined;
		for (const socket of this.ctx.getWebSockets()) {
			const attachment = socket.deserializeAttachment();
			if (!isAttachment(attachment)) continue;
			const expiresAt = attachment.authorizationExpiresAt;
			if (expiresAt <= now) {
				this.disconnect(socket, attachment);
				socket.close(ORDINARY_CLOSE_CODE, 'credential-expired');
			} else {
				nextExpiry = Math.min(nextExpiry ?? expiresAt, expiresAt);
			}
		}
		if (nextExpiry !== undefined) await this.ctx.storage.setAlarm(nextExpiry);
	}

	/** Close every socket for deleted addresses after their deletion commits. */
	evictTombstoned(workspaceId: string, addresses: readonly RowAddress[]): void {
		for (const address of addresses) {
			const key = addressKey(workspaceId, address);
			const hub = this.hubs.get(key);
			if (!hub) continue;
			hub.closeAll();
			this.hubs.delete(key);
		}
	}

	/** Close every socket and discard every hub for one deleted workspace. */
	evictWorkspace(workspaceId: string): void {
		for (const socket of this.ctx.getWebSockets()) {
			const attachment = socket.deserializeAttachment();
			if (!isAttachment(attachment) || attachment.workspaceId !== workspaceId) {
				continue;
			}
			if (attachment.connected) this.disconnect(socket, attachment);
			socket.close(ORDINARY_CLOSE_CODE, 'not-live');
		}
		const keyPrefix = JSON.stringify([workspaceId]).slice(0, -1);
		for (const key of this.hubs.keys()) {
			if (!key.startsWith(keyPrefix)) continue;
			this.hubs.delete(key);
		}
	}

	private hub(workspaceId: string, address: RowAddress) {
		const key = addressKey(workspaceId, address);
		let hub = this.hubs.get(key);
		if (!hub) {
			hub = createDocumentHubCore({
				address,
				store: this.resolveStore(workspaceId),
			});
			this.hubs.set(key, hub);
		}
		return hub;
	}

	private socket(socket: WebSocket): DocumentHubSocket {
		let adapter = this.sockets.get(socket);
		if (!adapter) {
			adapter = {
				send: (frame) => socket.send(encodeDocumentFrame(frame)),
				close: (code, reason) => socket.close(code, reason),
			};
			this.sockets.set(socket, adapter);
		}
		return adapter;
	}

	private disconnect(socket: WebSocket, attachment: DocumentAttachment): void {
		const address = { table: attachment.table, rowId: attachment.rowId };
		const key = addressKey(attachment.workspaceId, address);
		const hub = this.hubs.get(key);
		if (!hub) return;
		hub.disconnect(this.socket(socket));
		if (hub.connectionCount === 0) this.hubs.delete(key);
	}

	private async ensureExpiryAlarm(): Promise<void> {
		let target: number | undefined;
		for (const socket of this.ctx.getWebSockets()) {
			const attachment = socket.deserializeAttachment();
			if (!isAttachment(attachment)) continue;
			target = Math.min(
				target ?? attachment.authorizationExpiresAt,
				attachment.authorizationExpiresAt,
			);
		}
		if (target === undefined) return;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > target)
			await this.ctx.storage.setAlarm(target);
	}
}

export const CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS = {
	workspace: WORKSPACE_HEADER,
	table: TABLE_HEADER,
	row: ROW_HEADER,
	authorizationExpiresAt: AUTHORIZATION_EXPIRES_HEADER,
} as const;
