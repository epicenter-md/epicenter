/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread, over an in-memory SQLite, and its
 * durable state is three small relations in IndexedDB.
 *
 * ## Why an in-memory database is not a compromise
 *
 * The store needs a synchronous HANDLE, not synchronous DURABILITY. It touches
 * SQLite in three places, the schema and the replay at construction and then
 * `transaction` and `all`, and every read a person makes (`get`, `list`, `ids`,
 * `document`) comes from the `Y.Doc` already in memory. SQLite is a
 * write-behind log and a query cache, never the read path.
 *
 * ## Why there is no worker
 *
 * There was one, holding the same database on OPFS and fed every statement, so
 * that reopening restored the file whole. It was justified by the projection
 * "coming back for free", and that is false: `bind` rebuilds every projected
 * table unconditionally, because the CRDT is the truth and a projection is a
 * cache. So the restored projection was thrown away every time.
 *
 * What actually has to survive is `_updates`, `_outbox` and `_cursor`, and all
 * three are small: `appendUpdate` folds the log at `SNAPSHOT_FOLD_THRESHOLD`
 * (64) into one baseline, the outbox is coalesced before it is sent, and the
 * cursor is one row. That is an IndexedDB record, not a file, and IndexedDB is
 * reachable from the page. `createSyncAccessHandle` being dedicated-worker-only
 * (`evidence/browser/sync-access-handle.ts`) decided where a FILE could live,
 * and once nothing needs a file it decides nothing at all.
 *
 * Deleted with it: a second sqlite-wasm instance, the OPFS SAH pool and its
 * exclusive-per-origin retry loop, a message protocol, and the mirroring of
 * every statement including the projection writes it turned out nobody wanted.
 */
import type { LensJson, LensParseError } from '@epicenter/lens';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	APP_DOCUMENT,
	applyStoreSchema,
	copyBytes,
	readDocumentIdentity,
	readFormat,
	writeDocumentIdentity,
} from './log.js';
import { claimNamespace, releaseNamespace } from './namespaces.js';
import {
	type ApplicationOf,
	asApplication,
	createStore,
	type Store,
	StoreError,
} from './store.js';

/**
 * Whether this device's durable copy is keeping up with its live one.
 *
 * The one thing a browser store has that a Bun store does not. On Bun the
 * durable write IS the write, so `persist` can poison the store the moment
 * storage refuses. IndexedDB is asynchronous, so a refusal arrives after the
 * write already returned `Ok` and there is nothing left to fail.
 *
 * Nothing is lost when this fires. The `Y.Doc` still holds the work and the
 * outbox still owes it to the authority, so it reaches every other device
 * normally. What is lost is the guarantee that a RELOAD of this device sees it.
 * That makes it an alarm an application shows rather than an error a call
 * returns, in the same shape as `hasUnresolvedDependencies`.
 */
export type StoreDurability =
	| { readonly healthy: true }
	| {
			readonly healthy: false;
			readonly name: string;
			readonly message: string;
	  };

export type BrowserStore = Store & {
	/** Whether the durable copy has fallen behind, and why. */
	durability(): StoreDurability;
	/** Resolve once every write so far has reached durable storage. */
	whenDurable(): Promise<Result<void, StoreError>>;
	/**
	 * Delete this store's durable record whole, disposing the store first.
	 *
	 * ADR-0231's one client-side deletion: a replica whose document was
	 * replaced discards and rejoins at zero, and the initiating device adopts
	 * through the same move after a confirmed replace. Terminal for this store; the
	 * caller reloads (ADR-0232's instrument) and boot opens fresh. Crash-safe
	 * by repetition: a discard that never ran leaves the old file, whose next
	 * dial is refused again.
	 */
	discard(): Promise<Result<void, StoreError>>;
};

/** The relations that have to survive a reload. */
type DurableState = {
	updates: { seq: number; bytes: Uint8Array }[];
	outbox: { id: number; bytes: Uint8Array }[];
	cursor: number;
	/**
	 * The store format this record was written under (ADR-0231).
	 *
	 * Absent on records from before the document identity, and that absence
	 * is the cutover: a record without it is untrusted whole, so the open
	 * wipes what was seeded and the replica rejoins from zero.
	 */
	format?: string;
	/** Which authority document this replica's state belongs to (ADR-0231). */
	document?: string;
};

const STORE_NAME = 'state';
const STATE_KEY = 'durable';

function openIndexedDb(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(`epicenter-store-${name}`, 1);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('indexedDB.open failed'));
		// `blocked` fires when another tab holds an older version of this database
		// open, and when it does NEITHER `success` NOR `error` follows. Without
		// this the promise never settles, so `open` hangs with no
		// error and the application simply never boots in that one tab.
		//
		// Unreachable at version 1, and that is exactly why it is here: it becomes
		// reachable the first time anyone bumps the version, and the symptom then
		// is a hang rather than anything that would point at the change.
		request.onblocked = () =>
			reject(
				new Error(
					'Another tab is holding an older version of this store open. Close it and reload.',
				),
			);
	});
}

function readDurable(database: IDBDatabase): Promise<DurableState | undefined> {
	return new Promise((resolve, reject) => {
		const request = database
			.transaction(STORE_NAME, 'readonly')
			.objectStore(STORE_NAME)
			.get(STATE_KEY);
		request.onsuccess = () =>
			resolve(request.result as DurableState | undefined);
		request.onerror = () => reject(request.error ?? new Error('read failed'));
	});
}

function writeDurable(
	database: IDBDatabase,
	state: DurableState,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, 'readwrite');
		transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('write failed'));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('write aborted'));
	});
}

function describe(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error)
		return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
}

/** Delete one store's IndexedDB database whole. Our own connection is closed first. */
function deleteIndexedDb(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(`epicenter-store-${name}`);
		request.onsuccess = () => resolve();
		request.onerror = () =>
			reject(request.error ?? new Error('indexedDB.deleteDatabase failed'));
		// Another tab still holds this store open. The delete would complete
		// only when that tab closes, and resolving now would claim a wipe that
		// has not happened; the caller's reload rediscovers the refusal and
		// tries again, so failing loudly here is the honest answer.
		request.onblocked = () =>
			reject(
				new Error('Another tab is holding this store open. Close it first.'),
			);
	});
}

/**
 * Which of an application's two durable local documents to open (ADR-0233).
 *
 * A browser application keeps exactly two: `private` is the device-local
 * document that never joins workspace sync, and `workspace` is this device's
 * replica of the authority's current document (ADR-0231). They are separate
 * IndexedDB databases and separate open claims, so a workspace discard,
 * supersession, or rebuild cannot name the private document, and the two may
 * be open at once without being two `Y.Doc`s of one document.
 */
export type DocumentRole = 'private' | 'workspace';

/**
 * Delete the pre-split single database, `epicenter-store-<namespace>`.
 *
 * The clean break for storage written before ADR-0233: that one database held
 * anonymous work or a workspace replica, indistinguishably, so it is deleted
 * rather than reinterpreted as either document. Never rejects, because a dead
 * artifact must not block a boot: a delete blocked by another tab completes
 * when that tab closes, and running again at every open makes the deletion
 * certain without anyone waiting on it.
 */
function deleteLegacySingleStore(namespace: string): Promise<void> {
	return new Promise((resolve) => {
		const request = indexedDB.deleteDatabase(`epicenter-store-${namespace}`);
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
}

/**
 * Open one of the two documents of the application this lens names, in a
 * browser page.
 *
 * The lens names the application and the caller names the document
 * (ADR-0229 as amended by ADR-0233): the IndexedDB database is derived from
 * `lens.namespace` and `document` together, so a private and a workspace
 * document can never share storage, and neither can be opened without saying
 * which one is meant. `#` joins the two because a namespace cannot contain
 * it, so no namespace collides with another namespace's suffixed name.
 *
 * @example
 * ```ts
 * const { data: mail } = await open(inbox, { document: 'workspace' });
 * mail.tables.messages.create({ subject: 'hi', unread: true });
 * mail.store.pressure();
 * ```
 */
export async function open<const TLens extends LensJson>(
	lens: TLens,
	{ document }: { document: DocumentRole },
): Promise<
	Result<ApplicationOf<TLens, BrowserStore>, StoreError | LensParseError>
> {
	const name = `${lens.namespace}#${document}`;
	const { error: claimError } = claimNamespace(name);
	if (claimError !== null) return Err(claimError);

	await deleteLegacySingleStore(lens.namespace);

	const { data: store, error: storeError } = await openBrowserStore({ name });
	if (storeError !== null) {
		releaseNamespace(name);
		return Err(storeError);
	}

	const view = store.bind(lens);
	if (view.error !== null) {
		await store[Symbol.asyncDispose]().catch(() => undefined);
		return Err(view.error);
	}
	return Ok(asApplication<TLens, BrowserStore>(store, view.data));
}

async function openBrowserStore({
	name,
}: {
	name: string;
}): Promise<Result<BrowserStore, StoreError>> {
	const opened = await tryAsync({
		try: async () => {
			const durable = await openIndexedDb(name);
			return { durable, saved: await readDurable(durable) };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (opened.error !== null) return Err(opened.error);
	const { durable, saved } = opened.data;

	const built = await tryAsync({
		try: async () => {
			const sqlite3 = await sqlite3InitModule();
			const database = createBrowserSqliteAdapter(
				new sqlite3.oo1.DB(':memory:') as never,
			);
			applyStoreSchema(database);
			if (saved !== undefined) {
				// Seeded BEFORE `createStore`, because the replay that hydrates the
				// document reads `_updates` out of exactly this handle. From there
				// the browser is indistinguishable from Bun.
				database.transaction(() => {
					for (const update of saved.updates) {
						database.run(
							'INSERT INTO _updates (document, seq, bytes) VALUES (?, ?, ?)',
							[APP_DOCUMENT, update.seq, copyBytes(update.bytes)],
						);
					}
					for (const owed of saved.outbox) {
						database.run('INSERT INTO _outbox (id, bytes) VALUES (?, ?)', [
							owed.id,
							copyBytes(owed.bytes),
						]);
					}
					if (saved.cursor > 0) {
						database.run('INSERT INTO _cursor (document, seq) VALUES (?, ?)', [
							APP_DOCUMENT,
							saved.cursor,
						]);
					}
					// The certificate is seeded WITH the state it certifies. A record
					// from before the document identity has none, and the open's
					// format sweep wipes what was just seeded: the cutover, applied
					// to the browser's copy (ADR-0231).
					if (saved.format !== undefined) {
						database.run(
							"INSERT INTO _meta (key, value) VALUES ('format', ?)",
							[saved.format],
						);
					}
					if (saved.document !== undefined) {
						writeDocumentIdentity(database, saved.document);
					}
				});
			}
			return database;
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (built.error !== null) {
		durable.close();
		return Err(built.error);
	}
	const database = built.data;

	function snapshot(): DurableState {
		const updates = database.all<{ seq: number; bytes: Uint8Array }>(
			'SELECT seq, bytes FROM _updates WHERE document = ? ORDER BY seq',
			[APP_DOCUMENT],
		);
		const outbox = database.all<{ id: number; bytes: Uint8Array }>(
			'SELECT id, bytes FROM _outbox ORDER BY id',
		);
		const cursor = database.all<{ seq: number }>(
			'SELECT seq FROM _cursor WHERE document = ?',
			[APP_DOCUMENT],
		);
		return {
			updates: updates.map((row) => ({
				seq: row.seq,
				bytes: copyBytes(row.bytes),
			})),
			outbox: outbox.map((row) => ({
				id: row.id,
				bytes: copyBytes(row.bytes),
			})),
			cursor: cursor[0]?.seq ?? 0,
			...(() => {
				const format = readFormat(database);
				const document = readDocumentIdentity(database);
				return {
					...(format === undefined ? {} : { format }),
					...(document === undefined ? {} : { document }),
				};
			})(),
		};
	}

	let durability: StoreDurability = { healthy: true };
	let writing: Promise<void> | undefined;
	let again = false;

	/**
	 * Write the current durable state, coalescing bursts into one write.
	 *
	 * Latest-wins rather than a queue. Every write carries the WHOLE of the
	 * three relations, so a write that is superseded before it starts had
	 * nothing in it the next one does not, and a person typing produces one
	 * commit per transaction rather than one durable write per transaction.
	 *
	 * Whole rather than incremental because the whole is small: `_updates` is
	 * bounded at `SNAPSHOT_FOLD_THRESHOLD`, and snapshot folding renumbers it from 1, so
	 * an incremental writer would need to notice that its positions had come to
	 * mean different updates. There is no version of that which is worth 64 rows.
	 */
	function persistDurable(): void {
		if (writing !== undefined) {
			again = true;
			return;
		}
		const state = snapshot();
		writing = writeDurable(durable, state)
			.catch((cause) => {
				// First failure wins: a durable copy that has fallen behind stays
				// behind, so later failures are consequences.
				if (durability.healthy)
					durability = { healthy: false, ...describe(cause) };
			})
			.finally(() => {
				writing = undefined;
				if (again) {
					again = false;
					persistDurable();
				}
			});
	}

	const store = createStore({
		database,
		dispose: () => {
			durable.close();
			releaseNamespace(name);
		},
	});

	// `onCommitted` fires for local writes, application row-document writes, and
	// arrived remote bytes alike. The store contract says it is strictly wider
	// than `onLocalWork`, so it alone is correct and sufficient.
	const stopCommitted = store.onCommitted(persistDurable);

	return Ok(
		Object.freeze({
			...store,
			get sync() {
				return store.sync;
			},
			durability: () => durability,
			async whenDurable(): Promise<Result<void, StoreError>> {
				while (writing !== undefined) await writing;
				return durability.healthy
					? Ok(undefined)
					: StoreError.StorageFailed({
							cause: new Error(`${durability.name}: ${durability.message}`),
						});
			},
			async discard(): Promise<Result<void, StoreError>> {
				// Dispose first, in the wrapper's own order: stop the write-behind
				// before deleting, or a commit racing this call would re-create the
				// database it is trying to remove. Disposing also closes our own
				// IndexedDB connection, so the delete is not blocked by ourselves.
				stopCommitted();
				while (writing !== undefined) await writing;
				await store[Symbol.asyncDispose]();
				return tryAsync({
					try: () => deleteIndexedDb(name),
					catch: (cause) => StoreError.StorageFailed({ cause }),
				});
			},
			async [Symbol.asyncDispose]() {
				stopCommitted();
				while (writing !== undefined) await writing;
				await store[Symbol.asyncDispose]();
			},
		}) as BrowserStore,
	);
}
