/// <reference lib="webworker" />
/**
 * The durable half of a browser store: a file, and nothing else.
 *
 * This worker exists for exactly one measured reason.
 * `FileSystemFileHandle.createSyncAccessHandle` is available only in dedicated
 * workers, so sqlite-wasm's OPFS backing cannot be reached from a page
 * (`evidence/browser/sync-access-handle.ts`, with a control). That constrains
 * where the LOG lives and nothing else: the store itself runs in the page over
 * an in-memory database, because its reads come from the `Y.Doc` and it needs a
 * synchronous handle rather than synchronous durability.
 *
 * So this is not a replica and not a proxy. It applies statements it does not
 * interpret to a schema it does not know, and hands the file back on request.
 * Nothing here imports Yjs, a lens, or the store.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import type {
	BrowserLogRequest,
	BrowserLogResponse,
} from './browser-log-protocol.js';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type PoolUtil = Awaited<ReturnType<Sqlite3['installOpfsSAHPoolVfs']>>;
type Database = { exec(options: unknown): unknown; close(): void };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let sqlite3: Sqlite3 | undefined;
let pool: PoolUtil | undefined;
let database: Database | undefined;

function post(message: BrowserLogResponse): void {
	scope.postMessage(message);
}

/**
 * Install the OPFS pool, retrying while another context still holds it.
 *
 * The pool is exclusive per origin, so a page being replaced by its own reload
 * routinely finds the outgoing worker still holding it for a moment. Same
 * shape, and the same reason, as the superseded stack's own acquisition.
 */
async function acquirePool(module: Sqlite3): Promise<PoolUtil> {
	let lastFailure: unknown;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			return await module.installOpfsSAHPoolVfs({
				name: 'epicenter-store',
				directory: '.epicenter-store-sahpool',
			});
		} catch (cause) {
			lastFailure = cause;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(
		`durable browser storage is unavailable: ${describe(lastFailure).message}`,
		{ cause: lastFailure },
	);
}

function describe(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error) return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
}

async function open(name: string): Promise<Uint8Array | undefined> {
	sqlite3 ??= await sqlite3InitModule();
	pool ??= await acquirePool(sqlite3);
	const path = `/${name}.sqlite3`;
	const PoolDb = (pool as unknown as { OpfsSAHPoolDb: new (p: string) => Database })
		.OpfsSAHPoolDb;
	database = new PoolDb(path);
	database.exec({
		sql: `
			PRAGMA busy_timeout = 5000;
			PRAGMA journal_mode = DELETE;
			PRAGMA synchronous = EXTRA;
			PRAGMA temp_store = MEMORY;
		`,
	});
	const exported = (
		sqlite3 as unknown as {
			capi: { sqlite3_js_db_export(pointer: unknown): Uint8Array };
		}
	).capi.sqlite3_js_db_export((database as unknown as { pointer: unknown }).pointer);
	// An empty file is a first run rather than a failure, and the page tells the
	// two apart by whether it got bytes. A header-only database is 0 pages of
	// content, so anything at or below one page carries nothing worth restoring.
	return exported.byteLength > 4_096 ? exported : undefined;
}

function apply(statements: BrowserLogRequest & { kind: 'apply' }): void {
	const live = database;
	if (live === undefined) throw new Error('the durable log is not open');
	live.exec({ sql: 'BEGIN IMMEDIATE' });
	try {
		for (const statement of statements.statements) {
			live.exec({ sql: statement.sql, bind: statement.parameters });
		}
		live.exec({ sql: 'COMMIT' });
	} catch (cause) {
		try {
			live.exec({ sql: 'ROLLBACK' });
		} catch {
			// A rollback that fails on an already-rolled-back transaction is not
			// news; the original failure below is what the page has to hear.
		}
		throw cause;
	}
}

scope.addEventListener('message', (event: MessageEvent<BrowserLogRequest>) => {
	const request = event.data;
	void (async () => {
		try {
			switch (request.kind) {
				case 'open':
					post({ kind: 'opened', id: request.id, bytes: await open(request.name) });
					return;
				case 'apply':
					apply(request);
					post({ kind: 'ok', id: request.id });
					return;
				case 'settle':
					// Every message is handled in arrival order and `apply` is
					// synchronous, so anything accepted before this has already
					// committed. Answering is the whole of it.
					post({ kind: 'ok', id: request.id });
					return;
				case 'close':
					database?.close();
					database = undefined;
					// Paused rather than closed. The pool is exclusive per origin, and
					// a page reloading has its replacement racing to install one
					// before this worker is collected.
					pool?.pauseVfs();
					post({ kind: 'ok', id: request.id });
					return;
			}
		} catch (cause) {
			const { name, message } = describe(cause);
			// A failed `apply` is reported twice on purpose: once to whoever is
			// waiting, and once as an alarm, because the write it belonged to
			// returned `Ok` to the application long ago and nobody is waiting.
			post({ kind: 'failed', id: request.id, name, message });
			if (request.kind === 'apply') post({ kind: 'alarm', name, message });
		}
	})();
});
