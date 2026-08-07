import type { JsonObject } from '@epicenter/lens';
import {
	type CreateInputOf,
	type LensJson,
	type LensParseError,
	type NonconformingRowError,
	type ParsedLens,
	type ParsedTable,
	parseLens,
	type RowOf,
	type RowWriteError,
} from '@epicenter/lens/lens';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	createIndexDocument,
	deleteRow,
	isLive,
	listRowIds,
	readRow,
	tableRoot,
	writeRow,
} from './index-document.js';
import {
	appendUpdate,
	applyProjectionSchema,
	applyStoreSchema,
	copyBytes,
	deleteProjectedRow,
	INDEX_DOCUMENT,
	readUpdates,
	rebuildProjectedTable,
	rowDocumentName,
	upsertProjectedRow,
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
	 * A write named an address that holds no live row.
	 *
	 * The verb this replaces returned `Ok(undefined)` and silently swallowed the
	 * write, which is a live bug in the code this store supersedes. A write that
	 * reaches nothing is a failure and says so.
	 */
	RowAbsent: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Table '${table}' holds no live row '${rowId}'`,
		table,
		rowId,
	}),
	RowExists: ({ table, rowId }: { table: string; rowId: string }) => ({
		message: `Table '${table}' already holds row '${rowId}'`,
		table,
		rowId,
	}),
	UnknownTable: ({ table }: { table: string }) => ({
		message: `This lens declares no table '${table}'`,
		table,
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
});
export type StoreError = InferErrors<typeof StoreError>;

export type ReadRowError = StoreError | NonconformingRowError;
export type WriteRowError = StoreError | RowWriteError | NonconformingRowError;

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
	 * const { data, error } = await db.settings.get('app');
	 * const cfg = data ?? { ...db.settings.defaults, ...error?.conforming };
	 * ```
	 */
	readonly defaults: Readonly<JsonObject>;
	create(fields?: JsonObject): Promise<Result<Row, WriteRowError>>;
	create(rowId: string, fields?: JsonObject): Promise<Result<Row, WriteRowError>>;
	/**
	 * The one read verb.
	 *
	 * `Ok(undefined)` means the address holds no live row, which is a fact rather
	 * than a failure. `Err(Nonconforming)` carries `conforming`, so a caller
	 * composes whatever forgiveness it wants without a second verb existing.
	 */
	get(rowId: string): Promise<Result<Row | undefined, ReadRowError>>;
	/**
	 * Merge fields into a live row. Refuses an absent address.
	 *
	 * `update` rather than `set`, because only the fields handed in are touched
	 * and every other field is left alone. `set` promises replacement, and this
	 * is the verb called most often, so the name that misleads is the expensive
	 * one to keep.
	 */
	update(rowId: string, fields: JsonObject): Promise<Result<Row, WriteRowError>>;
	/**
	 * Get or create, in one transaction.
	 *
	 * The verb a singleton needs, and the reason there is no `kv` namespace: a
	 * singleton is a row whose id you chose. With defaults declared, occupying
	 * one needs no fields at all.
	 */
	ensure(rowId: string, fields?: JsonObject): Promise<Result<Row, WriteRowError>>;
	delete(rowId: string): Promise<Result<boolean, StoreError>>;
	/** Every live row id, sorted. */
	ids(): Promise<Result<string[], StoreError>>;
	/**
	 * Every live row, with the ones this lens cannot read reported separately
	 * rather than dropped or repaired.
	 */
	list(): Promise<
		Result<
			{ rows: Row[]; nonconforming: NonconformingRowError[] },
			StoreError
		>
	>;
	document: {
		/**
		 * The document this row inherently owns (ADR-0130/0212).
		 *
		 * Asynchronous because opening is a load, and disposable because a
		 * document is opened and never assigned: that is what makes it impossible
		 * to replace the type behind an editor that still holds a handle, which
		 * silently accepts writes that go nowhere.
		 *
		 * Epicenter creates it and never looks inside. The application names its
		 * own roots and chooses its own format.
		 */
		open(rowId: string): Promise<Result<RowDocument, StoreError>>;
	};
};

export type RowDocument = {
	/**
	 * One of the application's own roots inside its own document.
	 *
	 * `typeName` is Yjs 14's own second argument, and it is not optional in
	 * practice: a root with no name has no type, so `change` builds a delta that
	 * `applyDelta` then discards and the write silently does nothing. Verified
	 * against `@y/y@14.0.0-rc.24`. Epicenter passes it through and never reads
	 * what it names.
	 */
	get(root: string, typeName?: string | null): Y.Type;
	transact<T>(run: () => T): T;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Read-only SQL over one application's own projection.
 *
 * On the binding rather than on the store, so an application reaches only its
 * own namespace. `query` is a reserved table name for exactly this reason: a
 * table becomes a key on the same handle that carries the method.
 */
export type QueryMethod = (
	strings: TemplateStringsArray,
	...values: SqliteValue[]
) => Promise<Result<SqliteRow[], StoreError>>;

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
			delete(rowId: string): Promise<Result<boolean, StoreError>>;
			ids(): Promise<Result<string[], StoreError>>;
			document: TableHandle['document'];
			create(fields: TInput): Promise<Result<TRow, WriteRowError>>;
			create(
				rowId: string,
				fields: TInput,
			): Promise<Result<TRow, WriteRowError>>;
			get(rowId: string): Promise<Result<TRow | undefined, ReadRowError>>;
			update(
				rowId: string,
				fields: Partial<TInput>,
			): Promise<Result<TRow, WriteRowError>>;
			ensure(
				rowId: string,
				fields?: Partial<TInput>,
			): Promise<Result<TRow, WriteRowError>>;
			list(): Promise<
				Result<
					{ rows: TRow[]; nonconforming: NonconformingRowError[] },
					StoreError
				>
			>;
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
	: never) & { query: QueryMethod };

/** The untyped view, for a lens that arrived as data rather than as a literal. */
export type Bound = Record<string, TableHandle> & { query: QueryMethod };

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
	/** This replica's clocks, which is the whole sync manifest (ADR-0212). */
	stateVector(): Uint8Array;
	/** Everything this replica has that the given state vector does not. */
	encodeStateSince(stateVector?: Uint8Array): Uint8Array;
	[Symbol.asyncDispose](): Promise<void>;
};

export function createStore({
	database,
	history,
	now = () => Date.now(),
	dispose = () => undefined,
}: {
	database: SqliteDatabase;
	history?: SqliteDatabase;
	now?: () => number;
	dispose?: () => void | Promise<void>;
}): Store {
	applyStoreSchema(database);

	const index = createIndexDocument();
	let pending: Uint8Array[] = [];
	let poisoned: StoreError | undefined;
	let disposed = false;

	index.on('updateV2', (update: Uint8Array, origin: unknown) => {
		if (origin === hydrationOrigin) return;
		pending.push(copyBytes(update));
	});

	// Attach the listener before hydrating, then replay under an origin the
	// listener ignores, so loading cannot append the same bytes it just read.
	for (const stored of readUpdates(database, INDEX_DOCUMENT)) {
		Y.applyUpdateV2(index, copyBytes(stored.bytes), hydrationOrigin);
	}

	const openDocuments = new Map<
		string,
		{ document: Y.Doc; references: number; stop(): void }
	>();
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
			return persist(() => project());
		}
		return persist(() => {
			for (const update of authored) {
				appendUpdate({
					database,
					history,
					document: documentName,
					update,
					takenAt: now(),
				});
			}
			project();
		});
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
					liveRows(tableName),
				);
			}
		});
		if (rebuildError !== null) return Err(rebuildError);

		const query: QueryMethod = async (strings, ...values) => {
			const unusableNow = requireUsable();
			if (unusableNow !== undefined) return Err(unusableNow);
			return trySync({
				try: () => database.all(strings.join('?'), values),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
		};
		return Ok(Object.freeze({ ...tables, query }) as unknown as Bound);
	}

	function liveRows(tableName: string): Map<string, JsonObject> {
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
		): Result<Row, WriteRowError> {
			const { error } = commit(
				INDEX_DOCUMENT,
				() => writeRow(root, rowId, fields),
				() => projectRow(rowId),
			);
			if (error !== null) return Err(error);
			return readBack(rowId);
		}

		return Object.freeze({
			defaults: table.defaults,
			async create(
				first?: string | JsonObject,
				second?: JsonObject,
			): Promise<Result<Row, WriteRowError>> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const suppliedId = typeof first === 'string' ? first : undefined;
				const input: JsonObject =
					(suppliedId === undefined ? (first as JsonObject | undefined) : second) ??
					{};
				const { data: fields, error } = table.validateWrite(input);
				if (error !== null) return Err(error);
				const rowId = suppliedId ?? mintRowId();
				// The read and the write are not separated by an await, so nothing
				// can land between them.
				if (isLive(root, rowId)) {
					return StoreError.RowExists({ table: tableName, rowId });
				}
				return write(rowId, fields);
			},
			async get(rowId: string): Promise<Result<Row | undefined, ReadRowError>> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const payload = readRow(root, rowId);
				if (payload === undefined) return Ok(undefined);
				return table.project(addressOf(rowId), payload) as Result<
					Row,
					ReadRowError
				>;
			},
			async update(
				rowId: string,
				fields: JsonObject,
			): Promise<Result<Row, WriteRowError>> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				if (!isLive(root, rowId)) {
					return StoreError.RowAbsent({ table: tableName, rowId });
				}
				const { data: validated, error } = table.validateWrite(fields);
				if (error !== null) return Err(error);
				return write(rowId, validated);
			},
			async ensure(
				rowId: string,
				fields: JsonObject = {},
			): Promise<Result<Row, WriteRowError>> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const { data: validated, error } = table.validateWrite(fields);
				if (error !== null) return Err(error);
				if (isLive(root, rowId)) {
					// Already occupied, so supplied fields still land: `ensure` is
					// get-or-create, and creating with fields that then vanish on the
					// second call would be a different verb on the second run.
					return Object.keys(validated).length === 0
						? readBack(rowId)
						: write(rowId, validated);
				}
				return write(rowId, validated);
			},
			async delete(rowId: string): Promise<Result<boolean, StoreError>> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				let removed = false;
				const { error } = commit(
					INDEX_DOCUMENT,
					() => {
						removed = deleteRow(root, rowId);
					},
					() => projectRow(rowId),
				);
				if (error !== null) return Err(error);
				return Ok(removed);
			},
			async ids(): Promise<Result<string[], StoreError>> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				return Ok(listRowIds(root));
			},
			async list() {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const rows: Row[] = [];
				const nonconforming: NonconformingRowError[] = [];
				for (const [rowId, payload] of liveRows(tableName)) {
					const { data, error } = table.project(addressOf(rowId), payload);
					if (error !== null) nonconforming.push(error);
					else rows.push(data as Row);
				}
				return Ok({ rows, nonconforming });
			},
			document: {
				async open(rowId: string): Promise<Result<RowDocument, StoreError>> {
					const unusable = requireUsable();
					if (unusable !== undefined) return Err(unusable);
					if (!isLive(root, rowId)) {
						return StoreError.RowAbsent({ table: tableName, rowId });
					}
					return openRowDocument(rowDocumentName(tableName, rowId));
				},
			},
		}) as TableHandle;
	}

	function openRowDocument(name: string): Result<RowDocument, StoreError> {
		const existing = openDocuments.get(name);
		if (existing !== undefined) {
			existing.references += 1;
			return Ok(handleFor(name, existing.document));
		}
		const document = new Y.Doc({ gc: true });
		const persistDocument = (update: Uint8Array, origin: unknown) => {
			if (origin === hydrationOrigin) return;
			const { error } = persist(() =>
				appendUpdate({
					database,
					history,
					document: name,
					update: copyBytes(update),
					takenAt: now(),
				}),
			);
			if (error !== null) throw error;
		};
		document.on('updateV2', persistDocument);
		const { error } = trySync({
			try: () => {
				for (const stored of readUpdates(database, name)) {
					Y.applyUpdateV2(document, copyBytes(stored.bytes), hydrationOrigin);
				}
			},
			catch: (cause) => StoreError.StorageFailed({ cause }),
		});
		if (error !== null) {
			document.off('updateV2', persistDocument);
			document.destroy();
			return Err(error);
		}
		const entry = {
			document,
			references: 1,
			stop: () => document.off('updateV2', persistDocument),
		};
		openDocuments.set(name, entry);
		return Ok(handleFor(name, document));
	}

	function handleFor(name: string, document: Y.Doc): RowDocument {
		let released = false;
		return {
			get: (root: string, typeName?: string | null) =>
				document.get(root, typeName),
			transact: <T>(run: () => T): T => document.transact(run, localOrigin),
			async [Symbol.asyncDispose]() {
				if (released) return;
				released = true;
				const entry = openDocuments.get(name);
				if (entry === undefined) return;
				entry.references -= 1;
				if (entry.references > 0) return;
				openDocuments.delete(name);
				entry.stop();
				entry.document.destroy();
			},
		};
	}

	// Asserted rather than annotated. Checking this literal against `Store`
	// structurally re-instantiates the generic `bind` against `ValidateLens` and
	// `BoundOf`, which is enough to exceed TypeScript's depth limit (`TS2589`) on
	// its own. The members are individually typed above, so what the assertion
	// gives up is only the whole-object cross-check.
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
			return persist(() => {
				for (const update of authored) {
					appendUpdate({
						database,
						history,
						document: INDEX_DOCUMENT,
						update,
						takenAt: now(),
					});
				}
				rebuildAllProjections();
			});
		},
		hasUnresolvedDependencies: () => hasPendingStructs(index),
		stateVector: () => new Uint8Array(Y.encodeStateVector(index)),
		encodeStateSince: (stateVector?: Uint8Array) =>
			new Uint8Array(Y.encodeStateAsUpdateV2(index, stateVector)),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			for (const entry of openDocuments.values()) {
				entry.stop();
				entry.document.destroy();
			}
			openDocuments.clear();
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
	function rebuildAllProjections(): void {
		for (const [tableName, fieldNames] of projectedTables) {
			rebuildProjectedTable(
				database,
				tableName,
				fieldNames,
				liveRows(tableName),
			);
		}
	}
}
