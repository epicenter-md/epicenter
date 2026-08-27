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
	replay,
	SNAPSHOT_FOLD_THRESHOLD,
	STORE_FORMAT,
} from './log.js';
import type { DurableOp, DurablePort, DurableSnapshot } from './persistence.js';
import {
	type AccountStore,
	asData,
	createAccountStoreOverPort,
	createDeviceStoreOverPort,
	type DataOf,
	type DataView,
	type DeviceStore,
	StoreError,
	type UntypedDataView,
} from './store.js';

// Re-exported so a browser caller's one import site names both kinds beside
// the openers that produce them.
export type { AccountStore, DeviceStore } from './store.js';

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
type BrowserDurableSchema = DBSchema & {
	updates: { key: [string, number]; value: Uint8Array };
	outbox: { key: number; value: { document: string; bytes: Uint8Array } };
	tombstones: { key: string; value: 1 };
	meta: { key: 'format' | 'cursor' | 'document'; value: string | number };
};

type BrowserDurableDatabase = IDBPDatabase<BrowserDurableSchema>;

const DURABLE_STORES = ['updates', 'outbox', 'tombstones', 'meta'] as const;

/** Every key under one document's chain, in seq order. */
function documentRange(document: string): IDBKeyRange {
	return IDBKeyRange.bound([document, 0], [document, Infinity]);
}

function openIndexedDb(address: string): Promise<BrowserDurableDatabase> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		void openDB<BrowserDurableSchema>(address, 3, {
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
type BrowserBacking = {
	port: DurablePort;
	loaded: DurableSnapshot;
	close(): void;
};

async function openIdbBacking(
	address: string,
): Promise<Result<BrowserBacking, StoreError>> {
	return tryAsync({
		try: async () => {
			const durable = await openIndexedDb(address);

			// The format at open, exactly as the SQLite engine enforces it
			// (ADR-0231, ADR-0248): a record certified under another format, or
			// holding state without a certificate, is untrusted whole, so it is
			// wiped and the replica rejoins from zero; a fresh record is simply
			// certified. One transaction, so a crash converges at the next open.
			const enforce = durable.transaction(DURABLE_STORES, 'readwrite');
			const meta = enforce.objectStore('meta');
			const format = (await meta.get('format')) as string | undefined;
			if (format !== STORE_FORMAT) {
				await enforce.objectStore('updates').clear();
				await enforce.objectStore('outbox').clear();
				await enforce.objectStore('tombstones').clear();
				await meta.clear();
				void meta.put(STORE_FORMAT, 'format');
			}
			await enforce.done;

			const read = durable.transaction(DURABLE_STORES, 'readonly');
			const appRows = await read
				.objectStore('updates')
				.getAll(documentRange(APP_DOCUMENT));
			const updateKeys = await read.objectStore('updates').getAllKeys();
			const outboxRows = await read.objectStore('outbox').getAll();
			const outboxKeys = await read.objectStore('outbox').getAllKeys();
			const tombstones = await read.objectStore('tombstones').getAllKeys();
			const cursor = (await read.objectStore('meta').get('cursor')) as
				| number
				| undefined;
			const identity = (await read.objectStore('meta').get('document')) as
				| string
				| undefined;
			await read.done;

			const loaded: DurableSnapshot = {
				// `getAll` returns key order, which is the append order.
				updates: appRows.map((bytes) => copyBytes(bytes)),
				outbox: outboxRows.map((row, index) => ({
					id: outboxKeys[index] as number,
					document: row.document,
					bytes: copyBytes(row.bytes),
				})),
				cursor: cursor ?? 0,
				identity,
				tombstones: tombstones.map((key) => String(key)),
			};

			// The port's own bookkeeping, per document, committed only when a
			// batch lands so a failed transaction never advances it.
			const nextSeq = new Map<string, number>();
			const updateCount = new Map<string, number>();
			for (const key of updateKeys) {
				const [document, seq] = key as [string, number];
				nextSeq.set(document, Math.max(nextSeq.get(document) ?? 1, seq + 1));
				updateCount.set(document, (updateCount.get(document) ?? 0) + 1);
			}

			const port: DurablePort = {
				async commit(ops: readonly DurableOp[]): Promise<void> {
					const transaction = durable.transaction(DURABLE_STORES, 'readwrite');
					const updates = transaction.objectStore('updates');
					const outbox = transaction.objectStore('outbox');
					const tombstonesStore = transaction.objectStore('tombstones');
					const metaStore = transaction.objectStore('meta');
					const seqs = new Map(nextSeq);
					const counts = new Map(updateCount);
					const touched = new Set<string>();
					for (const op of ops) {
						switch (op.kind) {
							case 'append': {
								const seq = seqs.get(op.document) ?? 1;
								void updates.put(copyBytes(op.bytes), [op.document, seq]);
								seqs.set(op.document, seq + 1);
								counts.set(op.document, (counts.get(op.document) ?? 0) + 1);
								touched.add(op.document);
								if (op.outboxId !== undefined) {
									void outbox.put(
										{ document: op.document, bytes: copyBytes(op.bytes) },
										op.outboxId,
									);
								}
								break;
							}
							case 'cursor':
								void metaStore.put(op.seq, 'cursor');
								break;
							case 'identity':
								void metaStore.put(op.id, 'document');
								break;
							case 'dropOutbox':
								void outbox.delete(IDBKeyRange.upperBound(op.throughId));
								break;
							case 'replaceOutbox': {
								// One document's covered entries collapse to one merged
								// entry at its own highest id; other documents' entries
								// keep their places, so the walk is per entry.
								let at = await outbox.openCursor(
									IDBKeyRange.upperBound(op.throughId),
								);
								while (at !== null) {
									if (at.value.document === op.document) {
										await at.delete();
									}
									at = await at.continue();
								}
								void outbox.put(
									{ document: op.document, bytes: copyBytes(op.merged) },
									op.throughId,
								);
								break;
							}
							case 'retire': {
								void tombstonesStore.put(1, op.document);
								void updates.delete(documentRange(op.document));
								seqs.delete(op.document);
								counts.delete(op.document);
								touched.delete(op.document);
								let at = await outbox.openCursor();
								while (at !== null) {
									if (at.value.document === op.document) {
										await at.delete();
									}
									at = await at.continue();
								}
								break;
							}
						}
					}
					// The same per-document fold the SQLite engine applies, inside
					// the same transaction as the appends that crossed the
					// threshold: read the chain, replay it into one baseline,
					// rewrite. The replay is synchronous, so the transaction stays
					// active.
					for (const document of touched) {
						if ((counts.get(document) ?? 0) < SNAPSHOT_FOLD_THRESHOLD) {
							continue;
						}
						const chain = await updates.getAll(documentRange(document));
						const folded = replay(
							chain.map((bytes, index) => ({
								seq: index + 1,
								bytes: copyBytes(bytes),
							})),
						);
						let baseline: Uint8Array;
						try {
							baseline = new Uint8Array(Y.encodeStateAsUpdateV2(folded));
						} finally {
							folded.destroy();
						}
						void updates.delete(documentRange(document));
						void updates.put(baseline, [document, 1]);
						seqs.set(document, 2);
						counts.set(document, 1);
					}
					await transaction.done;
					for (const [document, seq] of seqs) nextSeq.set(document, seq);
					for (const document of [...nextSeq.keys()]) {
						if (!seqs.has(document)) nextSeq.delete(document);
					}
					for (const [document, count] of counts) {
						updateCount.set(document, count);
					}
					for (const document of [...updateCount.keys()]) {
						if (!counts.has(document)) updateCount.delete(document);
					}
				},
				async readDocument(document: string): Promise<Uint8Array[]> {
					const rows = await durable.getAll('updates', documentRange(document));
					return rows.map((bytes) => copyBytes(bytes));
				},
				async listDocuments(): Promise<string[]> {
					const keys = await durable.getAllKeys('updates');
					const documents = new Set<string>();
					for (const key of keys) {
						documents.add((key as [string, number])[0]);
					}
					return [...documents];
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
 * epicenter/<definition id>/device
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
function deviceAddress(databaseId: string): string {
	return `epicenter/${databaseId}/device`;
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
	databaseId: string,
	{ baseURL, principalId }: { baseURL: string; principalId: PrincipalId },
): string {
	return `epicenter/${databaseId}/account/${encodeURIComponent(baseURL)}/${encodeURIComponent(principalId)}`;
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
	databaseId: string,
	owner: 'device' | 'account',
	principalId?: PrincipalId,
): Promise<void> {
	const superseded = [
		`epicenter-store-${databaseId}`,
		`epicenter-store-${databaseId}#private`,
		`epicenter-store-${databaseId}#database`,
		owner === 'device'
			? `epicenter/${databaseId}/private`
			: `epicenter/${databaseId}/database/${principalId}`,
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
export async function openDevice<const TDatabase extends DataDefinition>(
	definition: TDatabase,
): Promise<
	Result<DataOf<TDatabase, DeviceStore>, StoreError | DataDefinitionParseError>
> {
	// Parsed before anything is claimed or opened: a declaration may arrive as
	// data, and a refusal here is a boot outcome rather than a programmer
	// error (ADR-0240).
	const { data: parsed, error: parseError } = parseData(definition);
	if (parseError !== null) return Err(parseError);

	const address = deviceAddress(parsed.id);
	const { error: claimError } = claimDocument(address);
	if (claimError !== null) return Err(claimError);

	await deleteSupersededStorage(parsed.id, 'device');

	const opened = await openIdbBacking(address);
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
		store: DeviceStore;
		view: UntypedDataView;
		definition: ParsedDataDefinition;
	};
	try {
		parts = createDeviceStoreOverPort({
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
	const { store, view, definition: parsedDefinition } = parts;

	return Ok(
		asData<TDatabase, DeviceStore>(
			store,
			// Through `unknown` deliberately: comparing the untyped view with
			// `DataView<TDatabase>` re-enters the per-field descriptor
			// instantiation and exceeds the depth limit.
			view as unknown as DataView<TDatabase>,
			parsedDefinition.definition,
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
	const { error: claimError } = claimDocument(address);
	if (claimError !== null) return Err(claimError);

	await deleteSupersededStorage(parsed.id, 'account', principalId);

	const opened = await openIdbBacking(address);
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
	const { store, view, definition: parsedDefinition } = parts;

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
			parsedDefinition.definition,
		),
	);
}
