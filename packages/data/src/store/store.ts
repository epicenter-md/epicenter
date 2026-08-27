import {
	type ConformanceIssue,
	type CreateInputOf,
	createInvalidationDispatcher,
	type DataDefinition,
	type DocumentReader,
	documentAddress,
	InstantString,
	type JsonObject,
	type JsonValue,
	type KvOf,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
	type RowAddress,
	type RowOf,
	type TableInvalidationListener,
} from '@epicenter/data/definition';
import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import { customAlphabet } from 'nanoid';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	createAppDocument,
	deleteRow,
	hasRow,
	kvRoot,
	listRowIds,
	readRow,
	tableRoot,
	writeRow,
} from './document.js';
import {
	createDocumentEngine,
	type DocumentError,
	type RowDocumentHandle,
} from './documents.js';
import { decodeEnvelope, encodeEnvelope } from './envelope.js';
import { APP_DOCUMENT, copyBytes, createSqliteDurablePort } from './log.js';
import {
	createPersistenceController,
	type DurableOp,
	type DurablePort,
	type DurableSnapshot,
	type PersistenceCapability,
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
	const store = (
		document as unknown as {
			store?: { pendingStructs?: unknown; pendingDs?: unknown };
		}
	).store;
	return (
		(store?.pendingStructs ?? null) !== null ||
		(store?.pendingDs ?? null) !== null
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
	const clients = (
		document as unknown as {
			store?: { clients?: Map<number, { length: number }[]> };
		}
	).store?.clients;
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
const remoteOrigin = Object.freeze({ kind: 'epicenter-remote' });

/**
 * The store capability itself is gone: the store was disposed.
 *
 * Thrown, never returned, and that is the boundary this type exists to hold
 * (ADR-0237). Every verb's `Result` carries outcomes the caller can act on at
 * that call site: a row that does not conform, or an address that holds no
 * row. Use-after-dispose is none of those; it is a
 * programmer error, and it surfaces at the application's error boundary,
 * once.
 *
 * Storage trouble is deliberately NOT here. A store whose durable writes fall
 * behind keeps serving the live document and reports through
 * `store.persistence` (ADR-0238); the poison that once lived in this class is
 * withdrawn.
 */
export class StoreUnusableError extends Error {
	override readonly name = 'StoreUnusableError';

	constructor() {
		super('This store is disposed');
	}
}

/**
 * A live stored value this release's declaration cannot fully read: what was
 * stored, what did conform, and what failed, so the call site composes its own
 * recovery.
 *
 * Plain diagnostic data, deliberately not a tagged error with a message. It is
 * the entire error arm of a read's `Result`, so there is nothing to
 * discriminate it from; it is about the relationship between one stored value
 * and one release-local declaration, never about the store failing
 * (ADR-0125). `raw` is the stored payload unmodified, including keys this
 * release cannot interpret. Never repaired and never hidden.
 */
export type NonconformingValue = {
	readonly raw: JsonObject;
	/** The fields that did pass, which is what recovery is composed from. */
	readonly conforming: JsonObject;
	readonly issues: readonly ConformanceIssue[];
};

/**
 * A live row this release's declaration cannot fully read.
 *
 * `conforming` carries the structural id, so the two branches of the one
 * recovery composition produce the same shape:
 * `data ?? { ...applicationRecovery, ...error.conforming }` is a whole row
 * either way. The id is not a declared field and cannot fail.
 */
export type NonconformingRow = NonconformingValue & {
	/** The structural row id, which is also the address that reported it. */
	readonly id: string;
};

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
	 * Opening could not reach or seed durable storage.
	 *
	 * A boot outcome, which is why it is returned rather than thrown: an opener
	 * is fallible I/O and its caller renders a boot failure. A store that
	 * cannot READ its durable record has nothing trustworthy to hydrate from.
	 * Once a store is open, storage never fails a verb again: durable writes
	 * are a visible, retryable debt reported through `store.persistence`
	 * (ADR-0238).
	 */
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The store could not commit to durable storage',
		cause,
	}),
	/**
	 * Foreign bytes arrived that this document cannot decode.
	 *
	 * A property of the bytes, not of the store: nothing was persisted and the
	 * store is still usable. The transport treats the position as a poison pill
	 * and says so loudly rather than advancing past it.
	 */
	ApplyFailed: ({ cause }: { cause: unknown }) => ({
		message: 'These bytes could not be applied to this document',
		cause,
	}),
	/**
	 * This process already holds this document's address open.
	 *
	 * A second open would be a second `Y.Doc` over one document, and the two
	 * cannot see each other's writes: they converge through storage under
	 * last-writer-wins, so one side's work vanishes with no error and nothing to
	 * retry (ADR-0229). Dispose the first application, or share the one you have.
	 */
	AlreadyOpen: ({ address }: { address: string }) => ({
		message: `This process already has ${address} open`,
		address,
	}),
	/**
	 * A definition replica was asked for without the account that owns it.
	 *
	 * A definition replica is retained across sign-out, so its address carries
	 * the principal it belongs to (ADR-0233). An auth state that cannot supply a
	 * stable principal id therefore names no definition, and guessing one would
	 * either open another account's bytes or take edits into storage no account
	 * can claim afterwards. Unavailable is the honest answer, and only an auth
	 * change repairs it.
	 */
	Unaddressable: () => ({
		message:
			'A definition replica belongs to one account, and no account id was supplied, so it has no address',
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
	/**
	 * A document identity cannot be stamped onto a store already holding state.
	 *
	 * Membership is stamped at first entanglement, before any push leaves and
	 * before any foreign byte applies, so a stampable store is necessarily
	 * empty. State without an identity is unplaceable across the clean break
	 * (ADR-0231): the caller discards it whole and rejoins, and nothing merges.
	 */
	Unstampable: () => ({
		message:
			'This store already holds state that belongs to no document, so it cannot adopt one; discard it and rejoin',
	}),
});
export type StoreError = InferErrors<typeof StoreError>;

export type RowAbsentError = Extract<StoreError, { name: 'RowAbsent' }>;
export type ApplyFailedError = Extract<StoreError, { name: 'ApplyFailed' }>;
export type UnstampableError = Extract<StoreError, { name: 'Unstampable' }>;

/** What a row update can refuse with: only an address holding no row. */
export type UpdateRowError = RowAbsentError;

export type {
	TableInvalidation,
	TableInvalidationListener,
} from '@epicenter/data/definition';

export type Row = { id: string } & JsonObject;

export type TableHandle = {
	/**
	 * Bring one row into being, at a minted id.
	 *
	 * There is no door for a chosen id, and that is a correctness decision. A row
	 * is a nested container addressed by the struct that created it, so two
	 * devices creating one address produce two containers and map LWW discards
	 * one along with every field in it. A 24-character minted id makes that
	 * unreachable rather than merely unlikely. Anything an application wants to
	 * name goes in `kv`, which lives at a name-addressed root.
	 *
	 * Nothing about the row's rich document is declared here. The document is
	 * inherent: it exists as an address derived from the row's coordinates
	 * (ADR-0248), and its roots are minted by name on first use, which is safe
	 * in an independent document because a top-level root is addressed by its
	 * name and concurrent minting converges
	 * (`evidence/independent-document-roots.test.ts`).
	 *
	 * The declaration is a read lens, so creation does not validate the supplied
	 * values or field names. The returned object is the typed write view, while
	 * a later `get` reports how the current lens interprets the stored payload.
	 */
	create(fields: JsonObject): Row;
	/**
	 * The one read verb, and conformance is its entire error arm.
	 *
	 * `Ok(Row)` is a live row this declaration reads whole. `Ok(undefined)` means the
	 * address holds no row, which is a fact rather than a failure.
	 * `Err(NonconformingRow)` is a live row this declaration cannot fully read; it
	 * carries `conforming`, so a caller composes whatever forgiveness it wants
	 * without a second verb existing. This Result is about conformance and
	 * nothing else: a store that cannot serve reads at all throws
	 * `StoreUnusableError` instead of dressing up as a read outcome.
	 */
	get(rowId: string): Result<Row | undefined, NonconformingRow>;
	/**
	 * Merge fields into an existing row. Refuses an absent address.
	 *
	 * `update` rather than `set`, because only the fields handed in are touched
	 * and every other field is left alone. `Ok` reports the write and nothing
	 * more: what the row now reads as is `get`'s answer, because a patch may
	 * legally land on a row whose OTHER fields this declaration cannot read (that is
	 * how a nonconforming row is repaired, ADR-0125), and a write verb that
	 * reported that read as its own failure punished a write that committed.
	 */
	update(rowId: string, fields: JsonObject): Result<void, UpdateRowError>;
	/**
	 * Take one row off the table, and retire its document (ADR-0248).
	 *
	 * One composition point: the scalar row's removal and the durable
	 * tombstone on its derived document address commit in one atomic batch, so
	 * a missed notification can never leave a live document behind, and a late
	 * write cannot resurrect the address.
	 *
	 * Returns nothing: deleting an address that holds no row is a no-op fact
	 * rather than an outcome a caller acts on, and every consumer said so by
	 * discarding the boolean this used to report.
	 */
	delete(rowId: string): void;
	/** Every row id, sorted. */
	ids(): string[];
	/**
	 * Every row, with the ones this declaration cannot read reported separately rather
	 * than dropped or repaired. Not a Result: there is nothing here that can
	 * fail, so there is nothing for a caller to mishandle into an empty list.
	 */
	list(): { rows: Row[]; nonconforming: NonconformingRow[] };
	/**
	 * Open the independent document this row owns at its derived address
	 * (ADR-0248).
	 *
	 * `openDocument` is asynchronous and resolves only after complete local hydration:
	 * it is a load, and a synchronous surface in front of one either forces
	 * eager loading or hands out a half-hydrated handle an editor merges
	 * keystrokes into at the wrong position. `Ok(undefined)` means the table
	 * holds no row at this address, which is a fact rather than a failure; the
	 * error arm is storage trouble.
	 *
	 * The application names its own roots and picks their formats:
	 * `handle.get('editor', 'text')`. Epicenter derives the address, retires
	 * the document with the row, and never looks inside. Dispose the handle
	 * when the surface holding it unmounts; the manager keeps one live
	 * document per address while any handle holds it.
	 */
	openDocument(
		rowId: string,
	): Promise<Result<RowDocumentHandle | undefined, DocumentError>>;
	/**
	 * Hear when rows in this table change, by id.
	 *
	 * Registration is synchronous, does no I/O, and never fires initially, so a
	 * caller that subscribes and then reads has already seen everything
	 * (ADR-0187). One call per commit per table, carrying every id that commit
	 * touched, and it fires for local writes and for bytes that arrived from a
	 * peer alike. Writes inside a row's rich document are not table commits
	 * (ADR-0248): they are observed on the open document's own Yjs types, and
	 * what a list renders from one is a preview, an ordinary scalar field the
	 * application writes itself.
	 *
	 * It fires after acceptance completes, and after every `onCommitted`
	 * listener has run. That phase order is a contract a follower can build
	 * on: a derived cache that marks itself dirty in `onCommitted` is already
	 * dirty by the time any table subscriber reads through it
	 * (`@epicenter/data/projection` is built on exactly this). The ids come
	 * from the type's `'delta'` event, which fires synchronously inside
	 * `applyUpdateV2` mid-acceptance, so they are held until acceptance
	 * completes.
	 *
	 * Nothing emits `{scope:'table'}`. The arm exists because ADR-0187's
	 * consumers already handle it and a future out-of-process proxy will need
	 * it, but an in-process store has no carrier and therefore no carrier gap.
	 */
	subscribe(listener: TableInvalidationListener): () => void;
};

/**
 * One table, with its own declaration's row and create-input types.
 *
 * Written out rather than derived as `Omit<TableHandle, ...> & {...}`. The
 * subtraction is what pushed a typed view past TypeScript's instantiation depth
 * limit (`TS2589`), because `RowOf` already instantiates a field descriptor per
 * field and `Omit` re-maps every remaining member on top of that.
 */
export type TypedTableHandle<TFields> =
	TableIo<TFields> extends {
		row: infer TRow;
		input: infer TInput;
	}
		? {
				create(fields: TInput): TRow;
				get(rowId: string): Result<TRow | undefined, NonconformingRow>;
				update(
					rowId: string,
					fields: Partial<TInput>,
				): Result<void, UpdateRowError>;
				delete(rowId: string): void;
				ids(): string[];
				list(): { rows: TRow[]; nonconforming: NonconformingRow[] };
				openDocument(
					rowId: string,
				): Promise<Result<RowDocumentHandle | undefined, DocumentError>>;
				subscribe(listener: TableInvalidationListener): () => void;
			}
		: never;

/**
 * One table's read and write shapes, from ONE descriptor instantiation.
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

/**
 * The typed view of one store through its data definition.
 *
 * `tables` is a container rather than a spread, and that is the whole reason
 * the application has no reserved table names. A definition declares `tables`
 * and `kv`, so the view mirrors the declaration instead of flattening it, and
 * every verb the store grows is free to be a sibling forever. Flattening cost
 * this API three collisions in its first month: a draft that named the bound
 * value `notes` beside a table called `notes`, `query` reserved as a table name
 * (ADR-0213), and a `$store` sigil invented to hold nine more (ADR-0229).
 */
export type DataView<TDatabase extends DataDefinition> = {
	readonly tables: {
		readonly [K in keyof TDatabase['tables']]: TypedTableHandle<
			TDatabase['tables'][K]['fields']
		>;
	};
	readonly kv: KvHandle<KvOf<TDatabase>>;
};

/**
 * One application's opened data: what the definition declared, and the file
 * under `store`.
 *
 * Named for what it is to the caller. The application itself is a bigger
 * thing that owns UI, state, and sync attachments; what an opener returns is
 * that application's DATA, which is exactly what the reference app already
 * called it (`HoneycrispData`, bound as `db`).
 *
 * The split is by who calls it. `tables` and `kv` are what an
 * application does; `store` holds pressure, the CRDT verbs, and, on a
 * replica, sync: what a transport needs and a feature never touches. Merging
 * the two put thirteen names on one object where four are used, and cost a
 * forwarded getter and a cast to build it. SQL is deliberately not here: it
 * is a follower an application composes (`@epicenter/data/projection`), not
 * a verb the store owes.
 *
 * The view and the store are born together: an opened runtime holds exactly
 * one data definition for its whole life (ADR-0240), so there is no verb
 * that takes a second view of a live store. A newer definition reads the same
 * durable data by closing this runtime and opening the next one.
 */
export type DataOf<
	TDatabase extends DataDefinition,
	TStore extends DataStoreBase = AccountStore,
> = DataView<TDatabase> & {
	/** The immutable declaration this opened data was built from. */
	readonly definition: DataDefinition;
	/** Group direct data operations into one accepted and durable transaction. */
	transact<TResult>(run: () => TResult): TResult;
	/** This application's file: pressure, the CRDT verbs, and replica sync. */
	readonly store: TStore;
	/** Dispose the opened data and the physical store it owns. */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Compose one file's verbs with its definition's view of it.
 *
 * Every opener ends here, so the shape an application sees is decided once
 * rather than per runtime. Internal: the openers and factories compose the
 * data they return, and nothing outside this package holds a store and a view
 * apart.
 */
export function asData<TDatabase extends DataDefinition, TStore extends DataStoreBase>(
	store: TStore,
	view: DataView<TDatabase>,
	definition: DataDefinition,
): DataOf<TDatabase, TStore> {
	return Object.freeze({
		...view,
		definition,
		transact: store.transact,
		store,
		[Symbol.asyncDispose]: () => store[Symbol.asyncDispose](),
	});
}

/**
 * One application's KV: the values it keeps exactly one of.
 *
 * No id and no create, because there is exactly one and it always exists. A
 * A missing key is a conformance error. Applications decide whether and how
 * to recover it after `get()` returns.
 *
 * It lives at a reserved ROOT rather than in a table, and that is a correctness
 * decision rather than a convenience. A root is addressed by its name, so two
 * devices writing settings on their own boot paths converge; a chosen row id is
 * a nested container, and two devices creating one produce two containers of
 * which map LWW keeps one, discarding the other's values entirely.
 */
export type KvHandle<TValues = JsonObject> = {
	/**
	 * The one read verb. Every declared key must be present and conforming.
	 *
	 * The same read law a table's `get` follows, minus absence: KV always
	 * exists, so the only error is a stored value this declaration cannot fully read,
	 * and the diagnostic carries what survived. No id, because KV has none;
	 * Applications compose recovery around `error.conforming`.
	 */
	get(): Result<TValues, NonconformingValue>;
	/**
	 * Merge some keys. Every other key is left alone.
	 *
	 * `update` rather than `set` for the same reason a table's is: only the keys
	 * handed in are touched, and `set` promises replacement. `Ok` reports the
	 * write; what KV now reads as is `get`'s answer, on the same reasoning as a
	 * table's `update`.
	 */
	update(values: Partial<TValues>): void;
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
	 * listener observes one settled commit, and a composed follower that marks
	 * itself dirty in `onCommitted` is already dirty here; see `subscribe` on
	 * a table.
	 */
	subscribe(listener: () => void): () => void;
};

/**
 * The same view with the definition's shape erased, which is what the engine
 * builds.
 *
 * Internal. It exists because the engine constructs one object and the
 * factories cast it to the caller's `DataView<TDatabase>`; comparing the
 * two structurally re-enters the per-field descriptor instantiation and exceeds
 * TypeScript's depth limit.
 */
export type UntypedDataView = {
	readonly tables: Readonly<Record<string, TableHandle>>;
	readonly kv: KvHandle;
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
	 * Merge every unsent update into one envelope, and return it.
	 *
	 * The 30x. Sending one update per transaction is what made the authority's
	 * log look like it had to be compacted; merging on the idle timer an editor
	 * debounces on anyway makes it a rounding error
	 * (`evidence/bench/never-compact.ts`).
	 *
	 * Per document first, then one envelope: entries for different documents
	 * cannot merge into one Yjs update, so each document's unsent bytes merge
	 * on their own and the envelope carries one section per document
	 * (ADR-0248). `id` is the highest outbox id the envelope covers, which is
	 * what an acknowledgement retires.
	 *
	 * It needs no proof from anybody, and that is the whole reason the merge
	 * lives here rather than on the authority. Every withdrawn design was trying
	 * to let one party rewrite another party's history, which requires proving
	 * the replacement covers what it replaced. A client merging bytes it
	 * indisputably authored has nothing to prove.
	 */
	coalesce(): { id: number; bytes: Uint8Array } | undefined;
	/** The authority has taken responsibility through this entry. */
	acknowledge(throughId: number): void;
	/** How far through the authority's log this replica has read. */
	cursor(): number;
	/** Record that everything through `seq` has been applied. */
	advance(seq: number): void;
	/**
	 * Which authority document this replica's state belongs to, or undefined
	 * for a document that has never exchanged a byte (ADR-0231).
	 *
	 * The cursor says how far through a delivery log this replica has read;
	 * this says WHICH document its bytes are entangled with. Both facts are
	 * needed: a push that landed while the ack died leaves the authority's
	 * log holding this replica's bytes with the cursor still at zero, and
	 * without the identity that replica would later present itself as a
	 * fresh install and republish a retired document's bytes into a new one.
	 */
	documentIdentity(): string | undefined;
	/**
	 * Stamp membership, durably and before the first push leaves. First write
	 * wins; membership changes only by discarding the file whole.
	 *
	 * Only an empty store can be stamped, because the stamp happens at first
	 * entanglement and nothing may precede it. A store holding state without an
	 * identity is refused with `Unstampable`: its bytes are unplaceable across
	 * the clean break (ADR-0231) and must be discarded, never merged. That
	 * refusal is the one outcome this log returns, because it is the one a
	 * caller concludes something from (supersession).
	 */
	adoptDocumentIdentity(id: string): Result<void, UnstampableError>;
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
	/** Rows the declaration can actually see, summed across declared tables. */
	liveRows: number;
	/**
	 * `items / liveRows`, or the raw item count when nothing is live.
	 *
	 * The ratio rather than either number alone, because a big document and a
	 * rotten one look identical from the item count.
	 */
	itemsPerLiveRow: number;
};

/**
 * One opened document's runtime: the live Yjs state and its durable record.
 *
 * Every verb here is a fact about the document itself: measure it, encode it,
 * hear it commit, watch its persistence. The data definition is not on
 * this surface, because it is not a verb: the engine closed over it at
	 * construction and every table handle, the KV handle, and the whole-index
	 * projection read the one parsed definition for the store's whole life
 * (ADR-0240). What tells the two store kinds apart is `sync`, present on both
 * and carrying the discriminating value: `undefined` on a device-owned
 * document, a `SyncCapability` on a replica. Every store has local
 * persistence; only a replica has a synchronization capability.
 */
export type DataStoreBase = {
	/**
	 * How much of this document is dead weight.
	 *
	 * The one number to watch, and the reason it exists rather than a design.
	 * Deleting a row leaves a tombstone that every device pays for in memory on
	 * every load, forever. A future explicit Compact workspace action could
	 * reclaim one (`evidence/bench/tombstones.ts`). Whether that ever matters is a question
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
	pressure(): StorePressure;
	/** The application document's clocks: which authored state it holds, from whom. */
	stateVector(): Uint8Array;
	/** Everything the application document has that the state vector does not. */
	encodeStateSince(stateVector?: Uint8Array): Uint8Array;
	/** Group direct data operations into one accepted and durable transaction. */
	transact<TResult>(run: () => TResult): TResult;
	/**
	 * Hear when anything committed into this document, whoever authored it.
	 *
	 * Fires at acceptance, whether or not the durable copy has caught up:
	 * acceptance and durability are two steps (ADR-0238), and durability has
	 * its own surface below. Delivered BEFORE table and KV notifications in
	 * the same flush, and that order is a contract: a composed follower marks
	 * itself dirty here, so it is already dirty by the time any table
	 * subscriber reads through it (`@epicenter/data/projection` depends on
	 * exactly this). Strictly wider than `onLocalWork`, and the two are not
	 * interchangeable: the transport wants to know that THIS replica owes the
	 * authority something, so bytes that arrived from a peer must not nudge
	 * it, while this fires for those too.
	 */
	onCommitted(listener: () => void): () => void;
	/**
	 * This store's local-persistence debt: whether everything accepted has
	 * reached durable storage (ADR-0238).
	 *
	 * `saved` | `pending` | `blocked`, with `subscribe` for changes and
	 * `flush()` to request an attempt now. A `blocked` store keeps serving and
	 * accepting; what is at risk is only what a RESTART would recover.
	 */
	readonly persistence: PersistenceCapability;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * A device-owned document: a complete store all by itself, which owes its
 * work to nobody and never receives a foreign byte (ADR-0233).
 *
 * `sync` is present and `undefined`, deliberately: the discriminant is the
 * VALUE, not the property's absence, so `store.sync === undefined` narrows a
 * `DeviceStore | AccountStore` without `in`-probing, and a future reader of
 * either
 * object sees the same shape with one honest difference.
 */
export type DeviceStore = DataStoreBase & {
	readonly sync: undefined;
};

/**
 * A store that is one replica of an authority's current document.
 *
 * The one thing it adds over `DataStoreBase` is a concrete `sync` capability:
 * the app-facing facts of this replica's entanglement. The delivery
 * machinery underneath (applying peer bytes, the outbox, cursors, the
 * acknowledgement bookkeeping) is deliberately not public: only the
 * transport drives it, and it reaches it through `syncEngineOf` inside this
 * package. Handing those verbs to applications is how a device document once
 * grew an outbox nothing could ever drain.
 */
export type AccountStore = DataStoreBase & {
	readonly sync: SyncCapability;
};

/**
 * The app-facing half of sync: what a surface renders and a boot gate reads.
 *
 * Mirrors `persistence` in shape: one snapshot, one change subscription.
 * Everything else about sync (connection health, attempts, in-flight
 * submissions) belongs to the connection driving the socket, not to the
 * store.
 */
export type SyncCapability = {
	get(): SyncFacts;
	/** Hear when the facts change. Never fires initially. */
	subscribe(listener: () => void): () => void;
};

/**
 * The facts a replica can state about its own entanglement.
 *
 * `document` is which authority document this replica's state belongs to,
 * or `undefined` for one that has never exchanged a byte (ADR-0231). It is
 * the boot gate's whole question: a signed-in definition is safe to edit once
 * it is stamped.
 */
export type SyncFacts = {
	readonly document: string | undefined;
};

/**
 * The delivery machinery only the transport drives (ADR-0238's audit): the
 * client log's bookkeeping, plus the three verbs that move foreign bytes and
 * wake the sender. Reached through `syncEngineOf`, never carried on the
 * public store: no application consumer ever needed these, and every one of
 * them can corrupt a replica if driven casually.
 */
export type SyncEngine = ClientLog & {
	/**
	 * Apply bytes from a peer. Never republished as local work.
	 *
	 * The bytes are accepted live immediately; the durable append and the
	 * `advanceTo` bookmark join the persistence queue as ADJACENT OPS in one
	 * atomic flush batch, so durable state can never hold a cursor ahead of
	 * the bytes it accounts for (ADR-0231, carried by ADR-0238). Membership
	 * is not stamped here: the sync client commits `adoptDocumentIdentity` at
	 * the document announcement and refuses foreign bytes until it has, so an
	 * absent identity always means no foreign byte was ever applied.
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
	 * This replica's whole state as one envelope: the application document's
	 * complete state plus every row document's, one section each (ADR-0248).
	 *
	 * What a snapshot offer carries. Asynchronous because closed
	 * row documents are read from storage rather than hydrated.
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
export function syncEngineOf(store: AccountStore): SyncEngine {
	const engine = syncEngines.get(store.sync);
	if (engine === undefined) {
		throw new Error(
			'This store has no sync engine: it is not a replica of any authority.',
		);
	}
	return engine;
}

/** What every store engine needs: the definition and the durable engine. */
export type StoreEngineOptions = {
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
	now?: () => number;
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
	/** The durable file: the update log, the outbox, the cursor, the metadata. */
	sqlite: SqliteDatabase;
	history?: SqliteDatabase;
	now?: () => number;
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
function parsedDatabaseOrThrow(definition: DataDefinition): ParsedDataDefinition {
	const { data, error } = parseData(definition);
	if (error !== null) throw new Error(error.message, { cause: error });
	return data;
}

/** Build the engine options for a synchronous SQLite durable engine. */
function overSqlite<TDatabase extends DataDefinition>({
	definition,
	sqlite,
	history,
	...rest
}: CreateStoreOptions<TDatabase>): StoreEngineOptions {
	const port = createSqliteDurablePort({ sqlite, history });
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
export function createDeviceStore<const TDatabase extends DataDefinition>(
	options: CreateStoreOptions<TDatabase>,
): DataOf<TDatabase, DeviceStore> {
	const { store, view, definition } = createStoreEngine(overSqlite(options), 'none');
	// Through `unknown` deliberately: comparing the untyped view with
	// `DataView<TDatabase>` re-enters the per-field descriptor instantiation
	// and exceeds the depth limit. The runtime value is the same object either
	// way; only the static view of it differs.
	return asData(store, view as unknown as DataView<TDatabase>, definition.definition);
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
): DataOf<TDatabase, AccountStore> {
	const { store, view, definition } = createStoreEngine(overSqlite(options), 'remote');
	return asData(store, view as unknown as DataView<TDatabase>, definition.definition);
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
export function createDeviceStoreOverPort(options: StoreEngineOptions): {
	store: DeviceStore;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
} {
	return createStoreEngine(options, 'none');
}

export function createAccountStoreOverPort(options: StoreEngineOptions): {
	store: AccountStore;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
} {
	return createStoreEngine(options, 'remote');
}

function createStoreEngine(
	options: StoreEngineOptions,
	replication: 'none',
): { store: DeviceStore; view: UntypedDataView; definition: ParsedDataDefinition };
function createStoreEngine(
	options: StoreEngineOptions,
	replication: 'remote',
): { store: AccountStore; view: UntypedDataView; definition: ParsedDataDefinition };
function createStoreEngine(
	{
		definition,
		durable,
		loaded,
		now = () => Date.now(),
		dispose = () => undefined,
		log = createLogger('data/store'),
	}: StoreEngineOptions,
	replication: 'none' | 'remote',
): { store: DeviceStore | AccountStore; view: UntypedDataView; definition: ParsedDataDefinition } {
	const index = createAppDocument();
	let pending: Uint8Array[] = [];
	let composedTransaction: DurableOp[] | undefined;
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

	// The three durable facts the engine also tracks live. The controller's
	// mirror says what storage has CONFIRMED; these say what the document has
	// ACCEPTED, which is what `sync` reports to the client. At open the two
	// agree; a blocked flush is the only
	// thing that separates them, and a restart then honestly recovers the
	// mirror's version.
	let liveCursor = loaded.cursor;
	let liveIdentity = loaded.identity;
	/**
	 * The highest outbox id acknowledged this session. An overlay over the
	 * durable mirror, so an acknowledged entry is never re-offered while its
	 * `dropOutbox` op is still queued behind a blocked flush.
	 */
	let ackedThrough = 0;
	/** The next outbox id to assign. The store mints ids, never the port. */
	let nextOutboxId =
		loaded.outbox.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
	/** One outbox sequence for every document, application and rows alike. */
	const mintOutboxId = (): number | undefined =>
		replication === 'none' ? undefined : nextOutboxId++;

	/**
	 * The row documents' runtime (ADR-0248): live handles, hydration, remote
	 * acceptance, and retirement, over the same durable queue every other
	 * accepted fact joins.
	 */
	/**
	 * Row documents whose local edits change the row: those with a `derive`
	 * (ADR-0264) or a store-managed `updatedAt` (ADR-0265), by document address.
	 * Populated when such a document is opened and consulted when it commits
	 * locally; the schema-blind engine never sees a table or a row.
	 */
	const deriveTargets = new Map<
		string,
		{
			derive?: (doc: DocumentReader) => Record<string, unknown>;
			managesUpdatedAt: boolean;
			root: Y.Type;
			rowId: string;
		}
	>();

	/**
	 * The store's answer to a local document commit (ADR-0264, ADR-0265): run the
	 * table's pure `derive` over the document, stamp `updatedAt` if the store
	 * manages it, and, only when the result changes the row, write it as its own
	 * follow-up commit. Not merged with the body append, so a crash leaves a
	 * self-healing one-edit-stale shadow rather than paying the cross-plane
	 * atomicity an inline merge would cost.
	 */
	function runDeriveOnCommit(address: string, doc: Y.Doc): void {
		const target = deriveTargets.get(address);
		if (target === undefined) return;
		const patch: Record<string, unknown> = target.derive
			? { ...target.derive(doc as unknown as DocumentReader) }
			: {};
		// A body edit is an edit to the row: `updatedAt` moves even when the
		// derived preview does not, so a fresh instant always makes the patch
		// non-empty and the write always happens on a local body edit.
		if (target.managesUpdatedAt) {
			patch.updatedAt = InstantString.fromDate(new Date(now()));
		}
		const current = readRow(target.root, target.rowId) ?? {};
		let changed = false;
		for (const key of Object.keys(patch)) {
			if ((current as Record<string, unknown>)[key] !== patch[key]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		commit(() => writeRow(target.root, target.rowId, patch as JsonObject));
	}

	const documents = createDocumentEngine({
		readDocument: (address) => durable.readDocument(address),
		listDocuments: () => durable.listDocuments(),
		appDocument: APP_DOCUMENT,
		controller,
		mintOutboxId,
		tombstones: loaded.tombstones,
		now,
		assertUsable: () => assertUsable(),
		onLocalCommit: runDeriveOnCommit,
		log,
	});

	/**
	 * Where a table's `'delta'` event becomes a subscriber's invalidation.
	 *
	 * `@epicenter/data/definition` owns the grouping, the per-table dedup and the delivery
	 * laws, and a delta-fed producer needs exactly those. Nothing about them is
	 * specific to a carrier, which is why they were written once there rather
	 * than here (ADR-0187).
	 */
	const invalidations = createInvalidationDispatcher({ log });
	/**
	 * Addresses the transaction in progress touched, held until it is durable.
	 *
	 * The one reason this buffer exists. A table root's `'delta'` fires
	 * SYNCHRONOUSLY inside `applyUpdateV2`, mid-acceptance (measured against
	 * `@y/y@14.0.0-rc.24`). Delivering there would hand a subscriber a commit
	 * still being accepted, and would run its listener ahead of the
	 * `onCommitted` phase a composed follower marks itself dirty in, so the
	 * ids wait for
	 * `persist` and go out afterwards.
	 */
	let touched: RowAddress[] = [];
	/** Whether the commit in progress changed anything at all. */
	let committedSomething = false;
	/** Whether the commit in progress touched the KV root. */
	let kvTouched = false;
	const kvFlushers = new Set<() => void>();
	const localWorkListeners = new Set<() => void>();
	const committedListeners = new Set<() => void>();
	/** Who is watching `sync.get()`'s facts; notified when the stamp lands. */
	const syncFactsListeners = new Set<() => void>();

	/**
	 * Hand a committed change to whoever is waiting for it, and reset the buffers.
	 *
	 * Runs at ACCEPTANCE, whatever the durable engine does later (ADR-0238).
	 * Phase order inside one flush is a contract: `onCommitted` listeners
	 * first, then KV, then table invalidations, so a follower that marks
	 * itself dirty in the first phase is dirty before any subscriber reads.
	 * Each buffer is swapped before delivery rather than cleared
	 * after, because a subscriber is allowed to write, and a nested write's
	 * addresses belong to its own flush.
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
		if (kvTouched) {
			kvTouched = false;
			for (const flush of [...kvFlushers]) flush();
		}
		if (touched.length === 0) return;
		const batch = touched;
		touched = [];
		invalidations.deliver(batch);
	}

	// The transport's nudge fires when a flush durably grows the outbox, not
	// when a commit is accepted: the sender reads only the durable outbox, so
	// nudging earlier would wake it to find nothing sendable (ADR-0238).
	controller.onOutboxGrew(() => {
		for (const listener of [...localWorkListeners]) {
			// Contained for the same reason a table subscriber is: one broken
			// listener must not cost the transport its nudge.
			const { error } = trySync({
				try: listener,
				catch: (cause) => StoreError.SubscriberThrew({ cause }),
			});
			if (error !== null) log.error(error);
		}
	});

	index.on(
		'updateV2',
		(
			update: Uint8Array,
			origin: unknown,
			_document: Y.Doc,
			transaction: Y.Transaction,
		) => {
			if (origin === hydrationOrigin) return;
			// `applyRemote` persists the bytes it RECEIVED, in its own transaction, so
			// the bytes the document emits in response describe a change that is
			// already on its way to storage. Returning here is what makes that comment
			// true: without it, a remote update landed in the log twice, once emitted
			// and once received, and the log grew at double the rate it reported.
			if (origin === remoteOrigin) return;
			if (origin === localOrigin) {
				// A store verb is mid-flight; `commit` queues these when the
				// transaction returns.
				pending.push(copyBytes(update));
				return;
			}
			// What remains below must be a LOCAL transaction. `applyUpdateV2` forces
			// `transaction.local` to false and a local `transact` defaults it to
			// true, so this check makes the branch below provably an application
			// writing through this document's own types rather than by convention.
			// Decoded foreign bytes reaching it would be persisted as the EMITTED
			// update rather than the received one (nothing at all when causal
			// dependencies are missing; see `applyRemote`), and would join the
			// outbox as this device's authored work and be republished to the
			// authority. The
			// throw surfaces synchronously at the rogue `Y.applyUpdateV2` call site,
			// before anything is accepted, so the store is untouched.
			if (!transaction.local) {
				throw new Error(
					"Foreign bytes must enter through applyRemote. A direct Y.applyUpdateV2 on this document would be republished as this device's own work, and is lost entirely when its causal dependencies have not arrived.",
				);
			}
			// A local write through a leaked type rather than a store verb. No
			// public surface hands out the application document's types since a
			// row's rich content moved to its own document (ADR-0248), so this is
			// defense rather than a path: authored bytes reach durable storage
			// and the outbox rather than silently vanishing.
			//
			// The notification flush runs in a finally, deliberately: the live
			// document already holds the change, so the ids are true whatever the
			// durable engine later does with the bytes, and leaving them buffered
			// would attach them to whichever commit ran next.
			const authored = copyBytes(update);
			try {
				committedSomething = true;
				controller.enqueue([
					{
						kind: 'append',
						document: APP_DOCUMENT,
						bytes: authored,
						takenAt: now(),
						outboxId: mintOutboxId(),
					},
				]);
			} finally {
				flushCommitted();
			}
		},
	);

	// Attach the listener before hydrating, then replay under an origin the
	// listener ignores, so loading cannot append the same bytes it just read.
	for (const stored of loaded.updates) {
		Y.applyUpdateV2(index, copyBytes(stored), hydrationOrigin);
	}

	/**
	 * The one gate every verb passes: a disposed store throws, it never
	 * returns. Fresh per throw so each call site gets its own stack.
	 */
	function assertUsable(): void {
		if (disposed) throw new StoreUnusableError();
	}

	/**
	 * Run one mutation and queue its bytes for durable storage.
	 *
	 * `updateV2` fires inside `transact`, after the observers and after
	 * `afterTransaction` (verified against `@y/y@14.0.0-rc.24`), so by the time
	 * `transact` returns the bytes are already buffered. Acceptance is the
	 * synchronous half, and cannot fail for storage reasons. Durability is the
	 * queued half: the bytes and, on a replica, their outbox claim join the
	 * controller's queue as adjacent ops in one atomic batch, so durable state
	 * can never hold a write locally and unowed (ADR-0238). On a synchronous
	 * engine the flush completes before this returns.
	 */
	function commit(
		mutate: () => void,
		/**
		 * Ops composed with this commit's appends into ONE atomic batch, built
		 * after the mutation so they can depend on what it did. Row deletion
		 * rides here: the scalar removal and the document retirement are one
		 * durable step (ADR-0248).
		 */
		compose?: () => DurableOp[],
	): void {
		if (composedTransaction !== undefined) {
			index.transact(mutate, localOrigin);
			composedTransaction.push(...(compose?.() ?? []));
			return;
		}
		pending = [];
		index.transact(mutate, localOrigin);
		const authored = pending;
		pending = [];
		try {
			const ops: DurableOp[] = authored.map(
				(update): DurableOp => ({
					kind: 'append',
					document: APP_DOCUMENT,
					bytes: update,
					takenAt: now(),
					outboxId: mintOutboxId(),
				}),
			);
			ops.push(...(compose?.() ?? []));
			if (ops.length > 0) {
				committedSomething = true;
				controller.enqueue(ops);
			}
		} finally {
			// Either way the buffers drain, so stale ids never ride along with the
			// next commit's.
			flushCommitted();
		}
	}

	/**
	 * Run several direct data operations as one Yjs transaction and one durable
	 * batch. Nested store verbs join this coordinator instead of opening their
	 * own durable boundary.
	 */
	function transact<TResult>(run: () => TResult): TResult {
		assertUsable();
		if (composedTransaction !== undefined) return run();

		composedTransaction = [];
		pending = [];
		let result!: TResult;
		let failed = false;
		let cause: unknown;
		try {
			index.transact(() => {
				result = run();
			}, localOrigin);
		} catch (error) {
			failed = true;
			cause = error;
		}

		const authored = pending;
		pending = [];
		const composed = composedTransaction;
		composedTransaction = undefined;
		try {
			const ops: DurableOp[] = authored.map(
				(update): DurableOp => ({
					kind: 'append',
					document: APP_DOCUMENT,
					bytes: update,
					takenAt: now(),
					outboxId: mintOutboxId(),
				}),
			);
			ops.push(...composed);
			if (ops.length > 0) {
				committedSomething = true;
				controller.enqueue(ops);
			}
		} finally {
			flushCommitted();
		}
		if (failed) throw cause;
		return result;
	}

	/**
	 * The one typed surface this runtime will ever have, built over the one
	 * definition (ADR-0240).
	 *
	 * SQL is deliberately not built here: a projection is a follower an
	 * application composes over this surface (`@epicenter/data/projection`),
	 * not a verb the store owes.
	 */
	function buildView(): UntypedDataView {
		const kv = createKvHandle();

		const tables: Record<string, TableHandle> = {};
		for (const [tableName, table] of definition.tables) {
			tables[tableName] = createTableHandle(tableName, table);
		}

		return Object.freeze({
			tables: Object.freeze(tables),
			kv,
		}) as UntypedDataView;
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
		const root = kvRoot(index);

		function readStored(): JsonObject {
			const payload: JsonObject = {};
			for (const key of root.attrKeys()) {
				payload[key as string] = root.getAttr(key as never) as JsonValue;
			}
			return payload;
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

		function readBack(): Result<JsonObject, NonconformingValue> {
			const raw = readStored();
			if (table === undefined) return Ok(raw);
			const { conforming, issues } = table.conformance(raw);
			// No structural id, because KV has none: the diagnostic's `conforming`
			// composes into a whole settings object without a stray key.
			return issues.length === 0
				? Ok(conforming)
				: Err({ raw, conforming, issues });
		}

		return Object.freeze({
			get() {
				assertUsable();
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
			update(values: JsonObject): void {
				assertUsable();
				commit(() => {
					for (const [name, value] of Object.entries(values)) {
						root.setAttr(name as never, value as never);
					}
				});
			},
		}) as KvHandle;
	}

	/** Every row of one table: by id, unvalidated. */
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
		tableName: string,
		table: ParsedTable,
	): TableHandle {
		const root = tableRoot(index, tableName);
		const addressOf = (rowId: string) => ({
			databaseId: definition.id,
			tableName,
			rowId,
		});

		// Store-managed timestamps (ADR-0265): an instant field named `createdAt`
		// or `updatedAt` is owned by the store. It stamps `createdAt` once at
		// create and `updatedAt` on every commit that touches the row, so an
		// application never writes them by hand. The instant-typed requirement is
		// what keeps an ordinary field that happens to share the name unmanaged.
		const managesCreatedAt = table.fields.get('createdAt')?.kind === 'instant';
		const managesUpdatedAt = table.fields.get('updatedAt')?.kind === 'instant';
		function stamps(mode: 'create' | 'update'): JsonObject {
			if (!managesUpdatedAt && !managesCreatedAt) return {};
			const iso = InstantString.fromDate(new Date(now()));
			const at: JsonObject = {};
			if (managesUpdatedAt) at.updatedAt = iso;
			if (mode === 'create' && managesCreatedAt) at.createdAt = iso;
			return at;
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
		 * it: `insert` for a created row, `modify` for a field edit, `delete`
		 * for a removed one. Verified against `@y/y@14.0.0-rc.24`, with a
		 * control that a write to a different table fires nothing here
		 * (`evidence/delta-names-the-row.test.ts`).
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

		return Object.freeze({
			create(fields: JsonObject): Row {
				assertUsable();
				const rowId = mintRowId();
				const at = stamps('create');
				commit(() => writeRow(root, rowId, { ...fields, ...at }));
				return { id: rowId, ...fields, ...at };
			},
			get(rowId: string): Result<Row | undefined, NonconformingRow> {
				assertUsable();
				const payload = readRow(root, rowId);
				if (payload === undefined) return Ok(undefined);
				return conformRow(rowId, payload);
			},
			update(rowId: string, fields: JsonObject): Result<void, UpdateRowError> {
				assertUsable();
				if (!hasRow(root, rowId)) {
					return StoreError.RowAbsent({ table: tableName, rowId });
				}
				commit(() => writeRow(root, rowId, { ...fields, ...stamps('update') }));
				return Ok(undefined);
			},
			delete(rowId: string): void {
				assertUsable();
				let removed = false;
				// One composition point (ADR-0248): the scalar removal's bytes and
				// the document's durable tombstone join one atomic batch, so no
				// crash point leaves a deleted row with a live document, and a late
				// write cannot resurrect the retired address.
				commit(
					() => {
						removed = deleteRow(root, rowId);
						if (removed) {
							deriveTargets.delete(documentAddress(addressOf(rowId)));
						}
					},
					() =>
						removed ? [documents.retire(documentAddress(addressOf(rowId)))] : [],
				);
			},
			ids(): string[] {
				assertUsable();
				return listRowIds(root);
			},
			list() {
				assertUsable();
				const rows: Row[] = [];
				const nonconforming: NonconformingRow[] = [];
				for (const [rowId, payload] of rowsOf(tableName)) {
					const { data, error } = conformRow(rowId, payload);
					if (error !== null) nonconforming.push(error);
					else rows.push(data);
				}
				return { rows, nonconforming };
			},
			async openDocument(
				rowId: string,
			): Promise<Result<RowDocumentHandle | undefined, DocumentError>> {
				assertUsable();
				// Row liveness is the table's own composition over the manager:
				// an absent row is a fact rather than a failure, answered the
				// same way `get` answers it, and refusing here is what keeps a
				// deleted or misspelled id from minting an orphan document.
				if (!hasRow(root, rowId)) return Ok(undefined);
				const address = documentAddress(addressOf(rowId));
				// Register the target while the document is open, so a local edit to
				// it can find its table's derivation and managed `updatedAt` without
				// the engine ever decoding the address back to a row (ADR-0264/0265).
				const derive = table.document?.derive;
				if (derive !== undefined || managesUpdatedAt) {
					deriveTargets.set(address, { derive, managesUpdatedAt, root, rowId });
				}
				return documents.open(address);
			},
			subscribe(listener: TableInvalidationListener): () => void {
				const unsubscribe = invalidations.subscribeTable(
					definition.id,
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
						// Every remote payload is an envelope (ADR-0248): sections for
						// the application document and for row documents, carried
						// together through the one connection. A payload that is not an
						// envelope is refused whole, before anything is accepted.
						const { data: sections, error: envelopeError } =
							decodeEnvelope(update);
						if (envelopeError !== null) {
							return StoreError.ApplyFailed({ cause: envelopeError });
						}
						// The RECEIVED bytes are what gets persisted, never what a document
						// emitted in response to them. Measured against `@y/y@14.0.0-rc.24`: an
						// update whose causal dependencies have not arrived is buffered into
						// `store.pendingStructs`, `applyUpdateV2` returns normally, and the
						// document emits NO `updateV2` event at all. Persisting emitted bytes
						// therefore writes nothing, while the caller advances its cursor and the
						// data is lost permanently with every layer reporting success.
						pending = [];
						const ops: DurableOp[] = [];
						// A decode refusal is a property of the bytes: nothing already
						// applied is rolled back (an update is idempotent, so a re-receive
						// after the refusal re-applies harmlessly), the cursor does not
						// advance, and the store stays usable.
						const { error } = trySync({
							try: () => {
								for (const section of sections) {
									if (section.document === APP_DOCUMENT) {
										const received = copyBytes(section.bytes);
										Y.applyUpdateV2(index, received, remoteOrigin);
										ops.push({
											kind: 'append',
											document: APP_DOCUMENT,
											bytes: received,
											takenAt: now(),
											// Never the outbox: these bytes came FROM the authority.
											outboxId: undefined,
										});
										continue;
									}
									// A row document's section: applied live when open,
									// appended durably either way, dropped whole when the
									// address was retired (ADR-0248).
									const op = documents.acceptRemote(
										section.document,
										section.bytes,
									);
									if (op !== undefined) ops.push(op);
								}
							},
							catch: (cause) => StoreError.ApplyFailed({ cause }),
						});
						if (error !== null) return Err(error);
						// Whatever any document emitted in response is dropped: it
						// describes the same change the received bytes already carry.
						pending = [];
						try {
							committedSomething = true;
							// With the bytes, never after them: the bookmark and what it
							// accounts for are adjacent ops in one atomic flush batch, so
							// durable state can never hold a cursor ahead of the bytes, and
							// never bytes wearing a fresh install's cursor (ADR-0231,
							// carried by ADR-0238's whole-queue flush). The LIVE cursor
							// advances now; the durable one advances when the batch lands,
							// and a crash before then re-receives, which is free because an
							// update is idempotent.
							if (opts?.advanceTo !== undefined) {
								ops.push({ kind: 'cursor', seq: opts.advanceTo });
								liveCursor = opts.advanceTo;
							}
							controller.enqueue(ops);
						} finally {
							// After the enqueue, which is what the ids were buffered for:
							// the `'delta'` that named them fired inside `applyUpdateV2`
							// above, mid-acceptance, and delivery waits until acceptance
							// completes so every listener phase observes one settled commit.
							flushCommitted();
						}
						return Ok(undefined);
					},
					onLocalWork(listener: () => void): () => void {
						localWorkListeners.add(listener);
						return () => localWorkListeners.delete(listener);
					},
					hasUnresolvedDependencies: () => hasPendingStructs(index),
					async encodeSnapshot(): Promise<Uint8Array> {
						assertUsable();
						return encodeEnvelope([
							{
								document: APP_DOCUMENT,
								bytes: new Uint8Array(Y.encodeStateAsUpdateV2(index)),
							},
							...(await documents.states()),
						]);
					},
				};

	// The one view this runtime will ever hold, built over the one definition,
	// after hydration.
	const view = buildView();

	const base: DataStoreBase = {
		transact,
		onCommitted(listener: () => void): () => void {
			committedListeners.add(listener);
			return () => committedListeners.delete(listener);
		},
		pressure(): StorePressure {
			assertUsable();
			let liveRows = 0;
			// Only declared tables: a document may carry a table this definition
			// does not declare, and guessing at it would report a number
			// nobody could act on.
			for (const tableName of definition.tables.keys()) {
				liveRows += listRowIds(tableRoot(index, tableName)).length;
			}
			const items = structCount(index);
			return {
				items,
				liveRows,
				itemsPerLiveRow: liveRows === 0 ? items : items / liveRows,
			};
		},
		stateVector: () => new Uint8Array(Y.encodeStateVector(index)),
		encodeStateSince: (stateVector?: Uint8Array) =>
			new Uint8Array(Y.encodeStateAsUpdateV2(index, stateVector)),
		// Acceptance, retirement, and state enumeration are the engine's to drive.
		persistence: controller.persistence,
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			// One final attempt over whatever is still queued, then let go.
			// Disposal never spins on a blocked engine: closing while blocked is
			// the accepted loss ADR-0238 makes visible, not a reason to hang.
			await controller.drain();
			documents.destroy();
			index.destroy();
			await dispose();
		},
	};
	// Both kinds carry `sync`; the VALUE is the discriminant. A device store
	// holds `undefined`, a replica holds the frozen capability, and the
	// delivery machinery is registered against the capability so wrappers
	// that spread the store (a `discard()` opener) keep the door reachable.
	if (syncEngine === undefined) {
		return { store: Object.freeze({ ...base, sync: undefined }), view, definition };
	}
	const sync: SyncCapability = Object.freeze({
		get: (): SyncFacts => ({ document: liveIdentity }),
		subscribe(listener: () => void): () => void {
			syncFactsListeners.add(listener);
			return () => syncFactsListeners.delete(listener);
		},
	});
	syncEngines.set(sync, Object.freeze(syncEngine));
	return { store: Object.freeze({ ...base, sync }), view, definition };

	function createClientLog(): ClientLog {
		return Object.freeze({
			coalesce(): { id: number; bytes: Uint8Array } | undefined {
				assertUsable();
				// The DURABLE outbox, filtered through this session's
				// acknowledgements. A local edit is offered to the authority only
				// once it is durable (ADR-0238): the queue's contents are not
				// here, so a blocked flush simply leaves nothing new to send. The
				// ack overlay keeps a taken entry from being re-offered while its
				// own `dropOutbox` op waits behind a blocked flush.
				const entries = controller
					.durableOutbox()
					.filter((entry) => entry.id > ackedThrough);
				const last = entries.at(-1);
				if (last === undefined) return undefined;
				// Per document: entries for different documents cannot merge into
				// one Yjs update, so each document's unsent bytes merge on their
				// own and the envelope carries one section per document (ADR-0248).
				const byDocument = new Map<
					string,
					{ throughId: number; bytes: Uint8Array[] }
				>();
				for (const entry of entries) {
					const group = byDocument.get(entry.document) ?? {
						throughId: 0,
						bytes: [],
					};
					group.throughId = Math.max(group.throughId, entry.id);
					group.bytes.push(entry.bytes);
					byDocument.set(entry.document, group);
				}
				const sections: { document: string; bytes: Uint8Array }[] = [];
				for (const [document, group] of byDocument) {
					if (group.bytes.length === 1) {
						sections.push({
							document,
							bytes: group.bytes[0] as Uint8Array,
						});
						continue;
					}
					const merged = new Uint8Array(
						Y.mergeUpdatesV2(group.bytes as Uint8Array<ArrayBuffer>[]),
					);
					// The durable outbox collapses to the merged entry too; until
					// that lands, a repeated coalesce re-merges the same entries,
					// which is idempotent.
					controller.enqueue([
						{
							kind: 'replaceOutbox',
							document,
							throughId: group.throughId,
							merged,
						},
					]);
					sections.push({ document, bytes: merged });
				}
				return { id: last.id, bytes: encodeEnvelope(sections) };
			},
			acknowledge(throughId: number): void {
				assertUsable();
				ackedThrough = Math.max(ackedThrough, throughId);
				// If this op never lands and the client restarts, the entries are
				// re-offered; the authority already holds them and an update is
				// idempotent, so re-delivery is the safe direction.
				controller.enqueue([{ kind: 'dropOutbox', throughId }]);
			},
			cursor(): number {
				assertUsable();
				// The LIVE position: everything this document has applied, whether
				// or not its durable record has caught up. The transport reads this
				// beside `encodeStateSince()`, which is also live, so the two
				// always describe the same state. At open, with nothing queued, it
				// equals the durable cursor, which is what a reconnect dials from.
				return liveCursor;
			},
			advance(seq: number): void {
				assertUsable();
				liveCursor = seq;
				controller.enqueue([{ kind: 'cursor', seq }]);
			},
			documentIdentity(): string | undefined {
				assertUsable();
				return liveIdentity;
			},
			adoptDocumentIdentity(id: string): Result<void, UnstampableError> {
				assertUsable();
				// First write wins, so a store that already carries its stamp has
				// nothing to do; membership changes only by discarding the file.
				if (liveIdentity !== undefined) return Ok(undefined);
				// The stamp lands only on an empty, unstamped store, checked here
				// because this verb owns the invariant: any bytes, pending work,
				// or read progress without an identity are unplaceable across the
				// clean break and must be discarded, never stamped into a document
				// they may not belong to (ADR-0231). The check spans the durable
				// mirror AND the queue, so work retained behind a blocked flush
				// still counts as held.
				if (controller.hasAnyState() || liveCursor > 0) {
					return StoreError.Unstampable();
				}
				liveIdentity = id;
				// Queued ahead of every append that follows, and the sender reads
				// only the durable outbox, so no push can leave before the stamp
				// is durable: a durable outbox entry structurally implies a
				// durable identity (ADR-0238 closing ADR-0231's window).
				try {
					committedSomething = true;
					controller.enqueue([{ kind: 'identity', id }]);
				} finally {
					flushCommitted();
					// The one fact `sync.get()` reports just changed; the boot gate
					// that waits on it hears it here. Contained like every listener.
					for (const listener of [...syncFactsListeners]) {
						const { error } = trySync({
							try: listener,
							catch: (cause) => StoreError.SubscriberThrew({ cause }),
						});
						if (error !== null) log.error(error);
					}
				}
				return Ok(undefined);
			},
		});
	}
}
