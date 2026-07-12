import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import type { WorkspaceServicePort } from './client.js';
import { createApplicationDatabase } from './database.js';
import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';
import {
	type LocalWorkspace,
	type OwnedWorkspaceServicePort,
	openLocalWorkspaceFromService,
} from './open.js';
import { createWorkspaceService } from './service.js';

export type OpenLocalWorkspaceOptions = {
	storage: { kind: 'bun'; path: string } | { kind: 'memory' };
	/** Receives post-commit observer failures. Must not throw. */
	onObserverError(error: unknown): void;
};

const ownedFilePaths = new Set<string>();

/** Open a local-only workspace whose authoritative SQLite runs in Bun. */
export async function openLocalWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{ storage, onObserverError }: OpenLocalWorkspaceOptions,
): Promise<LocalWorkspace<TTables, TKv>> {
	const filePath = storage.kind === 'bun' ? resolve(storage.path) : undefined;
	if (filePath && ownedFilePaths.has(filePath)) {
		throw new Error(`Workspace SQLite file already has an owner: ${filePath}`);
	}
	if (filePath) {
		mkdirSync(dirname(filePath), { recursive: true });
		ownedFilePaths.add(filePath);
	}
	let native: Database | undefined;
	let service: ReturnType<typeof createWorkspaceService> | undefined;
	let isDisposed = false;
	function close(): void {
		if (isDisposed) return;
		isDisposed = true;
		try {
			service?.[Symbol.dispose]();
		} finally {
			try {
				native?.close();
			} finally {
				if (filePath) ownedFilePaths.delete(filePath);
			}
		}
	}
	try {
		native = new Database(filePath ?? ':memory:', { create: true });
		native.exec('PRAGMA busy_timeout = 5000');
		if (filePath) native.exec('PRAGMA journal_mode = WAL');
		const database = createApplicationDatabase(
			definition,
			createBunSqliteAdapter(native),
			{ kind: 'local', onObserverError },
		);
		service = createWorkspaceService(database, {
			onObserverError,
		});
		const ownedService: OwnedWorkspaceServicePort = {
			request: service.request,
			observe: service.observe,
			async [Symbol.asyncDispose]() {
				close();
			},
		} satisfies WorkspaceServicePort & AsyncDisposable;
		return await openLocalWorkspaceFromService(definition, {
			service: ownedService,
		});
	} catch (cause) {
		close();
		throw cause;
	}
}
