import {
	type ConformanceIssue,
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
} from '@epicenter/data/definition';
import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import { customAlphabet } from 'nanoid';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	createDatabaseDocument,
	createRow,
	deleteRow,
	kvRoot,
	listRowIds,
	type RowInput,
	readRow,
	readRowTypes,
	storedTableNames,
	tableRoot,
	updateRow,
} from './document.js';
import { copyBytes, createSqliteDurablePort, NO_AUTHORITY } from './log.js';
import {
	createPersistenceController,
	type DurablePort,
	type DurableSnapshot,
} from './persistence.js';

export type {
	ApplyFailedError,
	NonconformingRow,
	RowAbsentError,
} from './errors.js';

import type {
	ApplyFailedError,
	NonconformingRow,
	RowAbsentError,
} from './errors.js';
// The declaration half of this module lives beside it: `errors.ts` is what a
// store refuses with, `handles.ts` is what an application holds. Re-exported
// here rather than moved out of reach, because `@epicenter/data`'s barrel and
// every caller already name them through this path.
import { StoreError, StoreUnusableError } from './errors.js';
import type {
	AccountData,
	AccountDocument,
	DataDocument,
	DataView,
	DocumentPressure,
	KvHandle,
	LocalData,
	LocalDocument,
	Row,
	StoredData,
	SyncCapability,
	TableHandle,
	UntypedDataView,
} from './handles.js';

export { StoreError, StoreUnusableError } from './errors.js';
export type {
	AccountData,
	AccountDocument,
	BrowserData,
	DataDocument,
	DataView,
	DocumentPressure,
	KvHandle,
	LocalData,
	LocalDocument,
	Row,
	StoredData,
	SyncCapability,
	TableHandle,
	TypedTableHandle,
	UntypedDataView,
} from './handles.js';

/** ADR-0206's minted id: 24 characters, so a collision never happens. */
const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

/** Bytes this process authored, which is what has to reach the authority. */
const localOrigin = Object.freeze({ kind: 'epicenter-local' });

/**
 * One `applyRemote` call, carried on the transaction that applies it.
 *
 * Bytes that arrived from a peer are durable but are not local work, so the
 * listener must not append them: `applyRemote` persists what it RECEIVED,
 * never what the document emitted in response. The listener parks the
 * transaction here on its way past, and `applyRemote` delivers from it once
 * the append is enqueued, so the notification still lands after acceptance
 * without anything having to be remembered between two calls.
 *
 * `transaction` stays undefined when the update had missing causal
 * dependencies. Yjs buffers those into `store.pendingStructs`, returns
 * normally, and emits NO event, and delivering nothing is then exactly right:
 * the document did not change.
 */
type RemoteApply = { kind: 'epicenter-remote'; transaction?: Y.Transaction };

function isRemoteApply(origin: unknown): origin is RemoteApply {
	return (origin as RemoteApply | null)?.kind === 'epicenter-remote';
}

/**
 * The client half of sync, which is two facts the store already owns.
 *
 * What this replica authored and has not handed over, and how far through the
 * authority's log it has read. Nothing else: there is no state vector here, and
 * that absence is the design. A state vector cannot express deletion, so it can
 * never answer "have I seen everything", and two of the four withdrawn
 * authority designs died reasoning from one anyway.
 *
 * Both verbs that give ground are safe in one direction only, and both are
 * written to fail in that direction. `acknowledge` runs after the authority has
 * confirmed, and `advance` runs after the bytes have committed, so a crash
 * re-offers or re-applies rather than skipping. Re-delivery is free because an
 * update is idempotent (`evidence/invariants.test.ts`); a skip is invisible
 * forever.
 */
type ClientLog = {
	/**
	 * Merge every unsent update into one, and return it.
	 *
	 * The 30x. Sending one update per transaction is what made the authority's
	 * log look like it had to be compacted; merging on the idle timer an editor
	 * debounces on anyway makes it a rounding error
	 * (`evidence/bench/never-compact.ts`).
	 *
	 * One document, so one merge (ADR-0295). `id` is the highest outbox id the
	 * merged bytes cover, which is what an acknowledgement retires.
	 *
	 * It needs no proof from anybody, and that is the whole reason the merge
	 * lives here rather than on the authority. Every withdrawn design was trying
	 * to let one party rewrite another party's history, which requires proving
	 * the replacement covers what it replaced. A client merging bytes it
	 * indisputably authored has nothing to prove.
	 */
	coalesce(): { id: number; bytes: Uint8Array } | undefined;
	/** The authority has taken responsibility through this entry. */
	acknowledge(throughId: number, authoritySeq: number): void;
	/** How far through the authority's log this replica has read. */
	cursor(): number;
};

/**
 * The delivery machinery only the transport drives (ADR-0238's audit): the
 * client log's bookkeeping, plus the three verbs that move foreign bytes and
 * wake the sender. Reached through `syncEngineOf`, never carried on the
 * public store: no application consumer ever needed these, and every one of
 * them can corrupt a replica if driven casually.
 */
type SyncEngine = ClientLog & {
	/**
	 * Apply bytes from a peer. Never republished as local work.
	 *
	 * The bytes are accepted live immediately; the durable append and the
	 * `advanceTo` bookmark join the persistence queue as ADJACENT OPS in one
	 * atomic flush batch, so durable state can never hold a cursor ahead of
	 * the bytes it accounts for (ADR-0231, carried by ADR-0238).
	 *
	 * The Result's one error is `ApplyFailed`: bytes this document cannot
	 * decode, which is a property of the bytes and leaves the store usable.
	 */
	applyRemote(
		update: Uint8Array,
		opts?: { advanceTo?: number },
	): Result<void, ApplyFailedError>;
	/**
	 * Whether this replica is holding updates it cannot apply yet.
	 *
	 * True means some received update referenced structs that have not arrived,
	 * so the document is missing data it will not report. Yjs surfaces no error
	 * and no event for this, and exposes no public API to detect it, so this
	 * reads an internal field; Yjs's own test helper asserts on the same one.
	 *
	 * A caller must not treat a cursor as settled while this is true, because
	 * advancing past the gap makes the loss permanent.
	 */
	hasUnresolvedDependencies(): boolean;
	/**
	 * Hear when this replica has durable authored work the authority has not
	 * taken.
	 *
	 * Fires when a flush durably grows the outbox, and never for bytes that
	 * arrived from a peer. It exists so that nothing has to remember to say
	 * so: the transport's idle timer only starts when it is told work was
	 * made, and a caller that forgets leaves that work sitting in the outbox
	 * until some unrelated write happens to start the timer.
	 */
	onLocalWork(listener: () => void): () => void;
	/**
	 * This replica's whole state as one update: the database document's
	 * complete state (ADR-0295).
	 *
	 * What a snapshot offer carries. Still asynchronous, because the transport
	 * awaits it and the shape outlives the reason: it used to read closed row
	 * documents from storage.
	 */
	encodeSnapshot(): Promise<Uint8Array>;
};

/**
 * The engines, keyed by the sync capability rather than by the store object.
 *
 * Openers wrap the engine's store in frozen spreads (`discard()` on Bun and
 * in the browser), and a spread is a NEW object; the capability rides along
 * by reference, so it is the one key every wrapper preserves.
 */
const syncEngines = new WeakMap<SyncCapability, SyncEngine>();

/**
 * The delivery machinery behind one replica's `sync` capability.
 *
 * Package-internal by convention: exported for the transport and tests, and
 * deliberately absent from the package barrel.
 */
export function syncEngineOf(store: AccountDocument): SyncEngine {
	const engine = syncEngines.get(store.sync);
	if (engine === undefined) {
		throw new Error(
			'This store has no sync engine: it is not a replica of any authority.',
		);
	}
	return engine;
}

/** What every store engine needs: the definition and the durable engine. */
type StoreEngineOptions = {
	/**
	 * The one data definition this runtime holds, already parsed
	 * (ADR-0240). Every table handle and the KV handle close over it for the
	 * store's whole life; a newer definition reads the same durable data by
	 * disposing this store and constructing the next one.
	 */
	definition: ParsedDataDefinition;
	/** The runtime-native durable engine: one atomic batch per flush. */
	durable: DurablePort;
	/** What that engine held at open, materialized once. */
	loaded: DurableSnapshot;
	dispose?: () => void | Promise<void>;
	/**
	 * Where a subscriber's own failure and a failed durable flush go.
	 *
	 * A listener that throws is contained rather than allowed to abort a
	 * batch, because the commit that produced the batch is already accepted
	 * and one broken listener must not cost every other one its notification;
	 * containing it without reporting it would make a broken subscriber look
	 * like a store that stopped notifying.
	 */
	log?: Logger;
};

export type CreateStoreOptions<TDatabase extends DataDefinition> = {
	/** The application's definition declaration, a `defineData` literal. */
	definition: TDatabase;
	/** The durable record: the update log, the outbox, the cursor, the metadata. */
	sqlite: SqliteDatabase;
	dispose?: () => void | Promise<void>;
	log?: Logger;
};

/**
 * Parse a declaration handed to a constructor as a literal.
 *
 * Throwing, not Result-returning, and that is a boundary rather than an
 * accident: at this level the declaration is a `defineData` literal the
 * compiler already validated, so a parse refusal is a programmer error. The
 * openers, which may be handed a declaration that arrived as data, parse
 * first and return the refusal as a boot outcome instead.
 */
function parsedDatabaseOrThrow(
	definition: DataDefinition,
): ParsedDataDefinition {
	const { data, error } = parseData(definition);
	if (error !== null) throw new Error(error.message, { cause: error });
	return data;
}

/** Build the engine options for a synchronous SQLite durable engine. */
function overSqlite<TDatabase extends DataDefinition>(
	{ definition, sqlite, ...rest }: CreateStoreOptions<TDatabase>,
	syncs: boolean,
): StoreEngineOptions {
	const port = createSqliteDurablePort({ sqlite, syncs });
	return {
		definition: parsedDatabaseOrThrow(definition),
		durable: port,
		loaded: port.load(),
		...rest,
	};
}

/**
 * Open a document with no remote authority, the device document of ADR-0233.
 *
 * No commit is owed to anyone, so nothing joins the outbox and none of the
 * replica verbs exists, at the type or at runtime. Without this, a device
 * document enqueued every commit into an outbox that only a sync
 * acknowledgement can drain, so its durable record grew with every write it
 * ever took, forever.
 */
export function createLocalStore<const TDatabase extends DataDefinition>(
	options: CreateStoreOptions<TDatabase>,
): LocalData<TDatabase> {
	const { store, view } = createStoreEngine(overSqlite(options, false), 'none');
	return Object.freeze({
		...(view as DataView<TDatabase>),
		...store,
	});
}

/**
 * Open a store that is one replica of an authority's current document.
 *
 * Every local commit joins the outbox until the authority acknowledges it,
 * and the replica verbs (`sync`, `applyRemote`, `onLocalWork`,
 * `hasUnresolvedDependencies`) exist. The two constructors share one private
 * engine because the obligation is one ordered queue: authored bytes and
 * their outbox claim are adjacent ops in one atomic flush batch, so durable
 * state can never hold a write locally and unowed (ADR-0238). A wrapper
 * subscribing from outside would commit the obligation in a second batch and
 * break exactly that.
 */
export function createAccountStore<const TDatabase extends DataDefinition>(
	options: CreateStoreOptions<TDatabase>,
): AccountData<TDatabase> {
	const { store, view } = createStoreEngine(
		overSqlite(options, true),
		'remote',
	);
	return Object.freeze({
		...(view as DataView<TDatabase>),
		...store,
	});
}

/**
 * The same two constructors over an arbitrary durable engine (ADR-0238),
 * returned as parts rather than composed data.
 *
 * The browser passes an IndexedDB port here; the SQLite constructors above
 * are this plus `createSqliteDurablePort`. The caller loads the snapshot
 * first (that may be asynchronous), so construction itself stays synchronous.
 * Parts, because an opener may still have to wrap the store (`discard` on a
 * deletable replica) before composing what an application sees; the store and
 * the view are one runtime either way, born over one definition.
 */
export function createLocalStoreOverPort(options: StoreEngineOptions): {
	store: LocalDocument;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
} {
	return createStoreEngine(options, 'none');
}

export function createAccountStoreOverPort(options: StoreEngineOptions): {
	store: AccountDocument;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
} {
	return createStoreEngine(options, 'remote');
}

function createStoreEngine(
	options: StoreEngineOptions,
	replication: 'none',
): {
	store: LocalDocument;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
};
function createStoreEngine(
	options: StoreEngineOptions,
	replication: 'remote',
): {
	store: AccountDocument;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
};
function createStoreEngine(
	{
		definition,
		durable,
		loaded,
		dispose = () => undefined,
		log = createLogger('data/store'),
	}: StoreEngineOptions,
	replication: 'none' | 'remote',
): {
	store: LocalDocument | AccountDocument;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
} {
	const database = createDatabaseDocument();
	let disposed = false;

	/**
	 * The local-persistence debt: accepted work the durable engine has not
	 * confirmed (ADR-0238). Every verb enqueues here and returns; a refused
	 * flush retains the work and reports `blocked`, and never fails the verb.
	 */
	const controller = createPersistenceController({
		port: durable,
		loaded,
		log,
	});

	/**
	 * The next append id. The store mints ids, never the port.
	 *
	 * Every append is numbered now, not only owed ones, because the id is what
	 * an acknowledgement names and what the fold leaves stable. Seeded past
	 * everything the record already holds so an id is never reused across a
	 * reopen.
	 */
	let nextId = loaded.lastId + 1;
	const mintId = (): number => nextId++;
	/**
	 * Who is watching each table, keyed by its ROOT. A ping, not a payload.
	 *
	 * By root rather than by name, because a commit arrives as changed types and
	 * a subscriber arrives holding the root its handle was built on: keying by
	 * name meant a second map to translate one into the other, and the name it
	 * produced was never used for anything but the lookup below. `typeListeners`
	 * is keyed the same way, so both keyed signals are now one shape.
	 */
	const tableListeners = new Map<Y.Type, Set<() => void>>();
	/** Who is watching the one KV root. Beside the tables', for the one reason. */
	const kvListeners = new Set<() => void>();
	/** The one KV root, taken once so a commit can be checked against it. */
	const kvRootType = kvRoot(database);
	/**
	 * Who is watching each type field, by the type itself.
	 *
	 * Keyed by the live type rather than by a row and field name, because that
	 * is what a commit names: `changedParentTypes` holds types, and a lookup
	 * beats reconstructing an address for each one.
	 */
	const typeListeners = new Map<Y.Type, Set<() => void>>();
	const localWorkListeners = new Set<() => void>();
	const committedListeners = new Set<() => void>();

	/**
	 * Tell every listener, and let none of them cost another its notification.
	 *
	 * Copied before iteration, because a listener is allowed to subscribe or
	 * unsubscribe while being told. A throw is contained and logged rather than
	 * propagated: the commit that caused the notification is already accepted,
	 * so a broken subscriber is that subscriber's bug and must not read as a
	 * store that stopped notifying.
	 */
	function notify(listeners: ReadonlySet<() => void> | undefined): void {
		if (listeners === undefined || listeners.size === 0) return;
		for (const listener of [...listeners]) {
			const { error } = trySync({
				try: listener,
				catch: (cause) => StoreError.SubscriberThrew({ cause }),
			});
			if (error !== null) log.error(error);
		}
	}

	/**
	 * Register a listener under one key, and hand back its teardown.
	 *
	 * The key is dropped once nobody watches it, and that pruning is not
	 * tidiness: `deliver` skips its whole table walk on `tableListeners.size
	 * === 0` and skips the type phase on `typeListeners.size === 0`, so a key
	 * left behind holding an empty set is a fast path quietly switched off.
	 * Written once, so the next keyed signal cannot be added without it.
	 *
	 * The teardown is idempotent, because a Svelte effect that reruns can call
	 * the one it was handed more than once.
	 */
	function subscribeByKey<TKey>(
		listeners: Map<TKey, Set<() => void>>,
		key: TKey,
		listener: () => void,
	): () => void {
		let forKey = listeners.get(key);
		if (forKey === undefined) {
			forKey = new Set();
			listeners.set(key, forKey);
		}
		forKey.add(listener);
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			forKey.delete(listener);
			if (forKey.size === 0) listeners.delete(key);
		};
	}

	/**
	 * Hand a settled commit to whoever is waiting for it.
	 *
	 * Runs at ACCEPTANCE, whatever the durable engine does later (ADR-0238),
	 * and reads the transaction rather than a buffer. Yjs maintains both maps
	 * for every transaction whether or not anything observes them, so what a
	 * subscriber needs is already assembled by the time `updateV2` fires; the
	 * buffers this replaced existed only to carry the same facts forward from
	 * the type-level `'delta'` events, which fire mid-acceptance and cannot be
	 * delivered from.
	 *
	 * Phase order is a contract: `onCommitted` listeners first, then KV, then
	 * tables, then type fields, so a follower that marks itself dirty in the
	 * first phase is dirty before any subscriber reads.
	 */
	function deliver(transaction: Y.Transaction): void {
		notify(committedListeners);
		if (transaction.changed.has(kvRootType)) notify(kvListeners);
		// A table's signal means its SHAPE changed, which is two depths and not
		// three (ADR-0187's superset, drawn as tightly as the document allows):
		//
		//   the table root    a row was added or removed
		//   a row             one of its scalars changed
		//   deeper            a type field's own content. NOT a table event.
		//
		// The third line is the whole point. A row's type field is nested on the
		// row (ADR-0295), so before this every prose keystroke bubbled to the
		// table root and woke every list in the application. `changed` holds only
		// what a transaction modified DIRECTLY, so the bubble never happens and
		// the depth test is a parent lookup rather than a walk.
		//
		// Skipped outright when nothing is subscribed, which is what the
		// per-table `'delta'` attach used to buy: a commit of 2,000 rows in an
		// application that watches no table should walk nothing and allocate
		// nothing. `subscribe` prunes its own entry so this stays true.
		if (tableListeners.size === 0) return deliverTypes(transaction);
		const roots = new Set<Y.Type>();
		for (const type of transaction.changed.keys()) {
			if (tableListeners.has(type)) {
				roots.add(type);
				continue;
			}
			const parent = type.parent;
			if (parent !== null && tableListeners.has(parent)) roots.add(parent);
		}
		for (const root of roots) {
			notify(tableListeners.get(root));
		}
		deliverTypes(transaction);
	}

	/**
	 * The last and finest phase: type-field watchers.
	 *
	 * A type-field subscriber is where an application hangs its own derived
	 * write (ADR-0297), so it runs after every coarser reader has already seen
	 * the commit that caused it.
	 *
	 * `changedParentTypes` rather than `changed`, because this is the one
	 * signal that SHOULD bubble: a watcher on a field wants an edit anywhere
	 * inside it, which is what the type-level `'delta'` it replaced reported.
	 */
	function deliverTypes(transaction: Y.Transaction): void {
		if (typeListeners.size === 0) return;
		for (const type of transaction.changedParentTypes.keys()) {
			notify(typeListeners.get(type));
		}
	}

	// The transport's nudge fires when a flush durably grows the outbox, not
	// when a commit is accepted: the sender reads only the durable outbox, so
	// nudging earlier would wake it to find nothing sendable (ADR-0238).
	controller.onOutboxGrew(() => notify(localWorkListeners));

	// Hydrate BEFORE the listener exists, so replaying the record cannot append
	// what it just read. Ordering rather than an origin to ignore, and the
	// ordering is backstopped: a replay that reached the listener would carry
	// `transaction.local === false` with no remote origin, and the throw below
	// would fail the open loudly on the first stored update.
	for (const stored of loaded.updates) {
		Y.applyUpdateV2(database, copyBytes(stored), null);
	}

	database.on(
		'updateV2',
		(
			update: Uint8Array,
			origin: unknown,
			_document: Y.Doc,
			transaction: Y.Transaction,
		) => {
			if (isRemoteApply(origin)) {
				// `applyRemote` owns both halves for its own bytes. It hears about
				// this transaction through the origin it minted.
				origin.transaction = transaction;
				return;
			}
			// What remains must be a LOCAL transaction, whether a store verb ran
			// it under `localOrigin` or an application wrote through a live type
			// it holds. `applyUpdateV2` forces `transaction.local` to false and a
			// local `transact` defaults it to true, so this check makes the branch
			// below provably an application writing through this document's own
			// types rather than by convention. Decoded foreign bytes reaching it
			// would be persisted as the EMITTED update rather than the received
			// one (nothing at all when causal dependencies are missing; see
			// `applyRemote`), and would join the outbox as this device's authored
			// work and be republished to the authority. The throw surfaces
			// synchronously at the rogue `Y.applyUpdateV2` call site, before
			// anything is accepted, so the store is untouched.
			if (!transaction.local) {
				throw new Error(
					"Foreign bytes must enter through applyRemote. A direct Y.applyUpdateV2 on this document would be republished as this device's own work, and is lost entirely when its causal dependencies have not arrived.",
				);
			}
			// The delivery runs in a finally, deliberately: the live document
			// already holds the change, so what a subscriber would read is true
			// whatever the durable engine later does with the bytes.
			try {
				controller.enqueue([
					{
						kind: 'append',
						id: mintId(),
						bytes: copyBytes(update),
						// What an append this device authored owes the authority:
						// nothing yet, on either store kind, because neither has a
						// position for bytes the authority has not seen. On a local
						// store nothing ever reads it, since there is no sender, and
						// the port folds its chain whole rather than asking.
						authoritySeq: undefined,
					},
				]);
			} finally {
				deliver(transaction);
			}
		},
	);

	/**
	 * The one gate every verb passes: a disposed store throws, it never
	 * returns. Fresh per throw so each call site gets its own stack.
	 */
	function assertUsable(): void {
		if (disposed) throw new StoreUnusableError();
	}

	/**
	 * Run direct data operations as one Yjs transaction and one durable batch,
	 * under the origin that marks them as this device's work.
	 *
	 * The one write path: every store verb runs its mutation through here, and
	 * an application groups several of them by calling it itself. There is no
	 * second, ungated form, so the disposal check is on the mutation rather
	 * than on the caller remembering to have made it.
	 *
	 * Everything durable happens in the `updateV2` listener, which fires inside
	 * `transact` after the observers, after `afterTransaction`, and after
	 * cleanup (verified against `@y/y@14.0.0-rc.24`). That is the only moment
	 * the change is settled AND its bytes exist, so it is the only moment both
	 * halves of a commit can be done at once. Acceptance is the synchronous
	 * half and cannot fail for storage reasons; durability is the queued half
	 * (ADR-0238). On a synchronous engine the flush completes before this
	 * returns.
	 *
	 * Nesting needs no bookkeeping here. A `transact` opened inside an open one
	 * reuses the transaction already running and ignores the origin it was
	 * handed, so nested store verbs join the outer one by construction and
	 * `updateV2` fires once, for the outermost. A throw from `run` still leaves
	 * through Yjs's own `finally`, so a partial mutation is queued and
	 * delivered before the error propagates.
	 */
	function transact<TResult>(run: () => TResult): TResult {
		assertUsable();
		return database.transact(run, localOrigin);
	}

	/**
	 * The delivery machinery, or nothing at all.
	 *
	 * Composed rather than always present, so a store with no authority has
	 * no engine to reach: `syncEngineOf` finds nothing because nothing was
	 * registered, exactly as `sync: undefined` says at the type.
	 */
	const syncEngine: SyncEngine | undefined =
		replication === 'none'
			? undefined
			: {
					...createClientLog(),
					applyRemote(
						update: Uint8Array,
						opts?: { advanceTo?: number },
					): Result<void, ApplyFailedError> {
						assertUsable();
						// One document, so one run of bytes (ADR-0295). The envelope that
						// used to wrap this is gone with the split it multiplexed: there
						// is nothing left to address, so the payload IS the update.
						//
						// The RECEIVED bytes are what gets persisted, never what the
						// document emitted in response to them. Measured against
						// `@y/y@14.0.0-rc.24`: an update whose causal dependencies have
						// not arrived is buffered into `store.pendingStructs`,
						// `applyUpdateV2` returns normally, and the document emits NO
						// `updateV2` event at all. Persisting emitted bytes therefore
						// writes nothing, while the caller advances its cursor and the
						// data is lost permanently with every layer reporting success.
						const received = copyBytes(update);
						// The origin the listener hands this transaction back through.
						// Minted per call, so nothing about one apply has to be
						// remembered beside the store.
						const applying: RemoteApply = { kind: 'epicenter-remote' };
						// A refusal is a property of the bytes: nothing already applied is
						// rolled back (an update is idempotent, so a re-receive after the
						// refusal re-applies harmlessly), the cursor does not advance, and
						// the store stays usable.
						const { error } = trySync({
							try: () => Y.applyUpdateV2(database, received, applying),
							catch: (cause) => StoreError.ApplyFailed({ cause }),
						});
						if (error !== null) return Err(error);
						try {
							// With the bytes, never after them: the bookmark and what it
							// accounts for are adjacent ops in one atomic flush batch, so
							// durable state can never hold a cursor ahead of the bytes, and
							// never bytes wearing a fresh install's cursor (ADR-0231,
							// carried by ADR-0238's whole-queue flush). The cursor is
							// derived from the position the append carries, so it cannot
							// run ahead of it, and a crash before the batch lands
							// re-receives, which is free because an update is idempotent.
							controller.enqueue([
								{
									kind: 'append',
									id: mintId(),
									bytes: received,
									// The position these bytes came FROM. Bytes that arrived
									// are never owed, whether or not the caller knew the
									// position they arrived at.
									authoritySeq: opts?.advanceTo ?? NO_AUTHORITY,
								},
							]);
						} finally {
							// After the enqueue, so every listener phase observes one
							// settled commit. Undefined when the update had missing
							// dependencies: Yjs buffered it and emitted nothing, so the
							// document did not change and there is nothing to deliver.
							if (applying.transaction !== undefined) {
								deliver(applying.transaction);
							}
						}
						return Ok(undefined);
					},
					onLocalWork(listener: () => void): () => void {
						localWorkListeners.add(listener);
						return () => localWorkListeners.delete(listener);
					},
					hasUnresolvedDependencies: () => hasPendingStructs(database),
					async encodeSnapshot(): Promise<Uint8Array> {
						assertUsable();
						return new Uint8Array(Y.encodeStateAsUpdateV2(database));
					},
				};

	// The one view this runtime will ever hold, built over the one definition,
	// after hydration.
	const view = buildView();

	const base: DataDocument = {
		/**
		 * Everything this application has stored, before its declaration reads
		 * it (ADR-0267).
		 *
		 * The one faithful read, and it is on the data rather than on a table on
		 * purpose. A table handle is the application's lens: `get` and `list`
		 * answer what THIS release can read, and both narrow to the declared
		 * fields, so a key an older release wrote and this one no longer names
		 * is unreachable through them. That narrowing is correct for an
		 * application and correct for any index a follower rebuilds on demand.
		 * It is wrong for an artifact: an export that drops a field is data
		 * loss, and the caller that must not lose one is asking about the store,
		 * not a table.
		 *
		 * So it enumerates the roots the document actually holds rather than the
		 * tables the declaration names, and it hands back stored values untyped.
		 * Untyped is the point: reaching for this means giving up the lens, and
		 * the absent row types are what makes that visible at the call site.
		 *
		 * A row's type content is not here, and cannot be: a nested `Y.Type` is
		 * not a JSON value, so no faithful read of stored VALUES can carry one.
		 * An export reaches it through `content` and the table's own file codec
		 * (ADR-0296).
		 */
		stored(): StoredData {
			assertUsable();
			const tables = new Map<string, ReadonlyMap<string, JsonObject>>();
			for (const tableName of storedTableNames(database)) {
				tables.set(tableName, rowsOf(tableName));
			}
			return { tables, kv: storedKv() };
		},
		/**
		 * One row as the exporter reads it: faithful scalars, live types.
		 *
		 * Deliberately not through a table handle. `readRow` returns every
		 * stored key including ones this release no longer declares, and no
		 * conformance runs, so a row the lens cannot read still has a file
		 * (ADR-0267, ADR-0125). The types come from the declaration's names,
		 * because a type at an undeclared key is unreachable by any codec
		 * anyway.
		 */
		rowFile(tableName: string, rowId: string): Row | undefined {
			assertUsable();
			const root = tableRoot(database, tableName);
			const fields = readRow(root, rowId);
			if (fields === undefined) return undefined;
			const types = definition.tables.get(tableName)?.types ?? [];
			return {
				id: rowId,
				...fields,
				...readRowTypes(root, rowId, types),
			};
		},
		onCommitted(listener: () => void): () => void {
			committedListeners.add(listener);
			return () => committedListeners.delete(listener);
		},
		pressure(): DocumentPressure {
			assertUsable();
			let liveRows = 0;
			// Only declared tables: a document may carry a table this definition
			// does not declare, and guessing at it would report a number
			// nobody could act on.
			for (const tableName of definition.tables.keys()) {
				liveRows += listRowIds(tableRoot(database, tableName)).length;
			}
			const items = structCount(database);
			return {
				items,
				liveRows,
				itemsPerLiveRow: liveRows === 0 ? items : items / liveRows,
			};
		},
		stateVector: () => new Uint8Array(Y.encodeStateVector(database)),
		encodeStateSince: (stateVector?: Uint8Array) =>
			new Uint8Array(Y.encodeStateAsUpdateV2(database, stateVector)),
		// Acceptance, retirement, and state enumeration are the engine's to drive.
		persistence: controller.persistence,
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			// One final attempt over whatever is still queued, then let go.
			// Disposal never spins on a blocked engine: closing while blocked is
			// the accepted loss ADR-0238 makes visible, not a reason to hang.
			await controller.persistence.flush();
			database.destroy();
			await dispose();
		},
	};
	// Both kinds carry `sync`; the VALUE is the discriminant. A device store
	// holds `undefined`, a replica holds the frozen capability, and the
	// delivery machinery is registered against the capability so wrappers
	// that spread the store (a `discard()` opener) keep the door reachable.
	if (syncEngine === undefined) {
		return {
			store: Object.freeze({ ...base, sync: undefined }),
			view,
			definition,
		};
	}
	const sync: SyncCapability = Object.freeze({ replicates: true as const });
	syncEngines.set(sync, Object.freeze(syncEngine));
	return { store: Object.freeze({ ...base, sync }), view, definition };

	function createClientLog(): ClientLog {
		// Typed where it is WRITTEN, not where it is returned. `Object.freeze(literal)`
		// infers `Readonly<typeof literal>` first, so by the time the result meets
		// the return type it is no longer a FRESH literal and an extra member is
		// not an error. Annotating here is what makes a phantom impossible: one
		// was implemented and unreachable for a release because a cast hid it.
		const handle: ClientLog = {
			coalesce(): { id: number; bytes: Uint8Array } | undefined {
				assertUsable();
				// The DURABLE outbox, and nothing on top of it. A local edit is
				// offered to the authority only once it is durable (ADR-0238): the
				// queue's contents are not here, so a blocked flush simply leaves
				// nothing new to send.
				//
				// There is no session overlay of what was acknowledged. While an
				// `ack` op waits behind a blocked flush its entries are still owed
				// on disk and go out again, which is redundant upload and nothing
				// worse: the authority already holds them and an update is
				// idempotent, so re-delivery is the safe direction. One truth about
				// what is owed, and it is the one that survives a restart.
				const entries = controller.durableOutbox();
				const last = entries.at(-1);
				if (last === undefined) return undefined;
				// One document, so one merge (ADR-0295). Every unsent entry belongs
				// to the same document, so they merge into one update rather than
				// grouping into an envelope's sections.
				//
				// Merged for the wire and nowhere else. This used to write the merge
				// back as a durable op, which was the only compaction that crossed
				// the port boundary while the far larger fold stayed private to it.
				// It carried no invariant: merging preserves the highest covered id
				// and is idempotent, so re-merging on the next pass costs a little
				// work and changes nothing.
				const bytes =
					entries.length === 1
						? last.bytes
						: new Uint8Array(
								Y.mergeUpdatesV2(
									entries.map((entry) =>
										copyBytes(entry.bytes),
									) as Uint8Array<ArrayBuffer>[],
								),
							);
				return { id: last.id, bytes };
			},
			acknowledge(throughId: number, authoritySeq: number): void {
				assertUsable();
				// One op for what used to be two. Dropping the outbox and moving
				// the cursor were the same fact reported twice: these bytes reached
				// the authority's log, at this position. If it never lands and the
				// client restarts, the appends are still owed and go out again;
				// the authority already holds them and an update is idempotent, so
				// re-delivery is the safe direction.
				controller.enqueue([{ kind: 'ack', throughId, authoritySeq }]);
			},
			cursor(): number {
				assertUsable();
				// The DURABLE position, which is the only one there is. It can lag
				// the document behind a blocked flush, and a reconnect then dials
				// from behind and re-receives entries this document already holds.
				// That costs a bounded re-download and changes nothing, because an
				// update is idempotent.
				return controller.durableCursor();
			},
		};
		return Object.freeze(handle);
	}

	/**
	 * The one typed surface this runtime will ever have, built over the one
	 * definition (ADR-0240).
	 *
	 * SQL is deliberately not built here: an index is a follower an application
	 * composes over this surface, not a verb the store owes.
	 */
	function buildView(): UntypedDataView {
		const kv = createKvHandle();

		const tables: Record<string, TableHandle> = {};
		for (const [tableName, table] of definition.tables) {
			tables[tableName] = createTableHandle(tableName, table);
		}

		// Typed where it is WRITTEN, not where it is returned. `Object.freeze(literal)`
		// infers `Readonly<typeof literal>` first, so by the time the result meets
		// the return type it is no longer a FRESH literal and an extra member is
		// not an error. Annotating here is what makes a phantom impossible: one
		// was implemented and unreachable for a release because a cast hid it.
		const handle: UntypedDataView = {
			tables: Object.freeze(tables),
			kv,
			// Beside the writes it groups. Grouping is what an application does,
			// so it belongs on the application's surface rather than on the
			// store's, which is what a transport and an exporter hold.
			transact,
		};
		return Object.freeze(handle);
	}

	/**
	 * The KV handle for this definition's one KV section.
	 *
	 * The root is minted here, which is safe for the same reason KV lives there
	 * at all: `Doc.get` is `setIfUndefined` on `doc.share`, so every device that
	 * mints `kv` converges on one logical root.
	 *
	 * Every definition has a `kv` section, even when it is `{}`. An empty section
	 * has no read lens, so the handle reads and writes the raw structured value
	 * rather than refusing keys that the declaration does not know about.
	 */
	function createKvHandle(): KvHandle {
		const table = definition.kv;
		const root = kvRoot(database);

		/**
		 * The declared keys this release can read, and the ones it cannot.
		 *
		 * Conformance runs over the whole stored object because that is what the
		 * declaration checks, and then the two halves are served separately: one
		 * key that fails costs that key, not the object around it.
		 */
		function readBack(): {
			conforming: JsonObject;
			issues: ConformanceIssue[];
		} {
			return table.conformance(storedKv());
		}

		// Typed where it is WRITTEN, not where it is returned. `Object.freeze(literal)`
		// infers `Readonly<typeof literal>` first, so by the time the result meets
		// the return type it is no longer a FRESH literal and an extra member is
		// not an error. Annotating here is what makes a phantom impossible: one
		// was implemented and unreachable for a release because a cast hid it.
		const handle: KvHandle = {
			get(key: string) {
				assertUsable();
				const { conforming, issues } = readBack();
				// A key the declaration refused is absent here, exactly as a key
				// nobody ever wrote is. The caller falls back the same way for both,
				// which is why the two are not told apart.
				if (issues.some((issue) => issue.field === key)) return undefined;
				return conforming[key];
			},
			get nonconforming(): ConformanceIssue[] {
				assertUsable();
				return readBack().issues;
			},
			subscribe(listener: () => void): () => void {
				kvListeners.add(listener);
				let stopped = false;
				return () => {
					// Idempotent, because a Svelte effect that reruns can call the
					// teardown it was handed more than once.
					if (stopped) return;
					stopped = true;
					kvListeners.delete(listener);
				};
			},
			update(values: JsonObject): void {
				transact(() => {
					for (const [name, value] of Object.entries(values)) {
						root.setAttr(name as never, value as never);
					}
				});
			},
		};
		return Object.freeze(handle);
	}

	/** Every row of one table: by id, unvalidated. */
	function rowsOf(tableName: string): Map<string, JsonObject> {
		const root = tableRoot(database, tableName);
		const rows = new Map<string, JsonObject>();
		for (const rowId of listRowIds(root)) {
			const payload = readRow(root, rowId);
			if (payload !== undefined) rows.set(rowId, payload);
		}
		return rows;
	}

	/** The kv root's stored values, unvalidated. */
	function storedKv(): JsonObject {
		const root = kvRoot(database);
		const values: JsonObject = {};
		for (const key of root.attrKeys()) {
			values[key as string] = root.getAttr(key as never) as JsonValue;
		}
		return values;
	}

	function createTableHandle(
		tableName: string,
		table: ParsedTable,
	): TableHandle {
		const root = tableRoot(database, tableName);
		/** The type fields this table declares, minted with every row it creates. */
		const typeFields = table.types;

		/** One stored payload, read through the declaration the way every read reads. */
		function conformRow(
			rowId: string,
			payload: JsonObject,
		): Result<Row, NonconformingRow> {
			const { conforming, issues } = table.conformance(payload);
			return issues.length === 0
				? Ok({ id: rowId, ...conforming })
				: Err({
						id: rowId,
						raw: payload,
						// The structural id rides along, so the two branches of the one
						// recovery composition produce the same shape:
						// `data ?? { ...applicationRecovery, ...error.conforming }` is a whole row
						// either way.
						conforming: { id: rowId, ...conforming },
						issues,
					});
		}

		/** One row as an application reads it: the scalars, and the live types. */
		function withTypes(row: Row): Row {
			return { ...row, ...readRowTypes(root, row.id, typeFields) };
		}

		// Typed where it is WRITTEN, not where it is returned. `Object.freeze(literal)`
		// infers `Readonly<typeof literal>` first, so by the time the result meets
		// the return type it is no longer a FRESH literal and an extra member is
		// not an error. Annotating here is what makes a phantom impossible: one
		// was implemented and unreachable for a release because a cast hid it.
		const handle: TableHandle = {
			create(fields: RowInput): Row {
				const rowId = mintRowId();
				// The type fields are integrated in the same transaction (ADR-0295),
				// and never again: nested types do not converge by name, so a field
				// minted lazily on two devices would lose one subtree.
				transact(() => createRow(root, rowId, fields, typeFields));
				// Read back rather than echoed: a type field the caller omitted was
				// minted empty here, and one it passed is now the INTEGRATED type
				// rather than the detached one it handed over. Echoing the argument
				// would return a type that reads as empty.
				return withTypes({ id: rowId, ...readRow(root, rowId) });
			},
			get(rowId: string): Row | undefined {
				assertUsable();
				const payload = readRow(root, rowId);
				if (payload === undefined) return undefined;
				// A row this declaration cannot read does not arrive. It is not
				// hidden: it is on `nonconforming`, with its raw values, which is
				// where every consumer already looks and where a repair is composed
				// (ADR-0125). Absent and unreadable answer the same way here because
				// a caller asking for one row does the same thing with either.
				const { data } = conformRow(rowId, payload);
				return data === null ? undefined : withTypes(data);
			},
			update(rowId: string, fields: JsonObject): Result<void, RowAbsentError> {
				// One lookup, not two. This used to ask `hasRow` and then write
				// through a function that would have minted the row had the answer
				// changed in between; `updateRow` answers whether it found one, so
				// the check and the write are the same read.
				const written = transact(() => updateRow(root, rowId, fields));
				if (!written) return StoreError.RowAbsent({ table: tableName, rowId });
				return Ok(undefined);
			},
			delete(rowId: string): void {
				// One removal (ADR-0295). Taking the row's nested type off the root
				// takes its type fields with it, so there is no second address to
				// retire and nothing to compose this write with.
				transact(() => {
					deleteRow(root, rowId);
				});
			},
			ids(): string[] {
				assertUsable();
				return listRowIds(root);
			},
			get rows(): Row[] {
				assertUsable();
				const rows: Row[] = [];
				for (const [rowId, payload] of rowsOf(tableName)) {
					const { data } = conformRow(rowId, payload);
					if (data !== null) rows.push(withTypes(data));
				}
				return rows;
			},
			get nonconforming(): NonconformingRow[] {
				assertUsable();
				const nonconforming: NonconformingRow[] = [];
				for (const [rowId, payload] of rowsOf(tableName)) {
					const { error } = conformRow(rowId, payload);
					if (error !== null) nonconforming.push(error);
				}
				return nonconforming;
			},
			/**
			 * Hear that this table's SHAPE changed: a row added, a row removed, or
			 * a row's scalars edited. Not an edit inside a type field.
			 *
			 * A ping, not a payload. `deliver` decides what counts, by depth
			 * against the table root, so nothing is registered on the document
			 * here and there is no listener lifecycle to keep in step.
			 */
			subscribe(listener: () => void): () => void {
				return subscribeByKey(tableListeners, root, listener);
			},
			watch(type: Y.Type, listener: () => void): () => void {
				assertUsable();
				// Keyed by the type itself, which is what a commit names:
				// `deliver` reads `changedParentTypes`, so an edit anywhere inside
				// this type reaches the listener while an edit to a sibling does
				// not. `tableName` is not consulted, which is why a type from
				// another table is accepted here (`handles.ts` says why).
				return subscribeByKey(typeListeners, type, listener);
			},
		};
		return Object.freeze(handle);
	}
}

// What Yjs knows and will not say in one word. Both of these read `doc.store`,
// which is DECLARED and typed in `@y/y`'s shipped types; what is missing is a
// predicate, not the fields. Both have exactly one caller above.

/**
 * Whether a document is holding updates whose dependencies never arrived.
 *
 * Yjs buffers an update it cannot integrate and returns normally, with no
 * error and no event, so `pendingStructs` is the only observable symptom of
 * silent data loss. Its own test helper asserts on this exact field after
 * sync.
 *
 * `store.pendingStructs` and `store.pendingDs` are public, typed
 * `null | {...}` on `StructStore`, so this is a plain read and a rename is a
 * BUILD error rather than a test failure. It used to go through
 * `as unknown as { store?: { pendingStructs?: unknown } }`, which is what made
 * a pinning test necessary: the cast accepted a document with no `store` at
 * all and answered "nothing pending" for it.
 */
function hasPendingStructs(document: Y.Doc): boolean {
	return (
		document.store.pendingStructs !== null || document.store.pendingDs !== null
	);
}

/**
 * Structs the engine is holding.
 *
 * `store.clients` is the same map the memory benches count, and the number is
 * the one memory actually tracks. Public and typed, like the fields above.
 */
function structCount(document: Y.Doc): number {
	let total = 0;
	for (const structs of document.store.clients.values()) {
		total += structs.length;
	}
	return total;
}
