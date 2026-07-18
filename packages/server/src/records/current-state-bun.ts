import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PrincipalId } from '@epicenter/identity';
import type { RowAddress } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import {
	createDocumentHubCore,
	type DocumentHubSocket,
} from '../document-hub/core.js';
import { sanitizeUpgradeSubprotocols } from '../sanitize-upgrade-subprotocols.js';
import { openAccountRowAuthority } from '../workspace-authority/authority.js';
import { runCurrentStateTransportCompaction } from './current-state-compaction.js';
import type {
	AccountAuthorities,
	AccountAuthority,
} from './current-state-contracts.js';

type OpenAuthority = {
	database: Database;
	authority: ReturnType<typeof openAccountRowAuthority>;
	hubs: Map<string, ReturnType<typeof createDocumentHubCore>>;
};

export type BunWorkspaceDocumentSocketData =
	| {
			surface: 'workspace-document';
			kind: 'document';
			principalId: PrincipalId;
			workspaceId: string;
			address: RowAddress;
			authorizationExpiresAt: number;
			connected: boolean;
	  }
	| {
			surface: 'workspace-document';
			kind: 'reject';
			code: number;
			reason: string;
	  };

function encodePathComponent(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

function databasePath(dir: string, principalId: PrincipalId): string {
	const principalDir = join(
		dir,
		'principals',
		encodePathComponent(principalId),
	);
	mkdirSync(principalDir, { recursive: true });
	return join(principalDir, 'authority.sqlite');
}

/**
 * The Bun account-authority runtime: persistent per-principal SQLite
 * authorities, their document hubs and sockets, credential expiry, and
 * shutdown, behind one route-facing `AccountAuthorities` locator.
 */
export function createBunAccountAuthorityRuntime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const openAuthorities = new Map<string, OpenAuthority>();
	const activeSockets = new Set<
		ServerWebSocket<BunWorkspaceDocumentSocketData>
	>();
	const socketAdapters = new WeakMap<
		ServerWebSocket<BunWorkspaceDocumentSocketData>,
		DocumentHubSocket
	>();
	let server: Server<BunWorkspaceDocumentSocketData> | null = null;
	let isClosed = false;

	function addressKey(workspaceId: string, address: RowAddress): string {
		return JSON.stringify([workspaceId, address.table, address.rowId]);
	}

	function load(principalId: PrincipalId): OpenAuthority {
		if (isClosed) throw new Error('Bun account authority runtime is closed');
		const cached = openAuthorities.get(principalId);
		if (cached) return cached;

		const database = new Database(databasePath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			database.run('PRAGMA journal_mode = WAL');
			const authority = openAccountRowAuthority({
				database: createBunSqliteAdapter(database),
				readDatabaseSize: () => readDatabaseSize(database),
			});
			const opened = { database, authority, hubs: new Map() };
			openAuthorities.set(principalId, opened);
			return opened;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	function readDatabaseSize(database: Database): number {
		const pageCount = database
			.query<{ page_count: number }, []>('PRAGMA page_count')
			.get()?.page_count;
		const pageSize = database
			.query<{ page_size: number }, []>('PRAGMA page_size')
			.get()?.page_size;
		if (pageCount === undefined || pageSize === undefined) {
			throw new Error('Could not read authority SQLite size');
		}
		return pageCount * pageSize;
	}

	function hub(
		principalId: PrincipalId,
		workspaceId: string,
		address: RowAddress,
	): ReturnType<typeof createDocumentHubCore> {
		const opened = load(principalId);
		const key = addressKey(workspaceId, address);
		let documentHub = opened.hubs.get(key);
		if (!documentHub) {
			documentHub = createDocumentHubCore({
				address,
				store: opened.authority.workspace(workspaceId).documents,
			});
			opened.hubs.set(key, documentHub);
		}
		return documentHub;
	}

	function socketAdapter(
		socket: ServerWebSocket<BunWorkspaceDocumentSocketData>,
	): DocumentHubSocket {
		let adapter = socketAdapters.get(socket);
		if (!adapter) {
			adapter = {
				send: (frame) => socket.send(encodeDocumentFrame(frame)),
				close: (code, reason) => socket.close(code, reason),
			};
			socketAdapters.set(socket, adapter);
		}
		return adapter;
	}

	function disconnect(
		socket: ServerWebSocket<BunWorkspaceDocumentSocketData>,
	): void {
		activeSockets.delete(socket);
		if (socket.data.kind !== 'document' || !socket.data.connected) return;
		const opened = openAuthorities.get(socket.data.principalId);
		const key = addressKey(socket.data.workspaceId, socket.data.address);
		const documentHub = opened?.hubs.get(key);
		if (!documentHub) return;
		documentHub.disconnect(socketAdapter(socket));
		if (documentHub.connectionCount === 0) {
			opened?.hubs.delete(key);
		}
	}

	function deleteWorkspace(
		principalId: PrincipalId,
		workspaceId: string,
	): void {
		const opened = load(principalId);
		opened.authority.deleteWorkspace(workspaceId);
		for (const socket of activeSockets) {
			if (
				socket.data.kind !== 'document' ||
				socket.data.principalId !== principalId ||
				socket.data.workspaceId !== workspaceId
			) {
				continue;
			}
			disconnect(socket);
			socket.close(1000, 'not-live');
		}
		const keyPrefix = JSON.stringify([workspaceId]).slice(0, -1);
		for (const [key, documentHub] of opened.hubs) {
			if (!key.startsWith(keyPrefix)) continue;
			documentHub.closeAll();
			opened.hubs.delete(key);
		}
	}

	function deleteAccount(principalId: PrincipalId): void {
		if (isClosed) throw new Error('Bun account authority runtime is closed');
		for (const socket of [...activeSockets]) {
			if (
				socket.data.kind !== 'document' ||
				socket.data.principalId !== principalId
			) {
				continue;
			}
			disconnect(socket);
			socket.close(1000, 'not-live');
		}
		const opened = openAuthorities.get(principalId);
		if (opened) {
			for (const documentHub of opened.hubs.values()) documentHub.closeAll();
			opened.hubs.clear();
			opened.database.close();
			openAuthorities.delete(principalId);
		}
		// Remove authority.sqlite and its WAL sidecars; force keeps retries
		// idempotent. Deliberately not load(): resolving the path would recreate
		// the directory this operation exists to remove.
		rmSync(join(dir, 'principals', encodePathComponent(principalId)), {
			recursive: true,
			force: true,
		});
	}

	function acceptDocumentUpgrade(
		principalId: PrincipalId,
		input: {
			workspaceId: string;
			address: RowAddress;
			authorizationExpiresAt: number;
			request: Request;
		},
	): Response {
		if (!server) {
			return new Response('workspace document server not bound', {
				status: 500,
			});
		}
		load(principalId);
		const data: BunWorkspaceDocumentSocketData = {
			surface: 'workspace-document',
			kind: 'document',
			principalId,
			workspaceId: input.workspaceId,
			address: input.address,
			authorizationExpiresAt: input.authorizationExpiresAt,
			connected: false,
		};
		sanitizeUpgradeSubprotocols(input.request, DOCUMENT_SUBPROTOCOL);
		return server.upgrade(input.request, { data })
			? new Response(null)
			: new Response('expected a WebSocket upgrade', { status: 426 });
	}

	const authorities: AccountAuthorities = {
		// Every operation re-enters load(principalId) so the closed-state guard
		// keeps firing even when a handle is held across an awaited admission step.
		authority(principalId): AccountAuthority {
			return {
				async hasReplica(workspaceId, replicaId) {
					return load(principalId)
						.authority.workspace(workspaceId)
						.hasReplica(replicaId);
				},
				async push(workspaceId, request) {
					const opened = load(principalId);
					const authority = opened.authority.workspace(workspaceId);
					const response = authority.push(request);
					if (response.result === 'accepted') {
						for (const intent of request.intents) {
							if (intent.kind !== 'delete') continue;
							const address = { table: intent.table, rowId: intent.rowId };
							const key = addressKey(workspaceId, address);
							const documentHub = opened.hubs.get(key);
							if (documentHub) {
								documentHub.closeAll();
								opened.hubs.delete(key);
							}
						}
						runCurrentStateTransportCompaction(
							authority.compactThrough,
							response.receipt,
						);
					}
					return response;
				},
				async pull(workspaceId, request) {
					return load(principalId)
						.authority.workspace(workspaceId)
						.pull(request);
				},
				async acquire(workspaceId, request) {
					return load(principalId)
						.authority.workspace(workspaceId)
						.acquire(request);
				},
				async deleteWorkspace(workspaceId) {
					deleteWorkspace(principalId, workspaceId);
				},
				async deleteAccount() {
					deleteAccount(principalId);
				},
				async databaseSize() {
					return readDatabaseSize(load(principalId).database);
				},
				acceptDocumentUpgrade(input) {
					return acceptDocumentUpgrade(principalId, input);
				},
			};
		},
		rejectDocumentUpgrade({ request, code, reason }) {
			if (!server) {
				return new Response('workspace document server not bound', {
					status: 500,
				});
			}
			const data: BunWorkspaceDocumentSocketData = {
				surface: 'workspace-document',
				kind: 'reject',
				code,
				reason,
			};
			sanitizeUpgradeSubprotocols(request, DOCUMENT_SUBPROTOCOL);
			return server.upgrade(request, { data })
				? new Response(null)
				: new Response(reason, { status: code >= 4500 ? 503 : 401 });
		},
	};

	const websocket: WebSocketHandler<BunWorkspaceDocumentSocketData> = {
		open(socket) {
			if (socket.data.kind === 'reject') {
				socket.close(socket.data.code, socket.data.reason);
				return;
			}
			activeSockets.add(socket);
			if (Date.now() >= socket.data.authorizationExpiresAt) {
				socket.close(1000, 'credential-expired');
			}
		},
		message(socket, message) {
			if (socket.data.kind !== 'document') return;
			if (Date.now() >= socket.data.authorizationExpiresAt) {
				disconnect(socket);
				socket.close(1000, 'credential-expired');
				return;
			}
			try {
				if (typeof message === 'string') {
					throw new TypeError('Document frames are binary');
				}
				const frame = decodeDocumentFrame(new Uint8Array(message));
				const documentHub = hub(
					socket.data.principalId,
					socket.data.workspaceId,
					socket.data.address,
				);
				if (!socket.data.connected) {
					if (frame.kind !== 'sync-request') {
						throw new TypeError('First document frame must be sync-request');
					}
					if (documentHub.connect(socketAdapter(socket), frame.stateVector)) {
						socket.data.connected = true;
					}
					return;
				}
				if (frame.kind === 'sync-request') {
					throw new TypeError('Document handshake is already complete');
				}
				documentHub.receive(socketAdapter(socket), frame);
			} catch {
				disconnect(socket);
				socket.close(1002, 'invalid-document-frame');
			}
		},
		close: disconnect,
	};

	const expirySweep = setInterval(() => {
		const now = Date.now();
		for (const socket of activeSockets) {
			if (
				socket.data.kind === 'document' &&
				now >= socket.data.authorizationExpiresAt
			) {
				disconnect(socket);
				socket.close(1000, 'credential-expired');
			}
		}
	}, 60_000);
	expirySweep.unref();

	return {
		authorities,
		websocket,
		bindServer(bound: Server<BunWorkspaceDocumentSocketData>): void {
			server = bound;
		},
		close(): void {
			if (isClosed) return;
			isClosed = true;
			clearInterval(expirySweep);
			for (const socket of [...activeSockets]) {
				disconnect(socket);
				socket.close(1001, 'server-shutdown');
			}
			for (const { database } of openAuthorities.values()) database.close();
			openAuthorities.clear();
		},
	};
}

export type BunAccountAuthorityRuntime = ReturnType<
	typeof createBunAccountAuthorityRuntime
>;
