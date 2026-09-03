/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread. The live Yjs document is the
 * source of truth, and the durable update log lives directly in IndexedDB.
 * Each record carries its authority position, so the outbox and cursor are
 * read from that same store and one flush is one atomic transaction (ADR-0238).
 * Every read a person makes
 * (`get`, `rows`, `ids`, `document`) comes from the `Y.Doc` already in
 * memory; SQL, when an application wants it, is a follower it composes over
 * this surface, so opening a store here loads no SQLite at all.
 *
 * ## Why IndexedDB owns the facts directly
 *
 * The previous shape snapshotted the whole in-memory SQLite (log, outbox,
 * cursor) into one IndexedDB checkpoint record after every commit. That
 * indirection stored one runtime's file format inside another's storage and
 * paid a whole-file write per commit. The update records now hold the only
 * durable facts, and the persistence controller's queue ordering keeps a
 * cursor from advancing before its bytes land (ADR-0238).
 *
 * y-indexeddb was considered and rejected: it exposes no public way to
 * participate in the transaction that records authority positions, and its
 * own debounce and compaction make its update store unreadable as the stable
 * log this transport needs.
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

import { isAppId } from '@epicenter/constants/app-id';
import {
	compileData,
	type DataDefinition,
	type DataDefinitionParseError,
	type ParsedDataDefinition,
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
import { createDatabaseDocument } from './document.js';
import type { DatabaseAccount } from './handles.js';
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
	createAccountStoreOverPort,
	type DataDocument,
	type DeclaredData,
	type ReplicaData,
	StoreError,
	type UntypedDeclaredData,
} from './store.js';

/**
 * What every opener here fails with, as a type.
 *
 * The CONSTRUCTORS stay internal: a store is what throws these, and nothing
 * outside builds one. The type is exported because a caller that holds an
 * opener's `Result` has to be able to name it, and `@epicenter/app`'s handle
 * does exactly that rather than wrapping it in an error of its own (ADR-0339).
 */
export type { StoreError } from './errors.js';
/**
 * One generation of one account's database, held on this device.
 *
 * It carries no `discard`. A superseded replica used to discard and rejoin at
 * zero, because one address held whatever the authority currently was; a
 * generation is created once and never mutated in place, so moving to a newer
 * one is opening a different address and this one is simply an older copy
 * (ADR-0292). Deleting it is a storage decision, not a correctness one.
 */
// Re-exported so a browser caller's one import site names the document beside
// the opener that produces it.
export type { DatabaseAccount } from './handles.js';
export type { DataDocument, ReplicaDocument } from './store.js';

/**
 * What one generation is bound to, written once and never rewritten
 * (ADR-0325).
 *
 * The canonical server identity and the verified principal: the two facts the
 * address stopped carrying when ADR-0324 reduced it to an application, a data
 * id, and a number. They have to live somewhere, because two authorities mint
 * generation numbers independently and Yjs merges rather than erroring, so
 * without this a `7` from one account silently interleaves with a `7` from
 * another.
 */
export type DatabaseBinding = {
	readonly baseURL: string;
	readonly principalId: PrincipalId;
};

/**
 * The durable facts, one object store each (ADR-0238, ADR-0295, ADR-0325).
 *
 * `updates` is this generation's Yjs update log, keyed by the append id the
 * store assigned. The outbox and the cursor are read off it rather than kept
 * beside it. `binding` holds one record, written in the transaction that
 * creates the generation. Both names are persisted; changing either requires
 * an IndexedDB migration.
 *
 * Two stores are gone with the designs they served. `tombstones` went with the
 * document split (ADR-0295): there is no second address a row deletion could
 * retire. `identity` went with the membership stamp (ADR-0292): the generation
 * is in the address, so a record here can only belong to the history its name
 * says it does. `binding` is not that stamp coming back. `identity` asked
 * which history these bytes were, which the address answers now; this asks
 * whose they are, which no address can answer, because a principal is asserted
 * by a remote party at first sign-in and local data can already exist by then.
 */
type StoredUpdateRecord = {
	bytes: Uint8Array;
	/** `null` is owed: the authority has no position for these bytes. */
	authoritySeq: number | null;
};

type BrowserDurableSchema = DBSchema & {
	updates: { key: number; value: StoredUpdateRecord };
	binding: { key: string; value: DatabaseBinding };
};

type BrowserDurableDatabase = IDBPDatabase<BrowserDurableSchema>;

const UPDATES_STORE = 'updates';
const BINDING_STORE = 'binding';
/** The one key `binding` ever holds. A generation is bound to one authority. */
const BINDING_KEY = 'binding';

function openIndexedDb(address: string): Promise<BrowserDurableDatabase> {
	// Version 1, and it is a constant rather than a starting point: the address
	// carries the storage generation, so a shape change strands the old record
	// at a name nothing opens rather than upgrading it in place. This database
	// is only ever created, never migrated.
	//
	// That is why there is no `blocked` handler here. `blocked` fires when a
	// versionchange transaction is needed while another connection is open,
	// which requires opening at a HIGHER version than a live connection holds.
	// With a constant 1 that can never be requested, so the handler this file
	// used to carry, and the flag and late-close branch around it, defended an
	// event the address scheme had already made unreachable. `deleteIndexedDb`
	// keeps its own: a delete always needs exclusive access, so that one fires.
	return openDB<BrowserDurableSchema>(address, 1, {
		upgrade(durable) {
			if (!durable.objectStoreNames.contains(UPDATES_STORE)) {
				durable.createObjectStore(UPDATES_STORE);
			}
			if (!durable.objectStoreNames.contains(BINDING_STORE)) {
				durable.createObjectStore(BINDING_STORE);
			}
		},
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
	/**
	 * Who this record was created for, or `undefined` when it holds nothing
	 * (ADR-0325).
	 *
	 * Read at open and compared. Nothing writes it but `create`, which makes a
	 * rebound database unrepresentable rather than detected.
	 */
	binding: DatabaseBinding | undefined;
	/**
	 * Bring this address into being: one whole state, its position, and the
	 * binding, in ONE transaction (ADR-0325).
	 *
	 * A separate verb rather than a `DurableOp`, because it is not one. The
	 * port is the seam two engines implement (`port-conformance.test.ts`) and a
	 * SQLite record writes its binding inside the transaction that creates the
	 * file's schema, which is a different mechanism for the same rule. What
	 * both promise is that a generation never exists unbound, not that they
	 * write it the same way.
	 *
	 * It does NOT check that the address is empty, and that is deliberate: both
	 * callers already branch on `loaded.updates.length` because they answer
	 * differently, and each holds the document claim across that branch, so a
	 * third check here would be a second guard saying a third thing.
	 */
	create(record: {
		bytes: Uint8Array;
		position: number;
		binding: DatabaseBinding;
	}): Promise<void>;
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
 * Not an opener. It hands back a port, what was loaded, and the binding;
 * composing a store over those is `openDatabase`'s job.
 */
export async function openIdbBacking(
	address: string,
): Promise<Result<BrowserBacking, StoreError>> {
	return tryAsync({
		try: async () => {
			const durable = await openIndexedDb(address);

			const read = durable.transaction(
				[UPDATES_STORE, BINDING_STORE],
				'readonly',
			);
			const updateStore = read.objectStore(UPDATES_STORE);
			const rows = await updateStore.getAll();
			const ids = (await updateStore.getAllKeys()) as number[];
			const binding = await read.objectStore(BINDING_STORE).get(BINDING_KEY);
			await read.done;

			// One pass over the chain answers everything the snapshot holds, which
			// is the shape of the collapse: the outbox and the cursor are read off
			// the appends rather than kept beside them.
			const stored: { id: number; bytes: Uint8Array }[] = [];
			const outbox: OutboxEntry[] = [];
			let cursor = 0;
			let lastId = 0;
			// Not copied, and the SQL port's `copyBytes` is not an inconsistency
			// here. `bun:sqlite` can hand back a view over memory it still owns,
			// so that port has to copy; `getAll` structured-clones, so these
			// arrays are already this caller's alone. Copying them again bought
			// nothing and cost a second whole document on every boot, because the
			// baseline row IS the whole document.
			//
			// One array per row, shared by `stored` and `outbox`: an owed row
			// appears in both and neither ever writes through it.
			for (const [index, row] of rows.entries()) {
				const id = ids[index] as number;
				if (id > lastId) lastId = id;
				const bytes = row.bytes;
				stored.push({ id, bytes });
				if (row.authoritySeq === null) {
					// NULL means owed, on every store kind (ADR-0301). A store with
					// no authority records `NO_AUTHORITY` on its own appends, so it
					// reaches this branch for nothing and needs no flag to say so.
					outbox.push({ id, bytes });
				} else if (row.authoritySeq > cursor) {
					cursor = row.authoritySeq;
				}
			}
			// Not sorted, because they are already in order and saying so is the
			// point. `getAll` returns an object store's rows in ascending key
			// order, and both arrays are pushed in that one iteration. Sorting
			// them was a no-op on every real input, and worse than a no-op as
			// documentation: this loop ALREADY depends on that ordering, pairing
			// `rows[index]` with `ids[index]`, so a defensive sort implied a
			// doubt the line above it does not share. The fold and `held` depend
			// on it too. One dependency, stated once.
			let held = stored.length;

			const loaded: DurableSnapshot = {
				updates: stored.map((row) => row.bytes),
				outbox,
				cursor,
				lastId,
			};

			const port: DurablePort = {
				async commit(ops: readonly DurableOp[]): Promise<void> {
					const transaction = durable.transaction(UPDATES_STORE, 'readwrite');
					const updates = transaction.objectStore(UPDATES_STORE);
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
							case 'mergeOwed': {
								for (const replaced of op.replaces) {
									void updates.delete(replaced);
								}
								void updates.put(
									{ bytes: copyBytes(op.bytes), authoritySeq: null },
									op.id,
								);
								chain = chain - op.replaces.length + 1;
								break;
							}
							case 'ack': {
								// One statement's worth of work, and the shape it takes here
								// is what a keyed object store makes cheap. A cursor walk
								// costs one round trip PER ROW to advance, which is what
								// made a wide ack -- a device reconnecting with a day of
								// offline work owed -- the slowest thing this port does.
								// Reading the range in two requests and issuing the stamps
								// without awaiting them costs two round trips for the whole
								// batch instead of one per row.
								//
								// The reads are the price: the range includes the baseline,
								// so a wide ack holds one document in memory while it runs.
								// That is bounded by the document rather than by the
								// backlog, and it is paid once per ack rather than per row.
								// `evidence/browser/port-cost` measures both shapes.
								const range = IDBKeyRange.upperBound(op.throughId);
								const [keys, rows] = await Promise.all([
									updates.getAllKeys(range),
									updates.getAll(range),
								]);
								for (const [index, key] of keys.entries()) {
									const row = rows[index];
									if (row === undefined || row.authoritySeq !== null) continue;
									void updates.put(
										{ ...row, authoritySeq: op.authoritySeq },
										key,
									);
									grew = true;
								}
								break;
							}
						}
					}

					// The same fold the SQL engine applies, and the same question:
					// an acknowledged row may be replaced by a whole-document
					// re-encode, an owed row may not (ADR-0301). A store with no
					// authority holds no owed rows, so it collapses everything here
					// without being told which kind it is.
					if (grew && chain >= SNAPSHOT_FOLD_THRESHOLD) {
						const foldable: { id: number; bytes: Uint8Array }[] = [];
						let position: number | null = null;
						let at = await updates.openCursor();
						while (at !== null) {
							const row = at.value;
							if (row.authoritySeq !== null) {
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
								{ bytes: baseline, authoritySeq: position ?? NO_AUTHORITY },
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

			async function create(record: {
				bytes: Uint8Array;
				position: number;
				binding: DatabaseBinding;
			}): Promise<void> {
				const transaction = durable.transaction(
					[UPDATES_STORE, BINDING_STORE],
					'readwrite',
				);
				const updates = transaction.objectStore(UPDATES_STORE);
				void updates.put(
					{
						bytes: copyBytes(record.bytes),
						authoritySeq: record.position,
					},
					1,
				);
				void transaction.objectStore(BINDING_STORE).put(
					{
						baseURL: record.binding.baseURL,
						principalId: record.binding.principalId,
					},
					BINDING_KEY,
				);
				await transaction.done;
				held = 1;
			}

			return { port, loaded, binding, create, close: () => durable.close() };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
}

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
 *
 * `v3` is the owed-row collapse (ADR-0301). A `v2` local store wrote its own
 * appends with a NULL position, which now means "owed to an authority" on
 * every store kind; read under this shape those rows would be offered to a
 * sender that does not exist and would take the weaker of the two folds
 * forever. The value changed rather than the schema, which is exactly the
 * migration this address scheme exists to refuse.
 *
 * `v4` is the ownership collapse (ADR-0324). A `v3` record named the server
 * and the principal it belonged to and named no application; this shape names
 * the application and says nothing about the owner. Read under this shape a
 * `v3` record could be offered to an authority its address never scoped it to,
 * which is the one thing the address used to prevent, so those names are left
 * where they are and ADR-0325's stamp answers the question instead.
 */
const STORE_GENERATION = 'v4';

/**
 * Normalize a server identity before it becomes a durable fact.
 *
 * No longer part of the address (ADR-0324): what this canonicalizes is what a
 * replica REPORTS as its server, so that `https://api.example.com` and the
 * same URL with a trailing slash are one identity rather than two. A path
 * prefix remains part of an Epicenter deployment; query and fragment are not
 * server identity.
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
 * What this account binds a generation to, canonical (ADR-0325).
 *
 * These two facts used to be four segments of a storage name, so a spelling
 * that could not be canonicalized had nowhere to live and was refused as an
 * address. They are written inside the database at creation now and compared at
 * open, and refused here for the same reason: a database that cannot name its
 * server cannot be compared against one.
 */
function canonicalBinding(account: {
	baseURL: string;
	principalId: PrincipalId;
}): Result<DatabaseBinding, StoreError> {
	const baseURL = canonicalBaseURL(account.baseURL);
	if (baseURL === undefined || account.principalId.trim() === '') {
		return StoreError.Unaddressable({
			reason: 'this account names no server and principal',
		});
	}
	return Ok({ baseURL, principalId: account.principalId });
}

/**
 * Whether a record's binding is the one signing in.
 *
 * Exact equality on both halves, over the canonical spelling, which is why
 * `canonicalBaseURL` survived ADR-0324's address collapse: a trailing slash is
 * not a different account and must not read as one.
 */
function isSameBinding(
	held: DatabaseBinding | undefined,
	opening: DatabaseBinding,
): boolean {
	return (
		held !== undefined &&
		held.baseURL === opening.baseURL &&
		held.principalId === opening.principalId
	);
}

/**
 * Where one database's generations live in this browser, up to the number
 * (ADR-0324, ADR-0292).
 *
 * ```txt
 * epicenter/v4/<app-id>/<data-id>/
 * ```
 *
 * The PREFIX rather than an address, because both callers want it: one appends
 * a number to open exactly that generation, the other matches it to enumerate
 * what this device holds. The trailing `/` is load-bearing: it is what stops
 * `foo.bar` from prefix-matching `foo.barbaz`.
 *
 * The app id is the OPENING application's, which is not the data id: two
 * applications may name one data id and each keeps its own replica, converging
 * through the authority (ADR-0304). It is self-claimed, and nothing here or
 * anywhere else verifies it, because a deployed app is a trusted app
 * (ADR-0334): the segment partitions storage by naming and never by
 * enforcement. It is checked against `isAppId` only so that a claim can never
 * contain a `/` and be read as somebody else's address.
 *
 * The generation is the last segment and is a NUMBER: enumeration parses it
 * rather than sorting it, because `9` sorts above `10`.
 *
 * The generation being IN the address is what retires the document identity
 * stamp. A record at this name can only belong to this generation, so there is
 * nothing to compare on a dial and nothing a stale replica could merge into.
 */
function generationPrefix(
	appId: string,
	dataId: string,
): Result<string, StoreError> {
	if (!isAppId(appId)) {
		return StoreError.Unaddressable({
			reason: `'${appId}' is not an application id`,
		});
	}
	return Ok(`epicenter/${STORE_GENERATION}/${appId}/${dataId}/`);
}

/**
 * A generation number, admitted or refused at the boundary (ADR-0292).
 *
 * `Number.isSafeInteger(n) && n >= 1`, checked inline like any other bad
 * input, because that is what it is: a number arrives from a caller that
 * computed it. The answer to a bad one is `Unaddressable`, not
 * `GenerationNotFound`; conflating them would tell a person a generation is
 * missing when the value was never a generation at all.
 */
function isGeneration(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1;
}

/**
 * One opened replica, and the one thing that ends it.
 *
 * A pair rather than a store carrying its own disposal (ADR-0340). Opening
 * acquires a document, an exclusive Web Lock, and whatever the caller attaches
 * next; the closer is the one hand that holds all of it, and the store an
 * application is given cannot end itself.
 */
export type OpenedDatabase<TDatabase extends DataDefinition> = {
	readonly store: ReplicaData<TDatabase>;
	close(): Promise<void>;
};

export type OpenDatabaseOptions = {
	/**
	 * The id of the application doing the opening, which is not the data id
	 * (ADR-0324, ADR-0304).
	 *
	 * Self-claimed, and nothing verifies it: a deployed app is a trusted app
	 * (ADR-0334). An application that holds `@epicenter/app`'s handle never
	 * writes it here, because the handle already carries it.
	 */
	appId: string;
	/** The exact generation to open. Never discovered, never defaulted. */
	generation: number;
	/**
	 * The account this generation belongs to. Required, and there is no second
	 * shape: an authority mints every generation, so a database with no account
	 * is not a kind this package can open.
	 */
	account: DatabaseAccount;
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
		return StoreError.GenerationUnreachable({ dataId, generation, cause });
	}
	// 404 is the one answer that is a fact about the generation rather than
	// about the moment. Everything else, including 401, is retryable: a token
	// that expired mid-boot is not a missing generation.
	if (response.status === 404) {
		return StoreError.GenerationNotFound({ dataId, generation });
	}
	if (!response.ok) {
		return StoreError.GenerationUnreachable({
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
		return StoreError.GenerationUnreachable({ dataId, generation, cause });
	}
}

/**
 * Open one exact generation of one database, cache-first (ADR-0292).
 *
 * One opener, and one store. An authority mints every generation, so the
 * device store this used to fork against is gone, and with it the
 * `sync === undefined` discriminant and the second address grammar.
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
 * 4. On a miss: fetch the generation, write it in one transaction, hydrate,
 *    and only then return. It bootstraps completely or fails; a fresh database
 *    never renders empty while its state is still arriving. Opening never
 *    invents a generation, because a number in a URL is an address rather than
 *    an instruction to allocate.
 *
 * It resolves once local state is durable enough to hydrate. It never waits on
 * a WebSocket round trip, and it does not attach one.
 */
export async function openDatabase<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	{ appId, generation, account }: OpenDatabaseOptions,
): Promise<
	Result<OpenedDatabase<TDatabase>, StoreError | DataDefinitionParseError>
> {
	if (!isGeneration(generation)) {
		return StoreError.Unaddressable({
			reason: `'${generation}' is not a generation number`,
		});
	}
	// Parsed before anything is claimed or opened: a declaration may arrive as
	// data, and a refusal here is a boot outcome rather than a programmer
	// error (ADR-0240).
	const { data: parsed, error: parseError } = compileData(definition);
	if (parseError !== null) return Err(parseError);

	const opening = canonicalBinding(account);
	if (opening.error !== null) return Err(opening.error);
	const located = generationPrefix(appId, parsed.id);
	if (located.error !== null) return Err(located.error);

	// Asked here rather than by an application, because this is the one place
	// that knows durable storage is about to matter, and because an eviction
	// has no event: an origin's data goes wholesale and the next boot simply
	// finds nothing. Not awaited, and a refusal is ordinary.
	void requestPersistentStorage();

	const address = `${located.data}${generation}`;
	const { error: claimError } = await claimDocument(address);
	if (claimError !== null) return Err(claimError);

	const opened = await openIdbBacking(address);
	if (opened.error !== null) {
		releaseDocument(address);
		return Err(opened.error);
	}
	let backing = opened.data;

	if (backing.loaded.updates.length === 0) {
		// A miss. Whatever happens next, the shell this open just created must
		// not be left behind reading as a hit.
		const fetched = await fetchGeneration(account, parsed.id, generation);
		if (fetched.error !== null) {
			backing.close();
			releaseDocument(address);
			await deleteIndexedDb(address).catch(() => undefined);
			return Err(fetched.error);
		}
		// One transaction, after the whole body has been read, so a failed
		// bootstrap leaves no half-written database, and the binding lands with
		// the bytes rather than after them (ADR-0325). The position rides on the
		// append, which is where every cursor is read from (ADR-0298).
		const { error: writeError } = await tryAsync({
			try: () =>
				backing.create({
					bytes: fetched.data.bytes,
					position: fetched.data.position,
					binding: opening.data,
				}),
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
		const reopened = await openIdbBacking(address);
		if (reopened.error !== null) {
			releaseDocument(address);
			return Err(reopened.error);
		}
		backing = reopened.data;
	}

	// The one refusal (ADR-0325). A cache hit that was created for somebody else
	// is not this account's data, and merging it would be silent: Yjs converges
	// rather than erroring, and generation numbers are small integers, so a `7`
	// here and a `7` there usually both exist. Nothing is deleted as a step
	// (ADR-0281); the caller is told, and a person invokes `eraseGenerations`.
	//
	// A record holding bytes and no binding is refused by the same arm, and
	// cannot be produced by this file: `create` writes both or neither.
	if (!isSameBinding(backing.binding, opening.data)) {
		backing.close();
		releaseDocument(address);
		return StoreError.BoundElsewhere({ dataId: parsed.id, generation });
	}

	const held = backing;
	// What can throw here is the hydration replay meeting a stored update it
	// cannot decode, which is "the store could not read its durable record":
	// contained so a corrupt record refuses the boot instead of leaking the
	// claim and the open connection.
	let parts: {
		store: DataDocument;
		close: () => Promise<void>;
		view: UntypedDeclaredData;
		definition: ParsedDataDefinition;
	};
	try {
		parts = createAccountStoreOverPort({
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

	// The whole address, stamped by the one party that knows it (ADR-0340).
	// Four of these five facts arrived as arguments and were thrown away after
	// they resolved a document name; keeping them is not new state.
	//
	// `close` comes back BESIDE the store rather than on it. What a caller has
	// to end here is more than the document: whoever attaches sync and a
	// page-hide listener holds those too, and a disposal on the store would
	// free one of the three and leave a connection running against a document
	// whose every verb throws.
	return Ok({
		store: Object.freeze({
			...(parts.view as DeclaredData<TDatabase>),
			...parts.store,
			appId,
			dataId: parsed.id,
			generation,
			baseURL: opening.data.baseURL,
			principalId: opening.data.principalId,
		}),
		close: parts.close,
	});
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
 * The binding lands in the same transaction as the bytes (ADR-0325), so a
 * generation never exists unbound and no code path updates one afterwards.
 *
 * Not exported. Both call sites are `createGeneration` below, and the split is
 * the two halves of one operation rather than a surface: without a number
 * there is nothing to write under, and choosing the number is what
 * `createGeneration` is for.
 */
async function writeGeneration({
	appId,
	dataId,
	generation,
	state,
	binding,
	position = 0,
}: {
	appId: string;
	dataId: string;
	generation: number;
	state: Uint8Array;
	/** Written in the same transaction as the state (ADR-0325). */
	binding: DatabaseBinding;
	position?: number;
}): Promise<Result<void, StoreError>> {
	if (!isGeneration(generation)) {
		return StoreError.Unaddressable({
			reason: `'${generation}' is not a generation number`,
		});
	}
	const located = generationPrefix(appId, dataId);
	if (located.error !== null) return Err(located.error);
	const address = `${located.data}${generation}`;

	const { error: claimError } = await claimDocument(address);
	if (claimError !== null) return Err(claimError);
	try {
		const opened = await openIdbBacking(address);
		if (opened.error !== null) return Err(opened.error);
		const backing = opened.data;
		try {
			if (backing.loaded.updates.length > 0) {
				return StoreError.AlreadyOpen({ address });
			}
			await backing.create({ bytes: state, position, binding });
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
 * Bring one generation into being (ADR-0293).
 *
 * `from` is a whole database state, and OMITTING it mints an empty one. That
 * is not a second code path: an empty database is what a folder with no files
 * in it reads as, so the default is the value rather than a branch. It used to
 * be a named helper in the artifact layer, `emptyDatabase`, whose own comment
 * said the name was the point; making it the default is the version where the
 * name does not have to be said.
 *
 * The split with the artifact layer is where ADR-0293's diagram puts it: the
 * CLIENT parses the folder with the application's own codecs and builds one
 * Yjs document (`readArtifact`), and this takes the state that came out and
 * gives it a number and an address. Keeping the parse outside means an opener
 * does not carry the artifact layer, and it is the same call either way.
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
export async function createGeneration(
	definition: DataDefinition,
	{
		appId,
		from,
		account,
	}: { appId: string; from?: Uint8Array; account: DatabaseAccount },
): Promise<
	Result<{ generation: number }, StoreError | DataDefinitionParseError>
> {
	const { data: parsed, error: parseError } = compileData(definition);
	if (parseError !== null) return Err(parseError);

	const state =
		from ?? new Uint8Array(Y.encodeStateAsUpdateV2(createDatabaseDocument()));

	const binding = canonicalBinding(account);
	if (binding.error !== null) return Err(binding.error);
	const posted = await postGeneration(account, parsed.id, state);
	if (posted.error !== null) return Err(posted.error);
	const { error } = await writeGeneration({
		appId,
		dataId: parsed.id,
		generation: posted.data.generation,
		state,
		binding: binding.data,
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
		return StoreError.GenerationUnreachable({ dataId, generation: 0, cause });
	}
	if (!response.ok) {
		return StoreError.GenerationUnreachable({
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
			return StoreError.GenerationUnreachable({
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
		return StoreError.GenerationUnreachable({ dataId, generation: 0, cause });
	}
}

/**
 * Which generation of this database to open, and minting the first one
 * (ADR-0292, ADR-0293).
 *
 * Cache first, then the account's own list. A device that already holds a copy
 * uses it without waiting for a server; one that holds none asks which exist.
 *
 * **It creates one only when the account's list comes back EMPTY**, which is a
 * first run. That distinction is the whole of this function, and it was
 * hand-rolled four times before it lived here: a device that could not SEE what
 * the account has must not invent a generation, because the authority mints the
 * next number and two devices doing that separately fork one notebook into two
 * histories that never meet. A failed listing is `GenerationUnreachable` and a
 * retry fixes it; an empty listing is a fact and a first run.
 *
 * A `Result` rather than a throw, because every arm is a boot outcome an
 * application renders: the copy is elsewhere, the account cannot be reached, or
 * this device names nothing. `epicenter.data` and every application that opens
 * its own store go through this one answer.
 */
export async function resolveGeneration(
	definition: DataDefinition,
	{ appId, account }: { appId: string; account: DatabaseAccount },
): Promise<
	Result<{ generation: number }, StoreError | DataDefinitionParseError>
> {
	const { data: parsed, error: parseError } = compileData(definition);
	if (parseError !== null) return Err(parseError);

	const held = await newestGeneration({ appId, dataId: parsed.id });
	if (held !== undefined) return Ok({ generation: held });

	const listed = await listGenerations(account, parsed.id);
	if (listed.error !== null) return Err(listed.error);
	// The maximum rather than the last element. The authority orders its listing
	// and this does not need to know that.
	if (listed.data.length > 0) {
		return Ok({ generation: Math.max(...listed.data) });
	}

	return createGeneration(definition, { appId, account });
}

/** Which generations the authority holds, oldest first. */
async function listGenerations(
	account: DatabaseAccount,
	dataId: string,
): Promise<Result<number[], StoreError>> {
	const unavailable = (extra: { status?: number; cause?: unknown }) =>
		StoreError.GenerationUnreachable({ dataId, generation: 0, ...extra });
	let response: Response;
	try {
		response = await account.fetch(
			GENERATIONS_ROUTE.collection(account.baseURL, dataId),
		);
	} catch (cause) {
		return unavailable({ cause });
	}
	if (!response.ok) return unavailable({ status: response.status });
	try {
		const body = (await response.json()) as { generations?: unknown };
		// Every element, or none of them. Filtering to the ones that parse would
		// turn `{"generations":["1","2"]}` into an empty list, and an empty list
		// is what tells `resolveGeneration` to mint: the exact fork it exists to
		// refuse, reached through a response that was merely misspelled.
		if (
			!Array.isArray(body.generations) ||
			!body.generations.every(
				(entry) => typeof entry === 'number' && isGeneration(entry),
			)
		) {
			return unavailable({});
		}
		return Ok(body.generations as number[]);
	} catch (cause) {
		return unavailable({ cause });
	}
}

/**
 * Erase every generation of this database this device holds (ADR-0325).
 *
 * The repair a person invokes after `BoundElsewhere`, and the only verb in this
 * file that deletes. It is plural because the refusal is: a device that holds
 * one account's generations holds all of them under one prefix, so erasing the
 * one that was refused would refuse the next one down and ask again.
 *
 * Never called as a step in a protocol (ADR-0281). Opening does not repair
 * itself, sign-out deletes nothing, and no rebind writes over a binding. A
 * person decides that the copy on this device is not theirs to keep, and this
 * is what they invoked.
 *
 * **Every generation is claimed before any is deleted, so this is all or
 * nothing.** IndexedDB blocks a delete on a live connection, and half an erase
 * is the one outcome nobody can act on: the person is told it failed while
 * some of their notes are already gone. A generation another window holds open
 * answers `AlreadyOpen`, which names the repair, and nothing is deleted.
 */
export async function eraseGenerations({
	appId,
	dataId,
}: {
	appId: string;
	dataId: string;
}): Promise<Result<{ erased: number }, StoreError>> {
	const located = generationPrefix(appId, dataId);
	if (located.error !== null) return Err(located.error);
	const names = await heldGenerationNames(located.data);

	// The same claim an open takes, so "somebody has this open" has one answer
	// on this origin rather than a second one read off a delete that blocked.
	const claimed: string[] = [];
	const release = () => {
		for (const name of claimed) releaseDocument(name);
	};
	for (const name of names) {
		const { error } = await claimDocument(name);
		if (error !== null) {
			release();
			return Err(error);
		}
		claimed.push(name);
	}

	try {
		for (const name of names) {
			const { error } = await tryAsync({
				try: () => deleteIndexedDb(name),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
			if (error !== null) return Err(error);
		}
	} finally {
		release();
	}
	return Ok({ erased: names.length });
}

/** Every IndexedDB name under one generation prefix, in no order. */
async function heldGenerationNames(prefix: string): Promise<string[]> {
	const names = (await indexedDB.databases())
		.map(({ name }) => name)
		.filter((name): name is string => name !== undefined);
	// The grammar rather than `Number`, which reads `' 1'`, `'0x1'` and `'1e0'`
	// as one. Nothing here writes those; a durable name is not the place to be
	// lenient about what it means.
	return names.filter(
		(name) =>
			name.startsWith(prefix) &&
			/^[1-9][0-9]*$/.test(name.slice(prefix.length)),
	);
}

/**
 * The newest generation of this database this device holds, or `undefined`
 * (ADR-0292).
 *
 * Newest is the HIGHEST number, not the latest timestamp: the number is the
 * order. Parsed rather than sorted, because `9` sorts above `10`.
 *
 * Not exported, and that is the point of `resolveGeneration` above: what this
 * device holds is half an answer, and the half that mints when it comes back
 * empty is the half that forks a notebook. Every caller wants the whole
 * decision, so the whole decision is what is public.
 *
 * `appId` and `dataId` rather than a definition, so this stays a question with
 * no error channel. A device that holds none and a device that cannot name an
 * address both answer the same way, and the honest answer is "none".
 *
 * It takes no account, because an account is not in the address any more
 * (ADR-0324). What this counts is every generation of this database this
 * application holds, and ADR-0325's stamp is what says whose they are.
 */
async function newestGeneration({
	appId,
	dataId,
}: {
	appId: string;
	dataId: string;
}): Promise<number | undefined> {
	const located = generationPrefix(appId, dataId);
	// A name this store cannot build addresses nothing, so there is nothing
	// here to find. `openDatabase` refuses the same input loudly; this one is a
	// question about what is on disk and the honest answer is "none".
	if (located.error !== null) return undefined;
	const prefix = located.data;
	let newest: number | undefined;
	for (const name of await heldGenerationNames(prefix)) {
		const parsed = Number(name.slice(prefix.length));
		if (newest === undefined || parsed > newest) newest = parsed;
	}
	return newest;
}
