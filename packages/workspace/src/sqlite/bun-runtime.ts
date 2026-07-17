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
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { sha256Hex } from '../shared/sha256.js';
import { mergeDocumentUpdates } from './canonical-documents.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import { createWorkspaceRuntime } from './runtime.js';

const ownedRoots = new Set<string>();

/** Open a Bun runtime whose workspace owners are lazy SQLite files. */
export function createBunWorkspaceRuntime({
	authorityKey,
	storageRoot,
	recordTransport,
	onRecordsChanged = () => undefined,
	onSyncError = () => undefined,
	recordPollIntervalMs = 30_000,
}: {
	authorityKey: string;
	storageRoot: string;
	recordTransport?(
		workspaceId: string,
	):
		| CanonicalReplicaTransport
		| undefined
		| Promise<CanonicalReplicaTransport | undefined>;
	onRecordsChanged?(workspaceId: string): void;
	onSyncError?(cause: unknown, workspaceId: string): void;
	recordPollIntervalMs?: number;
}) {
	if (!Number.isFinite(recordPollIntervalMs) || recordPollIntervalMs <= 0) {
		throw new Error('Record poll interval must be a positive finite number');
	}
	const root = resolve(storageRoot);
	if (ownedRoots.has(root)) {
		throw new Error(`Workspace runtime storage already has an owner: ${root}`);
	}
	ownedRoots.add(root);
	try {
		mkdirSync(root, { recursive: true });
		bindAuthority(root, authorityKey);
	} catch (cause) {
		ownedRoots.delete(root);
		throw cause;
	}

	const runtime = createWorkspaceRuntime({
		async openRecordOwner(workspaceId, signal) {
			const path = join(root, `${workspaceId}.records.sqlite3`);
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

				const remoteCommitListeners = new Set<() => void>();
				const deletionListeners = new Set<
					(addresses: { table: string; rowId: string }[]) => void
				>();
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
						for (const listener of remoteCommitListeners) listener();
					},
					onRowsDeleted(addresses) {
						for (const listener of deletionListeners) listener(addresses);
					},
				});
				let activeSynchronization: Promise<void> | undefined;
				const synchronize = (): void => {
					if (ownerDisposed) return;
					const pending = replica
						.synchronize()
						.then(() => undefined)
						.catch((cause) => {
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
					subscribeRemoteCommit(listener: () => void) {
						remoteCommitListeners.add(listener);
						return () => remoteCommitListeners.delete(listener);
					},
					subscribeRowsDeleted(
						listener: (addresses: { table: string; rowId: string }[]) => void,
					) {
						deletionListeners.add(listener);
						return () => deletionListeners.delete(listener);
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
				ownedRoots.delete(root);
			}
		},
	});
}

export type BunWorkspaceRuntime = ReturnType<typeof createBunWorkspaceRuntime>;

function bindAuthority(root: string, authorityKey: string): void {
	const path = join(root, '.epicenter-runtime.json');
	const encoded = JSON.stringify({
		formatVersion: 1,
		authorityHash: sha256Hex(authorityKey),
	});
	if (existsSync(path)) {
		if (readFileSync(path, 'utf8') !== encoded) {
			throw new Error('Workspace runtime storage belongs to another authority');
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
