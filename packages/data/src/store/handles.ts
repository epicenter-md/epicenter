/**
 * What an application holds: a row, a table, a KV, and the view over both.
 *
 * All declaration and no engine, which is why it is its own file. `store.ts`
 * builds these; nothing here knows how.
 *
 * The shapes here are the LENS. `RowOf` and friends come from the declaration
 * (`@epicenter/data/definition`); what this file adds is the verbs, and the
 * rule that decides which verbs exist: a read is what this release's
 * declaration can see, and a write is what it may say.
 */
import type {
	ConformanceIssue,
	DataDefinition,
	JsonObject,
	JsonValue,
	KvOf,
	NewRowOf,
	RowOf,
	ScalarsOf,
} from '@epicenter/data/definition';
import type * as Y from '@y/y';
import type { Result } from 'wellcrafted/result';

import type { RowInput } from './document.js';
import type { NonconformingRow, RowAbsentError } from './errors.js';
import type { PersistenceCapability } from './persistence.js';

/**
 * One row, as an application reads it: the id, the scalars, and the live types.
 *
 * A type field is here rather than behind a second verb (ADR-0296, amended).
 * `readRow` cannot return one, so the handle merges what `readRowTypes` finds
 * before handing the row over; what a caller gets is one object with `body` on
 * it, not a row plus a bag to go and fetch.
 *
 * **The two halves have different lifetimes, and that is forced rather than
 * chosen.** A scalar is a snapshot: it was copied out of the document when you
 * read, and a later commit does not change it. A type field is a reference: it
 * IS the container in the document, so an edit through it is an edit to the
 * store, and a peer's edit shows up in it without anyone re-reading.
 *
 * Neither could be the other. Copying a `Y.Type` out would break the merge that
 * makes it worth having, and a scalar has nothing to reference: it is a JSON
 * value on a map, not an object. So a row is half snapshot and half handle,
 * and which half a field is, its declared kind already says.
 *
 * What keeps that liveable is that reads are cheap and reactive. `get` walks a
 * document already in memory, and `fromData` re-runs a `$derived` on any commit
 * that touches the table, so a surface re-reads rather than holding. Holding a
 * destructured scalar across a commit is the one way to be surprised, and it is
 * the same way it always was.
 */
export type Row = { id: string } & Record<string, JsonValue | Y.Type>;

export type TableHandle<
	TRow = Row,
	TInput = RowInput,
	TPatch = JsonObject,
> = {
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
	 * A type field IS passed here, already built (ADR-0296, amended). The type
	 * is integrated in this transaction, which is what removes the concurrency:
	 * a nested type is addressed by the struct that created it, so two devices
	 * minting one at the same attribute key would lose a subtree, and a minted
	 * row id means no two devices ever do. Omit one and it is minted empty.
	 *
	 * The type must not already belong to a document. Two rows given one type
	 * share one body, silently; `createRow` refuses rather than allowing it.
	 *
	 * The return is the row `get` would give you: the id, the scalars, and the
	 * INTEGRATED types. Read back rather than echoed, because a type you passed
	 * in was detached and reads as empty until it is integrated here, and one
	 * you omitted was minted for you.
	 *
	 * The declaration is a read lens, so creation does not validate the supplied
	 * values or field names. The returned object is the typed write view, while
	 * a later `get` reports how the current lens interprets the stored payload.
	 */
	create(fields: TInput): TRow;
	/**
	 * One row, whole, or nothing.
	 *
	 * `undefined` covers both "no row at this address" and "a row this
	 * declaration cannot read", and collapsing them is deliberate: a caller
	 * asking about one row does the same thing with either answer, and no
	 * consumer in this repo ever branched on the difference. A row that does
	 * not conform is not hidden by that, it is on `nonconforming` with its raw
	 * values, which is where a repair is composed (ADR-0125) and where all
	 * three applications that care already look.
	 *
	 * No `Result`, and that is what the collapse bought. The error arm carried
	 * one variant nobody read, so every call site paid an unwrap for it;
	 * Honeycrisp had written `table.rows.find(...)` by hand rather than use
	 * this verb.
	 *
	 * A READ, not a value: see {@link Row}. Comparing what this returns is the
	 * one thing it does not support, and `store.stored()` is where that goes.
	 */
	get(rowId: string): TRow | undefined;
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
	update(rowId: string, fields: TPatch): Result<void, RowAbsentError>;
	/**
	 * Take one row off the table, type content and all (ADR-0295).
	 *
	 * One removal in one document. Deleting the row's nested type reclaims
	 * every scalar attribute and every type field's subtree with it, so there
	 * is no second address to retire and no crash point between two halves.
	 *
	 * Returns nothing: deleting an address that holds no row is a no-op fact
	 * rather than an outcome a caller acts on, and every consumer said so by
	 * discarding the boolean this used to report.
	 */
	delete(rowId: string): void;
	/**
	 * Every row id, sorted, without conforming any of them.
	 *
	 * Kept for the cheap count. `rows.length` answers the same question by
	 * walking every row through the declaration, which is the right answer for
	 * an application and the wrong one for a bench measuring the store: no
	 * application calls this, and `evidence/` calls it constantly.
	 */
	ids(): string[];
	/**
	 * Every row this declaration reads whole, with its live types.
	 *
	 * A member rather than `list().rows`, because every consumer destructured
	 * that tuple and three applications then re-exposed each half as its own
	 * getter. This is the shape they were all rebuilding.
	 */
	readonly rows: TRow[];
	/**
	 * Every row stored here that this declaration cannot read, with its raw
	 * values (ADR-0125).
	 *
	 * Reported rather than dropped or repaired, and reachable for WRITES:
	 * Honeycrisp walks this to re-parent notes out of a folder it is deleting,
	 * so a row it cannot read is not a row it can orphan.
	 */
	readonly nonconforming: NonconformingRow[];
	/**
	 * Hear when this table's SHAPE changes: a row added, a row removed, or a
	 * row's scalars edited.
	 *
	 * NOT an edit inside a row's type field. A type field is nested on its row
	 * (ADR-0295), so counting it here would wake every list in the application
	 * on every keystroke; the data's `watch` is the signal for that, scoped to
	 * the one type. The store decides by depth against the table root, so the
	 * invalidation stays a superset of what changed (ADR-0187) without being
	 * the whole document.
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
	 * reads. Naming the rows again is one lookup away if something ever wants
	 * them: a commit's changed types ARE the rows, and
	 * `evidence/delta-names-the-row.test.ts` still proves the ids are there.
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
		? TableHandle<TRow, TInput, Partial<ScalarsOf<TFields>>>
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
			TDatabase['tables'][K]
		>;
	};
	readonly kv: KvHandle<KvOf<TDatabase>>;
	/**
	 * Group direct data operations into one accepted and durable transaction.
	 *
	 * One commit, so one durable append and one notification per table it
	 * touched. Deleting a folder that re-parents fifty notes is one commit
	 * rather than fifty-one.
	 *
	 * It is HERE rather than on the store because grouping writes is what an
	 * APPLICATION does, and `tables` and `kv` are the writes it groups. On the
	 * store it was reachable only by a caller that also held the transport's
	 * verbs, so the reference application, which narrows to this view, could
	 * not reach it at all and paid a commit per row instead.
	 */
	transact<TResult>(run: () => TResult): TResult;
	/**
	 * Hear edits to ONE live type, local or remote.
	 *
	 * Takes the type rather than an address, because the caller is already
	 * holding it: a type field is read off its row (ADR-0295), and rendering it
	 * needs the type anyway. Naming an address instead looked the same object
	 * up a second time and could disagree with the first, handing back a dead
	 * subscription for a row deleted in between.
	 *
	 * It is on the DATA rather than on a table because the delivery is keyed by
	 * the type's own identity and knows nothing about a table. It sat on
	 * `tables.<name>` for one release and the placement was a lie: nothing in
	 * the implementation read the table, so watching one table's type through
	 * another table's handle worked.
	 *
	 * The scope is the whole reason it exists: the store writes no derived
	 * fields (ADR-0297), so an application hangs its own write on an edit, and
	 * a row-scoped signal would fire on the write it caused. It is also the
	 * only way to hear prose, because a table's `subscribe` reports that
	 * table's shape and deliberately not an edit inside a field.
	 *
	 * Fires once per commit, on the same flush every other subscriber's
	 * notification goes out on and AFTER all of them, so a listener that writes
	 * is writing against a settled commit. That ordering is the whole service:
	 * the type's own `on('delta')` fires mid-acceptance, and a write from there
	 * would re-enter the transaction being accepted.
	 */
	watch(type: Y.Type, listener: () => void): () => void;
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

/**
 * One application's opened data: everything it holds, on one object.
 *
 * The view and the document's own capabilities, intersected rather than
 * nested. There used to be a `store` key here, and the split it drew was by
 * audience: `tables` and `kv` for an application, `store` for a transport and
 * an exporter. The audience distinction is real; the OBJECT was the wrong
 * place to carry it.
 *
 * What carries it instead is the narrowing type an application already writes:
 *
 * ```ts
 * type HoneycrispData = DataView<typeof honeycrispDefinition>;
 * ```
 *
 * That is per-app, costs nothing at runtime, and is where this repository
 * actually enforces "a feature does not touch the document". Every consumer
 * does it. A second boundary inside the package duplicated that work and got
 * the contents wrong: `persistence`, the ONE member an application reaches
 * for, sat on the side labelled "a feature never touches", while `transact`
 * had to be moved off it because the label made it unreachable.
 *
 * `TStore` has no default, deliberately. Every consumer passes both, and a
 * default of `AccountStore` failed UPWARD: a caller who forgot got the more
 * capable kind, so code that only works on a replica typechecked against a
 * local store and broke at runtime.
 *
 * Structural typing does the rest. `DataView<T> & AccountStore` IS an
 * `AccountStore`, so `syncEngineOf` and `attachStoreSync` take this object
 * unchanged. The `store` key survives on the OVER-PORT parts
 * (`createAccountStoreOverPort`), which is a construction seam and not a
 * handle: an opener still has a bare store to wrap before it composes one.
 */
export type DataOf<
	TDatabase extends DataDefinition,
	TStore extends DataStoreBase,
> = DataView<TDatabase> & TStore;

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
	// One object. `asyncDispose` is a symbol key and object spread copies own
	// enumerable symbol properties, so the store's own disposal comes across
	// with everything else rather than being forwarded by hand.
	return Object.freeze({ ...view, ...store });
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
	 * One key's value, or nothing.
	 *
	 * The same read law a table's `get` follows, and now the same shape:
	 * `undefined` covers both "never written" and "written as something this
	 * declaration cannot read". Conformance is per KEY, so one unreadable
	 * setting costs that setting and not the object around it.
	 *
	 * It used to return the whole object as a `Result`, with the diagnostic
	 * carrying whatever conformed, and both consumers wrote the same recovery
	 * by hand: `{ ...APPLICATION_DEFAULTS, ...error.conforming }`, once in
	 * Vocab and once in Whispering, which then exposed a per-key getter over
	 * the top of it. That composition is now the line you would write anyway:
	 *
	 * ```ts
	 * kv.get('theme') ?? APPLICATION_DEFAULTS.theme
	 * ```
	 *
	 * The default stays in the application. A default declared in the
	 * definition would be a value nothing stored, so `stored()` and the export
	 * would not carry it and two releases could disagree about what is there
	 * with no write between them (ADR-0255).
	 */
	get<TKey extends keyof TValues & string>(
		key: TKey,
	): TValues[TKey] | undefined;
	/**
	 * Every declared key this release cannot read, with what is stored there.
	 *
	 * The mirror of a table's `nonconforming`, for the same reason: a value
	 * this declaration refuses is a fact about the KV, reported rather than
	 * dropped or repaired (ADR-0125). A surface that wants to say "3 settings
	 * could not be read" reads this; a surface that wants a value calls `get`
	 * and falls back.
	 */
	readonly nonconforming: ConformanceIssue[];
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
	transact<TResult>(run: () => TResult): TResult;
	watch(type: Y.Type, listener: () => void): () => void;
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
	/**
	 * Everything stored, before this declaration reads it (ADR-0267).
	 *
	 * A CRDT read like `stateVector` and `encodeStateSince` are: it answers
	 * about the document rather than about the application's view of it. What
	 * an artifact needs and a feature never touches.
	 */
	stored(): StoredData;
	/**
	 * One row exactly as the exporter needs it: every stored scalar, and the
	 * live types beside them.
	 *
	 * The narrow form of `stored()`, and the artifact layer's only per-row read.
	 * It is on the STORE rather than on a table handle because it is not a
	 * lens: it returns keys this release no longer declares and rows this
	 * release cannot conform, which is the one thing an export may not narrow
	 * (ADR-0267). A handle answers what an application can see; this answers
	 * what is there.
	 */
	rowFile(table: string, rowId: string): Row | undefined;
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
