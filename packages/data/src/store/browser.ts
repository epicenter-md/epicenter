/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread, over an in-memory SQLite. That is
 * not a compromise and it is worth stating plainly, because the opposite was
 * briefly concluded from a true measurement: a page cannot take a synchronous
 * handle to DURABLE storage (`evidence/browser/sync-access-handle.ts`), and
 * that constrains where the log lives rather than where the store runs. The
 * store touches SQLite in three places, the schema and the replay at
 * construction and then `transaction` and `all`; every read a person makes
 * comes from the `Y.Doc` already in memory. It needs a synchronous HANDLE, not
 * synchronous DURABILITY.
 *
 * So durability is a worker holding the same database on OPFS, fed the same
 * statements. On open the page takes the file back whole and deserializes it,
 * which leaves it holding exactly what the last session committed with nothing
 * to reconcile.
 *
 * This is not the superseded stack's arrangement inverted, it is a different
 * one. There the worker owned the replica and `src/browser.ts` was 700 lines of
 * asynchronous page client, which is why every read in an application on it is
 * awaited. Here the worker owns a file it never interprets, and the page's
 * surface is the same synchronous one Bun gets.
 */
import type { SqliteDatabase, SqliteValue } from '@epicenter/sqlite';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import type {
	BrowserLogRequest,
	BrowserLogResponse,
	LoggedStatement,
} from './browser-log-protocol.js';
import { applyStoreSchema } from './persistence.js';
import { createStore, StoreError, type Store } from './store.js';

/**
 * Whether this device's durable copy is keeping up with its live one.
 *
 * The one thing a browser store has that a Bun store does not, and the price of
 * the arrangement above. On Bun the durable write IS the write, so `persist`
 * can poison the store the moment storage refuses. Here the log is behind a
 * port, so a refusal arrives after the write already returned `Ok`, and there
 * is nothing left to fail.
 *
 * Nothing is lost when this fires. The `Y.Doc` still holds the work and the
 * outbox still owes it to the authority, so it will reach every other device
 * normally. What is lost is the guarantee that a RELOAD of this device sees it.
 * That makes it an alarm an application shows rather than an error a call
 * returns, in the same shape as `hasUnresolvedDependencies`.
 */
export type StoreDurability =
	| { readonly healthy: true }
	| { readonly healthy: false; readonly name: string; readonly message: string };

export type BrowserStore = Store & {
	/** Whether the durable log has fallen behind, and why. */
	durability(): StoreDurability;
	/** Resolve once every write so far has reached the durable log. */
	whenDurable(): Promise<Result<void, StoreError>>;
};

/** Whatever carries the log worker's messages. A `Worker` satisfies this. */
export type LogWorkerPort = {
	postMessage(message: BrowserLogRequest): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserLogResponse }) => void,
	): void;
	terminate?(): void;
};

/**
 * Mirror every statement to the durable log, batched by transaction.
 *
 * Every statement rather than a curated subset, and that is the simplification
 * the whole file rests on. The alternative was to forward only the three
 * underscore-prefixed relations the store owns and let the worker rebuild the
 * projection, which means the worker knows what a projection is, and means two
 * schemas that can disagree. Forwarding everything makes the worker's file
 * byte-identical to the page's, so opening it is a restore rather than a
 * replay, and the projection comes back for free.
 *
 * Batching is by transaction rather than by statement, so one store commit is
 * one message. A statement outside a transaction, which is only ever the schema
 * DDL at construction, goes on its own.
 */
function mirroring(
	local: SqliteDatabase,
	send: (statements: readonly LoggedStatement[]) => void,
): SqliteDatabase {
	let depth = 0;
	let batch: LoggedStatement[] = [];

	return {
		run(sql: string, parameters: readonly SqliteValue[] = []): void {
			local.run(sql, parameters);
			batch.push({ sql, parameters });
			if (depth === 0) {
				const only = batch;
				batch = [];
				send(only);
			}
		},
		all: local.all.bind(local),
		transaction<TResult>(run: () => TResult): TResult {
			depth += 1;
			try {
				const result = local.transaction(run);
				depth -= 1;
				if (depth === 0 && batch.length > 0) {
					const committed = batch;
					batch = [];
					send(committed);
				}
				return result;
			} catch (cause) {
				depth -= 1;
				// The local transaction rolled back, so these statements never
				// happened and must not reach the log. Dropping them is what keeps
				// the two databases the same one.
				if (depth === 0) batch = [];
				throw cause;
			}
		},
	};
}

export async function openBrowserStore({
	name,
	createWorker = defaultLogWorker,
}: {
	/**
	 * This application's durable file, inside the origin's private storage.
	 *
	 * Named by the application rather than derived, because an origin can host
	 * more than one and ADR-0215's "one document per application" is a statement
	 * about documents rather than about origins.
	 */
	name: string;
	createWorker?(): LogWorkerPort;
}): Promise<Result<BrowserStore, StoreError>> {
	const worker = createWorker();
	let nextRequest = 0;
	const waiting = new Map<
		number,
		(response: BrowserLogResponse) => void
	>();
	let durability: StoreDurability = { healthy: true };
	/** The tail of accepted batches, so `whenDurable` has something to await. */
	let inFlight: Promise<void> = Promise.resolve();

	worker.addEventListener('message', ({ data }) => {
		if (data.kind === 'alarm') {
			// First failure wins. A durable log that has fallen behind stays
			// behind, so later failures are consequences and the first one is the
			// one worth showing.
			if (durability.healthy) {
				durability = { healthy: false, name: data.name, message: data.message };
			}
			return;
		}
		waiting.get(data.id)?.(data);
		waiting.delete(data.id);
	});

	function request(
		build: (id: number) => BrowserLogRequest,
	): Promise<BrowserLogResponse> {
		const id = (nextRequest += 1);
		return new Promise<BrowserLogResponse>((resolve) => {
			waiting.set(id, resolve);
			worker.postMessage(build(id));
		});
	}

	const opened = await tryAsync({
		try: async () => {
			const response = await request((id) => ({ kind: 'open', id, name }));
			if (response.kind === 'failed') {
				throw new Error(`${response.name}: ${response.message}`);
			}
			return response.kind === 'opened' ? response.bytes : undefined;
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (opened.error !== null) {
		worker.terminate?.();
		return Err(opened.error);
	}

	const built = await tryAsync({
		try: async () => {
			const sqlite3 = await sqlite3InitModule();
			// The page's database IS the durable file when there is one, restored
			// whole rather than replayed. `createStore` then hydrates from it
			// exactly as it does on Bun, having no idea it is in a browser.
			const raw =
				opened.data === undefined
					? new sqlite3.oo1.DB(':memory:')
					: deserialize(sqlite3, opened.data);
			return createBrowserSqliteAdapter(raw as never);
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (built.error !== null) {
		worker.terminate?.();
		return Err(built.error);
	}

	const database = mirroring(built.data, (statements) => {
		const settled = request((id) => ({ kind: 'apply', id, statements })).then(
			() => undefined,
		);
		inFlight = inFlight.then(() => settled);
	});
	// Before `createStore`, so that a first run's DDL is mirrored as its own
	// batch and the worker's file has the schema even if nothing is ever written.
	applyStoreSchema(database);

	const store = createStore({
		database,
		dispose: async () => {
			await request((id) => ({ kind: 'close', id }));
			worker.terminate?.();
		},
	});

	return Ok(
		Object.freeze({
			...store,
			get sync() {
				return store.sync;
			},
			durability: () => durability,
			async whenDurable(): Promise<Result<void, StoreError>> {
				await inFlight;
				const response = await request((id) => ({ kind: 'settle', id }));
				if (response.kind === 'failed') {
					return StoreError.StorageFailed({
						cause: new Error(`${response.name}: ${response.message}`),
					});
				}
				return durability.healthy
					? Ok(undefined)
					: StoreError.StorageFailed({
							cause: new Error(
								`${durability.name}: ${durability.message}`,
							),
						});
			},
			[Symbol.asyncDispose]: store[Symbol.asyncDispose].bind(store),
		}) as BrowserStore,
	);
}

/** Rebuild a database from the bytes the worker handed back. */
function deserialize(
	sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>,
	bytes: Uint8Array,
): unknown {
	const database = new sqlite3.oo1.DB(':memory:');
	const capi = sqlite3 as unknown as {
		capi: {
			sqlite3_js_posix_create_file?(path: string, data: Uint8Array): void;
		};
		oo1: { DB: new (path: string, flags?: string) => unknown };
	};
	const create = capi.capi.sqlite3_js_posix_create_file;
	if (create === undefined) return database;
	// Through a temporary file rather than `sqlite3_deserialize`, because the
	// deserialized handle owns memory the JS side has to keep alive for the life
	// of the database and getting that wrong is a use-after-free rather than an
	// error. Writing a file and opening it is boring, and boring is correct here.
	const path = `/epicenter-restore-${Math.trunc(bytes.byteLength)}.sqlite3`;
	create(path, bytes);
	(database as unknown as { close(): void }).close();
	return new capi.oo1.DB(path, 'w');
}

function defaultLogWorker(): LogWorkerPort {
	if (typeof Worker === 'undefined') {
		throw new Error('a dedicated worker is required for durable browser storage');
	}
	// Written as a literal `new Worker(new URL('...', import.meta.url), ...)`
	// because that exact syntax is what bundlers pattern-match to compile this
	// worker into its own same-origin asset. Reaching the constructor through an
	// alias still runs, but the build silently degrades to an inlined `data:`
	// module that the desktop host's Content-Security-Policy refuses (ADR-0183),
	// so first paint dies with no message worth reading.
	const worker = new Worker(new URL('./browser-log-worker.ts', import.meta.url), {
		type: 'module',
		name: 'epicenter-store-log',
	});
	return {
		postMessage: (message) => worker.postMessage(message),
		addEventListener: (type, listener) =>
			worker.addEventListener(type, (event) =>
				listener({ data: (event as MessageEvent<BrowserLogResponse>).data }),
			),
		terminate: () => worker.terminate(),
	};
}
