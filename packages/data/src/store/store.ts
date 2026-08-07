import type { JsonObject, JsonValue } from '@epicenter/lens';
import {
	type CreateInputOf,
	KV_ROOT,
	type KvOf,
	type LensJson,
	type LensParseError,
	type NonconformingRowError,
	type ParsedLens,
	type ParsedTable,
	parseLens,
	type RowOf,
	RowWriteError,
} from '@epicenter/lens/lens';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	createIndexDocument,
	deleteRow,
	documentContainer,
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
	 * const { data, error } = db.settings.get(id);
	 * const row = data ?? { ...db.settings.defaults, ...error?.conforming };
	 * ```
	 */
	readonly defaults: Readonly<JsonObject>;
	/**
	 * Bring one row into being, at a minted id.
	 *
	 * There is no door for a chosen id, and that is a correctness decision. A row
	 * is a nested container addressed by the struct that created it, so two
	 * devices creating one address produce two containers and map LWW discards
	 * one along with every field in it. A 24-character minted id makes that
	 * unreachable rather than merely unlikely. Anything an application wants to
	 * name goes in `kv`, which lives at a name-addressed root.
	 */
	create(fields: JsonObject): Result<Row, WriteRowError>;
	/**
	 * The one read verb.
	 *
	 * `Ok(undefined)` means the address holds no live row, which is a fact rather
	 * than a failure. `Err(Nonconforming)` carries `conforming`, so a caller
	 * composes whatever forgiveness it wants without a second verb existing.
	 */
	get(rowId: string): Result<Row | undefined, ReadRowError>;
	/**
	 * Merge fields into a live row. Refuses an absent address.
	 *
	 * `update` rather than `set`, because only the fields handed in are touched
	 * and every other field is left alone.
	 */
	update(rowId: string, fields: JsonObject): Result<Row, WriteRowError>;
	delete(rowId: string): Result<boolean, StoreError>;
	/** Every live row id, sorted. */
	ids(): Result<string[], StoreError>;
	/**
	 * Every live row, with the ones this lens cannot read reported separately
	 * rather than dropped or repaired.
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
 * Read-only SQL over one application's own projection.
 *
 * On the binding rather than on the store, so an application reaches only its
 * own namespace. `query` is a reserved table name for exactly this reason: a
 * table becomes a key on the same handle that carries the method.
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
			create(fields: TInput): Result<TRow, WriteRowError>;
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
};

/** The untyped view, for a lens that arrived as data rather than as a literal. */
export type Bound = Record<string, TableHandle> & {
	query: QueryMethod;
	kv: KvHandle;
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
		const { error } = persist(() =>
			appendUpdate({
				database,
				history,
				document: INDEX_DOCUMENT,
				update: copyBytes(update),
				takenAt: now(),
			}),
		);
		if (error !== null) throw error;
	});

	// Attach the listener before hydrating, then replay under an origin the
	// listener ignores, so loading cannot append the same bytes it just read.
	for (const stored of readUpdates(database, INDEX_DOCUMENT)) {
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

		const kv = createKvHandle(lens);

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
	 * The reserved root is minted here, which is safe for the same reason KV
	 * lives there at all: `Doc.get` is `setIfUndefined` on `doc.share`, so every
	 * device that mints `!kv` converges on one logical root.
	 *
	 * A lens with no `kv` section still gets a handle. It reads as an empty
	 * object and refuses every write by name, which is a better answer than a
	 * missing property that a caller has to feel for.
	 */
	function createKvHandle(lens: ParsedLens): KvHandle {
		const table = lens.kv;
		const root = tableTypeFor(KV_ROOT);
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

		function readBack(): Result<JsonObject, ReadRowError> {
			if (table === undefined) return Ok({});
			const projected = table.project(address, readStored());
			if (projected.error !== null) return Err(projected.error);
			// `project` adds the structural id a row has and KV does not.
			const { id: _id, ...values } = projected.data;
			return Ok(values);
		}

		return Object.freeze({
			defaults: table?.defaults ?? Object.freeze({}),
			get() {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				return readBack();
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
					INDEX_DOCUMENT,
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
		}) as KvHandle;
	}

	function tableTypeFor(name: string): Y.Type {
		return tableRoot(index, name);
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
			create(fields: JsonObject): Result<Row, WriteRowError> {
				const unusable = requireUsable();
				if (unusable !== undefined) return Err(unusable);
				const { data: validated, error } = table.validateWrite(fields);
				if (error !== null) return Err(error);
				return write(mintRowId(), validated);
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
				if (!isLive(root, rowId)) {
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
					INDEX_DOCUMENT,
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
				for (const [rowId, payload] of liveRows(tableName)) {
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
