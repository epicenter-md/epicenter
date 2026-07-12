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
import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';
import { createInvalidationRefreshQueue } from './invalidation-queue.js';
import { createWorkspaceService } from './service.js';
import {
	parseWorkspaceInvalidationMessage,
	WORKSPACE_INVALIDATION_PROTOCOL,
	type WorkspaceInvalidation,
} from './service-protocol.js';

export type ServeLocalWorkspaceWorkerOptions = {
	storage: { kind: 'opfs'; name: string };
	/** Receives worker-side observer, broadcast, and cleanup failures. */
	onError(error: unknown): void;
};

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
		kv: Object.keys(delta.kv),
	};
}

async function openOpfsWorkspaceService<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{ storage, onError }: ServeLocalWorkspaceWorkerOptions,
): Promise<WorkerWorkspaceService> {
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

	async function disposeResources(): Promise<void> {
		isDisposed = true;
		const cleanupErrors: unknown[] = [];
		try {
			channel?.close();
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
		channel = new BroadcastChannel(`epicenter.sqlite.local/${storage.name}`);
		const senderId = crypto.randomUUID();
		native.exec({ sql: 'PRAGMA busy_timeout = 5000' });
		const database = createApplicationDatabase(
			definition,
			createBrowserSqliteAdapter(native),
			{ kind: 'local', onObserverError: (error) => report(onError, error) },
		);
		const openedService = createWorkspaceService(database, {
			onObserverError: (error) => report(onError, error),
		});
		service = openedService;
		refreshQueue = createInvalidationRefreshQueue({
			tables: new Set(Object.keys(definition.tables)),
			kv: new Set(Object.keys(definition.kv)),
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
export function serveLocalWorkspaceWorker<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: ServeLocalWorkspaceWorkerOptions,
	scope: WorkspaceWorkerScope = self as unknown as WorkspaceWorkerScope,
): void {
	exposeWorkspaceService(scope, openOpfsWorkspaceService(definition, options));
}
