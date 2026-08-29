/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread. The live Yjs document is the
 * source of truth, and the durable facts (the update log, the outbox, the
 * cursor, and the metadata) live directly in IndexedDB, written one atomic
 * multi-store transaction per flush (ADR-0238). Every read a person makes
 * (`get`, `list`, `ids`, `document`) comes from the `Y.Doc` already in
 * memory; SQL, when an application wants it, is a follower it composes over
 * this surface, so opening a store here loads no SQLite at all.
 *
 * ## Why IndexedDB owns the facts directly
 *
 * The previous shape snapshotted the whole in-memory SQLite (log, outbox,
 * cursor) into one IndexedDB checkpoint record after every commit. That
 * indirection stored one runtime's file format inside another's storage,
 * paid a whole-file write per commit, and left ADR-0231's stamp-before-push
 * window open: the identity stamp was durable only when the next checkpoint
 * happened to land. Four object stores written through the persistence
 * controller's atomic batch replace it; the controller's queue ordering is
 * what closes the window (ADR-0238).
 *
 * y-indexeddb was considered and rejected: it exposes no public way to
 * participate in its transactions, so the outbox and cursor could never
 * commit atomically with the updates it stores, and its own debounce and
 * compaction make its update store unreadable as a stable log.
 *
 * ## Why there is no worker
 *
 * There was one, holding an OPFS SQLite fed every statement, justified by a
 * derived index "coming back for free"; that was false, because such an index
 * rebuilds from the document at open regardless. What actually has to survive
 * is small: the log folds at `SNAPSHOT_FOLD_THRESHOLD` (64), the outbox is
 * coalesced before it is sent, and the cursor is one row. IndexedDB holds
 * that from the page.
 */

import {
	type DataDefinition,
	type DataDefinitionParseError,
	type ParsedDataDefinition,
	parseData,
} from '@epicenter/data/definition';
import type { PrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { claimDocument, releaseDocument } from './claims.js';
import {
	APP_DOCUMENT,
	copyBytes,
	NO_AUTHORITY,
	replay,
	SNAPSHOT_FOLD_THRESHOLD,
} from './log.js';
import type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
} from './persistence.js';
import {
	type AccountStore,
	asData,
	createAccountStoreOverPort,
	createLocalStoreOverPort,
	type DataOf,
	type DataView,
	type LocalStore,
	StoreError,
	type UntypedDataView,
} from './store.js';

// Re-exported so a browser caller's one import site names both kinds beside
// the openers that produce them.
export type { AccountStore, LocalStore } from './store.js';

/** One browser document that replicates with an account authority. */
export type BrowserAccountStore = AccountStore & {
	/** The canonical server identity this replica belongs to. */
	readonly baseURL: string;
	/** The principal asserted by that server for this replica. */
	readonly principalId: PrincipalId;
	/**
	 * Delete this store's durable record whole, disposing the store first.
	 *
	 * A superseded replica discards and rejoins at zero. Terminal for this store;
	 * the caller reloads (ADR-0232's instrument) and boot opens fresh. Crash-safe
	 * by repetition: a discard that never ran leaves the old file, whose next
	 * dial is refused again.
	 *
	 * Its blast radius is this store's own address and nothing else (ADR-0261),
	 * so a definition discard names one account's replica and can reach neither
	 * the device document nor any other account's.
	 */
	discard(): Promise<Result<void, StoreError>>;
};

/**
 * The durable facts, one object store each (ADR-0238, ADR-0248).
 *
 * `updates` is the per-document Yjs update log at explicit `[document, seq]`
 * keys, the application document under the reserved `app` name and each row
 * document under its derived address; `outbox` holds locally authored bytes
 * at the ids the store assigned, each naming its document; `tombstones`
 * holds every retired document address; `meta` holds the format certificate,
 * the cursor, and the document identity. These are persisted names: changing
 * them requires an IndexedDB migration.
 */
type StoredUpdateRecord = {
	document: string;
	bytes: Uint8Array;
	/** `null` is owed: the authority has no position for these bytes. */
	authoritySeq: number | null;
};

type BrowserDurableSchema = DBSchema & {
	updates: { key: number; value: StoredUpdateRecord };
	tombstones: { key: string; value: 1 };
	/** One key, ever. The format left for the address. */
	identity: { key: 'document'; value: string };
};

type BrowserDurableDatabase = IDBPDatabase<BrowserDurableSchema>;

const DURABLE_STORES = ['updates', 'tombstones', 'identity'] as const;

/**
 * One append id is the whole key now.
 *
 * It used to be `[document, seq]`, because seq was a per-document position.
 * Ids are one monotone sequence across every document, so a document's chain
 * is a filter rather than a range, and an acknowledgement naming ids across
 * documents is one scan rather than several.
 */

function openIndexedDb(address: string): Promise<BrowserDurableDatabase> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		void openDB<BrowserDurableSchema>(address, 4, {
			upgrade(sqlite) {
				for (const name of DURABLE_STORES) {
					if (!sqlite.objectStoreNames.contains(name)) {
						sqlite.createObjectStore(name);
					}
				}
				// Version 1 held one checkpoint record in a `state` store. Nothing
				// migrates from it: its format certificate predates '3' either way,
				// so the format rule at load wipes whatever it held (ADR-0231's
				// cutover, applied again at ADR-0248's).
				if ((sqlite.objectStoreNames as DOMStringList).contains('state')) {
					sqlite.deleteObjectStore('state' as never);
				}
			},
			blocked() {
				// A later schema upgrade must not leave boot hanging behind a tab that
				// still holds the old version. `idb` still resolves if that tab closes,
				// so close the late connection rather than leaking it after rejection.
				blocked = true;
				reject(
					new Error(
						'Another tab is holding an older version of this store open. Close it and reload.',
					),
				);
			},
		}).then(
			(sqlite) => {
				if (blocked) sqlite.close();
				else resolve(sqlite);
			},
			(cause) => reject(cause),
		);
	});
}

/** Delete one store's IndexedDB definition whole. Our own connection is closed first. */
function deleteIndexedDb(address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		void deleteDB(address, {
			blocked() {
				// `deleteDB` waits for the other tab. This caller must instead know
				// that its requested wipe did not happen before it reloads.
				blocked = true;
				reject(
					new Error('Another tab is holding this store open. Close it first.'),
				);
			},
		}).then(
			() => {
				if (!blocked) resolve();
			},
			(cause) => reject(cause),
		);
	});
}

/** One address's durable engine, loaded and ready to commit batches. */
export type BrowserBacking = {
	port: DurablePort;
	loaded: DurableSnapshot;
	close(): void;
};

/**
 * This address's durable record, as a `DurablePort` over IndexedDB.
 *
 * Exported for the same reason `createSqliteDurablePort` is: the port is the
 * seam, and there are two implementations of it. One conformance suite drives
 * both through identical batches and holds them to identical results
 * (`port-conformance.test.ts`). Two suites that each check one implementation
 * against its own expectations is how the two came to disagree about the fold,
 * the identity stamp, and what a duplicate key does.
 *
 * Not an opener. It hands back a port and what was loaded; composing a store
 * over those is `openLocal`'s and `openAccount`'s job.
 */
export async function openIdbBacking(
	address: string,
	syncs: boolean,
): Promise<Result<BrowserBacking, StoreError>> {
	return tryAsync({
		try: async () => {
			const durable = await openIndexedDb(address);

			const read = durable.transaction(DURABLE_STORES, 'readonly');
			const updateStore = read.objectStore('updates');
			const rows = await updateStore.getAll();
			const ids = (await updateStore.getAllKeys()) as number[];
			const tombstones = await read.objectStore('tombstones').getAllKeys();
			const identity = await read.objectStore('identity').get('document');
			await read.done;

			// One pass over the chain answers everything the snapshot holds, which
			// is the shape of the collapse: the outbox and the cursor are read off
			// the appends rather than kept beside them.
			const appUpdates: Uint8Array[] = [];
			const outbox: OutboxEntry[] = [];
			let cursor = 0;
			let lastId = 0;
			const counts = new Map<string, number>();
			for (const [index, row] of rows.entries()) {
				const id = ids[index] as number;
				if (id > lastId) lastId = id;
				counts.set(row.document, (counts.get(row.document) ?? 0) + 1);
				if (row.document === APP_DOCUMENT)
					appUpdates.push(copyBytes(row.bytes));
				if (row.authoritySeq === null) {
					// A store with no authority owes nobody, and nothing would read
					// the result: there is no sender.
					if (syncs) {
						outbox.push({
							id,
							document: row.document,
							bytes: copyBytes(row.bytes),
						});
					}
				} else if (row.authoritySeq > cursor) {
					cursor = row.authoritySeq;
				}
			}
			outbox.sort((a, b) => a.id - b.id);

			const loaded: DurableSnapshot = {
				updates: appUpdates,
				outbox,
				cursor,
				identity,
				tombstones: tombstones.map((key) => String(key)),
				lastId,
			};

			const port: DurablePort = {
				async commit(ops: readonly DurableOp[]): Promise<void> {
					const transaction = durable.transaction(DURABLE_STORES, 'readwrite');
					const updates = transaction.objectStore('updates');
					const tombstonesStore = transaction.objectStore('tombstones');
					const identityStore = transaction.objectStore('identity');
					const chain = new Map(counts);
					const touched = new Set<string>();
					for (const op of ops) {
						switch (op.kind) {
							case 'append': {
								void updates.put(
									{
										document: op.document,
										bytes: copyBytes(op.bytes),
										authoritySeq: op.authoritySeq ?? null,
									},
									op.id,
								);
								chain.set(op.document, (chain.get(op.document) ?? 0) + 1);
								touched.add(op.document);
								break;
							}
							case 'ack': {
								// One statement's worth of work, spread over a walk because
								// the store is keyed by id and the predicate is "still
								// owed". The SQL port writes the same thing as one UPDATE.
								let at = await updates.openCursor(
									IDBKeyRange.upperBound(op.throughId),
								);
								while (at !== null) {
									if (at.value.authoritySeq === null) {
										await at.update({
											...at.value,
											authoritySeq: op.authoritySeq,
										});
										touched.add(at.value.document);
									}
									at = await at.continue();
								}
								break;
							}
							case 'identity': {
								// First write wins, which is the rule
								// `writeDocumentIdentity` states and enforces with a
								// primary key. Held to the SQL port by
								// `port-conformance.test.ts`.
								const stamped = await identityStore.get('document');
								if (stamped === undefined) {
									void identityStore.put(op.id, 'document');
								}
								break;
							}
							case 'retire': {
								void tombstonesStore.put(1, op.document);
								let at = await updates.openCursor();
								while (at !== null) {
									if (at.value.document === op.document) await at.delete();
									at = await at.continue();
								}
								chain.delete(op.document);
								touched.delete(op.document);
								break;
							}
						}
					}

					// The same fold the SQL engine applies, with the same one
					// question: a store that syncs collapses only the acknowledged
					// prefix, because the sender offers owed appends individually
					// and an ack names them by id. A store that does not sync
					// collapses everything, because nothing reads its owed work.
					for (const document of touched) {
						if ((chain.get(document) ?? 0) < SNAPSHOT_FOLD_THRESHOLD) continue;
						const foldable: { id: number; bytes: Uint8Array }[] = [];
						let position: number | null = null;
						let at = await updates.openCursor();
						while (at !== null) {
							const row = at.value;
							if (
								row.document === document &&
								(!syncs || row.authoritySeq !== null)
							) {
								foldable.push({ id: at.key as number, bytes: row.bytes });
								if (
									row.authoritySeq !== null &&
									row.authoritySeq > (position ?? -1)
								) {
									position = row.authoritySeq;
								}
							}
							at = await at.continue();
						}
						if (foldable.length < SNAPSHOT_FOLD_THRESHOLD) continue;
						const through = foldable.at(-1)?.id;
						if (through === undefined) continue;
						const folded = replay(
							foldable.map((row) => ({ seq: row.id, bytes: row.bytes })),
						);
						let baseline: Uint8Array;
						try {
							baseline = new Uint8Array(Y.encodeStateAsUpdateV2(folded));
						} finally {
							folded.destroy();
						}
						for (const row of foldable) void updates.delete(row.id);
						// The baseline inherits the highest position it replaced, so
						// on a syncing store it is not owed and is never offered back.
						void updates.put(
							{
								document,
								bytes: baseline,
								authoritySeq: syncs ? position : NO_AUTHORITY,
							},
							through,
						);
						chain.set(
							document,
							(chain.get(document) ?? 0) - foldable.length + 1,
						);
					}

					await transaction.done;
					// Advanced only after the batch landed, so a retried batch
					// recomputes from the same starting point.
					counts.clear();
					for (const [document, count] of chain) counts.set(document, count);
				},
				async readDocument(document: string): Promise<Uint8Array[]> {
					const store = durable
						.transaction('updates', 'readonly')
						.objectStore('updates');
					const rows = await store.getAll();
					const keys = (await store.getAllKeys()) as number[];
					return rows
						.map((row, index) => ({ row, id: keys[index] as number }))
						.filter(({ row }) => row.document === document)
						.sort((a, b) => a.id - b.id)
						.map(({ row }) => copyBytes(row.bytes));
				},
				async listDocuments(): Promise<string[]> {
					const rows = await durable.getAll('updates');
					return [...new Set(rows.map((row) => row.document))].sort();
				},
			};

			return { port, loaded, close: () => durable.close() };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
}

/**
 * Where one of an application's durable documents lives, as ownership
 * (ADR-0261, amending ADR-0233):
 *
 * ```text
 * epicenter/<definition id>/local
 * epicenter/<definition id>/account/<base URL>/<principal id>
 * ```
 *
 * A browser application keeps one device document and one retained account
 * replica per server identity, and may hold them open at once. The device
 * document never joins definition sync and survives every sign-in and
 * sign-out; an account replica is this device's replica of one principal's
 * current authority document (ADR-0231), retained across sign-out too. The
 * server URL is part of the address because the same principal identifier can
 * exist on multiple independent servers.
 *
 * Three identities, none of them collapsed into another: the definition id says
 * which application, the base URL and principal form the server identity that
 * owns this replica, and the authority document id says which current Yjs
 * document that replica belongs to. The first two are in the name. The third
 * lives inside the store
 * because a future explicit document replacement may change it while the
 * logical address stays stable; the current runtime does not expose that
 * replacement action.
 *
 * A definition id is dot-separated lowercase labels, so it holds no `/`: the
 * segment after `epicenter/` is always exactly the application, and no address
 * can be read as another one.
 */
/**
 * The storage generation, carried in the address rather than in the record.
 *
 * A record written under an older shape sits at a name nothing opens. It is
 * not detected and wiped: it is not addressed. That deletes the format
 * certificate, the comparison at every open, and the wipe transaction that
 * followed it, and it makes a bad migration impossible to write rather than
 * merely discouraged.
 *
 * Bumping this strands every existing record, which is the same thing the
 * format wipe always did, said out loud in the address instead of buried in
 * a table.
 */
const STORE_GENERATION = 'v1';

function localAddress(dataId: string): string {
	return `epicenter/${STORE_GENERATION}/${dataId}/local`;
}

/**
 * Normalize the server identity before it becomes durable local state.
 *
 * Auth authorities already persist this form, but the data opener is also a
 * public boundary and must not create two local replicas for equivalent URL
 * spellings. A path prefix remains part of an Epicenter deployment; query and
 * fragment are not server identity.
 */
function canonicalBaseURL(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed === '') return undefined;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}
	if (url.hostname === '') return undefined;
	if (url.username !== '' || url.password !== '') return undefined;
	url.search = '';
	url.hash = '';
	return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function accountAddress(
	dataId: string,
	{ baseURL, principalId }: { baseURL: string; principalId: PrincipalId },
): string {
	return `epicenter/${STORE_GENERATION}/${dataId}/account/${encodeURIComponent(baseURL)}/${encodeURIComponent(principalId)}`;
}

/**
 * Delete the browser storage that came before the account-scoped address.
 *
 * Two superseded shapes, neither of them read: `epicenter-store-<definition id>`,
 * the single definition from before an application had two documents, which held
 * anonymous work or an account replica indistinguishably; and
 * `epicenter-store-<definition id>#private` / `#database`, the per-application
 * split that separated the two documents but left an account replica with no
 * owner, so a second account would have opened the first account's bytes.
 * Neither is the final address, so both are deleted rather than renamed,
 * merged, or reinterpreted: the browser-storage twin of the format wipe in
 * ADR-0231's cutover.
 *
 * Never rejects, because a dead artifact must not block a boot: a delete
 * blocked by another tab completes when that tab closes, and running again at
 * every open makes the deletion certain without anyone waiting on it.
 */
function deleteSupersededStorage(
	dataId: string,
	owner: 'local' | 'account',
	principalId?: PrincipalId,
): Promise<void> {
	const superseded = [
		`epicenter-store-${dataId}`,
		`epicenter-store-${dataId}#private`,
		`epicenter-store-${dataId}#database`,
		owner === 'local'
			? `epicenter/${dataId}/private`
			: `epicenter/${dataId}/database/${principalId}`,
		// Everything written before the generation entered the address. There
		// is no migration and there never was one: a record under an older
		// shape was always wiped, and now it is simply somewhere else.
		owner === 'local'
			? `epicenter/${dataId}/local`
			: `epicenter/${dataId}/account/${principalId}`,
	];
	return Promise.all(
		superseded.map(
			(name) =>
				new Promise<void>((resolve) => {
					const request = indexedDB.deleteDatabase(name);
					request.onsuccess = () => resolve();
					request.onerror = () => resolve();
					request.onblocked = () => resolve();
				}),
		),
	).then(() => undefined);
}

/**
 * Open this browser's device-owned document for the application this definition
 * names.
 *
 * This document has no remote authority, so it carries neither an outbox nor
 * replica-only verbs, and no verb that could delete it. It can remain open
 * while an account replica is open too.
 */
export async function openLocal<const TDatabase extends DataDefinition>(
	definition: TDatabase,
): Promise<
	Result<DataOf<TDatabase, LocalStore>, StoreError | DataDefinitionParseError>
> {
	// Parsed before anything is claimed or opened: a declaration may arrive as
	// data, and a refusal here is a boot outcome rather than a programmer
	// error (ADR-0240).
	const { data: parsed, error: parseError } = parseData(definition);
	if (parseError !== null) return Err(parseError);

	const address = localAddress(parsed.id);
	const { error: claimError } = await claimDocument(address);
	if (claimError !== null) return Err(claimError);

	await deleteSupersededStorage(parsed.id, 'local');

	const opened = await openIdbBacking(address, false);
	if (opened.error !== null) {
		releaseDocument(address);
		return Err(opened.error);
	}
	const backing = opened.data;

	// What can throw here is the hydration replay meeting a stored update it
	// cannot decode, which is "the store could not read its durable record":
	// contained so a corrupt record refuses the boot instead of leaking the
	// claim and the open connections.
	let parts: {
		store: LocalStore;
		view: UntypedDataView;
		definition: ParsedDataDefinition;
	};
	try {
		parts = createLocalStoreOverPort({
			definition: parsed,
			durable: backing.port,
			loaded: backing.loaded,
			dispose: () => {
				backing.close();
				releaseDocument(address);
			},
		});
	} catch (cause) {
		backing.close();
		releaseDocument(address);
		return StoreError.StorageFailed({ cause });
	}
	const { store, view } = parts;

	return Ok(
		asData<TDatabase, LocalStore>(
			store,
			// Through `unknown` deliberately: comparing the untyped view with
			// `DataView<TDatabase>` re-enters the per-field descriptor
			// instantiation and exceeds the depth limit.
			view as unknown as DataView<TDatabase>,
		),
	);
}

/** Open this device's retained replica of one account's document. */
export async function openAccount<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	{ baseURL, principalId }: { baseURL: string; principalId: PrincipalId },
): Promise<
	Result<
		DataOf<TDatabase, BrowserAccountStore>,
		StoreError | DataDefinitionParseError
	>
> {
	const canonicalURL = canonicalBaseURL(baseURL);
	if (canonicalURL === undefined || principalId.trim() === '') {
		return StoreError.Unaddressable();
	}

	const { data: parsed, error: parseError } = parseData(definition);
	if (parseError !== null) return Err(parseError);

	const address = accountAddress(parsed.id, {
		baseURL: canonicalURL,
		principalId,
	});
	const { error: claimError } = await claimDocument(address);
	if (claimError !== null) return Err(claimError);

	await deleteSupersededStorage(parsed.id, 'account', principalId);

	const opened = await openIdbBacking(address, true);
	if (opened.error !== null) {
		releaseDocument(address);
		return Err(opened.error);
	}
	const backing = opened.data;

	// Contained for the same reason the device open is: a hydration replay
	// that throws must refuse the boot, not leak the claim.
	let parts: {
		store: AccountStore;
		view: UntypedDataView;
		definition: ParsedDataDefinition;
	};
	try {
		parts = createAccountStoreOverPort({
			definition: parsed,
			durable: backing.port,
			loaded: backing.loaded,
			dispose: () => {
				backing.close();
				releaseDocument(address);
			},
		});
	} catch (cause) {
		backing.close();
		releaseDocument(address);
		return StoreError.StorageFailed({ cause });
	}
	const { store, view } = parts;

	const replicaStore: BrowserAccountStore = Object.freeze({
		...store,
		baseURL: canonicalURL,
		principalId,
		async discard(): Promise<Result<void, StoreError>> {
			// Dispose first: the engine drains its queue and stops, and our own
			// IndexedDB connection closes, so the delete is not blocked by
			// ourselves and no flush can re-create the definition mid-delete.
			await store[Symbol.asyncDispose]();
			return tryAsync({
				try: () => deleteIndexedDb(address),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
		},
	});

	return Ok(
		asData<TDatabase, BrowserAccountStore>(
			replicaStore,
			view as unknown as DataView<TDatabase>,
		),
	);
}
