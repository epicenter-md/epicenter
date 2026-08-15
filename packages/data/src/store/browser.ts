/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread. The live Yjs document is the
 * source of truth, and the durable facts (the update log, the outbox, the
 * cursor, and the metadata) live directly in IndexedDB, written one atomic
 * multi-store transaction per flush (ADR-0238). Every read a person makes
 * (`get`, `list`, `ids`, `document`) comes from the `Y.Doc` already in
 * memory; SQL, when an application wants it, is a follower it composes over
 * this surface (`@epicenter/data/projection`), so opening a store here loads
 * no SQLite at all.
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
 * There was one, holding an OPFS SQLite fed every statement, justified by the
 * projection "coming back for free"; that was false, because opening rebuilds
 * every projected table unconditionally. What actually has to survive is
 * small: the log folds at `SNAPSHOT_FOLD_THRESHOLD` (64), the outbox is
 * coalesced before it is sent, and the cursor is one row. IndexedDB holds
 * that from the page.
 */
import type { PrincipalId } from '@epicenter/identity';
import {
	parseWorkspace,
	type WorkspaceJson,
	type WorkspaceParseError,
} from '@epicenter/workspace';
import * as Y from '@y/y';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { claimDocument, releaseDocument } from './claims.js';
import {
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
	type DeviceStore,
	StoreError,
	type UntypedWorkspaceView,
	type WorkspaceView,
} from './store.js';

// Re-exported so a browser caller's one import site names both kinds beside
// the openers that produce them.
export type { AccountStore, DeviceStore } from './store.js';

/** One browser document that replicates with an account authority. */
export type BrowserAccountStore = AccountStore & {
	/**
	 * Delete this store's durable record whole, disposing the store first.
	 *
	 * ADR-0231's one client-side deletion: a replica whose document was
	 * replaced discards and rejoins at zero, and the initiating device adopts
	 * through the same move after a confirmed replace. Terminal for this store; the
	 * caller reloads (ADR-0232's instrument) and boot opens fresh. Crash-safe
	 * by repetition: a discard that never ran leaves the old file, whose next
	 * dial is refused again.
	 *
	 * Its blast radius is this store's own address and nothing else (ADR-0233),
	 * so a workspace discard names one account's replica and can reach neither
	 * the device document nor any other account's.
	 */
	discard(): Promise<Result<void, StoreError>>;
};

/**
 * The durable facts, one object store each (ADR-0238).
 *
 * `updates` is the Yjs update log at explicit numeric keys; `outbox` holds
 * locally authored bytes at the ids the store assigned; `meta` holds the
 * format certificate, the cursor, and the document identity. These are
 * persisted names: changing them requires an IndexedDB migration.
 */
type BrowserDurableSchema = DBSchema & {
	updates: { key: number; value: Uint8Array };
	outbox: { key: number; value: Uint8Array };
	meta: { key: 'format' | 'cursor' | 'document'; value: string | number };
};

type BrowserDurableDatabase = IDBPDatabase<BrowserDurableSchema>;

const DURABLE_STORES = ['updates', 'outbox', 'meta'] as const;

/**
 * The superseded version-1 record: the whole in-memory SQLite snapshotted as
 * one value. Read once, during the version-2 upgrade, to migrate what was
 * already durable; never written again.
 */
type SupersededCheckpoint = {
	updates: { seq: number; bytes: Uint8Array }[];
	outbox: { id: number; bytes: Uint8Array }[];
	cursor: number;
	format?: string;
	document?: string;
};

function openIndexedDb(address: string): Promise<BrowserDurableDatabase> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		void openDB<BrowserDurableSchema>(address, 2, {
			async upgrade(database, oldVersion, _newVersion, transaction) {
				for (const name of DURABLE_STORES) {
					if (!database.objectStoreNames.contains(name)) {
						database.createObjectStore(name);
					}
				}
				// Version 1 held one checkpoint record. Its contents were already
				// durable, so they migrate rather than being wiped; the format rule
				// at load still decides whether they are trusted (ADR-0231).
				if (
					oldVersion === 1 &&
					(database.objectStoreNames as DOMStringList).contains('state')
				) {
					const checkpoint = (await transaction
						.objectStore('state' as never)
						.get('durable' as never)) as SupersededCheckpoint | undefined;
					if (checkpoint !== undefined) {
						const updates = transaction.objectStore('updates');
						for (const update of checkpoint.updates) {
							void updates.put(copyBytes(update.bytes), update.seq);
						}
						const outbox = transaction.objectStore('outbox');
						for (const owed of checkpoint.outbox) {
							void outbox.put(copyBytes(owed.bytes), owed.id);
						}
						const meta = transaction.objectStore('meta');
						if (checkpoint.cursor > 0) {
							void meta.put(checkpoint.cursor, 'cursor');
						}
						if (checkpoint.format !== undefined) {
							void meta.put(checkpoint.format, 'format');
						}
						if (checkpoint.document !== undefined) {
							void meta.put(checkpoint.document, 'document');
						}
					}
					database.deleteObjectStore('state' as never);
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
			(database) => {
				if (blocked) database.close();
				else resolve(database);
			},
			(cause) => reject(cause),
		);
	});
}

/** Delete one store's IndexedDB database whole. Our own connection is closed first. */
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
			// (ADR-0231): a record holding state without a certificate predates
			// the document identity and is untrusted whole, so it is wiped and
			// the replica rejoins from zero; a fresh record is simply certified.
			// One transaction, so a crash converges at the next open either way.
			const enforce = durable.transaction(DURABLE_STORES, 'readwrite');
			const meta = enforce.objectStore('meta');
			const format = (await meta.get('format')) as string | undefined;
			if (format === undefined) {
				const held =
					(await enforce.objectStore('updates').count()) +
					(await enforce.objectStore('outbox').count()) +
					(await meta.count());
				if (held > 0) {
					await enforce.objectStore('updates').clear();
					await enforce.objectStore('outbox').clear();
					await meta.clear();
				}
				void meta.put(STORE_FORMAT, 'format');
			}
			await enforce.done;

			const read = durable.transaction(DURABLE_STORES, 'readonly');
			const updateRows = await read.objectStore('updates').getAll();
			const updateKeys = await read.objectStore('updates').getAllKeys();
			const outboxRows = await read.objectStore('outbox').getAll();
			const outboxKeys = await read.objectStore('outbox').getAllKeys();
			const cursor = (await read.objectStore('meta').get('cursor')) as
				| number
				| undefined;
			const identity = (await read.objectStore('meta').get('document')) as
				| string
				| undefined;
			await read.done;

			const loaded: DurableSnapshot = {
				// `getAll` returns key order, which is the append order.
				updates: updateRows.map((bytes) => copyBytes(bytes)),
				outbox: outboxRows.map((bytes, index) => ({
					id: outboxKeys[index] as number,
					bytes: copyBytes(bytes),
				})),
				cursor: cursor ?? 0,
				identity,
			};

			// The port's own bookkeeping, committed only when a batch lands so a
			// failed transaction never advances it.
			let nextSeq =
				updateKeys.reduce<number>((max, key) => Math.max(max, key), 0) + 1;
			let updateCount = updateRows.length;

			const port: DurablePort = {
				async commit(ops: readonly DurableOp[]): Promise<void> {
					const transaction = durable.transaction(DURABLE_STORES, 'readwrite');
					const updates = transaction.objectStore('updates');
					const outbox = transaction.objectStore('outbox');
					const metaStore = transaction.objectStore('meta');
					let seq = nextSeq;
					let count = updateCount;
					for (const op of ops) {
						switch (op.kind) {
							case 'append': {
								void updates.put(copyBytes(op.bytes), seq);
								seq += 1;
								count += 1;
								if (op.outboxId !== undefined) {
									void outbox.put(copyBytes(op.bytes), op.outboxId);
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
								void outbox.delete(IDBKeyRange.upperBound(op.throughId));
								void outbox.put(copyBytes(op.merged), op.throughId);
								break;
							}
						}
					}
					// The same fold the SQLite engine applies, inside the same
					// transaction as the appends that crossed the threshold: read
					// the whole chain, replay it into one baseline, rewrite. The
					// replay is synchronous, so the transaction stays active.
					if (count >= SNAPSHOT_FOLD_THRESHOLD) {
						const chain = await updates.getAll();
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
						await updates.clear();
						void updates.put(baseline, 1);
						seq = 2;
						count = 1;
					}
					await transaction.done;
					nextSeq = seq;
					updateCount = count;
				},
			};

			return { port, loaded, close: () => durable.close() };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
}

/**
 * Where one of an application's durable documents lives, as ownership
 * (ADR-0233):
 *
 * ```text
 * epicenter/<workspace id>/device
 * epicenter/<workspace id>/account/<principal id>
 * ```
 *
 * A browser application keeps one device document and one retained account
 * replica per account, and may hold them open at once. The device document
 * never joins workspace sync and survives every sign-in and sign-out; an
 * account replica is this device's replica of one principal's current
 * authority document (ADR-0231), retained across sign-out too, which is why
 * it is addressed by the account that owns it rather than by the application
 * alone.
 *
 * Three identities, none of them collapsed into another: the workspace id says
 * which application, the principal says whose replica this is, and the
 * authority document id says which current Yjs document that replica belongs
 * to. Only the first two are in the name. The third lives inside the store
 * because it changes on rebuild, and a rebuilt workspace has to stay at the
 * same address while its contents are discarded.
 *
 * A workspace id is dot-separated lowercase labels, so it holds no `/`: the
 * segment after `epicenter/` is always exactly the application, and no address
 * can be read as another one.
 */
function deviceAddress(workspaceId: string): string {
	return `epicenter/${workspaceId}/device`;
}

function accountAddress(workspaceId: string, principalId: PrincipalId): string {
	return `epicenter/${workspaceId}/account/${principalId}`;
}

/**
 * Delete the browser storage that came before the account-scoped address.
 *
 * Two superseded shapes, neither of them read: `epicenter-store-<workspace id>`,
 * the single database from before an application had two documents, which held
 * anonymous work or an account replica indistinguishably; and
 * `epicenter-store-<workspace id>#private` / `#workspace`, the per-application
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
	workspaceId: string,
	owner: 'device' | 'account',
	principalId?: PrincipalId,
): Promise<void> {
	const superseded = [
		`epicenter-store-${workspaceId}`,
		`epicenter-store-${workspaceId}#private`,
		`epicenter-store-${workspaceId}#workspace`,
		owner === 'device'
			? `epicenter/${workspaceId}/private`
			: `epicenter/${workspaceId}/workspace/${principalId}`,
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
 * Open this browser's device-owned document for the application this workspace
 * names.
 *
 * This document has no remote authority, so it carries neither an outbox nor
 * replica-only verbs, and no verb that could delete it. It can remain open
 * while an account replica is open too.
 */
export async function openDevice<const TWorkspace extends WorkspaceJson>(
	workspace: TWorkspace,
): Promise<
	Result<DataOf<TWorkspace, DeviceStore>, StoreError | WorkspaceParseError>
> {
	// Parsed before anything is claimed or opened: a declaration may arrive as
	// data, and a refusal here is a boot outcome rather than a programmer
	// error (ADR-0240).
	const { data: parsed, error: parseError } = parseWorkspace(workspace);
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
	let parts: { store: DeviceStore; view: UntypedWorkspaceView };
	try {
		parts = createDeviceStoreOverPort({
			workspace: parsed,
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
		asData<TWorkspace, DeviceStore>(
			store,
			// Through `unknown` deliberately: comparing the untyped view with
			// `WorkspaceView<TWorkspace>` re-enters the per-field arktype
			// instantiation and exceeds the depth limit.
			view as unknown as WorkspaceView<TWorkspace>,
		),
	);
}

/** Open this device's retained replica of one account's document. */
export async function openAccount<const TWorkspace extends WorkspaceJson>(
	workspace: TWorkspace,
	{ principalId }: { principalId: PrincipalId },
): Promise<
	Result<
		DataOf<TWorkspace, BrowserAccountStore>,
		StoreError | WorkspaceParseError
	>
> {
	if (principalId.trim() === '') return StoreError.Unaddressable();

	const { data: parsed, error: parseError } = parseWorkspace(workspace);
	if (parseError !== null) return Err(parseError);

	const address = accountAddress(parsed.id, principalId);
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
	let parts: { store: AccountStore; view: UntypedWorkspaceView };
	try {
		parts = createAccountStoreOverPort({
			workspace: parsed,
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
		async discard(): Promise<Result<void, StoreError>> {
			// Dispose first: the engine drains its queue and stops, and our own
			// IndexedDB connection closes, so the delete is not blocked by
			// ourselves and no flush can re-create the database mid-delete.
			await store[Symbol.asyncDispose]();
			return tryAsync({
				try: () => deleteIndexedDb(address),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
		},
	});

	return Ok(
		asData<TWorkspace, BrowserAccountStore>(
			replicaStore,
			view as unknown as WorkspaceView<TWorkspace>,
		),
	);
}
