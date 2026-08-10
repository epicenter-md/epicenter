import { createInvalidationDispatcher, type JsonObject, type JsonValue, type RowAddress, type TableInvalidationListener } from '@epicenter/lens';
import { type CreateInputOf, KV_ROOT, type KvOf, type LensJson, type LensParseError, type NonconformingRowError, type ParsedLens, type ParsedTable, parseLens, type RowOf, RowWriteError } from '@epicenter/lens';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	createAppDocument,
	deleteRow,
	kvRoot,
	documentContainer,
	hasRow,
	listRowIds,
	readRow,
	tableRoot,
	writeRow,
} from './document.js';
import {
	appendUpdate,
	applyProjectionSchema,
	applyStoreSchema,
	copyBytes,
	deleteProjectedRow,
	dropOutboxThrough,
	enqueueOutbox,
	APP_DOCUMENT,
	type OutboxEntry,
	readCursor,
	readOutbox,
	readUpdates,
	rebuildProjectedTable,
	replaceOutboxThrough,
	upsertProjectedRow,
	writeCursor,
} from './persistence.js';

/**
 * Whether a document is holding updates whose dependencies never arrived.
 *
 * `store.pendingStructs` is internal, and deliberately so: Yjs buffers an
 * update it cannot integrate and returns normally, with no error, no event, and
 * no public reader. It is still the only observable symptom of silent data
 * loss, and Yjs's own test helper asserts on this exact field after sync, so it
 * is read here through one named function rather than reached for in several
 * places. Pinned by a test, because it is internal and an rc can move it.
 */
function hasPendingStructs(document: Y.Doc): boolean {
	const store = (document as unknown as {
		store?: { pendingStructs?: unknown; pendingDs?: unknown };
	}).store;
	return (
		(store?.pendingStructs ?? null) !== null || (store?.pendingDs ?? null) !== null
	);
}

/**
 * Structs the engine is holding.
 *
 * Reads the same internal `store.clients` the memory benches count, and for the
 * same reason: there is no public reader, and the number is the one memory
 * actually tracks. Pinned by a test, because an rc can move it.
 */
function structCount(document: Y.Doc): number {
	const clients = (document as unknown as {
		store?: { clients?: Map<number, { length: number }[]> };
	}).store?.clients;
	let total = 0;
	for (const structs of clients?.values() ?? []) total += structs.length;
	return total;
}

/** ADR-0206's minted id: 24 characters, so a collision never happens. */
const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

/** Bytes this process authored, which is what has to reach the authority. */
const localOrigin = Object.freeze({ kind: 'epicenter-local' });
/** Bytes replayed from SQLite, which must not be appended back to SQLite. */
const hydrationOrigin = Object.freeze({ kind: 'epicenter-hydration' });
/** Bytes that arrived from a peer: durable, but not local work. */
export const remoteOrigin = Object.freeze({ kind: 'epicenter-remote' });

export const StoreError = defineErrors({
	/**
	 * A write named an address that holds no row.
	 *
	 * The verb this replaces returned `Ok(undefined)` and silently swallowed the
	 * write, which is a live bug in the code this store supersedes. A write that
	 * reaches nothing is a failure and says so.
	 */
	RowAbsent: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Table '${table}' holds no row '${rowId}'`,
		table,
		rowId,
	}),
	/**
	 * Durable storage refused a write the live document already made.
	 *
	 * Terminal for the store. Memory and SQLite have diverged, so continuing
	 * would publish work that was never committed; every later call reports this
	 * rather than compounding it.
	 */
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The store could not commit to durable storage',
		cause,
	}),
	Disposed: () => ({ message: 'This store is disposed' }),
	/**
	 * This process already holds this namespace open.
	 *
	 * A second open would be a second `Y.Doc` over one document, and the two
	 * cannot see each other's writes: they converge through storage under
	 * last-writer-wins, so one side's work vanishes with no error and nothing to
	 * retry (ADR-0229). Dispose the first application, or share the one you have.
	 */
	AlreadyOpen: ({ namespace }: { namespace: string }) => ({
		message: `This process already has ${namespace} open`,
		namespace,
	}),
	/**
	 * A subscriber threw while being told about a committed change.
	 *
	 * Logged, never returned. It is the subscriber's own bug, the commit that
	 * produced the notification is already durable, and failing the write that
	 * caused it would make one broken listener into everybody's data loss.
	 */
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: 'A store subscriber threw while being told about a commit',
		cause,
	}),
});
export type StoreError = InferErrors<typeof StoreError>;

export type ReadRowError = StoreError | NonconformingRowError;
export type WriteRowError = StoreError | RowWriteError | NonconformingRowError;

export type { TableInvalidation, TableInvalidationListener } from '@epicenter/lens';

export type Row = { id: string } & JsonObject;

export type TableHandle = {
	/**
	 * The values a read supplies for keys a stored payload does not have.
	 *
	 * Half of the one recovery composition, the other half being a failed read's
	 * `conforming`. Use `??` and never a destructuring default: an Err sets
	 * `data` to null, and `= fallback` fires only on undefined.
	 *
	 * @example
	 * ```ts
	 * const { data, error } = db.settings.get(id);
	 * const row = data ?? { ...db.settings.defaults, ...error?.conforming };
	 * ```
	 */
	readonly defaults: Readonly<JsonObject>;
	/**
	 * Bring one row into being, at a minted id.
	 *
	 * `document` names the roots to allocate inside this row's document, and
	 * naming them here is what makes them safe. `document(id).get(name)` creates
	 * on miss, and a created nested type is addressed by the operation that made
	 * it, so two devices first-opening one note each mint a type at that key and
	 * map LWW discards one along with everything typed into it. It is a narrow
	 * window, once per root at the very start of its life, and it closes the
	 * moment any device creates and syncs it; but the loss is a person's writing
	 * disappearing with no error anywhere, so it is worth making unreachable
	 * rather than documented. This is ADR-0215's own rule for the container,
	 * carried one level down.
	 *
	 * There is no door for a chosen id, and that is a correctness decision. A row
	 * is a nested container addressed by the struct that created it, so two
	 * devices creating one address produce two containers and map LWW discards
	 * one along with every field in it. A 24-character minted id makes that
	 * unreachable rather than merely unlikely. Anything an application wants to
	 * name goes in `kv`, which lives at a name-addressed root.
	 */
	create(
		fields: JsonObject,
		options?: { readonly document?: readonly string[] },
	): Result<Row, WriteRowError>;
	/**
	 * The one read verb.
	 *
	 * `Ok(undefined)` means the address holds no row, which is a fact rather
	 * than a failure. `Err(Nonconforming)` carries `conforming`, so a caller
	 * composes whatever forgiveness it wants without a second verb existing.
	 */
	get(rowId: string): Result<Row | undefined, ReadRowError>;
	/**
	 * Merge fields into an existing row. Refuses an absent address.
	 *
	 * `update` rather than `set`, because only the fields handed in are touched
	 * and every other field is left alone.
	 */
	update(rowId: string, fields: JsonObject): Result<Row, WriteRowError>;
	delete(rowId: string): Result<boolean, StoreError>;
	/** Every row id, sorted. */
	ids(): Result<string[], StoreError>;
	/**
	 * Every row, with the ones this lens cannot read reported separately rather
	 * than dropped or repaired.
	 */
	list(): Result<
		{ rows: Row[]; nonconforming: NonconformingRowError[] },
		StoreError
	>;
	/**
	 * The container this row's document lives in (ADR-0130/0215).
	 *
	 * Synchronous, because the application is one document that was replayed in
	 * full before this binding existed, so there is nothing left to load. That
	 * reverses ADR-0135's asynchronous `open`, whose reason was that a
	 * per-document lazy load returned a half-hydrated handle; with one document
	 * no handle can be half-hydrated. Not disposable either, because nothing is
	 * held open.
	 *
	 * The application names its own roots and picks their formats:
	 * `document(id).get('editor', 'text')`. Epicenter allocates the container
	 * with the row, collects it with the row, and never looks inside.
	 */
	document(rowId: string): RowDocument | undefined;
	/**
	 * Hear when rows in this table change, by id.
	 *
	 * Registration is synchronous, does no I/O, and never fires initially, so a
	 * caller that subscribes and then reads has already seen everything
	 * (ADR-0187). One call per commit per table, carrying every id that commit
	 * touched, and it fires for local writes, for an application's own writes
	 * inside a row's document, and for bytes that arrived from a peer alike.
	 *
	 * It fires AFTER the projection has committed, so a listener may read
	 * through `db.query` and see the same ROWS `get` and `list` report. Same
	 * rows, not the same values: the projection stores what was WRITTEN, so a
	 * field nobody has written reads as its declared default through `list` and
	 * as `NULL` through `db.query`. That is
	 * not free: the ids come from the type's `'delta'` event, which fires
	 * synchronously inside `applyUpdateV2` while the projection is still one
	 * transaction behind, so they are held until the write is durable.
	 *
	 * Nothing emits `{scope:'table'}`. The arm exists because ADR-0187's
	 * consumers already handle it and a future out-of-process proxy will need
	 * it, but an in-process store has no carrier and therefore no carrier gap.
	 */
	subscribe(listener: TableInvalidationListener): () => void;
};

/**
 * One row's document: the roots an application names inside its own container.
 *
 * Mirrors `Y.Doc.get(key, typeName)` deliberately, because a nested `Y.Type`
 * has no such method of its own; it carries attributes, and a root inside a
 * container is one of them. Epicenter creates on miss and returns what is
 * already there, and never reads what is inside.
 */
export type RowDocument = {
	get(root: string, typeName?: string | null): Y.Type;
};

/**
 * Read-only SQL over this store's projection.
 *
 * It reaches one application's tables because a store holds one application,
 * not because anything here scopes by namespace: the statement runs against the
 * whole file, including `_updates`, `_outbox` and `_cursor`. That is a bound on
 * WHAT A STORE IS, and it is the only bound there is.
 *
 * It lives on the binding rather than on the store so that a caller reaches it
 * beside the tables it queries. `query` is a reserved table name for exactly
 * that reason: a table becomes a key on the same handle that carries the
 * method.
 */
export type QueryMethod = (
	strings: TemplateStringsArray,
	...values: SqliteValue[]
) => Result<SqliteRow[], StoreError>;

/**
 * One table, with its own lens's row and create-input types.
 *
 * Written out rather than derived as `Omit<TableHandle, ...> & {...}`. The
 * subtraction is what pushed a bound lens past TypeScript's instantiation depth
 * limit (`TS2589`), because `RowOf` already instantiates an arktype type per
 * field and `Omit` re-maps every remaining member on top of that.
 */
export type TypedTableHandle<TFields> = TableIo<TFields> extends {
	row: infer TRow;
	input: infer TInput;
}
	? {
			readonly defaults: Readonly<JsonObject>;
			create(
				fields: TInput,
				options?: { readonly document?: readonly string[] },
			): Result<TRow, WriteRowError>;
			get(rowId: string): Result<TRow | undefined, ReadRowError>;
			update(
				rowId: string,
				fields: Partial<TInput>,
			): Result<TRow, WriteRowError>;
			delete(rowId: string): Result<boolean, StoreError>;
			ids(): Result<string[], StoreError>;
			list(): Result<
				{ rows: TRow[]; nonconforming: NonconformingRowError[] },
				StoreError
			>;
			document(rowId: string): RowDocument | undefined;
			subscribe(listener: TableInvalidationListener): () => void;
		}
	: never;

/**
 * One table's read and write shapes, from ONE arktype instantiation.
 *
 * `RowOf` and `CreateInputOf` each instantiate the field definitions on their
 * own, so naming both across every verb of every table was enough to exceed
 * TypeScript's depth limit. Resolving the pair once and reusing the two halves
 * keeps the surface identical and the instantiation count at one per table.
 */
type TableIo<TFields> = {
	row: RowOf<TFields>;
	input: CreateInputOf<TFields>;
};

/** The typed view of one store through one lens: its tables, plus `query`. */
export type BoundOf<TLens> = (TLens extends { tables: infer TTables }
	? { [K in keyof TTables]: TypedTableHandle<TTables[K]> }
	: never) & { query: QueryMethod; kv: KvHandle<KvOf<TLens>> };

/**
 * One application's KV: the values it keeps exactly one of.
 *
 * No id and no create, because there is exactly one and it always exists. A
 * key that was never written reads as its declared default, so `get` cannot
 * report absence and does not try to.
 *
 * It lives at a reserved ROOT rather than in a table, and that is a correctness
 * decision rather than a convenience. A root is addressed by its name, so two
 * devices writing settings on their own boot paths converge; a chosen row id is
 * a nested container, and two devices creating one produce two containers of
 * which map LWW keeps one, discarding the other's values entirely.
 */
export type KvHandle<TValues = JsonObject> = {
	/**
	 * The declared defaults, for the same recovery composition a table uses.
	 *
	 * @example
	 * ```ts
	 * const { data, error } = await db.kv.get();
	 * const settings = data ?? { ...db.kv.defaults, ...error?.conforming };
	 * ```
	 */
	readonly defaults: Readonly<JsonObject>;
	/** The one read verb. Every declared key is present, defaulted if unwritten. */
	get(): Result<TValues, ReadRowError>;
	/**
	 * Merge some keys. Every other key is left alone.
	 *
	 * `update` rather than `set` for the same reason a table's is: only the keys
	 * handed in are touched, and `set` promises replacement.
	 */
	update(values: Partial<TValues>): Result<TValues, WriteRowError>;
	/**
	 * Hear when any declared key changes, whoever changed it.
	 *
	 * A void listener rather than a `TableInvalidation`, and that is the whole
	 * difference from a table's. KV is ONE value at a name-addressed root: there
	 * are no ids to carry, so "something here moved, re-read" is the complete
	 * message. A caller re-reads with `get()`, which is a property access on a
	 * document already in memory.
	 *
	 * Fires after the commit is durable, on the same flush as a table's, so a
	 * listener sees `get()` and `db.query` agree about WHICH rows exist. They do
	 * not agree about unwritten fields; see `subscribe` on a table.
	 */
	subscribe(listener: () => void): () => void;
};

/** The untyped view, for a lens that arrived as data rather than as a literal. */
export type Bound = Record<string, TableHandle> & {
	query: QueryMethod;
	kv: KvHandle;
};

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
export type ClientLog = {
	/**
	 * Merge every unsent update into one, and return it.
	 *
	 * The 30x. Sending one update per transaction is what made the authority's
	 * log look like it had to be compacted; merging on the idle timer an editor
	 * debounces on anyway makes it a rounding error
	 * (`evidence/bench/never-compact.ts`).
	 *
	 * It needs no proof from anybody, and that is the whole reason the merge
	 * lives here rather than on the authority. Every withdrawn design was trying
	 * to let one party rewrite another party's history, which requires proving
	 * the replacement covers what it replaced. A client merging bytes it
	 * indisputably authored has nothing to prove.
	 */
	coalesce(): Result<OutboxEntry | undefined, StoreError>;
	/** The authority has taken responsibility through this entry. */
	acknowledge(throughId: number): Result<void, StoreError>;
	/** How far through the authority's log this replica has read. */
	cursor(): Result<number, StoreError>;
	/** Record that everything through `seq` has been applied. */
	advance(seq: number): Result<void, StoreError>;
};

/**
 * What one document costs, in the unit that actually drives the cost.
 *
 * Items rather than bytes, because memory tracks struct count: 10 MB of
 * recordings costs 263 MB resident, since every field is an item and an item
 * costs whatever the engine charges for a small object regardless of how few
 * bytes it encodes to (ADR-0215). Items are a property of the data and
 * reproduce anywhere; bytes-per-item is a property of the engine.
 */
export type StorePressure = {
	/** Structs the engine is holding, live and dead together. */
	items: number;
	/** Rows a lens can actually see, summed across bound tables. */
	liveRows: number;
	/**
	 * `items / liveRows`, or the raw item count when nothing is live.
	 *
	 * The ratio rather than either number alone, because a big document and a
	 * rotten one look identical from the item count.
	 */
	itemsPerLiveRow: number;
};

export type Store = {
	/**
	 * The typed view of this file through one lens.
	 *
	 * Synchronous because it does no I/O, and Result-returning because a lens may
	 * arrive as data from an installed application folder rather than as a
	 * TypeScript literal, and `parseLens` reports that as a value rather than
	 * throwing.
	 */
	/**
	 * Infers, and deliberately does not re-validate.
	 *
	 * `defineLens` is where a lens is typechecked against arktype, and doing it
	 * again here is both redundant and expensive: instantiating `ValidateLens`
	 * against the `LensJson` constraint rather than against a concrete literal
	 * exceeds TypeScript's depth limit on its own, measured by bisecting this
	 * signature. A lens that never went through `defineLens` is still caught, by
	 * `parseLens`, at runtime, where a lens loaded from disk has to be caught
	 * anyway.
	 */
	bind<const TLens extends LensJson>(
		lens: TLens,
	): Result<BoundOf<TLens>, LensParseError | StoreError>;
	/** Bind a lens whose shape is not known until runtime. */
	bindUnknown(lens: unknown): Result<Bound, LensParseError | StoreError>;
	/** Apply bytes from a peer. Durable, and never republished as local work. */
	applyRemote(update: Uint8Array): Result<void, StoreError>;
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
	 * How much of this document is dead weight.
	 *
	 * The one number to watch, and the reason it exists rather than a design.
	 * Deleting a row leaves a tombstone that every device pays for in memory on
	 * every load, forever, and only a rebuild reclaims one
	 * (`evidence/bench/tombstones.ts`). Whether that ever matters is a question
	 * about how much a real person deletes, and nobody has that number.
	 *
	 * The arithmetic it feeds: memory tracks struct count at roughly 1 KB of rss
	 * per item, and a dead row costs about 2. So 50,000 deletions is around
	 * 100 MB, which is 14 deletions a day sustained for a decade. A vault of a
	 * thousand notes does not get there; something with real churn might.
	 *
	 * Watch `itemsPerLiveRow`. A healthy application sits near the item cost of
	 * one row, about 7 for a note with a body. Ten times that means the document
	 * is mostly corpse, and the decision about what to do becomes worth having
	 * against a measurement rather than against a guess.
	 */
	pressure(): Result<StorePressure, StoreError>;
	/** This replica's clocks, which is the whole sync manifest (ADR-0212). */
	stateVector(): Uint8Array;
	/** Everything this replica has that the given state vector does not. */
	encodeStateSince(stateVector?: Uint8Array): Uint8Array;
	/** What this replica owes the authority, and what it has read from it. */
	readonly sync: ClientLog;
	/**
	 * Hear when this replica has authored work the authority has not taken.
	 *
	 * Fires once per commit that added to the outbox, after that commit is
	 * durable, and never for bytes that arrived from a peer.
	 *
	 * It exists so that nothing has to remember to say so. Every durable local
	 * write leaves an authority obligation (ADR-0171), and the transport's idle
	 * timer only starts when it is told one was made, so a caller that forgets
	 * leaves that work sitting in the outbox until some unrelated write happens
	 * to start the timer. That is a silent wedge of the same family as the
	 * missing reconnect a fuzz found: the device looks connected, reports no
	 * error, and never delivers. A write that announces itself cannot be
	 * forgotten about.
	 */
	onLocalWork(listener: () => void): () => void;
	/**
	 * Hear when anything durable changed, whoever authored it.
	 *
	 * Strictly wider than `onLocalWork`, and the two are not interchangeable.
	 * The transport wants to know that THIS replica owes the authority
	 * something, so bytes that arrived from a peer must not nudge it. A store
	 * whose durable log is behind a port wants to know that the log moved at
	 * all, and an arrived update moves it exactly as much as a local write does.
	 */
	onCommitted(listener: () => void): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

export function createStore({
	database,
	history,
	now = () => Date.now(),
	dispose = () => undefined,
	log = createLogger('data/store'),
}: {
	database: SqliteDatabase;
	history?: SqliteDatabase;
	now?: () => number;
	dispose?: () => void | Promise<void>;
	/**
	 * Where a subscriber's own failure goes.
	 *
	 * The only thing the store logs. A listener that throws is contained rather
	 * than allowed to abort a batch, because the commit that produced the batch
	 * is already durable and one broken listener must not cost every other one
	 * its notification; containing it without reporting it would make a broken
	 * subscriber look like a store that stopped notifying.
	 */
	log?: Logger;
}): Store {
	applyStoreSchema(database);

	const index = createAppDocument();
	let pending: Uint8Array[] = [];
	let poisoned: StoreError | undefined;
	let disposed = false;

	/**
	 * Where a table's `'delta'` event becomes a subscriber's invalidation.
	 *
	 * `@epicenter/lens` owns the grouping, the per-table dedup and the delivery
	 * laws, and a delta-fed producer needs exactly those. Nothing about them is
	 * specific to a carrier, which is why they were written once there rather
	 * than here (ADR-0187).
	 */
	const invalidations = createInvalidationDispatcher({ log });
	/**
	 * Addresses the transaction in progress touched, held until it is durable.
	 *
	 * The one reason this buffer exists. A table root's `'delta'` fires
	 * SYNCHRONOUSLY inside `applyUpdateV2`, before the projection has been
	 * rebuilt: measured against `@y/y@14.0.0-rc.24`, at notify time the CRDT
	 * reported 2 rows while `db.query` still reported 1, and the two agreed only
	 * once `applyRemote` returned. Delivering there would hand a subscriber a
	 * row id and a SQL view that does not have it yet, so the ids wait for
	 * `persist` and go out afterwards.
	 */
	let touched: RowAddress[] = [];
	/** Whether the commit in progress put anything into the outbox. */
	let owedSomething = false;
	/** Whether the commit in progress changed anything durable at all. */
	let committedSomething = false;
	/** Whether the commit in progress touched the KV root. */
	let kvTouched = false;
	const kvFlushers = new Set<() => void>();
	const localWorkListeners = new Set<() => void>();
	const committedListeners = new Set<() => void>();

	/**
	 * Hand a committed change to whoever is waiting for it, and reset the buffers.
	 *
	 * Called after `persist` on every path a write can take, including the one
	 * that fails: the buffers have to be drained either way, or a poisoned
	 * store's stale ids would ride along with the next commit's.
	 *
	 * Each buffer is swapped before delivery rather than cleared after, because a
	 * subscriber is allowed to write, and a nested write's addresses belong to
	 * its own flush.
	 */
	function flushCommitted(): void {
		if (committedSomething) {
			committedSomething = false;
			for (const listener of [...committedListeners]) {
				const { error } = trySync({
					try: listener,
					catch: (cause) => StoreError.SubscriberThrew({ cause }),
				});
				if (error !== null) log.error(error);
			}
		}
		if (owedSomething) {
			owedSomething = false;
			for (const listener of [...localWorkListeners]) {
				// Contained for the same reason a table subscriber is: one broken
				// listener must not cost the transport its nudge, and the commit that
				// produced this is already durable.
				const { error } = trySync({
					try: listener,
					catch: (cause) => StoreError.SubscriberThrew({ cause }),
				});
				if (error !== null) log.error(error);
			}
		}
		if (kvTouched) {
			kvTouched = false;
			for (const flush of [...kvFlushers]) flush();
		}
		if (touched.length === 0) return;
		const batch = touched;
		touched = [];
		invalidations.deliver(batch);
	}

	index.on('updateV2', (update: Uint8Array, origin: unknown) => {
		if (origin === hydrationOrigin) return;
		// `applyRemote` persists the bytes it RECEIVED, in its own transaction, so
		// the bytes the document emits in response describe a change that is
		// already on its way to storage. Returning here is what makes that comment
		// true: without it, a remote update landed in the log twice, once emitted
		// and once received, and the log grew at double the rate it reported.
		if (origin === remoteOrigin) return;
		if (origin === localOrigin) {
			// A store verb is mid-flight; `commit` flushes these with the
			// projection write they imply, in one SQLite transaction.
			pending.push(copyBytes(update));
			return;
		}
		// An application writing into a row's document, typically an editor
		// binding. These bytes must reach durable storage on their own, because
		// nothing else is going to flush them. No projection work: Epicenter
		// never looks inside a document, so nothing it holds is ever projected.
		// They are still this device's own work, so they join the outbox.
		const authored = copyBytes(update);
		const { error } = persist(() => {
			appendUpdate({
				database,
				history,
				document: APP_DOCUMENT,
				update: authored,
				takenAt: now(),
			});
			enqueueOutbox(database, authored);
			owedSomething = true;
			committedSomething = true;
		});
		// Before the throw, deliberately. The live document already holds the
		// change, so the ids are true whatever storage did with them, and leaving
		// them buffered would attach them to whichever commit ran next.
		flushCommitted();
		if (error !== null) throw error;
	});

	// Attach the listener before hydrating, then replay under an origin the
	// listener ignores, so loading cannot append the same bytes it just read.
	for (const stored of readUpdates(database, APP_DOCUMENT)) {
		Y.applyUpdateV2(index, copyBytes(stored.bytes), hydrationOrigin);
	}

	/** Which tables have a live projection, and the columns each one carries. */
	const projectedTables = new Map<string, string[]>();

	function requireUsable(): StoreError | undefined {
		if (disposed) return StoreError.Disposed().error;
		return poisoned;
	}

	/**
	 * Run one mutation and commit its bytes and its projection together.
	 *
	 * `updateV2` fires inside `transact`, after the observers and after
	 * `afterTransaction` (verified against `@y/y@14.0.0-rc.24`), so by the time
	 * this returns the bytes are already buffered and can join the same SQLite
	 * transaction as the projection write they imply.
	 */
	function commit(
		documentName: string,
		mutate: () => void,
		project: () => void,
	): Result<void, StoreError> {
		pending = [];
		index.transact(mutate, localOrigin);
		const authored = pending;
		pending = [];
		if (authored.length === 0) {
			// Nothing changed, so there is nothing to persist. The projection still
			// runs: a no-op write must not leave a stale projected row behind.
			const unchanged = persist(() => project());
			flushCommitted();
			return unchanged;
		}
		const committed = persist(() => {
			for (const update of authored) {
				appendUpdate({
					database,
					history,
					document: documentName,
					update,
					takenAt: now(),
				});
				// One transaction holds the local log, the projection, and the claim
				// that these bytes still owe the authority a delivery. A crash cannot
				// leave a write durable locally and unowed.
				enqueueOutbox(database, update);
				owedSomething = true;
				committedSomething = true;
			}
			project();
		});
		flushCommitted();
		return committed;
	}

	function persist(run: () => void): Result<void, StoreError> {
		const { error } = trySync({
			try: () => database.transaction(run),
			catch: (cause) => StoreError.StorageFailed({ cause }),
		});
		if (error !== null) {
			// Fail closed. The live document holds work durable storage refused, so
			// every later call reports this rather than compounding the divergence.
			poisoned = error;
			return Err(error);
		}
		return Ok(undefined);
	}

	function bindUnknown(
		lensInput: unknown,
	): Result<Bound, LensParseError | StoreError> {
		const unusable = requireUsable();
		if (unusable !== undefined) return Err(unusable);
		const { data: lens, error } = parseLens(lensInput);
		if (error !== null) return Err(error);

		const { error: schemaError } = persist(() =>
			applyProjectionSchema(database, lens),
		);
		if (schemaError !== null) return Err(schemaError);

		const { handle: kv, project: projectKv } = createKvHandle(lens);

		const tables: Record<string, TableHandle> = {};
		for (const [tableName, table] of lens.tables) {
			tables[tableName] = createTableHandle(lens, tableName, table);
			projectedTables.set(tableName, [...table.fields.keys()]);
		}
		// The projection is rebuilt at bind rather than trusted, because the CRDT
		// is the truth and a projection is a cache: a file whose projection is
		// stale, absent, or written by an older lens costs 2 ms to make right.
		const { error: rebuildError } = persist(() => {
			for (const [tableName, table] of lens.tables) {
				rebuildProjectedTable(
					database,
					tableName,
					[...table.fields.keys()],
					rowsOf(tableName),
				);
			}
			// KV is rebuilt here for the same reason a table is, and it used to be
			// missed. Its projection was written only by `kv.update`, so `db.query`
			// saw NO kv row at all until something wrote one, and saw a row written
			// by the PREVIOUS lens after a release changed the declaration. Both are
			// the staleness this rebuild exists to remove.
			projectKv();
		});
		if (rebuildError !== null) return Err(rebuildError);

		const query: QueryMethod = (strings, ...values) => {
			const unusableNow = requireUsable();
			if (unusableNow !== undefined) return Err(unusableNow);
			return trySync({
				try: () => database.all(strings.join('?'), values),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
		};
		return Ok(Object.freeze({ ...tables, kv, query }) as unknown as Bound);
	}

	/**
	 * The KV handle for one bound lens.
	 *
	 * The root is minted here, which is safe for the same reason KV lives there
	 * at all: `Doc.get` is `setIfUndefined` on `doc.share`, so every device that
	 * mints `kv` converges on one logical root.
	 *
	 * A lens with no `kv` section still gets a handle. It reads as an empty
	 * object and refuses every write by name, which is a better answer than a
	 * missing property that a caller has to feel for.
	 */
	function createKvHandle(lens: ParsedLens): {
		handle: KvHandle;
		/** Rebuild the KV row, so `bind` can make a stale one right. */
		project(): void;
	} {
		const table = lens.kv;
		const root = kvRoot(index);
		const address = {
			namespace: lens.namespace,
			tableName: 'kv',
			rowId: KV_ROOT,
		};

		function readStored(): JsonObject {
			const payload: JsonObject = {};
			for (const key of root.attrKeys()) {
				payload[key as string] = root.getAttr(key as never) as JsonValue;
			}
			return payload;
		}

		function project(): void {
			if (table === undefined) return;
			const { conforming } = table.conformance(readStored());
			upsertProjectedRow(
				database,
				'kv',
				[...table.fields.keys()],
				KV_ROOT,
				conforming,
			);
		}

		/**
		 * How many live subscriptions this handle holds.
		 *
		 * Attached on the first and detached on the last, for the same reason a
		 * table's is: a `'delta'` listener is what makes the type build and emit
		 * its delta, and an application that never watches its settings should
		 * not pay for one.
		 */
		let subscriptions = 0;
		const kvListeners = new Set<() => void>();
		kvFlushers.add(() => {
			for (const listener of [...kvListeners]) {
				const { error } = trySync({
					try: listener,
					catch: (cause) => StoreError.SubscriberThrew({ cause }),
				});
				if (error !== null) log.error(error);
			}
		});
		const onKvDelta = (): void => {
			// Buffered onto the same flush the tables use, so a settings listener
			// and a row listener observe one consistent commit rather than two.
			kvTouched = true;
		};

		function readBack(): Result<JsonObject, ReadRowError> {
			if (table === undefined) return Ok({});
			const projected = table.project(address, readStored());
			if (projected.error !== null) return Err(projected.error);
			// `project` adds the structural id a row has and KV does not.
			const { id: _id, ...values } = projected.data;
			return Ok(values);
		}

		return {
			project,
			handle: Object.freeze({
			defaults: table?.defaults ?? Object.freeze({}),
			get() {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				return readBack();
			},
			subscribe(listener: () => void): () => void {
				kvListeners.add(listener);
				subscriptions += 1;
				if (subscriptions === 1) root.on('delta', onKvDelta);
				let stopped = false;
				return () => {
					if (stopped) return;
					stopped = true;
					kvListeners.delete(listener);
					subscriptions -= 1;
					if (subscriptions === 0) root.off('delta', onKvDelta);
				};
			},
			update(values: JsonObject) {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				if (table === undefined) {
					const [field] = Object.keys(values);
					return field === undefined
						? readBack()
						: RowWriteError.UnknownField({ table: 'kv', field });
				}
				const { data: validated, error } = table.validateWrite(values);
				if (error !== null) return Err(error);
				const { error: commitError } = commit(
					APP_DOCUMENT,
					() => {
						for (const [name, value] of Object.entries(validated)) {
							root.setAttr(name as never, value as never);
						}
					},
					project,
				);
				if (commitError !== null) return Err(commitError);
				return readBack();
			},
			}) as KvHandle,
		};
	}

	/**
	 * Reach one named root inside a row's container, creating it on miss.
	 *
	 * The create is a write, so it runs in a transaction and reaches storage
	 * through the same `updateV2` listener every other application write does.
	 * `typeName` is passed through unread: it is what gives the type its label
	 * in Yjs 14, and choosing it is the application's business.
	 */
	function rowDocumentOver(container: Y.Type): RowDocument {
		return {
			get(rootName: string, typeName?: string | null): Y.Type {
				const existing = container.getAttr(rootName as never) as unknown;
				if (existing instanceof Y.Type) return existing;
				const created = new Y.Type((typeName ?? null) as never);
				index.transact(() => {
					container.setAttr(rootName as never, created as never);
				});
				return created;
			},
		};
	}

	/** Every row of one table, as the projection needs them: by id, unvalidated. */
	function rowsOf(tableName: string): Map<string, JsonObject> {
		const root = tableRoot(index, tableName);
		const rows = new Map<string, JsonObject>();
		for (const rowId of listRowIds(root)) {
			const payload = readRow(root, rowId);
			if (payload !== undefined) rows.set(rowId, payload);
		}
		return rows;
	}

	function createTableHandle(
		lens: ParsedLens,
		tableName: string,
		table: ParsedTable,
	): TableHandle {
		const fieldNames = [...table.fields.keys()];
		const root = tableRoot(index, tableName);
		const addressOf = (rowId: string) => ({
			namespace: lens.namespace,
			tableName,
			rowId,
		});

		function projectRow(rowId: string): void {
			const payload = readRow(root, rowId);
			if (payload === undefined) {
				deleteProjectedRow(database, tableName, rowId);
				return;
			}
			upsertProjectedRow(database, tableName, fieldNames, rowId, payload);
		}

		/**
		 * The rows one committed change touched, named by the type itself.
		 *
		 * `observeDeep` cannot do this and the comment in `applyRemote` says so
		 * correctly: it reports a nested row's field edit as an event on the TABLE
		 * ROOT with `keysChanged` empty. The conclusion once drawn from that, that
		 * nothing can name the row, does not follow. The same type also emits
		 * `'delta'`, whose `attrs` is keyed by the attribute that changed, and a
		 * row IS an attribute on the table root, so every arm of the change names
		 * it: `insert` for a created row, `modify` for a field edit and for prose
		 * written deep inside the row's own document, `delete` for a removed one.
		 * Verified against `@y/y@14.0.0-rc.24` for all four, with a control that a
		 * write to a different table fires nothing here
		 * (`evidence/delta-names-the-row.test.ts`).
		 *
		 * The projection is still rebuilt wholesale on a remote update rather than
		 * patched from these ids. That is a separate decision and it stands: one
		 * rebuild is 2 ms on the real vault and it is one code path instead of two
		 * that can disagree.
		 */
		function collectTouched(delta: unknown): void {
			const { attrs } = delta as { attrs?: Record<string, unknown> };
			if (attrs === undefined) return;
			for (const rowId of Object.keys(attrs)) {
				touched.push(addressOf(rowId));
			}
		}

		/**
		 * How many live subscriptions this handle holds.
		 *
		 * The listener is attached on the first and detached on the last, rather
		 * than for the life of the handle, because attaching one is what makes the
		 * type build and emit its delta, and that cost lands on every commit.
		 *
		 * Measured (`evidence/bench/subscription.ts`), and the size is worth
		 * knowing because it is much smaller than it was assumed to be. On 20,000
		 * rows a commit editing one row costs about 0.003 ms more with a
		 * subscriber, which is at the noise floor; the cost only becomes visible
		 * at 2,000 rows in one commit, where it is about 0.7 ms on top of 2.0 ms.
		 * So it scales with the CHANGE and not with the table, which is the shape
		 * ADR-0187 needed to be true and the reason row ids are affordable at all.
		 *
		 * Given numbers that small, this is not really a performance guard. It is
		 * what keeps `touched` empty for an application that subscribes to
		 * nothing, so a write in that application allocates no addresses and
		 * flushes no batch.
		 */
		let subscriptions = 0;

		/** Read one row back through the lens, after the write that changed it. */
		function readBack(rowId: string): Result<Row, ReadRowError> {
			const payload = readRow(root, rowId);
			if (payload === undefined) {
				return StoreError.RowAbsent({ table: tableName, rowId });
			}
			return table.project(addressOf(rowId), payload) as Result<
				Row,
				ReadRowError
			>;
		}

		function write(
			rowId: string,
			fields: JsonObject,
			documentRoots: readonly string[] = [],
		): Result<Row, WriteRowError> {
			const { error } = commit(
				APP_DOCUMENT,
				() => writeRow(root, rowId, fields, documentRoots),
				() => projectRow(rowId),
			);
			if (error !== null) return Err(error);
			return readBack(rowId);
		}

		return Object.freeze({
			defaults: table.defaults,
			create(
				fields: JsonObject,
				options?: { readonly document?: readonly string[] },
			): Result<Row, WriteRowError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const { data: validated, error } = table.validateWrite(fields);
				if (error !== null) return Err(error);
				return write(mintRowId(), validated, options?.document ?? []);
			},
			get(rowId: string): Result<Row | undefined, ReadRowError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const payload = readRow(root, rowId);
				if (payload === undefined) return Ok(undefined);
				return table.project(addressOf(rowId), payload) as Result<
					Row,
					ReadRowError
				>;
			},
			update(rowId: string, fields: JsonObject): Result<Row, WriteRowError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				if (!hasRow(root, rowId)) {
					return StoreError.RowAbsent({ table: tableName, rowId });
				}
				const { data: validated, error } = table.validateWrite(fields);
				if (error !== null) return Err(error);
				return write(rowId, validated);
			},
			delete(rowId: string): Result<boolean, StoreError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				let removed = false;
				const { error } = commit(
					APP_DOCUMENT,
					() => {
						removed = deleteRow(root, rowId);
					},
					() => projectRow(rowId),
				);
				if (error !== null) return Err(error);
				return Ok(removed);
			},
			ids(): Result<string[], StoreError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				return Ok(listRowIds(root));
			},
			list() {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const rows: Row[] = [];
				const nonconforming: NonconformingRowError[] = [];
				for (const [rowId, payload] of rowsOf(tableName)) {
					const { data, error } = table.project(addressOf(rowId), payload);
					if (error !== null) nonconforming.push(error);
					else rows.push(data as Row);
				}
				return Ok({ rows, nonconforming });
			},
			document(rowId: string): RowDocument | undefined {
				// No Result, because there is nothing here that can fail. An absent
				// row is a fact rather than a failure, which is the same answer
				// `get` gives it, and Epicenter never interprets what is inside a
				// document so there is no lens to disagree with.
				const container = documentContainer(root, rowId);
				return container === undefined ? undefined : rowDocumentOver(container);
			},
			subscribe(listener: TableInvalidationListener): () => void {
				const unsubscribe = invalidations.subscribeTable(
					lens.namespace,
					tableName,
					listener,
				);
				subscriptions += 1;
				if (subscriptions === 1) root.on('delta', collectTouched);
				let stopped = false;
				return () => {
					// Idempotent, because a Svelte effect that reruns can call the
					// teardown it was handed more than once, and a second call that
					// decremented the count would detach the listener out from under
					// the subscribers still holding one.
					if (stopped) return;
					stopped = true;
					unsubscribe();
					subscriptions -= 1;
					if (subscriptions === 0) root.off('delta', collectTouched);
				};
			},
		}) as TableHandle;
	}

	const store = Object.freeze({
		// One implementation, two doors onto it. The typed door exists so a lens
		// authored as a literal carries its row types through; the untyped door is
		// what a lens loaded from an application folder gets, where there is no
		// literal to infer from and `unknown` is the honest answer.
		bind: <const TLens extends LensJson>(lens: TLens) =>
			// Through `unknown` deliberately: comparing `Result<Bound, ...>` with
			// `Result<BoundOf<TLens>, ...>` re-enters the per-field arktype
			// instantiation and exceeds the depth limit. The runtime value is the
			// same object either way; only the static view of it differs.
			bindUnknown(lens) as unknown as Result<
				BoundOf<TLens>,
				LensParseError | StoreError
			>,
		bindUnknown,
		applyRemote(update: Uint8Array): Result<void, StoreError> {
			const unusable = requireUsable();
			if (unusable !== undefined) return Err(unusable);
			// The RECEIVED bytes are what gets persisted, never what the document
			// emitted in response to them. Measured against `@y/y@14.0.0-rc.24`: an
			// update whose causal dependencies have not arrived is buffered into
			// `store.pendingStructs`, `applyUpdateV2` returns normally, and the
			// document emits NO `updateV2` event at all. Persisting emitted bytes
			// therefore writes nothing, while the caller advances its cursor and the
			// data is lost permanently with every layer reporting success.
			pending = [];
			const received = copyBytes(update);
			const { error } = trySync({
				try: () => Y.applyUpdateV2(index, received, remoteOrigin),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
			if (error !== null) return Err(error);
			// Dropped deliberately: whatever the document emitted describes the same
			// change these bytes already carry, and re-persisting it would duplicate
			// the chain.
			pending = [];
			const authored = [received];
			// The projection is rebuilt rather than patched, because a remote update
			// does not say which rows it touched. Measured against
			// `@y/y@14.0.0-rc.24`: `observeDeep` reports a nested row's field edit as
			// an event on the TABLE ROOT with `keysChanged` empty, so the observer
			// cannot name the row. A full rebuild is 2 ms on the real vault, and it
			// is one code path instead of two that can disagree.
			const applied = persist(() => {
				for (const update of authored) {
					appendUpdate({
						database,
						history,
						document: APP_DOCUMENT,
						update,
						takenAt: now(),
					});
					committedSomething = true;
				}
				rebuildAllProjections();
			});
			// After the rebuild, which is the whole reason the ids were buffered:
			// the `'delta'` that named them fired inside `applyUpdateV2` above,
			// while the projection still described the state before it.
			flushCommitted();
			return applied;
		},
		sync: createClientLog(),
		onLocalWork(listener: () => void): () => void {
			localWorkListeners.add(listener);
			return () => localWorkListeners.delete(listener);
		},
		onCommitted(listener: () => void): () => void {
			committedListeners.add(listener);
			return () => committedListeners.delete(listener);
		},
		hasUnresolvedDependencies: () => hasPendingStructs(index),
		pressure(): Result<StorePressure, StoreError> {
			const unusable = requireUsable();
			if (unusable !== undefined) return Err(unusable);
			return trySync({
				try: () => {
					let liveRows = 0;
					// Only bound tables, for the same reason the projection rebuild
					// counts only those: a document may carry a table this process
					// holds no lens for, and guessing at it would report a number
					// nobody could act on.
					for (const tableName of projectedTables.keys()) {
						liveRows += listRowIds(tableRoot(index, tableName)).length;
					}
					const items = structCount(index);
					return {
						items,
						liveRows,
						itemsPerLiveRow: liveRows === 0 ? items : items / liveRows,
					};
				},
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
		},
		stateVector: () => new Uint8Array(Y.encodeStateVector(index)),
		encodeStateSince: (stateVector?: Uint8Array) =>
			new Uint8Array(Y.encodeStateAsUpdateV2(index, stateVector)),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			index.destroy();
			await dispose();
		},
	}) as Store;
	return store;

	/**
	 * Rebuild every bound table's projection.
	 *
	 * Only tables a binding created a projection for are rebuilt. A remote update
	 * may carry a table this process holds no lens for, and inventing a relation
	 * for it would mean guessing at columns Epicenter cannot interpret; those
	 * rows stay in the CRDT, which is the truth, and appear the moment a lens
	 * that declares them binds.
	 */
	function createClientLog(): ClientLog {
		/** A read, wrapped the way every other SQLite touch in this file is. */
		function read<TValue>(run: () => TValue): Result<TValue, StoreError> {
			const unusable = requireUsable();
			if (unusable !== undefined) return Err(unusable);
			return trySync({
				try: run,
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
		}

		return Object.freeze({
			coalesce(): Result<OutboxEntry | undefined, StoreError> {
				const { data: entries, error } = read(() => readOutbox(database));
				if (error !== null) return Err(error);
				const last = entries.at(-1);
				if (last === undefined) return Ok(undefined);
				if (entries.length === 1) return Ok(last);
				const merged = new Uint8Array(
					Y.mergeUpdatesV2(
						entries.map((entry) => entry.bytes) as Uint8Array<ArrayBuffer>[],
					),
				);
				const { error: writeError } = persist(() =>
					replaceOutboxThrough(database, last.id, merged),
				);
				if (writeError !== null) return Err(writeError);
				return Ok({ id: last.id, bytes: merged });
			},
			acknowledge(throughId: number): Result<void, StoreError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				return persist(() => dropOutboxThrough(database, throughId));
			},
			cursor(): Result<number, StoreError> {
				return read(() => readCursor(database, APP_DOCUMENT));
			},
			advance(seq: number): Result<void, StoreError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				return persist(() => writeCursor(database, APP_DOCUMENT, seq));
			},
		});
	}

	function rebuildAllProjections(): void {
		for (const [tableName, fieldNames] of projectedTables) {
			rebuildProjectedTable(
				database,
				tableName,
				fieldNames,
				rowsOf(tableName),
			);
		}
	}
}
