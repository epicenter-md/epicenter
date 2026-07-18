import type { SqliteDatabase } from '@epicenter/sqlite';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import type {
	BrowserRecordOperation,
	BrowserRuntimeMessage,
	BrowserWorkerInbound,
	BrowserWorkspaceManifest,
} from './browser-runtime-protocol.js';
import {
	acquireBrowserStorageLease,
	type BrowserStorageLease,
} from './browser-storage-lease.js';
import {
	captureLocalWorkspace,
	deleteLocalWorkspace,
	logicalWorkspaceIntents,
} from './canonical-addition.js';
import { mergeDocumentUpdates } from './canonical-documents.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import { type CanonicalRows, createCanonicalRows } from './canonical-rows.js';
import {
	type CanonicalSyncSupervisor,
	createCanonicalSyncSupervisor,
} from './canonical-sync-supervisor.js';
import {
	type CurrentStateReplica,
	type CurrentStateReplicaTransport,
	createCurrentStateReplica,
} from './current-state-replica.js';
import {
	CurrentStateTransportInterruption,
	classifyCurrentStateTransport,
} from './current-state-transport.js';
import type { KvDefinitions } from './kv-definition.js';
import { defineTable, type TableLensDefinitions } from './lens-definition.js';
import {
	initializeLocalWorkspaceStorage,
	readLocalRow,
} from './local-workspace-storage.js';

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
	sqlite: SqliteDatabase;
	records: CanonicalRows;
	kv: CanonicalKv<KvDefinitions>;
	replica?: CurrentStateReplica;
	sync?: CanonicalSyncSupervisor;
	/** Held until Worker termination so this storage has one SQLite owner. */
	retainedLease: BrowserStorageLease;
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
			let retainedLease: BrowserStorageLease | undefined;
			let database: Database | undefined;
			try {
				retainedLease = await acquireBrowserStorageLease(
					navigator.locks,
					manifest.storageKey,
				);
				sqliteModule ??= await sqlite3InitModule();
				if (!sqliteModule.capi.sqlite3_vfs_find('opfs')) {
					throw new Error('SQLite OPFS VFS is unavailable');
				}
				database = new sqliteModule.oo1.DB(
					`/epicenter-${manifest.storageKey}.sqlite3`,
					'c',
					'opfs',
				);
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
				if (!manifest.rowSync) initializeLocalWorkspaceStorage(sqlite);
				const replica = manifest.rowSync
					? createCurrentStateReplica({
							sqlite,
							transport: createRecordTransport(manifest.workspaceId),
							onRemoteCommit() {
								scope.postMessage({
									type: 'records-changed',
									workspaceId: manifest.workspaceId,
								});
							},
							onRowsDeleted(addresses) {
								scope.postMessage({
									type: 'rows-deleted',
									workspaceId: manifest.workspaceId,
									addresses,
								});
							},
						})
					: undefined;
				const records = createCanonicalRows(sqlite, definitions, {
					admitIntent: replica?.admit,
					readCurrentRow: replica?.readCurrentRow,
				});
				const kv = createCanonicalKv(
					sqlite,
					(manifest.kv ?? {}) as KvDefinitions,
					{
						admitIntent: replica?.admit,
						readCurrentRow: replica?.readCurrentRow,
					},
				);
				const sync = replica
					? createCanonicalSyncSupervisor({
							driver: classifyCurrentStateTransport(replica),
							pollIntervalMs: manifest.rowSync?.intervalMs,
							onFatal(cause) {
								scope.postMessage({
									type: 'background-error',
									workspaceId: manifest.workspaceId,
									name: cause instanceof Error ? cause.name : 'Error',
									message:
										cause instanceof Error ? cause.message : String(cause),
								});
							},
						})
					: undefined;
				sync?.onStatusChange((status) => {
					scope.postMessage({
						type: 'sync-status',
						workspaceId: manifest.workspaceId,
						status,
					});
				});
				return {
					manifest,
					database,
					sqlite,
					records,
					kv,
					replica,
					sync,
					retainedLease,
				};
			} catch (cause) {
				const cleanupFailures: unknown[] = [];
				try {
					database?.close();
				} catch (cleanupCause) {
					cleanupFailures.push(cleanupCause);
				}
				try {
					await retainedLease?.release();
				} catch (cleanupCause) {
					cleanupFailures.push(cleanupCause);
				}
				if (cleanupFailures.length > 0) {
					throw new AggregateError(
						[cause, ...cleanupFailures],
						'Browser workspace initialization and cleanup failed',
					);
				}
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
		JSON.stringify(state.manifest.rowSync) !== JSON.stringify(manifest.rowSync)
	) {
		throw new Error(
			`Workspace '${manifest.workspaceId}' is already bound to another release-local lens in this Worker`,
		);
	}
	return state;
}

function createRecordTransport(
	workspaceId: string,
): CurrentStateReplicaTransport {
	const post = (
		action: 'push' | 'pull' | 'acquire',
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
		push: (request) => post('push', request),
		pull: (request) => post('pull', request),
		acquire: (request) => post('acquire', request),
	};
}

function tableFor(records: CanonicalRows, name: string) {
	const table = records.tables[name];
	if (!table) throw new Error(`Unknown canonical table '${name}'`);
	return table;
}

async function execute(
	state: OpenedRecords,
	operation: BrowserRecordOperation,
) {
	const { records } = state;
	switch (operation.kind) {
		case 'open':
			return { isReady: state.replica?.isReady() ?? true };
		case 'get':
			return tableFor(records, operation.table).get(operation.id);
		case 'kv-get':
			return state.kv.get(operation.key);
		case 'kv-set':
			return state.kv.set(operation.key, operation.value as never);
		case 'kv-unset':
			state.kv.unset(operation.key);
			return undefined;
		case 'read-current-row':
			return state.replica
				? state.replica.readCurrentRow(operation.table, operation.rowId)
				: readLocalRow(state.sqlite, operation.table, operation.rowId);
		case 'sync-settle':
			throw new Error('Sync settlement must not block the Worker request tail');
		case 'sync-start-fresh':
			throw new Error(
				'Fresh-lineage acquisition must not block the Worker request tail',
			);
		case 'sync-capture-recovery':
			if (!state.sync) {
				throw new Error('Local-only workspace has no synchronization');
			}
			return state.sync.captureRecovery();
		case 'logical-capture':
			if (state.replica) {
				throw new Error('Only Device workspaces expose logical capture');
			}
			return captureLocalWorkspace(state.sqlite, mergeDocumentUpdates);
		case 'capture-visible':
			if (!state.replica) {
				throw new Error('Only Account workspaces expose visible capture');
			}
			return state.replica.captureVisible();
		case 'capture-confirmed':
			if (!state.replica) {
				throw new Error('Only Account workspaces expose confirmed capture');
			}
			return state.replica.captureConfirmed();
		case 'logical-add':
			if (!state.replica) {
				throw new Error('Only Account workspaces accept logical additions');
			}
			state.replica.admitMany(logicalWorkspaceIntents(operation.copy));
			return undefined;
		case 'logical-delete':
			if (state.replica) {
				throw new Error('Only Device workspaces expose logical deletion');
			}
			deleteLocalWorkspace(state.sqlite);
			return undefined;
		case 'list':
			return tableFor(records, operation.table).list();
		case 'create':
			return tableFor(records, operation.table).create(operation.input);
		case 'update':
			return tableFor(records, operation.table).update(
				operation.id,
				operation.changes,
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
			let cause: Error;
			if (message.pendingReason) {
				cause = new CurrentStateTransportInterruption(
					message.pendingReason,
					message.message,
				);
			} else {
				cause = new Error(message.message);
				cause.name = message.name;
			}
			pending.reject(cause);
		}
		return;
	}
	const request = message;
	tail = tail.then(async () => {
		try {
			const state = await openRecords(request.manifest);
			if (request.operation.kind === 'sync-settle') {
				if (!state.sync) {
					throw new Error('Local-only workspace has no synchronization');
				}
				void state.sync.settle().then(
					(value) => {
						scope.postMessage({ type: 'result', id: request.id, value });
					},
					(cause) => {
						scope.postMessage({
							type: 'error',
							id: request.id,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						});
					},
				);
				return;
			}
			if (request.operation.kind === 'sync-start-fresh') {
				if (!state.sync) {
					throw new Error('Local-only workspace has no synchronization');
				}
				void state.sync.startFresh().then(
					() => {
						scope.postMessage({
							type: 'result',
							id: request.id,
							value: undefined,
						});
					},
					(cause) => {
						scope.postMessage({
							type: 'error',
							id: request.id,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						});
					},
				);
				return;
			}
			const value = await execute(state, request.operation);
			scope.postMessage({ type: 'result', id: request.id, value });
			if (
				request.operation.kind === 'create' ||
				request.operation.kind === 'update' ||
				request.operation.kind === 'delete' ||
				request.operation.kind === 'kv-set' ||
				request.operation.kind === 'kv-unset' ||
				request.operation.kind === 'logical-add' ||
				request.operation.kind === 'logical-delete'
			) {
				scope.postMessage({
					type: 'records-changed',
					workspaceId: request.manifest.workspaceId,
				});
				state.sync?.wake();
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
