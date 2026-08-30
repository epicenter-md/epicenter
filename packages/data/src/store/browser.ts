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
import type { PrincipalId } from '@epicenter/principal';
import {
	GENERATIONS_ROUTE,
	LOG_POSITION_HEADER,
} from '@epicenter/sync/generations-route';
import * as Y from '@y/y';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { claimDocument, releaseDocument } from './claims.js';
import {
	copyBytes,
	NO_AUTHORITY,
	replay,
	SNAPSHOT_FOLD_THRESHOLD,
} from './log.js';
import { requestPersistentStorage } from './persist.js';
import type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
} from './persistence.js';
import {
	type AccountStore,
	createAccountStoreOverPort,
	createLocalStoreOverPort,
	type DataOf,
	type DataView,
	type LocalStore,
	StoreError,
	type UntypedDataView,
} from './store.js';

// And the collection an application asks which generations exist. It is the
// transport package's vocabulary, but an app that opens a database should not
// have to depend on the transport to ask that question, and the opener here
// already speaks it.
export {
	GENERATIONS_ROUTE,
	LOG_POSITION_HEADER,
} from '@epicenter/sync/generations-route';
// Re-exported so a browser caller's one import site names both kinds beside
// the openers that produce them.
export type { AccountStore, LocalStore } from './store.js';

/**
 * One generation of one account's database, held on this device.
 *
 * It carries no `discard`. A superseded replica used to discard and rejoin at
 * zero, because one address held whatever the authority currently was; a
 * generation is created once and never mutated in place, so moving to a newer
 * one is opening a different address and this one is simply an older copy
 * (ADR-0292). Deleting it is a storage decision, not a correctness one.
 */
export type BrowserAccountStore = AccountStore & {
	/** The canonical server identity this replica belongs to. */
	readonly baseURL: string;
	/** The principal asserted by that server for this replica. */
	readonly principalId: PrincipalId;
};

/**
 * The durable facts, one object store each (ADR-0238, ADR-0295).
 *
 * One object store, `updates`: this generation's Yjs update log, keyed by the
 * append id the store assigned. The outbox and the cursor are read off it
 * rather than kept beside it. The name is persisted; changing it requires an
 * IndexedDB migration.
 *
 * Two stores are gone with the designs they served. `tombstones` went with the
 * document split (ADR-0295): there is no second address a row deletion could
 * retire. `identity` went with the membership stamp (ADR-0292): the generation
 * is in the address, so a record here can only belong to the history its name
 * says it does.
 */
type StoredUpdateRecord = {
	bytes: Uint8Array;
	/** `null` is owed: the authority has no position for these bytes. */
	authoritySeq: number | null;
};

type BrowserDurableSchema = DBSchema & {
	updates: { key: number; value: StoredUpdateRecord };
};

type BrowserDurableDatabase = IDBPDatabase<BrowserDurableSchema>;

const DURABLE_STORES = ['updates'] as const;

function openIndexedDb(address: string): Promise<BrowserDurableDatabase> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		// Version 1, because the address carries the generation: a shape change
		// strands the old record at a name nothing opens rather than upgrading it
		// in place, so this database is only ever created, never migrated.
		void openDB<BrowserDurableSchema>(address, 1, {
			upgrade(sqlite) {
				for (const name of DURABLE_STORES) {
					if (!sqlite.objectStoreNames.contains(name)) {
						sqlite.createObjectStore(name);
					}
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
			await read.done;

			// One pass over the chain answers everything the snapshot holds, which
			// is the shape of the collapse: the outbox and the cursor are read off
			// the appends rather than kept beside them.
			const stored: { id: number; bytes: Uint8Array }[] = [];
			const outbox: OutboxEntry[] = [];
			let cursor = 0;
			let lastId = 0;
			for (const [index, row] of rows.entries()) {
				const id = ids[index] as number;
				if (id > lastId) lastId = id;
				stored.push({ id, bytes: copyBytes(row.bytes) });
				if (row.authoritySeq === null) {
					// A store with no authority owes nobody, and nothing would read
					// the result: there is no sender.
					if (syncs) outbox.push({ id, bytes: copyBytes(row.bytes) });
				} else if (row.authoritySeq > cursor) {
					cursor = row.authoritySeq;
				}
			}
			stored.sort((a, b) => a.id - b.id);
			outbox.sort((a, b) => a.id - b.id);
			let held = stored.length;

			const loaded: DurableSnapshot = {
				updates: stored.map((row) => row.bytes),
				outbox,
				cursor,
				lastId,
			};

			const port: DurablePort = {
				async commit(ops: readonly DurableOp[]): Promise<void> {
					const transaction = durable.transaction(DURABLE_STORES, 'readwrite');
					const updates = transaction.objectStore('updates');
					let chain = held;
					let grew = false;
					for (const op of ops) {
						switch (op.kind) {
							case 'append': {
								void updates.put(
									{
										bytes: copyBytes(op.bytes),
										authoritySeq: op.authoritySeq ?? null,
									},
									op.id,
								);
								chain += 1;
								grew = true;
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
										grew = true;
									}
									at = await at.continue();
								}
								break;
							}
						}
					}

					// The same fold the SQL engine applies, with the same one
					// question: a store that syncs collapses only the acknowledged
					// prefix, because the sender offers owed appends individually
					// and an ack names them by id. A store that does not sync
					// collapses everything, because nothing reads its owed work.
					if (grew && chain >= SNAPSHOT_FOLD_THRESHOLD) {
						const foldable: { id: number; bytes: Uint8Array }[] = [];
						let position: number | null = null;
						let at = await updates.openCursor();
						while (at !== null) {
							const row = at.value;
							if (!syncs || row.authoritySeq !== null) {
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
						const through = foldable.at(-1)?.id;
						if (
							foldable.length >= SNAPSHOT_FOLD_THRESHOLD &&
							through !== undefined
						) {
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
									bytes: baseline,
									authoritySeq: syncs ? position : NO_AUTHORITY,
								},
								through,
							);
							chain = chain - foldable.length + 1;
						}
					}

					await transaction.done;
					// Advanced only after the batch landed, so a retried batch
					// recomputes from the same starting point.
					held = chain;
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
 *
 * `v2` is the collapse (ADR-0295). A `v1` record keyed its updates by the
 * document they belonged to and kept a `tombstones` store beside them; a
 * database is one document now, so those rows are a shape this reader cannot
 * honestly interpret. Stranding them is the answer, not a migration.
 */
const STORE_GENERATION = 'v2';

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

/**
 * Where one database's generations live on this device, up to the number
 * (ADR-0292).
 *
 * ```txt
 * epicenter/v2/<dataId>/local/gen/
 * epicenter/v2/<dataId>/account/<baseURL>/<principalId>/gen/
 * ```
 *
 * The PREFIX rather than an address, because both callers want it: one appends
 * a number to open exactly that generation, the other matches it to enumerate
 * what this device holds. It used to be an address function that enumeration
 * called with generation zero and then chopped the last character off, which
 * worked only while zero rendered as one digit.
 *
 * Both account segments are percent-encoded, because a base URL contains `://`
 * and may keep a path prefix. The generation is the last segment and is a
 * NUMBER: enumeration parses it rather than sorting it, because `gen/9` sorts
 * above `gen/10`.
 *
 * The generation being IN the address is what retires the document identity
 * stamp. A record at this name can only belong to this generation, so there is
 * nothing to compare on a dial and nothing a stale replica could merge into.
 *
 * Refusing here is what keeps one deployment from being two: an account whose
 * URL cannot be canonicalized has no address, rather than an address under
 * whatever the caller happened to spell.
 */
function generationPrefix(
	dataId: string,
	account?: { baseURL: string; principalId: PrincipalId },
): Result<{ prefix: string; baseURL: string | undefined }, StoreError> {
	const root = `epicenter/${STORE_GENERATION}/${dataId}`;
	if (account === undefined) {
		return Ok({ prefix: `${root}/local/gen/`, baseURL: undefined });
	}
	const baseURL = canonicalBaseURL(account.baseURL);
	if (baseURL === undefined || account.principalId.trim() === '') {
		return StoreError.Unaddressable({
			reason: 'an account generation needs a server URL and a principal',
		});
	}
	return Ok({
		prefix: `${root}/account/${encodeURIComponent(baseURL)}/${encodeURIComponent(account.principalId)}/gen/`,
		baseURL,
	});
}

/**
 * A generation number, admitted or refused at the boundary (ADR-0292).
 *
 * `Number.isSafeInteger(n) && n >= 1`, checked inline like any other bad
 * input, because that is what it is: a route parses a URL segment and may hand
 * over `NaN`. The answer to that is `Unaddressable`, not `GenerationNotFound`;
 * conflating them would tell a person a generation is missing when what they
 * typed was never a generation at all.
 */
function isGeneration(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1;
}

/**
 * The account half of an address, and how this device reaches its authority.
 *
 * A two-member port rather than an `AuthClient`, for the same reason
 * `attach.ts` takes one: it keeps this file free of the auth package, and an
 * `AuthClient` satisfies it structurally with no adapter. `fetch` is here and
 * not in `attach` because opening a generation this device does not hold is an
 * HTTP request, not a socket (ADR-0292).
 */
export type DatabaseAccount = {
	readonly baseURL: string;
	readonly principalId: PrincipalId;
	/** A credentialed fetch, waiting on machine work but never on a human. */
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
};

export type OpenDatabaseOptions = {
	/** The exact generation to open. Never discovered, never defaulted. */
	generation: number;
	/**
	 * The account this generation belongs to, or absent for a device-owned one.
	 *
	 * The VALUE is the discriminant, all the way down: it decides the address,
	 * whether the store carries an outbox, and whether a cache miss can be
	 * bootstrapped or is simply not here.
	 */
	account?: DatabaseAccount;
};

/**
 * The bytes one generation is, and the log position they are current through.
 *
 * The position is what makes the bootstrap worth making. Without it a device
 * would seed a cursor of zero, dial, and be handed the authority's snapshot,
 * which is the same state it just downloaded; with it the socket carries only
 * what happened after.
 */
async function fetchGeneration(
	account: DatabaseAccount,
	dataId: string,
	generation: number,
): Promise<Result<{ bytes: Uint8Array; position: number }, StoreError>> {
	const url = GENERATIONS_ROUTE.item(account.baseURL, dataId, generation);
	let response: Response;
	try {
		response = await account.fetch(url);
	} catch (cause) {
		return StoreError.GenerationUnavailable({ dataId, generation, cause });
	}
	// 404 is the one answer that is a fact about the generation rather than
	// about the moment. Everything else, including 401, is retryable: a token
	// that expired mid-boot is not a missing generation.
	if (response.status === 404) {
		return StoreError.GenerationNotFound({ dataId, generation });
	}
	if (!response.ok) {
		return StoreError.GenerationUnavailable({
			dataId,
			generation,
			status: response.status,
		});
	}
	try {
		const bytes = new Uint8Array(await response.arrayBuffer());
		const header = response.headers.get(LOG_POSITION_HEADER);
		const position = header === null ? 0 : Number(header);
		return Ok({
			bytes,
			position: Number.isSafeInteger(position) && position >= 0 ? position : 0,
		});
	} catch (cause) {
		return StoreError.GenerationUnavailable({ dataId, generation, cause });
	}
}

/**
 * Open one exact generation of one database, cache-first (ADR-0292).
 *
 * One opener, not two. The stores differ by one key, `sync`, which is already
 * the discriminant the types carry, and the second half of each open was the
 * same address, claim, and hydrate either way.
 *
 * The sequence, and every step of it is load-bearing:
 *
 * 1. Open the exact address and read what is there.
 * 2. **A cache hit is the presence of STATE, not the presence of the name.**
 *    `openDB` on a missing name creates it, so a name-existence test would
 *    fabricate the empty database it was asked about and every later open
 *    would read that shell as a hit.
 * 3. On a hit: hydrate and return. The caller attaches a socket afterwards if
 *    it has an account; a cached database stays usable when that fails.
 * 4. On a miss with no account: `GenerationNotFound`. Opening never invents a
 *    local generation, because a number in a URL is an address rather than an
 *    instruction to allocate.
 * 5. On a miss with an account: fetch the generation, write it in one
 *    transaction, hydrate, and only then return. It bootstraps completely or
 *    fails; a fresh account database never renders empty while its state is
 *    still arriving.
 *
 * It resolves once local state is durable enough to hydrate. It never waits on
 * a WebSocket round trip, and it does not attach one.
 */
export function openDatabase<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	options: OpenDatabaseOptions & { account: DatabaseAccount },
): Promise<
	Result<
		DataOf<TDatabase, BrowserAccountStore>,
		StoreError | DataDefinitionParseError
	>
>;
export function openDatabase<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	options: OpenDatabaseOptions & { account?: undefined },
): Promise<
	Result<DataOf<TDatabase, LocalStore>, StoreError | DataDefinitionParseError>
>;
export async function openDatabase<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	{ generation, account }: OpenDatabaseOptions,
): Promise<
	Result<
		DataOf<TDatabase, LocalStore | BrowserAccountStore>,
		StoreError | DataDefinitionParseError
	>
> {
	if (!isGeneration(generation)) {
		return StoreError.Unaddressable({
			reason: `'${generation}' is not a generation number`,
		});
	}
	// Parsed before anything is claimed or opened: a declaration may arrive as
	// data, and a refusal here is a boot outcome rather than a programmer
	// error (ADR-0240).
	const { data: parsed, error: parseError } = parseData(definition);
	if (parseError !== null) return Err(parseError);

	const located = generationPrefix(parsed.id, account);
	if (located.error !== null) return Err(located.error);
	const canonicalURL = located.data.baseURL;

	// Asked here rather than by an application, because this is the one place
	// that knows durable storage is about to matter, and because an eviction
	// has no event: an origin's data goes wholesale and the next boot simply
	// finds nothing. Not awaited, and a refusal is ordinary.
	void requestPersistentStorage();

	const address = `${located.data.prefix}${generation}`;
	const { error: claimError } = await claimDocument(address);
	if (claimError !== null) return Err(claimError);

	const opened = await openIdbBacking(address, account !== undefined);
	if (opened.error !== null) {
		releaseDocument(address);
		return Err(opened.error);
	}
	let backing = opened.data;

	if (backing.loaded.updates.length === 0) {
		// A miss. Whatever happens next, the shell this open just created must
		// not be left behind reading as a hit.
		if (account === undefined) {
			backing.close();
			releaseDocument(address);
			await deleteIndexedDb(address).catch(() => undefined);
			return StoreError.GenerationNotFound({
				dataId: parsed.id,
				generation,
			});
		}
		const fetched = await fetchGeneration(account, parsed.id, generation);
		if (fetched.error !== null) {
			backing.close();
			releaseDocument(address);
			await deleteIndexedDb(address).catch(() => undefined);
			return Err(fetched.error);
		}
		// One transaction, after the whole body has been read, so a failed
		// bootstrap leaves no half-written database. The position rides on the
		// append, which is where every cursor is read from (ADR-0298).
		const { error: writeError } = await tryAsync({
			try: () =>
				Promise.resolve(
					backing.port.commit([
						{
							kind: 'append',
							id: 1,
							bytes: fetched.data.bytes,
							authoritySeq: fetched.data.position,
						},
					]),
				),
			catch: (cause) => StoreError.StorageFailed({ cause }),
		});
		if (writeError !== null) {
			backing.close();
			releaseDocument(address);
			return Err(writeError);
		}
		// Reopened rather than patched in memory: what hydrates has to be what
		// a later boot would read, and a snapshot assembled here would be a
		// second answer to that question.
		backing.close();
		const reopened = await openIdbBacking(address, true);
		if (reopened.error !== null) {
			releaseDocument(address);
			return Err(reopened.error);
		}
		backing = reopened.data;
	}

	const held = backing;
	// What can throw here is the hydration replay meeting a stored update it
	// cannot decode, which is "the store could not read its durable record":
	// contained so a corrupt record refuses the boot instead of leaking the
	// claim and the open connection.
	let parts: {
		store: LocalStore | AccountStore;
		view: UntypedDataView;
		definition: ParsedDataDefinition;
	};
	try {
		parts =
			account === undefined
				? createLocalStoreOverPort({
						definition: parsed,
						durable: held.port,
						loaded: held.loaded,
						dispose: () => {
							held.close();
							releaseDocument(address);
						},
					})
				: createAccountStoreOverPort({
						definition: parsed,
						durable: held.port,
						loaded: held.loaded,
						dispose: () => {
							held.close();
							releaseDocument(address);
						},
					});
	} catch (cause) {
		held.close();
		releaseDocument(address);
		return StoreError.StorageFailed({ cause });
	}

	if (account === undefined || canonicalURL === undefined) {
		return Ok(
			Object.freeze({
				// Through `unknown` deliberately: comparing the untyped view with
				// `DataView<TDatabase>` re-enters the per-field descriptor
				// instantiation and exceeds the depth limit.
				...(parts.view as unknown as DataView<TDatabase>),
				...(parts.store as LocalStore),
			}),
		);
	}
	return Ok(
		Object.freeze({
			...(parts.view as unknown as DataView<TDatabase>),
			...(parts.store as AccountStore),
			baseURL: canonicalURL,
			principalId: account.principalId,
		}),
	);
}

/**
 * Write one generation's whole state into this device's own storage.
 *
 * The last step of an import (ADR-0293), and the only way a generation comes
 * into being on a device: a folder is parsed into one Yjs document, its state
 * is one blob, and the blob is written at that generation's address. The
 * number is already known, because the address contains it.
 *
 * `position` is where the authority put those bytes, and zero for a
 * device-owned generation that no authority has ever seen. It becomes the
 * store's cursor, derived off this append like every other one.
 *
 * Refuses an address that already holds state rather than adding to it. A
 * generation is created once and never mutated in place, so a second write
 * here would be a caller confusing import with sync.
 *
 * Not exported. Both call sites are `importGeneration` below, and the split is
 * the two halves of one operation rather than a surface: without a number
 * there is nothing to write under, and choosing the number is what
 * `importGeneration` is for.
 */
async function writeGeneration({
	dataId,
	generation,
	state,
	account,
	position = 0,
}: {
	dataId: string;
	generation: number;
	state: Uint8Array;
	account?: { baseURL: string; principalId: PrincipalId };
	position?: number;
}): Promise<Result<void, StoreError>> {
	if (!isGeneration(generation)) {
		return StoreError.Unaddressable({
			reason: `'${generation}' is not a generation number`,
		});
	}
	const located = generationPrefix(dataId, account);
	if (located.error !== null) return Err(located.error);
	const address = `${located.data.prefix}${generation}`;

	const { error: claimError } = await claimDocument(address);
	if (claimError !== null) return Err(claimError);
	try {
		const opened = await openIdbBacking(address, account !== undefined);
		if (opened.error !== null) return Err(opened.error);
		const backing = opened.data;
		try {
			if (backing.loaded.updates.length > 0) {
				return StoreError.AlreadyOpen({ address });
			}
			await backing.port.commit([
				{ kind: 'append', id: 1, bytes: state, authoritySeq: position },
			]);
			return Ok(undefined);
		} catch (cause) {
			return StoreError.StorageFailed({ cause });
		} finally {
			backing.close();
		}
	} finally {
		releaseDocument(address);
	}
}

/**
 * Bring one generation into being from a whole database state (ADR-0293).
 *
 * The second half of an import, and the split is where ADR-0293's diagram puts
 * it: the CLIENT parses the folder with the application's own codecs and
 * builds one Yjs document (`readArtifact`), and this takes the state that came
 * out and gives it a number and an address. Keeping the parse outside means an
 * opener does not carry the artifact layer, and it is the same call either way.
 *
 * **The client never chooses the number.** With an account the authority
 * assigns it: the state is posted whole, stored whole, and the ledger row is
 * written last, so a generation exists if and only if it is listed. Without
 * one the device assigns it, by reading the addresses it already holds, which
 * is the same operation with the network step removed rather than a second
 * feature.
 *
 * The local write happens strictly AFTER the number is known, because the
 * address contains it. Both paths end identically, with bytes at a generation's
 * address that `openDatabase` will find as a cache hit.
 *
 * **Never retry this blindly.** If a response is lost after the authority
 * created the generation, listing and comparing the maximum answers what
 * happened: higher means the import landed and that is its number, unchanged
 * means it did not.
 */
export async function importGeneration(
	definition: DataDefinition,
	state: Uint8Array,
	{ account }: { account?: DatabaseAccount } = {},
): Promise<
	Result<{ generation: number }, StoreError | DataDefinitionParseError>
> {
	const { data: parsed, error: parseError } = parseData(definition);
	if (parseError !== null) return Err(parseError);

	if (account === undefined) {
		const held = await listLocalGenerations(parsed.id);
		const generation = (held.at(-1) ?? 0) + 1;
		const { error } = await writeGeneration({
			dataId: parsed.id,
			generation,
			state,
		});
		return error === null ? Ok({ generation }) : Err(error);
	}

	const canonicalURL = canonicalBaseURL(account.baseURL);
	if (canonicalURL === undefined || account.principalId.trim() === '') {
		return StoreError.Unaddressable({
			reason: 'an account import needs a server URL and a principal',
		});
	}
	const posted = await postGeneration(account, parsed.id, state);
	if (posted.error !== null) return Err(posted.error);
	const { error } = await writeGeneration({
		dataId: parsed.id,
		generation: posted.data.generation,
		state,
		account: { baseURL: canonicalURL, principalId: account.principalId },
		position: posted.data.position,
	});
	return error === null
		? Ok({ generation: posted.data.generation })
		: Err(error);
}

/** Post one whole state and hear back the number the authority gave it. */
async function postGeneration(
	account: DatabaseAccount,
	dataId: string,
	state: Uint8Array,
): Promise<Result<{ generation: number; position: number }, StoreError>> {
	let response: Response;
	try {
		response = await account.fetch(
			GENERATIONS_ROUTE.collection(account.baseURL, dataId),
			{
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: state as unknown as BodyInit,
			},
		);
	} catch (cause) {
		return StoreError.GenerationUnavailable({ dataId, generation: 0, cause });
	}
	if (!response.ok) {
		return StoreError.GenerationUnavailable({
			dataId,
			generation: 0,
			status: response.status,
		});
	}
	try {
		const body = (await response.json()) as {
			generation?: number;
			position?: number;
		};
		if (!Number.isSafeInteger(body.generation) || (body.generation ?? 0) < 1) {
			return StoreError.GenerationUnavailable({
				dataId,
				generation: 0,
				status: response.status,
			});
		}
		return Ok({
			generation: body.generation as number,
			position: Number.isSafeInteger(body.position)
				? (body.position as number)
				: 0,
		});
	} catch (cause) {
		return StoreError.GenerationUnavailable({ dataId, generation: 0, cause });
	}
}

/**
 * Every generation of this database this device holds, ascending (ADR-0292).
 *
 * Parsed rather than sorted, because `gen/9` sorts above `gen/10`. Used to
 * assign the next number for a device-owned import, and to answer "which
 * generations does this device have" without a second index to keep true.
 */
export async function listLocalGenerations(
	dataId: string,
	account?: { baseURL: string; principalId: PrincipalId },
): Promise<number[]> {
	const located = generationPrefix(dataId, account);
	// An account with no address holds nothing addressable, so there is nothing
	// here to find. `openDatabase` refuses the same input loudly; this one is a
	// question about what is on disk and the honest answer is "none".
	if (located.error !== null) return [];
	const { prefix } = located.data;
	const names = (await indexedDB.databases())
		.map(({ name }) => name)
		.filter((name): name is string => name !== undefined);
	const generations: number[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const parsed = Number(name.slice(prefix.length));
		if (isGeneration(parsed)) generations.push(parsed);
	}
	return generations.sort((left, right) => left - right);
}
