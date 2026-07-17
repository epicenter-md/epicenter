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
import {
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	sha256Hex,
} from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';

import {
	accountPersistenceKey,
	devicePersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import { mergeDocumentUpdates } from './canonical-documents.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
	initializeCanonicalSchema,
} from './canonical-replica.js';
import { createWorkspaceRuntime } from './runtime.js';

const ownedRoots = new Set<string>();

export type BunWorkspaceAccount = WorkspaceAccount<
	(
		workspaceId: string,
	) =>
		| CanonicalReplicaTransport
		| undefined
		| Promise<CanonicalReplicaTransport | undefined>
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
		recordTransport: account.transport,
	});
}

/** Open a Bun runtime whose workspace owners are lazy SQLite files. */
function createBunRuntimeWithPersistence({
	persistenceKey,
	storageRoot,
	recordTransport,
	onRecordsChanged = () => undefined,
	onSyncError = () => undefined,
	recordPollIntervalMs = 30_000,
}: BunWorkspaceRuntimeOptions & {
	persistenceKey: string;
	recordTransport?: BunWorkspaceAccount['transport'];
}) {
	if (!Number.isFinite(recordPollIntervalMs) || recordPollIntervalMs <= 0) {
		throw new Error('Record poll interval must be a positive finite number');
	}
	const root = resolve(storageRoot, persistenceKey);
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
						for (const listener of remoteCommitListeners) listener();
					},
					onRowsDeleted(addresses) {
						for (const listener of deletionListeners) listener(addresses);
					},
					onBaselinePromoted() {
						for (const listener of baselineListeners) listener();
					},
				});
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
				ownedRoots.delete(root);
			}
		},
	});
}

export type BunWorkspaceRuntime = ReturnType<
	typeof createDeviceBunWorkspaceRuntime
>;

export type DeviceWorkspaceInspection =
	| { adoptable: false }
	| {
			adoptable: true;
			summary: {
				rows: number;
				kv: number;
				documents: number;
			};
	  };

export function inspectDeviceWorkspace({
	storageRoot,
	workspaceId,
}: {
	storageRoot: string;
	workspaceId: string;
}): DeviceWorkspaceInspection {
	const path = workspaceDatabasePath(
		storageRoot,
		devicePersistenceKey(),
		workspaceId,
	);
	if (!existsSync(path)) return { adoptable: false };
	const database = new Database(path, { readonly: true });
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeCanonicalSchema(sqlite);
		const summary = workspaceSummary(database);
		if (summary.rows === 0 && summary.kv === 0 && summary.documents === 0) {
			return { adoptable: false };
		}
		if (hasAdoptedMarker(database)) return { adoptable: false };
		return { adoptable: true, summary };
	} finally {
		database.close();
	}
}

export function adoptDeviceWorkspace({
	storageRoot,
	workspaceId,
	into,
}: {
	storageRoot: string;
	workspaceId: string;
	into: BunWorkspaceAccount;
}): void {
	const sourcePath = workspaceDatabasePath(
		storageRoot,
		devicePersistenceKey(),
		workspaceId,
	);
	if (!existsSync(sourcePath)) {
		throw new Error(`Device workspace '${workspaceId}' does not exist`);
	}
	assertDeviceWorkspaceAdoptable(sourcePath);
	const targetPersistenceKey = accountPersistenceKey(into);
	const targetPath = workspaceDatabasePath(
		storageRoot,
		targetPersistenceKey,
		workspaceId,
	);
	assertAccountWorkspaceEmpty(targetPath);
	mkdirSync(dirname(targetPath), { recursive: true });
	deleteWorkspaceFiles(targetPath);
	writeFileAtomic(targetPath, serializeDatabase(sourcePath));
	markDeviceWorkspaceAdopted(sourcePath);
}

export function deleteDeviceWorkspace({
	storageRoot,
	workspaceId,
}: {
	storageRoot: string;
	workspaceId: string;
}): void {
	const path = workspaceDatabasePath(
		storageRoot,
		devicePersistenceKey(),
		workspaceId,
	);
	deleteWorkspaceFiles(path);
}

function workspaceDatabasePath(
	storageRoot: string,
	persistenceKey: string,
	workspaceId: string,
): string {
	return join(
		resolve(storageRoot, persistenceKey),
		`${workspaceId}.records.sqlite3`,
	);
}

function workspaceSummary(database: Database): {
	rows: number;
	kv: number;
	documents: number;
} {
	const rowCount =
		database
			.query<{ count: number }, [string, string]>(
				`SELECT COUNT(*) AS count FROM rows
				 WHERE NOT (table_key = ? AND row_id = ?)`,
			)
			.get(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID)?.count ?? 0;
	const kvCount =
		database
			.query<{ count: number }, [string, string]>(
				`SELECT COUNT(*) AS count
				 FROM rows, json_each(rows.fields_json)
				 WHERE table_key = ? AND row_id = ?`,
			)
			.get(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID)?.count ?? 0;
	const documentCount =
		database
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM documents')
			.get()?.count ?? 0;
	return { rows: rowCount, kv: kvCount, documents: documentCount };
}

function assertDeviceWorkspaceAdoptable(path: string): void {
	const database = new Database(path, { readonly: true });
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeCanonicalSchema(sqlite);
		const summary = workspaceSummary(database);
		if (summary.rows === 0 && summary.kv === 0 && summary.documents === 0) {
			throw new Error('Cannot adopt an empty device workspace');
		}
		if (hasAdoptedMarker(database)) {
			throw new Error('Device workspace has already been adopted');
		}
	} finally {
		database.close();
	}
}

function assertAccountWorkspaceEmpty(path: string): void {
	if (!existsSync(path)) return;
	const database = new Database(path, { readonly: true });
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeCanonicalSchema(sqlite);
		const summary = workspaceSummary(database);
		if (summary.rows > 0 || summary.kv > 0 || summary.documents > 0) {
			throw new Error(
				'Cannot adopt device workspace into a non-empty account workspace',
			);
		}
	} finally {
		database.close();
	}
}

function markDeviceWorkspaceAdopted(path: string): void {
	const database = new Database(path, { create: true });
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS adoption_meta (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				adopted_at TEXT NOT NULL
			);
			INSERT INTO adoption_meta(id, adopted_at)
			VALUES (1, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET adopted_at = excluded.adopted_at;
		`);
	} finally {
		database.close();
	}
}

function hasAdoptedMarker(database: Database): boolean {
	const table = database
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'adoption_meta'",
		)
		.get();
	if (!table) return false;
	return (
		(database
			.query<{ present: number }, []>(
				'SELECT 1 AS present FROM adoption_meta WHERE id = 1',
			)
			.get()?.present ?? 0) === 1
	);
}

function serializeDatabase(path: string): Uint8Array {
	const database = new Database(path, { readonly: true });
	try {
		return database.serialize();
	} finally {
		database.close();
	}
}

function deleteWorkspaceFiles(path: string): void {
	rmSync(path, { force: true });
	rmSync(`${path}-wal`, { force: true });
	rmSync(`${path}-shm`, { force: true });
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
