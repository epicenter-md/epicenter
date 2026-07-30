import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
	ExchangeRequest,
	ExchangeResponse,
	RowAddress,
} from '@epicenter/data/protocol';
import type { PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Hono, MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import { openEpicenterSyncAuthority } from './authority.js';
import {
	createEpicenterDocumentStore,
	type DocumentAppendOutcome,
	type DocumentReadOutcome,
	type EpicenterDocumentStore,
} from './document-store.js';
import { mountDocumentSyncRoute, mountEpicenterSyncRoute } from './route.js';

type OpenPrincipalAuthority = {
	raw: Database;
	exchange(request: ExchangeRequest): ExchangeResponse;
	documents: EpicenterDocumentStore;
};

function encodePathComponent(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

function authorityPath(dir: string, principalId: PrincipalId): string {
	const principalDir = join(
		dir,
		'principals',
		encodePathComponent(principalId),
	);
	mkdirSync(principalDir, { recursive: true });
	return join(principalDir, 'epicenter.sqlite');
}

function readDatabaseSize(database: Database): number {
	const pageCount = database
		.query<{ page_count: number }, []>('PRAGMA page_count')
		.get()?.page_count;
	const pageSize = database
		.query<{ page_size: number }, []>('PRAGMA page_size')
		.get()?.page_size;
	if (pageCount === undefined || pageSize === undefined) {
		throw new Error('Could not read Epicenter authority SQLite size');
	}
	return pageCount * pageSize;
}

/** Open the Bun runtime for principal-partitioned Epicenter synchronization. */
export function createBunEpicenterSyncRuntime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<PrincipalId, OpenPrincipalAuthority>();
	let closed = false;

	function load(principalId: PrincipalId): OpenPrincipalAuthority {
		if (closed) throw new Error('Bun Epicenter sync runtime is closed');
		const existing = authorities.get(principalId);
		if (existing !== undefined) return existing;

		const raw = new Database(authorityPath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			raw.run('PRAGMA journal_mode = WAL');
			const database = createBunSqliteAdapter(raw);
			const authority = openEpicenterSyncAuthority({
				database,
				readDatabaseSize: () => readDatabaseSize(raw),
			});
			const opened = {
				raw,
				exchange: authority.exchange,
				documents: createEpicenterDocumentStore(database, {
					readDatabaseSize: () => readDatabaseSize(raw),
				}),
			};
			authorities.set(principalId, opened);
			return opened;
		} catch (cause) {
			raw.close();
			throw cause;
		}
	}

	return {
		locateAuthority: (principalId: PrincipalId) => (request: ExchangeRequest) =>
			load(principalId).exchange(request),
		publishDocument: (
			principalId: PrincipalId,
			address: RowAddress,
			update: Uint8Array,
		): DocumentAppendOutcome =>
			load(principalId).documents.appendIfLive(address, update),
		pullDocument: (
			principalId: PrincipalId,
			address: RowAddress,
			sinceVersion: number | undefined,
		): DocumentReadOutcome =>
			load(principalId).documents.read(address, sinceVersion),
		close(): void {
			if (closed) return;
			closed = true;
			for (const authority of authorities.values()) authority.raw.close();
			authorities.clear();
		},
	};
}

export type BunEpicenterSyncRuntime = ReturnType<
	typeof createBunEpicenterSyncRuntime
>;

/** Mount the Bun scalar exchange and row-document HTTP sync routes. */
export function mountBunEpicenterSyncApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		runtime,
	}: {
		auth: MiddlewareHandler<E>;
		runtime: BunEpicenterSyncRuntime;
	},
): void {
	mountEpicenterSyncRoute(app, {
		auth,
		locateAuthority: runtime.locateAuthority,
	});
	mountDocumentSyncRoute(app, {
		auth,
		publish: (principalId, address, update) =>
			runtime.publishDocument(principalId, address, update),
		pull: (principalId, address, sinceVersion) =>
			runtime.pullDocument(principalId, address, sinceVersion),
	});
}
