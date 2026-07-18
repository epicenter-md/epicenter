import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RowAddress } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { WorkspaceDocuments } from '../document-hub/contracts.js';
import {
	createDocumentHubCore,
	type DocumentHubSocket,
} from '../document-hub/core.js';
import { sanitizeUpgradeSubprotocols } from '../sanitize-upgrade-subprotocols.js';
import {
	type AccountRowAuthority,
	openAccountRowAuthority,
} from '../workspace-authority/authority.js';
import { runCurrentStateTransportCompaction } from './current-state-compaction.js';
import type {
	CurrentStateRecords,
	CurrentStateRecordsPartition,
} from './current-state-contracts.js';

type OpenAuthority = {
	database: Database;
	authority: AccountRowAuthority;
	hubs: Map<string, ReturnType<typeof createDocumentHubCore>>;
};

export type BunWorkspaceDocumentSocketData =
	| {
			surface: 'workspace-document';
			kind: 'document';
			partition: CurrentStateRecordsPartition;
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

function databasePath(
	dir: string,
	principalId: CurrentStateRecordsPartition['principalId'],
): string {
	const principalDir = join(
		dir,
		'principals',
		encodePathComponent(principalId),
	);
	mkdirSync(principalDir, { recursive: true });
	return join(principalDir, 'authority.sqlite');
}

/** Open persistent current-state account authorities in one Bun directory. */
export function createCurrentStateBunRecords({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<string, OpenAuthority>();
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

	function load(
		principalId: CurrentStateRecordsPartition['principalId'],
	): OpenAuthority {
		if (isClosed) throw new Error('Bun account authority backend is closed');
		const cached = authorities.get(principalId);
		if (cached) return cached;

		const database = new Database(databasePath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			database.run('PRAGMA journal_mode = WAL');
			const authority = openAccountRowAuthority({
				database: createBunSqliteAdapter(database),
				readDatabaseSize: () => {
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
				},
			});
			const opened = { database, authority, hubs: new Map() };
			authorities.set(principalId, opened);
			return opened;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	function hub(
		partition: CurrentStateRecordsPartition,
		address: RowAddress,
	): ReturnType<typeof createDocumentHubCore> {
		const opened = load(partition.principalId);
		const key = addressKey(partition.workspaceId, address);
		let documentHub = opened.hubs.get(key);
		if (!documentHub) {
			documentHub = createDocumentHubCore({
				address,
				store: opened.authority.workspace(partition.workspaceId).documents,
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
		const opened = authorities.get(socket.data.partition.principalId);
		const key = addressKey(
			socket.data.partition.workspaceId,
			socket.data.address,
		);
		const documentHub = opened?.hubs.get(key);
		if (!documentHub) return;
		documentHub.disconnect(socketAdapter(socket));
		if (documentHub.connectionCount === 0) {
			opened?.hubs.delete(key);
		}
	}

	const records: CurrentStateRecords = {
		async deleteWorkspace(partition) {
			const opened = load(partition.principalId);
			opened.authority.deleteWorkspace(partition.workspaceId);
			for (const socket of activeSockets) {
				if (
					socket.data.kind !== 'document' ||
					socket.data.partition.principalId !== partition.principalId ||
					socket.data.partition.workspaceId !== partition.workspaceId
				) {
					continue;
				}
				disconnect(socket);
				socket.close(1000, 'not-live');
			}
			const keyPrefix = JSON.stringify([partition.workspaceId]).slice(0, -1);
			for (const [key, documentHub] of opened.hubs) {
				if (!key.startsWith(keyPrefix)) continue;
				documentHub.closeAll();
				opened.hubs.delete(key);
			}
		},
		async hasReplica(partition, replicaId) {
			return load(partition.principalId)
				.authority.workspace(partition.workspaceId)
				.hasReplica(replicaId);
		},
		async push(partition, request) {
			const opened = load(partition.principalId);
			const authority = opened.authority.workspace(partition.workspaceId);
			const response = authority.push(request);
			if (response.result === 'accepted') {
				for (const intent of request.intents) {
					if (intent.kind !== 'delete') continue;
					const address = { table: intent.table, rowId: intent.rowId };
					const key = addressKey(partition.workspaceId, address);
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
		async pull(partition, request) {
			return load(partition.principalId)
				.authority.workspace(partition.workspaceId)
				.pull(request);
		},
		async acquire(partition, request) {
			return load(partition.principalId)
				.authority.workspace(partition.workspaceId)
				.acquire(request);
		},
	};

	const documents: WorkspaceDocuments = {
		handleUpgrade({ partition, address, authorizationExpiresAt, request }) {
			if (!server) {
				return new Response('workspace document server not bound', {
					status: 500,
				});
			}
			load(partition.principalId);
			const data: BunWorkspaceDocumentSocketData = {
				surface: 'workspace-document',
				kind: 'document',
				partition,
				address,
				authorizationExpiresAt,
				connected: false,
			};
			sanitizeUpgradeSubprotocols(request, DOCUMENT_SUBPROTOCOL);
			return server.upgrade(request, { data })
				? new Response(null)
				: new Response('expected a WebSocket upgrade', { status: 426 });
		},
		rejectUpgrade({ request, code, reason }) {
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
				const documentHub = hub(socket.data.partition, socket.data.address);
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
		records,
		documents,
		websocket,
		bindServer(bound: Server<BunWorkspaceDocumentSocketData>): void {
			server = bound;
		},
		close(): void {
			if (isClosed) return;
			isClosed = true;
			clearInterval(expirySweep);
			for (const { database } of authorities.values()) database.close();
			authorities.clear();
		},
	};
}

export type CurrentStateBunRecords = ReturnType<
	typeof createCurrentStateBunRecords
>;
