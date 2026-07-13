import { RECORD_SYNC_PROTOCOL_MAJOR } from '@epicenter/record-sync';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/record-sync/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
	exposeWorkspaceService,
	type WorkerWorkspaceService,
	type WorkspaceWorkerScope,
} from './browser-transport.js';
import type { WorkspaceCommitDelta } from './client.js';
import { createApplicationDatabase } from './database.js';
import type { TableDefinitions, WorkspaceDefinition } from './definition.js';
import { createInvalidationRefreshQueue } from './invalidation-queue.js';
import {
	createReplicaRuntime,
	type ReplicaSyncPort,
	startReplicaSyncSupervisor,
} from './replica.js';
import { createWorkspaceService } from './service.js';
import {
	parseWorkspaceInvalidationMessage,
	WORKSPACE_INVALIDATION_PROTOCOL,
	type WorkspaceInvalidation,
} from './service-protocol.js';

export type ServeStandaloneWorkspaceWorkerOptions = {
	storage: { kind: 'opfs'; name: string };
	/** Receives worker-side observer, broadcast, and cleanup failures. */
	onError(error: unknown): void;
};

export type ServeWorkspaceReplicaWorkerOptions = {
	storage: { kind: 'opfs'; name: string };
	sync: ReplicaSyncPort;
	/** Receives retryable or paused synchronization failures. */
	onSyncError(error: unknown): void;
	/** Receives worker-side observer, broadcast, and cleanup failures. */
	onError(error: unknown): void;
	pollIntervalMs?: number;
};

type ServeWorkspaceWorkerOptions =
	| ({ workspaceKind: 'standalone' } & ServeStandaloneWorkspaceWorkerOptions)
	| ({ workspaceKind: 'replica' } & ServeWorkspaceReplicaWorkerOptions);

const STORAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function report(onError: (error: unknown) => void, error: unknown): void {
	try {
		onError(error);
	} catch {
		// A broken error sink must not crash the database worker.
	}
}

function invalidationFor(delta: WorkspaceCommitDelta): WorkspaceInvalidation {
	return {
		tables: Object.fromEntries(
			Object.entries(delta.tables).map(([table, change]) => [
				table,
				[...change.upserted.map((row) => row.id), ...change.removed],
			]),
		),
	};
}

async function openOpfsWorkspaceService<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	options: ServeWorkspaceWorkerOptions,
): Promise<WorkerWorkspaceService> {
	const { storage, onError, workspaceKind } = options;
	if (!STORAGE_NAME.test(storage.name)) {
		throw new Error(
			`Invalid OPFS workspace name '${storage.name}'; expected lowercase letters, digits, and internal hyphens`,
		);
	}
	if (!globalThis.crossOriginIsolated || !globalThis.SharedArrayBuffer) {
		throw new Error(
			'OPFS SQLite requires cross-origin isolation with COOP and COEP headers',
		);
	}
	const sqlite3 = await sqlite3InitModule();
	if (!sqlite3.capi.sqlite3_vfs_find('opfs')) {
		throw new Error('SQLite opfs VFS is unavailable');
	}
	let native: (BrowserSqliteDatabase & { close(): void }) | undefined;
	let channel: BroadcastChannel | undefined;
	let service: ReturnType<typeof createWorkspaceService> | undefined;
	let stopChanges: (() => void) | undefined;
	let refreshQueue:
		| ReturnType<typeof createInvalidationRefreshQueue>
		| undefined;
	let isDisposed = false;
	let disposePromise: Promise<void> | undefined;
	let stopScheduling: (() => void) | undefined;
	let supervisor: ReturnType<typeof startReplicaSyncSupervisor> | undefined;

	async function disposeResources(): Promise<void> {
		isDisposed = true;
		const cleanupErrors: unknown[] = [];
		try {
			channel?.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			stopScheduling?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await supervisor?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await refreshQueue?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			stopChanges?.();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			service?.[Symbol.dispose]();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			native?.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'OPFS workspace cleanup failed');
		}
	}

	try {
		native = new sqlite3.oo1.DB(
			`/${storage.name}.sqlite3`,
			'c',
			'opfs',
		) as unknown as BrowserSqliteDatabase & { close(): void };
		channel = new BroadcastChannel(
			`epicenter.sqlite.${workspaceKind}/${storage.name}`,
		);
		const senderId = crypto.randomUUID();
		native.exec({ sql: 'PRAGMA busy_timeout = 5000' });
		const sqlite = createBrowserSqliteAdapter(native);
		const replicaRuntime =
			workspaceKind === 'replica'
				? await createReplicaRuntime({
						definition,
						sqlite,
						sync: options.sync,
						protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
						createActorId: () => crypto.randomUUID(),
						sha256,
						onObserverError: (error) => report(onError, error),
					})
				: undefined;
		const database =
			replicaRuntime?.database ??
			createApplicationDatabase(definition, sqlite, {
				kind: 'standalone',
				onObserverError: (error) => report(onError, error),
			});
		const openedService = createWorkspaceService(database, {
			onObserverError: (error) => report(onError, error),
			readRecoveryCheckpoint: replicaRuntime?.readRecoveryCheckpoint,
		});
		service = openedService;
		if (workspaceKind === 'replica' && replicaRuntime) {
			supervisor = startReplicaSyncSupervisor(replicaRuntime, {
				onError: options.onSyncError,
				pollIntervalMs: options.pollIntervalMs,
			});
			stopScheduling = openedService.observe(() => supervisor?.request());
			supervisor.request();
		}
		refreshQueue = createInvalidationRefreshQueue({
			tables: new Set(Object.keys(definition.tables)),
			refresh: openedService.refresh,
			onError: (error) => report(onError, error),
		});
		stopChanges = openedService.observeChanges((delta, source) => {
			if (source !== 'commit' || isDisposed) return;
			channel?.postMessage({
				protocol: WORKSPACE_INVALIDATION_PROTOCOL,
				senderId,
				invalidation: invalidationFor(delta),
			});
		});
		channel.addEventListener('message', (event: MessageEvent<unknown>) => {
			if (isDisposed) return;
			try {
				const message = parseWorkspaceInvalidationMessage(event.data);
				if (message.senderId !== senderId) {
					refreshQueue?.enqueue(message.invalidation);
				}
			} catch (error) {
				report(onError, error);
			}
		});
	} catch (cause) {
		try {
			await disposeResources();
		} catch (cleanupCause) {
			throw new AggregateError(
				[cause, cleanupCause],
				'OPFS workspace initialization and cleanup both failed',
				{ cause },
			);
		}
		throw cause;
	}
	const openedService = service;
	if (!openedService)
		throw new Error('OPFS workspace service did not initialize');

	return {
		request: openedService.request,
		observe: openedService.observe,
		[Symbol.asyncDispose]() {
			disposePromise ??= disposeResources();
			return disposePromise;
		},
	};
}

/** Start the worker-side OPFS owner for one app-imported workspace definition. */
export function serveStandaloneWorkspaceWorker<
	TTables extends TableDefinitions,
>(
	definition: WorkspaceDefinition<TTables>,
	options: ServeStandaloneWorkspaceWorkerOptions,
	scope: WorkspaceWorkerScope = self as unknown as WorkspaceWorkerScope,
): void {
	exposeWorkspaceService(
		scope,
		openOpfsWorkspaceService(definition, {
			...options,
			workspaceKind: 'standalone',
		}),
	);
}

/** Start the worker-side OPFS owner for one synchronized workspace replica. */
export function serveWorkspaceReplicaWorker<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	options: ServeWorkspaceReplicaWorkerOptions,
	scope: WorkspaceWorkerScope = self as unknown as WorkspaceWorkerScope,
): void {
	exposeWorkspaceService(
		scope,
		openOpfsWorkspaceService(definition, {
			...options,
			workspaceKind: 'replica',
		}),
	);
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
