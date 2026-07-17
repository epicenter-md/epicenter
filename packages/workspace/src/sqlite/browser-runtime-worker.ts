import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/record-sync/browser';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import type {
	BrowserRecordOperation,
	BrowserRuntimeMessage,
	BrowserWorkerInbound,
	BrowserWorkspaceManifest,
} from './browser-runtime-protocol.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import {
	type CanonicalRecords,
	createCanonicalRecords,
} from './canonical-records.js';
import {
	type CanonicalReplica,
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import type { KvDefinitions } from './kv-definition.js';
import { defineTable, type TableLensDefinitions } from './lens-definition.js';

type WorkerScope = {
	postMessage(message: BrowserRuntimeMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: MessageEvent<BrowserWorkerInbound>) => void,
	): void;
};

type OpenedRecords = {
	manifest: BrowserWorkspaceManifest;
	database: Database;
	records: CanonicalRecords;
	kv: CanonicalKv<KvDefinitions>;
	replica?: CanonicalReplica;
};

const scope = self as unknown as WorkerScope;
const opened = new Map<string, Promise<OpenedRecords>>();
const transportRequests = new Map<
	number,
	{ resolve(value: unknown): void; reject(cause: unknown): void }
>();
let sqliteModule: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
let tail = Promise.resolve();
let transportId = 0;

async function openRecords(
	manifest: BrowserWorkspaceManifest,
): Promise<OpenedRecords> {
	let opening = opened.get(manifest.workspaceId);
	if (!opening) {
		opening = (async () => {
			sqliteModule ??= await sqlite3InitModule();
			if (!sqliteModule.capi.sqlite3_vfs_find('opfs')) {
				throw new Error('SQLite OPFS VFS is unavailable');
			}
			const database = new sqliteModule.oo1.DB(
				`/epicenter-${manifest.storageKey}.sqlite3`,
				'c',
				'opfs',
			);
			try {
				// EXTRA extends FULL by syncing rollback-journal deletion in DELETE
				// mode, strengthening the configured local commit boundary.
				database.exec(`
					PRAGMA busy_timeout = 5000;
					PRAGMA journal_mode = DELETE;
					PRAGMA synchronous = EXTRA;
					PRAGMA temp_store = MEMORY;
				`);
				const definitions = Object.fromEntries(
					Object.entries(manifest.tables).map(([name, lens]) => [
						name,
						defineTable({ fields: lens.fields, optional: lens.optional }),
					]),
				) as TableLensDefinitions;
				const sqlite = createBrowserSqliteAdapter(
					database as unknown as BrowserSqliteDatabase,
				);
				const replica = manifest.recordSync
					? createCanonicalReplica({
							sqlite,
							transport: createRecordTransport(manifest.workspaceId),
							sha256,
							onRemoteCommit() {
								scope.postMessage({
									type: 'records-changed',
									workspaceId: manifest.workspaceId,
								});
							},
						})
					: undefined;
				const records = createCanonicalRecords(sqlite, definitions, {
					admit: replica?.admit,
				});
				const kv = createCanonicalKv(
					sqlite,
					(manifest.kv ?? {}) as KvDefinitions,
					{ admit: replica?.admit },
				);
				if (replica) {
					synchronize(replica, manifest.workspaceId);
					setInterval(
						() => synchronize(replica, manifest.workspaceId),
						manifest.recordSync?.intervalMs,
					);
				}
				return {
					manifest,
					database,
					records,
					kv,
					replica,
				};
			} catch (cause) {
				database.close();
				throw cause;
			}
		})().catch((cause) => {
			opened.delete(manifest.workspaceId);
			throw cause;
		});
		opened.set(manifest.workspaceId, opening);
	}
	const state = await opening;
	if (
		state.manifest.storageKey !== manifest.storageKey ||
		JSON.stringify(state.manifest.tables) !== JSON.stringify(manifest.tables) ||
		JSON.stringify(state.manifest.kv) !== JSON.stringify(manifest.kv) ||
		JSON.stringify(state.manifest.recordSync) !==
			JSON.stringify(manifest.recordSync)
	) {
		throw new Error(
			`Workspace '${manifest.workspaceId}' is already bound to another release-local lens in this Worker`,
		);
	}
	return state;
}

function createRecordTransport(workspaceId: string): CanonicalReplicaTransport {
	const post = (
		action: 'sync' | 'snapshot-chunk',
		body: unknown,
	): Promise<unknown> => {
		const id = ++transportId;
		return new Promise((resolve, reject) => {
			transportRequests.set(id, { resolve, reject });
			scope.postMessage({
				type: 'transport-request',
				transportId: id,
				workspaceId,
				action,
				body,
			});
		});
	};
	return {
		sync: (request) => post('sync', request),
		snapshotChunk: (request) => post('snapshot-chunk', request),
	};
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function synchronize(replica: CanonicalReplica, workspaceId: string): void {
	void replica.synchronize().catch((cause) => {
		scope.postMessage({
			type: 'background-error',
			workspaceId,
			name: cause instanceof Error ? cause.name : 'Error',
			message: cause instanceof Error ? cause.message : String(cause),
		});
	});
}

function tableFor(records: CanonicalRecords, name: string) {
	const table = records.tables[name];
	if (!table) throw new Error(`Unknown canonical table '${name}'`);
	return table;
}

function execute(state: OpenedRecords, operation: BrowserRecordOperation) {
	const { records } = state;
	switch (operation.kind) {
		case 'get':
			return tableFor(records, operation.table).get(operation.id);
		case 'kv-get':
			return state.kv.get(operation.key);
		case 'kv-set':
			return state.kv.set(operation.key, operation.value as never);
		case 'kv-unset':
			state.kv.unset(operation.key);
			return undefined;
		case 'scan':
			return tableFor(records, operation.table).scan(operation.options);
		case 'create':
			return tableFor(records, operation.table).create(operation.input);
		case 'patch':
			return tableFor(records, operation.table).patch(
				operation.id,
				operation.patch,
			);
		case 'delete':
			tableFor(records, operation.table).delete(operation.id);
			return undefined;
		case 'sql':
			return records.sql(
				operation.query,
				operation.parameters,
				operation.resultSchema,
			);
		default:
			return operation satisfies never;
	}
}

scope.addEventListener('message', (event) => {
	const message = event.data;
	if ('type' in message) {
		const pending = transportRequests.get(message.transportId);
		if (!pending) return;
		transportRequests.delete(message.transportId);
		if (message.type === 'transport-result') pending.resolve(message.value);
		else {
			const cause = new Error(message.message);
			cause.name = message.name;
			pending.reject(cause);
		}
		return;
	}
	const request = message;
	tail = tail.then(async () => {
		try {
			const state = await openRecords(request.manifest);
			const value = execute(state, request.operation);
			scope.postMessage({ type: 'result', id: request.id, value });
			if (
				request.operation.kind === 'create' ||
				request.operation.kind === 'patch' ||
				request.operation.kind === 'delete' ||
				request.operation.kind === 'kv-set' ||
				request.operation.kind === 'kv-unset'
			) {
				scope.postMessage({
					type: 'records-changed',
					workspaceId: request.manifest.workspaceId,
				});
				if (state.replica) {
					synchronize(state.replica, request.manifest.workspaceId);
				}
			}
		} catch (cause) {
			scope.postMessage({
				type: 'error',
				id: request.id,
				name: cause instanceof Error ? cause.name : 'Error',
				message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	});
});

scope.postMessage({ type: 'ready' });
