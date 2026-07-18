import { Database } from 'bun:sqlite';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256Hex } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { createNativeSqliteDocumentStore } from '../document-provider/native-sqlite.js';
import type { DocumentStore } from '../document-provider/persistence.js';
import {
	attachAuthenticatedDocumentConnection,
	rowDocumentWebSocketUrl,
} from '../document-provider/connection/index.js';

import {
	accountPersistenceKey,
	devicePersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import {
	captureLocalWorkspace,
	deleteLocalWorkspace,
	type LogicalWorkspaceCopy,
	logicalWorkspaceIntents,
} from './canonical-addition.js';
import { mergeDocumentUpdates } from './canonical-documents.js';
import { createCanonicalSyncSupervisor } from './canonical-sync-supervisor.js';
import {
	type CurrentStateReplicaTransport,
	createCurrentStateReplica,
} from './current-state-replica.js';
import { classifyCurrentStateTransport } from './current-state-transport.js';
import { initializeLocalWorkspaceStorage } from './local-workspace-storage.js';
import { createWorkspaceRuntime } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

const ownedRoots = new Set<string>();

export type BunWorkspaceAccount = WorkspaceAccount<
	(
		workspaceId: string,
	) => CurrentStateReplicaTransport | Promise<CurrentStateReplicaTransport>
>;

export type BunWorkspaceRuntimeOptions = {
	storageRoot: string;
	onRecordsChanged?(workspaceId: string): void;
	onSyncError?(cause: unknown, workspaceId: string): void;
	recordPollIntervalMs?: number;
	/** Native auth-owned document transport. Omit only for Device workspaces. */
	documentTransport?: {
		baseUrl: string;
		openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	};
};

export function createDeviceBunWorkspaceRuntime(
	options: BunWorkspaceRuntimeOptions,
) {
	const runtime = createBunRuntimeWithPersistence({
		...options,
		persistenceKey: devicePersistenceKey(),
	});
	return Object.freeze({
		open: runtime.open,
		async capture(definition: WorkspaceDefinition) {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return runtime.captureLocal(definition.id);
		},
		async delete(definition: WorkspaceDefinition) {
			await runtime.open(definition);
			await runtime.deleteLocal(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

export function createAccountBunWorkspaceRuntime({
	account,
	...options
}: BunWorkspaceRuntimeOptions & { account: BunWorkspaceAccount }) {
	const runtime = createBunRuntimeWithPersistence({
		...options,
		persistenceKey: accountPersistenceKey(account),
		recordTransport: account.transport,
	});
	return Object.freeze({
		open: runtime.open,
		async add(definition: WorkspaceDefinition, copy: LogicalWorkspaceCopy) {
			await runtime.open(definition);
			await runtime.whenReady(definition.id);
			await runtime.addToAccount(definition.id, copy);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

/** Open a Bun runtime whose `open()` eagerly acquires its SQLite owner. */
function createBunRuntimeWithPersistence({
	persistenceKey,
	storageRoot,
	recordTransport,
	onRecordsChanged = () => undefined,
	onSyncError = () => undefined,
	recordPollIntervalMs = 30_000,
	documentTransport,
}: BunWorkspaceRuntimeOptions & {
	persistenceKey: string;
	recordTransport?: BunWorkspaceAccount['transport'];
}) {
	if (!Number.isFinite(recordPollIntervalMs) || recordPollIntervalMs <= 0) {
		throw new Error('Record poll interval must be a positive finite number');
	}
	const root = resolve(storageRoot, persistenceKey);
	const localWorkspaces = new Map<
		string,
		{
			sqlite: ReturnType<typeof createBunSqliteAdapter>;
			documents: DocumentStore;
			notifyDeleted(addresses: { table: string; rowId: string }[]): void;
			emitChanged(): void;
		}
	>();
	const accountWorkspaces = new Map<
		string,
		{
			replica: ReturnType<typeof createCurrentStateReplica>;
			documents: DocumentStore;
			wake(): void;
			emitChanged(): void;
		}
	>();
	if (ownedRoots.has(root)) {
		throw new Error(`Workspace runtime storage already has an owner: ${root}`);
	}
	ownedRoots.add(root);
	try {
		mkdirSync(root, { recursive: true });
		bindPersistenceIdentity(root, persistenceKey);
	} catch (cause) {
		ownedRoots.delete(root);
		throw cause;
	}

	const runtime = createWorkspaceRuntime({
		async openWorkspaceOwner(workspaceId, signal) {
			const path = join(root, `${workspaceId}.records.sqlite3`);
			let database: Database | undefined;
			try {
				database = new Database(path, { create: true });
				database.exec('PRAGMA busy_timeout = 5000');
				database.exec('PRAGMA journal_mode = WAL');
				const sqlite = createBunSqliteAdapter(database);
				const documents = createNativeSqliteDocumentStore({ database: sqlite });
				const transport = await abortable(
					Promise.resolve(recordTransport?.(workspaceId)),
					signal,
				);
				let ownerDisposed = false;
				const reportSyncError = (cause: unknown): void => {
					try {
						onSyncError(cause, workspaceId);
					} catch {
						// Reporting cannot become another synchronization failure.
					}
				};
				const emitRecordsChanged = (): void => {
					if (ownerDisposed) return;
					try {
						onRecordsChanged(workspaceId);
					} catch (cause) {
						reportSyncError(cause);
					}
				};
				if (!transport) {
					initializeLocalWorkspaceStorage(sqlite);
					const deletionListeners = new Set<
						(addresses: { table: string; rowId: string }[]) => void
					>();
					localWorkspaces.set(workspaceId, {
						sqlite,
						documents,
						notifyDeleted(addresses) {
							for (const listener of deletionListeners) {
								try {
									listener(addresses);
								} catch (cause) {
									reportSyncError(cause);
								}
							}
						},
						emitChanged: emitRecordsChanged,
					});
					return {
						sqlite,
						documentStore: documents,
						onLocalCommit() {
							queueMicrotask(emitRecordsChanged);
						},
						subscribeRowsDeleted(listener) {
							deletionListeners.add(listener);
							return () => deletionListeners.delete(listener);
						},
						async [Symbol.asyncDispose]() {
							ownerDisposed = true;
							localWorkspaces.delete(workspaceId);
							database?.close();
						},
					};
				}

				const deletionListeners = new Set<
					(addresses: { table: string; rowId: string }[]) => void
				>();
				const cancellableTransport: CurrentStateReplicaTransport = {
					push: (request) => abortable(transport.push(request), signal),
					pull: (request) => abortable(transport.pull(request), signal),
					acquire: (request) => abortable(transport.acquire(request), signal),
				};
				const replica = createCurrentStateReplica({
					sqlite,
					transport: cancellableTransport,
					onRemoteCommit() {
						emitRecordsChanged();
					},
					onRowsDeleted(addresses) {
						for (const listener of deletionListeners) listener(addresses);
					},
				});
				const supervisor = createCanonicalSyncSupervisor({
					driver: classifyCurrentStateTransport(replica),
					pollIntervalMs: recordPollIntervalMs,
					onFatal(cause) {
						if (!signal.aborted) reportSyncError(cause);
					},
				});
				accountWorkspaces.set(workspaceId, {
					replica,
					documents,
					wake: supervisor.wake,
					emitChanged: emitRecordsChanged,
				});
				return {
					sqlite,
					documentStore: documents,
					...(documentTransport
						? {
								connectDocument(address, document) {
									const connection = attachAuthenticatedDocumentConnection({
										document,
										url: rowDocumentWebSocketUrl({
											baseUrl: documentTransport.baseUrl,
											workspaceId,
											address,
										}),
										openWebSocket: documentTransport.openWebSocket,
									});
									return {
										connection,
										dispose: connection.dispose,
									};
								},
							}
						: {}),
					sync: supervisor,
					admitIntent(intent) {
						replica.admit(intent);
						queueMicrotask(() => {
							emitRecordsChanged();
							supervisor.wake();
						});
					},
					readCurrentRow: replica.readCurrentRow,
					subscribeRowsDeleted(
						listener: (addresses: { table: string; rowId: string }[]) => void,
					) {
						deletionListeners.add(listener);
						return () => deletionListeners.delete(listener);
					},
					async [Symbol.asyncDispose]() {
						ownerDisposed = true;
						accountWorkspaces.delete(workspaceId);
						await supervisor.dispose();
						database?.close();
					},
				};
			} catch (cause) {
				database?.close();
				throw cause;
			}
		},
	});

	let isDisposed = false;
	return Object.freeze({
		open: runtime.open,
		captureDurability: runtime.captureDurability,
		whenReady: runtime.whenReady,
		async captureLocal(workspaceId: string): Promise<LogicalWorkspaceCopy> {
			const state = localWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Device workspace '${workspaceId}' is not open`);
			const copy = captureLocalWorkspace(state.sqlite, mergeDocumentUpdates);
			return {
				...copy,
				rows: await Promise.all(
					copy.rows.map(async (row) => {
						const document = await state.documents.capture({
							table: row.table,
							rowId: row.rowId,
						});
						return document === undefined ? row : { ...row, document };
					}),
				),
			};
		},
		async deleteLocal(workspaceId: string): Promise<void> {
			const state = localWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Device workspace '${workspaceId}' is not open`);
			const addresses = captureLocalWorkspace(
				state.sqlite,
				mergeDocumentUpdates,
			).rows.map(({ table, rowId }) => ({ table, rowId }));
			deleteLocalWorkspace(state.sqlite);
			state.notifyDeleted(addresses);
			await state.documents.deleteAll();
			state.emitChanged();
		},
		async addToAccount(
			workspaceId: string,
			copy: LogicalWorkspaceCopy,
		): Promise<void> {
			const state = accountWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Account workspace '${workspaceId}' is not open`);
			state.replica.admitMany(logicalWorkspaceIntents(copy));
			for (const row of copy.rows) {
				if (row.document === undefined) continue;
				const document = new Y.Doc();
				const lease = state.documents.attach(
					{ table: row.table, rowId: row.rowId },
					document,
				);
				try {
					await lease.whenLoaded;
					Y.applyUpdateV2(document, row.document);
					await lease.whenDurable();
				} finally {
					await lease.dispose();
					document.destroy();
				}
			}
			queueMicrotask(() => {
				state.emitChanged();
				state.wake();
			});
		},
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			isDisposed = true;
			try {
				await runtime[Symbol.asyncDispose]();
			} finally {
				ownedRoots.delete(root);
			}
		},
	});
}

export type BunWorkspaceRuntime = ReturnType<
	typeof createDeviceBunWorkspaceRuntime
>;

function bindPersistenceIdentity(root: string, persistenceKey: string): void {
	const path = join(root, '.epicenter-runtime.json');
	const encoded = JSON.stringify({
		formatVersion: 1,
		persistenceHash: sha256Hex(persistenceKey),
	});
	if (existsSync(path)) {
		if (readFileSync(path, 'utf8') !== encoded) {
			throw new Error(
				'Workspace runtime storage belongs to another persistence identity',
			);
		}
		return;
	}
	writeFileAtomic(path, encoded);
}

function writeFileAtomic(path: string, value: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, value, { flag: 'wx' });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const abort = () => rejectPromise(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		promise.then(resolvePromise, rejectPromise).finally(() => {
			signal.removeEventListener('abort', abort);
		});
	});
}
