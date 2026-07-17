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
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';

import {
	accountPersistenceKey,
	devicePersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import { mergeDocumentUpdates } from './canonical-documents.js';
import {
	addCanonicalWorkspace,
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import { createWorkspaceRuntime } from './runtime.js';

const ownedRoots = new Set<string>();

export type BunWorkspaceAccount = WorkspaceAccount<
	(
		workspaceId: string,
	) => CanonicalReplicaTransport | Promise<CanonicalReplicaTransport>
>;

export type BunWorkspaceRuntimeOptions = {
	storageRoot: string;
	onRecordsChanged?(workspaceId: string): void;
	onSyncError?(cause: unknown, workspaceId: string): void;
	recordPollIntervalMs?: number;
};

export function createDeviceBunWorkspaceRuntime(
	options: BunWorkspaceRuntimeOptions,
) {
	return createBunRuntimeWithPersistence({
		...options,
		persistenceKey: devicePersistenceKey(),
	});
}

export function createAccountBunWorkspaceRuntime({
	account,
	...options
}: BunWorkspaceRuntimeOptions & { account: BunWorkspaceAccount }) {
	return createBunRuntimeWithPersistence({
		...options,
		persistenceKey: accountPersistenceKey(account),
		additionSourcePersistenceKey: devicePersistenceKey(),
		recordTransport: account.transport,
	});
}

/** Open a Bun runtime whose `open()` eagerly acquires its SQLite owner. */
function createBunRuntimeWithPersistence({
	persistenceKey,
	additionSourcePersistenceKey,
	storageRoot,
	recordTransport,
	onRecordsChanged = () => undefined,
	onSyncError = () => undefined,
	recordPollIntervalMs = 30_000,
}: BunWorkspaceRuntimeOptions & {
	persistenceKey: string;
	additionSourcePersistenceKey?: string;
	recordTransport?: BunWorkspaceAccount['transport'];
}) {
	if (!Number.isFinite(recordPollIntervalMs) || recordPollIntervalMs <= 0) {
		throw new Error('Record poll interval must be a positive finite number');
	}
	const root = resolve(storageRoot, persistenceKey);
	const additionSourceRoot = additionSourcePersistenceKey
		? resolve(storageRoot, additionSourcePersistenceKey)
		: undefined;
	const claimedRoots = [
		...(additionSourceRoot ? [additionSourceRoot] : []),
		root,
	];
	for (const claimed of claimedRoots) {
		if (ownedRoots.has(claimed)) {
			throw new Error(
				`Workspace runtime storage already has an owner: ${claimed}`,
			);
		}
	}
	for (const claimed of claimedRoots) ownedRoots.add(claimed);
	try {
		mkdirSync(root, { recursive: true });
		bindPersistenceIdentity(root, persistenceKey);
	} catch (cause) {
		for (const claimed of claimedRoots) ownedRoots.delete(claimed);
		throw cause;
	}

	const runtime = createWorkspaceRuntime({
		async openWorkspaceOwner(workspaceId, signal) {
			const path = join(root, `${workspaceId}.records.sqlite3`);
			const additionSourcePath = additionSourceRoot
				? join(additionSourceRoot, `${workspaceId}.records.sqlite3`)
				: undefined;
			let database: Database | undefined;
			try {
				database = new Database(path, { create: true });
				database.exec('PRAGMA busy_timeout = 5000');
				database.exec('PRAGMA journal_mode = WAL');
				const sqlite = createBunSqliteAdapter(database);
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
					return {
						sqlite,
						onLocalCommit() {
							queueMicrotask(emitRecordsChanged);
						},
						async [Symbol.asyncDispose]() {
							ownerDisposed = true;
							database?.close();
						},
					};
				}

				const deletionListeners = new Set<
					(addresses: { table: string; rowId: string }[]) => void
				>();
				const baselineListeners = new Set<() => void>();
				const cancellableTransport: CanonicalReplicaTransport = {
					enroll: (request) => abortable(transport.enroll(request), signal),
					sync: (request) => abortable(transport.sync(request), signal),
					baselineScan: (request) =>
						abortable(transport.baselineScan(request), signal),
				};
				const replica = createCanonicalReplica({
					sqlite,
					transport: cancellableTransport,
					codec: { mergeUpdates: mergeDocumentUpdates },
					onRemoteCommit() {
						emitRecordsChanged();
					},
					onRowsDeleted(addresses) {
						for (const listener of deletionListeners) listener(addresses);
					},
					onBaselinePromoted() {
						for (const listener of baselineListeners) listener();
					},
				});
				if (additionSourcePath && existsSync(additionSourcePath)) {
					const sourceDatabase = new Database(additionSourcePath, {
						readonly: true,
					});
					try {
						addCanonicalWorkspace({
							source: createBunSqliteAdapter(sourceDatabase),
							admitIntent: replica.admit,
							mergeUpdates: mergeDocumentUpdates,
						});
					} finally {
						sourceDatabase.close();
					}
					deleteWorkspaceFiles(additionSourcePath);
				}
				let activeSynchronization: Promise<unknown> | undefined;
				const synchronize = (): void => {
					if (ownerDisposed) return;
					const pending = replica.synchronize().catch((cause) => {
						if (!signal.aborted) reportSyncError(cause);
					});
					const synchronization = pending.finally(() => {
						if (activeSynchronization === synchronization) {
							activeSynchronization = undefined;
						}
					});
					activeSynchronization = synchronization;
				};
				const poll = setInterval(synchronize, recordPollIntervalMs);
				poll.unref();
				queueMicrotask(synchronize);
				return {
					sqlite,
					admitIntent(intent) {
						replica.admit(intent);
						queueMicrotask(() => {
							emitRecordsChanged();
							synchronize();
						});
					},
					readCurrentRow: replica.readCurrentRow,
					readCurrentDocumentParts: replica.readCurrentDocumentParts,
					subscribeRowsDeleted(
						listener: (addresses: { table: string; rowId: string }[]) => void,
					) {
						deletionListeners.add(listener);
						return () => deletionListeners.delete(listener);
					},
					subscribeBaselinePromoted(listener: () => void) {
						baselineListeners.add(listener);
						return () => baselineListeners.delete(listener);
					},
					async [Symbol.asyncDispose]() {
						ownerDisposed = true;
						clearInterval(poll);
						await activeSynchronization;
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
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			isDisposed = true;
			try {
				await runtime[Symbol.asyncDispose]();
			} finally {
				for (const claimed of claimedRoots) ownedRoots.delete(claimed);
			}
		},
	});
}

export type BunWorkspaceRuntime = ReturnType<
	typeof createDeviceBunWorkspaceRuntime
>;

function deleteWorkspaceFiles(path: string): void {
	rmSync(`${path}-wal`, { force: true });
	rmSync(`${path}-shm`, { force: true });
	rmSync(path, { force: true });
}

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
