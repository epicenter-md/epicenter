import {
	type ConformanceIssue,
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type KvOf,
	type NewRowOf,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
	type RowOf,
	type TypesOf,
} from '@epicenter/data/definition';
import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import { customAlphabet } from 'nanoid';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
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
	type DurableOp,
	type DurablePort,
	type DurableSnapshot,
	type OutboxEntry,
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
	Unaddressable: ({ reason }: { reason: string }) => ({
		message: `This database has no address: ${reason}`,
		reason,
	}),
	/**
	 * This device holds no copy of the generation asked for, and has no account
	 * to fetch it from (ADR-0292).
	 *
	 * A generation number is an ADDRESS, not an instruction to allocate. Opening
	 * an empty database here would turn any URL somebody typed into a real
	 * generation, so the miss is reported and the caller decides: import a
	 * folder to create one, or send the person somewhere that exists.
	 */
	GenerationNotFound: ({
		dataId,
		generation,
	}: {
		dataId: string;
		generation: number;
	}) => ({
		message: `This device holds no generation ${generation} of '${dataId}'`,
		dataId,
		generation,
	}),
	/**
	 * The authority could not be asked for a generation this device lacks.
	 *
	 * Distinct from `GenerationNotFound`, and the distinction is the whole
	 * point: not-found is a fact about the generation and this is a fact about
	 * the network. A retry can fix one and never the other, so a boot surface
	 * that conflates them tells a person their data is gone when their wifi is
	 * off.
	 */
	GenerationUnavailable: ({
		dataId,
		generation,
		status,
		cause,
	}: {
		dataId: string;
		generation: number;
		status?: number;
		cause?: unknown;
	}) => ({
		message: `Generation ${generation} of '${dataId}' could not be fetched${
			status === undefined ? '' : ` (${status})`
		}`,
		dataId,
		generation,
		status,
		cause,
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

export type RowAbsentError = Extract<StoreError, { name: 'RowAbsent' }>;
export type ApplyFailedError = Extract<StoreError, { name: 'ApplyFailed' }>;

/** What a row update can refuse with: only an address holding no row. */
export type UpdateRowError = RowAbsentError;

export type {} from '@epicenter/data/definition';

export type Row = { id: string } & JsonObject;

/**
 * One row's rich content: the live types, and a per-field edit signal
 * (ADR-0296, ADR-0297).
 *
 * The signal is scoped to the FIELD rather than to the row, and that is the
 * whole reason it exists in this shape. The store writes no timestamps
 * (ADR-0297), so an application that wants a recency-sorted list hangs its own
 * write on an edit; a row-scoped signal would fire on the write it caused, and
 * every application would have to break its own loop.
 */
export type RowContent<TTypes = Readonly<Record<string, Y.Type>>> = {
	/** The nested types, by declared field name. */
	readonly types: TTypes;
	/**
	 * Hear edits to one rich field, local or remote.
	 *
	 * Fires for what changed INSIDE the type, never for the row's scalars, so
	 * an application's own derived write does not re-enter through it. Fires
	 * once per commit, on the same flush every other subscriber's notification
	 * goes out on and after all of them, so a listener that writes is writing
	 * against a settled commit.
	 */
	subscribe(field: keyof TTypes & string, listener: () => void): () => void;
};

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
	 * A rich field IS passed here, already built (ADR-0296, amended). The type
	 * is integrated in this transaction, which is what removes the concurrency:
	 * a nested type is addressed by the struct that created it, so two devices
	 * minting one at the same attribute key would lose a subtree, and a minted
	 * row id means no two devices ever do. Omit one and it is minted empty.
	 *
	 * The type must not already belong to a document. Two rows given one type
	 * share one body, silently; `createRow` refuses rather than allowing it.
	 *
	 * The return carries the scalars and the id, not the types. You built them,
	 * so you have them; a later reader asks through `content` (ADR-0295).
	 *
	 * The declaration is a read lens, so creation does not validate the supplied
	 * values or field names. The returned object is the typed write view, while
	 * a later `get` reports how the current lens interprets the stored payload.
	 */
	create(fields: RowInput): Row;
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
	 * Take one row off the table, rich content and all (ADR-0295).
	 *
	 * One removal in one document. Deleting the row's nested type reclaims
	 * every scalar attribute and every rich field's subtree with it, so there
	 * is no second address to retire and no crash point between two halves.
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
	 * One row's stored fields, before this declaration reads them (ADR-0267).
	 *
	 * The narrow form of `data.stored()`, for a caller that already knows which
	 * row it is asking about: a subscriber holding the ids a commit touched,
	 * rendering one file each (ADR-0271). Reading the whole store to answer
	 * about one row is what that caller would otherwise have to do on every
	 * keystroke.
	 *
	 * It is on the handle and the whole read is on the data, and the asymmetry
	 * is honest rather than an oversight: `data.stored()` enumerates the roots
	 * the document holds, so it sees a table this declaration no longer names
	 * (ADR-0240), and no handle exists to ask that question through. What a
	 * handle can answer is narrower and that is all this claims.
	 *
	 * Untyped, and never a Result. `get` is the lens and conformance is its
	 * error arm; this is what is stored, so an absent row is `undefined` and
	 * there is nothing here to fail.
	 */
	stored(rowId: string): JsonObject | undefined;
	/**
	 * One row's rich fields: the live nested types, and their edit signals
	 * (ADR-0295, ADR-0296).
	 *
	 * Synchronous, and there is nothing left for it to await. The types are in
	 * the one document this store already holds, so there is no address to
	 * derive, no chain to hydrate, no handle to refcount, and no half-hydrated
	 * type an editor could merge keystrokes into. `undefined` means the table
	 * holds no row at this address.
	 *
	 * Nothing is disposed. A type's lifetime is its row's: it is minted when
	 * the row is minted and reclaimed when the row is deleted, so holding one
	 * pins nothing that a close could release.
	 */
	content(rowId: string): RowContent | undefined;
	/**
	 * Hear when anything in this table changes, whoever changed it.
	 *
	 * A ping, not a payload. It carried the ids a commit touched until nothing
	 * turned out to read them: the one live subscriber discards the argument,
	 * the mirror refuses the signal and renders everything (ADR-0271), and the
	 * consumer the ids were kept for reads `updatedAt` off the index through
	 * A caller re-reads with `list()`, which walks a document already in
	 * memory.
	 *
	 * Fires after the commit is accepted, on the same flush as KV's and after
	 * `onCommitted`, so a composed follower is dirty before any subscriber
	 * reads. Naming the rows again is one listener away if something ever
	 * wants them: the delta that produces them is still there, and
	 * `evidence/delta-names-the-row.test.ts` still proves it.
	 */
	subscribe(listener: () => void): () => void;
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
				/** One row's stored fields, untyped, before the declaration reads them. */
				stored(rowId: string): JsonObject | undefined;
				content(rowId: string): RowContent<TypesOf<TFields>> | undefined;
				subscribe(listener: () => void): () => void;
			}
		: never;

/**
 * One table's read and write shapes, from ONE descriptor instantiation.
 *
 * `RowOf` and `NewRowOf` each instantiate the field definitions on their own,
 * so naming both across every verb of every table was enough to exceed
 * TypeScript's depth limit. Resolving the pair once and reusing the two halves
 * keeps the surface identical and the instantiation count at one per table.
 */
type TableIo<TFields> = {
	row: RowOf<TFields>;
	input: NewRowOf<TFields>;
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
 * forwarded getter and a cast to build it. SQL is deliberately not here: an
 * index is a follower an application composes, not a verb the store owes.
 *
 * The view and the store are born together: an opened runtime holds exactly
 * one data definition for its whole life (ADR-0240), so there is no verb
 * that takes a second view of a live store. A newer definition reads the same
 * durable data by closing this runtime and opening the next one.
 */
/**
 * One application's stored state, by root, with no declaration applied.
 *
 * Every table root the document actually holds, whether or not this release
 * declares it, and every kv key the same way. Values are `JsonObject` because
 * nothing has interpreted them: this is what is there, not what reads.
 */
export type StoredData = {
	readonly tables: ReadonlyMap<string, ReadonlyMap<string, JsonObject>>;
	readonly kv: JsonObject;
};

export type DataOf<
	TDatabase extends DataDefinition,
	TStore extends DataStoreBase = AccountStore,
> = DataView<TDatabase> & {
	/** Group direct data operations into one accepted and durable transaction. */
	transact<TResult>(run: () => TResult): TResult;
	/**
	 * Everything stored, before this declaration reads it (ADR-0267).
	 *
	 * A table handle reads through the declaration; this reads what is stored.
	 * The artifact read, for an export that must not narrow.
	 */
	stored(): StoredData;
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
export function asData<
	TDatabase extends DataDefinition,
	TStore extends DataStoreBase,
>(store: TStore, view: DataView<TDatabase>): DataOf<TDatabase, TStore> {
	return Object.freeze({
		...view,
		transact: store.transact,
		stored: store.stored,
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
	 * The same shape a table's has: a ping, and "something here moved, re-read"
	 * is the complete message. A caller re-reads with `get()`, which is a
	 * property access on a document already in memory.
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
 * construction and every table handle and the KV handle read the one parsed
 * definition for the store's whole life
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
	 * every load, forever. An explicit Rebuild action reclaims one (ADR-0276,
	 * `evidence/bench/tombstones.ts`). Whether that ever matters is a question
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
	/** The document's clocks: which authored state it holds, from whom. */
	stateVector(): Uint8Array;
	/** Everything the document has that the state vector does not. */
	encodeStateSince(stateVector?: Uint8Array): Uint8Array;
	/** Group direct data operations into one accepted and durable transaction. */
	transact<TResult>(run: () => TResult): TResult;
	/**
	 * Everything stored, before this declaration reads it (ADR-0267).
	 *
	 * A CRDT read like `stateVector` and `encodeStateSince` are: it answers
	 * about the document rather than about the application's view of it. What
	 * an artifact needs and a feature never touches.
	 */
	stored(): StoredData;
	/**
	 * Hear when anything committed into this document, whoever authored it.
	 *
	 * Fires at acceptance, whether or not the durable copy has caught up:
	 * acceptance and durability are two steps (ADR-0238), and durability has
	 * its own surface below. Delivered BEFORE table and KV notifications in
	 * the same flush, and that order is a contract: a composed follower marks
	 * itself dirty here, so it is already dirty by the time any table
	 * subscriber reads through it. Strictly wider than `onLocalWork`, and the
	 * two are not
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
 * `LocalStore | AccountStore` without `in`-probing, and a future reader of
 * either
 * object sees the same shape with one honest difference.
 */
export type LocalStore = DataStoreBase & {
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
 * That this store replicates, and the key its transport is registered against.
 *
 * It carries no facts, and it used to carry one: the document identity, which
 * was a boot gate's whole question (ADR-0231). The generation is in the address
 * now, so a replica is bound the moment it opens and there is nothing left to
 * wait for (ADR-0292). What is left is the discriminant the store types already
 * had, plus an object identity `syncEngineOf` can key on, so a wrapper that
 * spreads the store keeps the door reachable.
 *
 * Connection health, attempts, and in-flight submissions belong to the
 * connection driving the socket and were never here.
 */
export type SyncCapability = { readonly replicates: true };

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
): DataOf<TDatabase, LocalStore> {
	const { store, view } = createStoreEngine(overSqlite(options, false), 'none');
	// Through `unknown` deliberately: comparing the untyped view with
	// `DataView<TDatabase>` re-enters the per-field descriptor instantiation
	// and exceeds the depth limit. The runtime value is the same object either
	// way; only the static view of it differs.
	return asData(store, view as unknown as DataView<TDatabase>);
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
	const { store, view } = createStoreEngine(
		overSqlite(options, true),
		'remote',
	);
	return asData(store, view as unknown as DataView<TDatabase>);
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
	store: LocalStore;
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
): {
	store: LocalStore;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
};
function createStoreEngine(
	options: StoreEngineOptions,
	replication: 'remote',
): {
	store: AccountStore;
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
	store: LocalStore | AccountStore;
	view: UntypedDataView;
	definition: ParsedDataDefinition;
} {
	const database = createDatabaseDocument();
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
	/**
	 * The highest outbox id acknowledged this session. An overlay over the
	 * durable mirror, so an acknowledged entry is never re-offered while its
	 * `dropOutbox` op is still queued behind a blocked flush.
	 */
	let ackedThrough = 0;
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
	 * What an append this device authored owes the authority: nothing yet.
	 *
	 * Always `undefined`, on both store kinds, because neither has a position
	 * for bytes the authority has not seen. On a local store nothing ever
	 * reads the result, since there is no sender, and the port folds its chain
	 * whole rather than asking.
	 */
	const authoredSeq = (): number | undefined => undefined;

	/**
	 * Where a table's `'delta'` event becomes a subscriber's invalidation.
	 *
	 * `@epicenter/data/definition` owns the grouping, the per-table dedup and the delivery
	 * laws, and a delta-fed producer needs exactly those. Nothing about them is
	 * specific to a carrier, which is why they were written once there rather
	 * than here (ADR-0187).
	 */
	/**
	 * Tables the transaction in progress changed, held until the commit lands.
	 *
	 * The one reason this buffer exists. A table root's `'delta'` fires
	 * SYNCHRONOUSLY inside `applyUpdateV2`, mid-acceptance (measured against
	 * `@y/y@14.0.0-rc.24`). Delivering there would hand a subscriber a commit
	 * still being accepted, and would run its listener ahead of the
	 * `onCommitted` phase a composed follower marks itself dirty in, so the
	 * notification waits and goes out afterwards.
	 *
	 * It holds table names rather than row addresses because nothing has ever
	 * read a row id off this path: `subscribe` is a ping.
	 */
	let touched = new Set<string>();
	/** Whether the commit in progress changed anything at all. */
	let committedSomething = false;
	/** Whether the commit in progress touched the KV root. */
	let kvTouched = false;
	/** Who is watching each table, by name. A ping, not a payload. */
	const tableListeners = new Map<string, Set<() => void>>();
	/**
	 * Rich-field listeners whose type changed in the commit being accepted.
	 *
	 * Buffered for the same reason a table's invalidation is: a nested type's
	 * `'delta'` fires SYNCHRONOUSLY inside `applyUpdateV2`, mid-acceptance, so
	 * delivering there would hand a subscriber a commit still being accepted
	 * and would run its listener ahead of the `onCommitted` phase a composed
	 * follower marks itself dirty in.
	 */
	let richTouched = new Set<() => void>();
	const kvFlushers = new Set<() => void>();
	const localWorkListeners = new Set<() => void>();
	const committedListeners = new Set<() => void>();

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
		if (touched.size > 0) {
			const batch = touched;
			touched = new Set();
			for (const tableName of batch) {
				for (const listener of [...(tableListeners.get(tableName) ?? [])]) {
					// Contained for the same reason every other listener here is: one
					// broken subscriber must not cost the others their notification.
					const { error } = trySync({
						try: listener,
						catch: (cause) => StoreError.SubscriberThrew({ cause }),
					});
					if (error !== null) log.error(error);
				}
			}
		}
		// Last, and finest-grained. A rich-field subscriber is where an
		// application hangs its own derived write (ADR-0297), so it runs after
		// every coarser reader has already seen the commit that caused it.
		if (richTouched.size === 0) return;
		const fields = richTouched;
		richTouched = new Set();
		for (const notify of fields) {
			const { error } = trySync({
				try: notify,
				catch: (cause) => StoreError.SubscriberThrew({ cause }),
			});
			if (error !== null) log.error(error);
		}
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

	database.on(
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
			// An application writing through a live type it holds: an editor bound
			// to a rich field, which is the ordinary path since a row's rich
			// content came back into this document (ADR-0295). Authored bytes join
			// the durable queue and the outbox on their own, because no store verb
			// is going to flush them.
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
						id: mintId(),
						bytes: authored,
						authoritySeq: authoredSeq(),
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
		Y.applyUpdateV2(database, copyBytes(stored), hydrationOrigin);
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
		 * after the mutation so they can depend on what it did.
		 *
		 * Nothing passes it today. Row deletion used to: the scalar removal and
		 * the row document's durable tombstone had to land together, and a
		 * database is one document now, so a deletion is bytes like any other
		 * write (ADR-0295). Kept because `transact` composes through the same
		 * seam and the next fact that needs one atomic batch will want it.
		 */
		compose?: () => DurableOp[],
	): void {
		if (composedTransaction !== undefined) {
			database.transact(mutate, localOrigin);
			composedTransaction.push(...(compose?.() ?? []));
			return;
		}
		pending = [];
		database.transact(mutate, localOrigin);
		const authored = pending;
		pending = [];
		try {
			const ops: DurableOp[] = authored.map(
				(update): DurableOp => ({
					kind: 'append',
					id: mintId(),
					bytes: update,
					authoritySeq: authoredSeq(),
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
			database.transact(() => {
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
					id: mintId(),
					bytes: update,
					authoritySeq: authoredSeq(),
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
	 * SQL is deliberately not built here: an index is a follower an application
	 * composes over this surface, not a verb the store owes.
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
		const root = kvRoot(database);

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
			const raw = storedKv();
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

	/**
	 * Everything this application has stored, before its declaration reads it
	 * (ADR-0267).
	 *
	 * The one faithful read, and it is on the data rather than on a table on
	 * purpose. A table handle is the application's lens: `get` and `list` answer
	 * what THIS release can read, and both narrow to the declared fields, so a
	 * key an older release wrote and this one no longer names is unreachable
	 * through them. That narrowing is correct for an application and correct for
	 * any index a follower rebuilds on demand. It is wrong for an artifact: an
	 * export that drops a field is data loss, and the
	 * caller that must not lose one is asking about the store, not a table.
	 *
	 * So it enumerates the roots the document actually holds rather than the
	 * tables the declaration names, and it hands back stored values untyped.
	 * Untyped is the point: reaching for this means giving up the lens, and the
	 * absent row types are what makes that visible at the call site.
	 *
	 * A row's rich content is not here, and cannot be: a nested `Y.Type` is not
	 * a JSON value, so no faithful read of stored VALUES can carry one. An
	 * export reaches it through `content` and the table's own file codec
	 * (ADR-0296).
	 */
	function stored(): StoredData {
		const tables = new Map<string, ReadonlyMap<string, JsonObject>>();
		for (const tableName of storedTableNames(database)) {
			tables.set(tableName, rowsOf(tableName));
		}
		return { tables, kv: storedKv() };
	}

	function createTableHandle(
		tableName: string,
		table: ParsedTable,
	): TableHandle {
		const root = tableRoot(database, tableName);
		/** The rich fields this table declares, minted with every row it creates. */
		const richFields = table.types;

		/**
		 * That this table changed, noted for the flush to deliver.
		 *
		 * `'delta'` rather than `observeDeep` because `observeDeep` reports a
		 * nested row's field edit as an event on the TABLE ROOT with
		 * `keysChanged` empty, so it cannot even tell that a row moved. Delta
		 * can, and once could name which row: its `attrs` is keyed by the
		 * attribute that changed, and a row IS an attribute on the table root
		 * (`evidence/delta-names-the-row.test.ts`).
		 *
		 * Nothing ever read that name. The one live subscriber, `from-data`'s
		 * `createSubscriber`, discards the argument, and the mirror refuses the
		 * signal and renders everything. So this notes the table and drops the
		 * ids, and the delta test keeps standing as evidence that they were
		 * there to be had.
		 *
		 * It also fires for a rich field's edit, because a nested edit bubbles
		 * through `changedParentTypes` to the table root (ADR-0295). A list that
		 * re-renders off this signal therefore re-renders at typing frequency;
		 * a listener that wants only one field's edits uses `content`'s own
		 * per-field signal instead.
		 */
		function collectTouched(delta: unknown): void {
			const { attrs } = delta as { attrs?: Record<string, unknown> };
			if (attrs === undefined) return;
			touched.add(tableName);
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
			create(fields: RowInput): Row {
				assertUsable();
				const rowId = mintRowId();
				// The rich fields are integrated in the same transaction (ADR-0295),
				// and never again: nested types do not converge by name, so a field
				// minted lazily on two devices would lose one subtree.
				commit(() => createRow(root, rowId, fields, richFields));
				const scalars: JsonObject = {};
				for (const [name, value] of Object.entries(fields)) {
					if (!(value instanceof Y.Type)) scalars[name] = value;
				}
				return { id: rowId, ...scalars };
			},
			get(rowId: string): Result<Row | undefined, NonconformingRow> {
				assertUsable();
				const payload = readRow(root, rowId);
				if (payload === undefined) return Ok(undefined);
				return conformRow(rowId, payload);
			},
			update(rowId: string, fields: JsonObject): Result<void, UpdateRowError> {
				assertUsable();
				// One lookup, not two. This used to ask `hasRow` and then write
				// through a function that would have minted the row had the answer
				// changed in between; `updateRow` answers whether it found one, so
				// the check and the write are the same read.
				let written = false;
				commit(() => {
					written = updateRow(root, rowId, fields);
				});
				if (!written) return StoreError.RowAbsent({ table: tableName, rowId });
				return Ok(undefined);
			},
			delete(rowId: string): void {
				assertUsable();
				// One removal (ADR-0295). Taking the row's nested type off the root
				// takes its rich fields with it, so there is no second address to
				// retire and nothing to compose this write with.
				commit(() => {
					deleteRow(root, rowId);
				});
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
			stored(rowId: string): JsonObject | undefined {
				assertUsable();
				return readRow(root, rowId);
			},
			content(rowId: string): RowContent | undefined {
				assertUsable();
				const types = readRowTypes(root, rowId, richFields);
				if (types === undefined) return undefined;
				return {
					types,
					subscribe(field: string, listener: () => void): () => void {
						const type = types[field];
						if (type === undefined) return () => undefined;
						// Straight onto the field's own type, so what a listener hears
						// is an edit to THAT content and nothing else (ADR-0297). A
						// nested edit does also bubble to the table root, which is what
						// `subscribe` above reports; this one does not widen to it.
						//
						// Noted rather than delivered: the delta fires inside
						// acceptance, and the notification goes out on the same flush
						// every other subscriber's does.
						const onDelta = () => richTouched.add(listener);
						type.on('delta', onDelta);
						let stopped = false;
						return () => {
							// Idempotent, for the same reason a table subscription is: a
							// Svelte effect that reruns can call its teardown twice.
							if (stopped) return;
							stopped = true;
							type.off('delta', onDelta);
							// A stop between the delta and the flush must not deliver.
							richTouched.delete(listener);
						};
					},
				};
			},
			subscribe(listener: () => void): () => void {
				let listeners = tableListeners.get(tableName);
				if (listeners === undefined) {
					listeners = new Set();
					tableListeners.set(tableName, listeners);
				}
				listeners.add(listener);
				const unsubscribe = () => listeners.delete(listener);
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
						pending = [];
						const received = copyBytes(update);
						// A refusal is a property of the bytes: nothing already applied is
						// rolled back (an update is idempotent, so a re-receive after the
						// refusal re-applies harmlessly), the cursor does not advance, and
						// the store stays usable.
						const { error } = trySync({
							try: () => Y.applyUpdateV2(database, received, remoteOrigin),
							catch: (cause) => StoreError.ApplyFailed({ cause }),
						});
						if (error !== null) return Err(error);
						// Whatever the document emitted in response is dropped: it
						// describes the same change the received bytes already carry.
						pending = [];
						try {
							committedSomething = true;
							// With the bytes, never after them: the bookmark and what it
							// accounts for are adjacent ops in one atomic flush batch, so
							// durable state can never hold a cursor ahead of the bytes, and
							// never bytes wearing a fresh install's cursor (ADR-0231,
							// carried by ADR-0238's whole-queue flush). The LIVE cursor
							// advances now; the durable one is derived from the position
							// the append carries, so it cannot run ahead of it, and a crash
							// before the batch lands re-receives, which is free because an
							// update is idempotent.
							if (opts?.advanceTo !== undefined) {
								liveCursor = opts.advanceTo;
							}
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
							// After the enqueue, which is what the touched tables were
							// buffered for: the `'delta'` naming them fired inside
							// `applyUpdateV2` above, mid-acceptance, and delivery waits
							// until acceptance completes so every listener phase observes
							// one settled commit.
							flushCommitted();
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

	const base: DataStoreBase = {
		transact,
		stored(): StoredData {
			assertUsable();
			return stored();
		},
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
			await controller.drain();
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
						? (entries[0] as OutboxEntry).bytes
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
				ackedThrough = Math.max(ackedThrough, throughId);
				liveCursor = Math.max(liveCursor, authoritySeq);
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
				// The LIVE position: everything this document has applied, whether
				// or not its durable record has caught up. The transport reads this
				// beside `encodeStateSince()`, which is also live, so the two
				// always describe the same state. At open, with nothing queued, it
				// equals the durable cursor, which is what a reconnect dials from.
				return liveCursor;
			},
		});
	}
}
