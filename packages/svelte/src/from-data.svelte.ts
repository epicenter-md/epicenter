/**
 * A Svelte 5 reactivity adapter over one opened data handle's declared shape.
 *
 * `fromData(data)` mirrors the declaration exactly: `tables.<name>` and
 * `kv`, with the names and row types the definition declares, plus
 * `persistence`. It earns its existence by adding reactivity, not by renaming
 * anything, and the rule is one sentence: every read verb tracks its own
 * invalidation signal, and every write verb passes through unchanged.
 *
 * Reads track. `rows`, `nonconforming`, and `get()` read
 * through a `createSubscriber` per table, so a read inside `$derived` or an
 * effect re-runs when a commit touches that table, whoever committed it: a
 * local write and bytes that arrived from another device alike (ADR-0221).
 * A row's `content` node is not made reactive by this adapter, deliberately. It
 * carries its own field-scoped `subscribe` (ADR-0296): an editor binds the type
 * directly and hears every keystroke, local or remote, without a table signal in
 * the path. Routing it through this adapter's per-table subscriber would fire
 * the whole list on every character. `stored()` is not made reactive either, and for the opposite reason: its
 * caller is a mirror rendering files off its own commit subscription, and it
 * has no template that would track.
 *
 * Writes pass through. `create`, `update`, and `delete` are the store's own
 * synchronous verbs, untouched; the commit they make is what fires the
 * invalidation the reads are subscribed to, so there is no second write path
 * and no cache to tell.
 *
 * Lazy by construction. Wrapping subscribes to nothing: a table's store
 * subscription attaches when the first effect reads it and detaches when the
 * last stops, because `createSubscriber` ref-counts subscription to effect
 * usage. A declared table no surface reads costs nothing, and the store's own
 * per-table delta hook (which is also subscription-counted) stays off too.
 * That ref-counting is the whole lifecycle: there is nothing to dispose here,
 * and the raw runtime keeps ownership of opening, sync attachment, and
 * disposal. Network operations stay on the raw plane on purpose: a reactive
 * wrapper must not pretend a rebuild or a reconnect is local state.
 *
 * One instance per opened data object, owned by whoever opened it, usually a
 * root component that provides it through context. Never a module-global
 * singleton: the data it wraps is one auth generation's document, and the
 * next generation opens its own.
 *
 * Every read is a read-through: a fresh walk over the document already in
 * memory, never a cached copy. The store flushes a commit in phases (public
 * `onCommitted` listeners before table invalidations), so any snapshot this
 * adapter kept would be observably stale to an `onCommitted` reader; holding
 * no copy makes every phase, every event handler, and every effect read the
 * same current rows. `$derived` over `rows` still memoizes its own result,
 * which is where filtering and sorting belong.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   const honeycrisp = fromData(data);
 *   const notes = honeycrisp.tables.notes;
 *   const active = $derived(notes.rows.filter((n) => n.deletedAt === null));
 * </script>
 * <button onclick={() => notes.create({ title: '' })}>New</button>
 * {#each active as note (note.id)}...{/each}
 * ```
 */

import { createSubscriber, SvelteMap } from 'svelte/reactivity';

/**
 * The slice of `@epicenter/data`'s `TableHandle` this adapter touches: the
 * read verbs it makes reactive, and the invalidation feed it rides.
 *
 * Structural rather than imported, and that is a variance requirement, not a
 * dropped dependency edge. A typed handle narrows `create` and `update` to
 * the table's own input type, so it is not assignable to the untyped
 * `TableHandle`; constraining on the shared read surface accepts every typed
 * handle while `ReactiveTable<TTable>` preserves the caller's exact type.
 *
 * **Every reactive read verb is here.** `create`, `update`, `delete`, `watch` and
 * `subscribe` pass through the spread untouched; they are writes or their own
 * feeds. The row's live `content` node is intentionally a direct row property,
 * not a second table read surface.
 */
type AdaptableTable = {
	readonly rows: unknown[];
	readonly nonconforming: unknown[];
	ids(): string[];
	get(rowId: string): unknown;
	subscribe(listener: (rowIds: readonly string[]) => void): () => void;
	watch(type: never, listener: () => void): () => void;
};

/** The slice of `KvHandle` the adapter touches: its reads, and one feed. */
type AdaptableKv = {
	get(key: never): unknown;
	readonly nonconforming: unknown[];
	subscribe(listener: () => void): () => void;
};

/**
 * The persistence status feed: a read and the signal that invalidates it.
 *
 * Structural like the rest, and a SLICE: `flush()` is not named here because
 * this adapter does not touch it, and `ReactiveData` hands back the caller's
 * own type, so it survives.
 */
type AdaptablePersistence = {
	get(): unknown;
	subscribe(listener: () => void): () => void;
};

/**
 * What `fromData` needs from opened data: the declared view, plus the one
 * store capability that is shaped like one.
 *
 * `persistence` is the single thing here that is not the declaration. It earns
 * the exception the same way tables and kv do: a `get()` and a `subscribe()`
 * that already dedupes by value, reporting local state about this document.
 * Every application that renders it would otherwise hand-roll the identical
 * `$state.raw` plus `$effect`, which is the definition of a missing adapter
 * property rather than a pattern to teach.
 *
 * The boundary that stays is the one about MEANING, not about ownership: sync
 * is a fact about a socket somewhere else, and its status is a pull-only
 * getter that a consumer has to poll, so this adapter cannot hold it honestly
 * and does not pretend to.
 */
type AdaptableData = {
	tables: Record<string, AdaptableTable>;
	kv: AdaptableKv;
	transact<TResult>(run: () => TResult): TResult;
	persistence: AdaptablePersistence;
};

/**
 * One table, same verbs and types, reads reactive.
 *
 * Nothing is added any more. `rows` and `nonconforming` are the store's own
 * reads, so this wraps rather than extends.
 */
export type ReactiveTable<TTable extends AdaptableTable> = TTable;

/**
 * The declared shape of one opened data handle, made Svelte-reactive.
 *
 * The table names pass through unchanged at both levels: `keyof` at compile
 * time, `Object.entries` at runtime.
 */
export type ReactiveData<TData extends AdaptableData> = {
	readonly tables: {
		readonly [TName in keyof TData['tables']]: ReactiveTable<
			TData['tables'][TName]
		>;
	};
	/** Same `KvHandle`, with `get()` reactive. */
	readonly kv: TData['kv'];
	/**
	 * Passed straight through. Grouping writes has nothing to do with
	 * reactivity: the commit it produces invalidates through the same table
	 * subscriptions a single write does, once instead of once per write.
	 */
	transact: TData['transact'];
	/**
	 * The same capability, with `get()` reactive. `flush()` and `subscribe()`
	 * pass through.
	 *
	 * Read it and render the answer; do not mirror it. The store is already the
	 * one place this fact lives, and a second copy in application state is the
	 * shape that has to be kept in step with the first.
	 */
	readonly persistence: TData['persistence'];
};

/** Adapt one opened data handle's `tables` and `kv` into Svelte reactivity. */
export function fromData<TData extends AdaptableData>(
	data: TData,
): ReactiveData<TData> {
	return Object.freeze({
		tables: Object.freeze(
			Object.fromEntries(
				Object.entries(data.tables).map(([name, table]) => [
					name,
					reactiveTable(table),
				]),
			),
		),
		kv: reactiveKv(data.kv),
		transact: data.transact,
		persistence: reactivePersistence(data.persistence),
	}) as ReactiveData<TData>;
}

/**
 * One persistence capability, `get()` reactive.
 *
 * The store notifies only on a CHANGE (`persistence.ts` compares against the
 * last status before telling anyone), so a thousand failed flushes in a row
 * wake a reader once. That is what makes rendering the status directly
 * cheaper than reacting to it: there is no event stream to debounce, only a
 * value to display.
 */
function reactivePersistence<TPersistence extends AdaptablePersistence>(
	persistence: TPersistence,
): TPersistence {
	const subscribe = createSubscriber((update) => persistence.subscribe(update));
	// Descriptors for the same reason a table needs them, and it is not
	// hypothetical here either: a capability may carry getters, and a spread
	// would invoke them at wrap time.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(persistence),
				get: {
					enumerable: true,
					value: () => {
						subscribe();
						return persistence.get();
					},
				},
			},
		),
	) as TPersistence;
}

/**
 * One table, held as a live projection of its rows.
 *
 * A row is CRDT structs until somebody builds a plain object out of it, and
 * building one costs about two microseconds. Reading `rows` builds every one
 * of them, so a list over ten thousand notes pays twenty milliseconds to
 * discover that one note moved. This holds what it built and rebuilds only
 * what the commit named.
 *
 * **Seeded here, never during a read.** An application reads `rows` inside
 * `$derived`, and writing Svelte state from there is `state_unsafe_mutation`.
 * Filling the map lazily on first read is therefore not available, which is
 * why this is eager and why `fromData` is no longer free to call.
 *
 * **Never torn down.** The subscription is held for the life of the wrapper
 * rather than ref-counted to readers, because a projection that stops being
 * maintained is stale rather than free: the object survives, the updates stop,
 * and the next reader is served rows from before it looked away. It dies with
 * the document it mirrors, which is the only lifetime that fits a cache.
 *
 * A `SvelteMap` rather than a plain one, and that is the reactivity: reading a
 * key tracks that key, iterating tracks all of them, so a list wakes on any
 * change while a component reading one row wakes only for that row. Nothing
 * here calls `createSubscriber`; the map IS the signal.
 *
 * `nonconforming` passes through and is NOT tracked. Rows this release cannot
 * read are absent from the projection by construction, so there is nothing
 * here to keep current, and the getter still answers correctly whenever it is
 * asked.
 */
function reactiveTable<TTable extends AdaptableTable>(
	table: TTable,
): ReactiveTable<TTable> {
	const rows = new SvelteMap<string, unknown>();
	for (const rowId of table.ids()) {
		const row = table.get(rowId);
		if (row !== undefined) rows.set(rowId, row);
	}

	table.subscribe((rowIds) => {
		for (const rowId of rowIds) {
			const row = table.get(rowId);
			if (row === undefined) rows.delete(rowId);
			else rows.set(rowId, row);
		}
	});

	// Descriptors, not a spread. `rows` and `nonconforming` are GETTERS on the
	// handle, and `{ ...table }` would invoke them: wrapping a table would walk
	// every row once, before anything had read anything.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(table),
				rows: {
					enumerable: true,
					get() {
						return [...rows.values()];
					},
				},
				get: {
					enumerable: true,
					value: (rowId: string) => rows.get(rowId),
				},
			},
		),
	) as ReactiveTable<TTable>;
}

function reactiveKv<TKv extends AdaptableKv>(kv: TKv): TKv {
	// No snapshot cache, unlike a table: KV is one small object, not an N-row
	// walk feeding keyed iteration, so a fresh read per access is the simpler
	// honest shape.
	const subscribe = createSubscriber((update) => kv.subscribe(update));
	// Descriptors for the same reason a table needs them: `nonconforming` is a
	// getter, and a spread would invoke it.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(kv),
				get: {
					enumerable: true,
					value: (key: never) => {
						subscribe();
						return kv.get(key);
					},
				},
				nonconforming: {
					enumerable: true,
					get() {
						subscribe();
						return kv.nonconforming;
					},
				},
			},
		),
	) as TKv;
}
