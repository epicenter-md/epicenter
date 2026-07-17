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
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { sha256Hex } from '../shared/sha256.js';
import { createCanonicalRecords } from './canonical-records.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import {
	type AttachDocumentSync,
	createDocumentRoomCatalog,
} from './document-runtime.js';
import { createWorkspaceRuntime } from './runtime.js';

const ownedRoots = new Set<string>();

/** Open a Bun runtime whose workspace record owners are lazy SQLite files. */
export function createBunWorkspaceRuntime({
	authorityKey,
	storageRoot,
	recordTransport,
	attachDocumentSync,
	onRecordsChanged = () => undefined,
	onSyncError = () => undefined,
	recordPollIntervalMs = 30_000,
}: {
	authorityKey: string;
	storageRoot: string;
	/** Environment-owned private transport binding for each synchronized workspace. */
	recordTransport?(
		workspaceId: string,
	):
		| CanonicalReplicaTransport
		| undefined
		| Promise<CanonicalReplicaTransport | undefined>;
	/** Environment-owned remote Yjs attachment, started after local hydration. */
	attachDocumentSync?: AttachDocumentSync;
	/** Lossy re-read hint after local commits and installed remote state. */
	onRecordsChanged?(workspaceId: string): void;
	/** Environment-owned reporting for retryable background sync failures. */
	onSyncError?(cause: unknown, workspaceId: string): void;
	/** Private periodic remote repair interval for synchronized workspaces. */
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
	const documentsRoot = join(root, 'documents');
	const documentCatalogRoot = join(documentsRoot, 'catalog');
	const documentRoomCatalog = createDocumentRoomCatalog({
		localStore: {
			async rememberRoom(manifest) {
				mkdirSync(documentCatalogRoot, { recursive: true });
				const path = join(documentCatalogRoot, `${manifest.storageRef}.json`);
				const encoded = JSON.stringify(manifest);
				if (existsSync(path)) {
					if (readFileSync(path, 'utf8') !== encoded) {
						throw new Error(
							`Document room manifest conflicts with persisted catalog: ${manifest.storageRef}`,
						);
					}
					return;
				}
				writeFileAtomic(path, encoded);
			},
			async load(roomId) {
				const path = join(documentsRoot, `${roomId}.yjs`);
				return existsSync(path) ? readFileSync(path) : undefined;
			},
			async save(roomId, update) {
				mkdirSync(documentsRoot, { recursive: true });
				writeFileAtomic(join(documentsRoot, `${roomId}.yjs`), update);
			},
		},
		attachSync: attachDocumentSync,
	});
	const runtime = createWorkspaceRuntime({
		authorityKey,
		documentRoomCatalog,
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
						// A reporting sink cannot become another synchronization failure.
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
						admit() {
							queueMicrotask(emitRecordsChanged);
						},
						async [Symbol.asyncDispose]() {
							ownerDisposed = true;
							database?.close();
						},
					};
				}

				// Establish the schema-opaque canonical map before background sync can
				// install remote rows. The runtime installs release-local lens views next.
				createCanonicalRecords(sqlite, {});
				let activeSynchronization: Promise<void> | undefined;
				const cancellableTransport: CanonicalReplicaTransport = {
					sync: (request) => abortable(transport.sync(request), signal),
					snapshotChunk: (request) =>
						abortable(transport.snapshotChunk(request), signal),
				};
				const replica = createCanonicalReplica({
					sqlite,
					transport: cancellableTransport,
					sha256: async (value) => sha256Hex(value),
					onRemoteCommit: emitRecordsChanged,
				});
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
				const scheduleSynchronization = (): void => {
					queueMicrotask(synchronize);
				};
				const poll = setInterval(synchronize, recordPollIntervalMs);
				poll.unref();
				scheduleSynchronization();
				return {
					sqlite,
					admit(command) {
						replica.admit(command);
						queueMicrotask(() => {
							emitRecordsChanged();
							synchronize();
						});
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
