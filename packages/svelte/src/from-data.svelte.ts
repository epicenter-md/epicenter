/**
 * A Svelte 5 reactivity adapter over one opened data handle's declared shape.
 *
 * `fromData(data)` mirrors the declaration exactly: `tables.<name>` and
 * `kv`, with the names and row types the definition declares. It earns its
 * existence by adding reactivity, not by renaming anything, and the rule is
 * one sentence: every read verb tracks the table's invalidation signal, and
 * every write verb passes through unchanged.
 *
 * Reads track. `list()`, `rows`, `nonconforming`, `get()`, and `ids()` read
 * through a `createSubscriber` per table, so a read inside `$derived` or an
 * effect re-runs when a commit touches that table, whoever committed it: a
 * local write and bytes that arrived from another device alike (ADR-0221).
 * `content()` is not one of them, deliberately. It hands back the row's live
 * nested Yjs types, which carry their own field-scoped `subscribe` (ADR-0296):
 * an editor binds the type directly and hears every keystroke, local or
 * remote, without a table signal in the path. Routing it through this
 * adapter's per-table subscriber would fire the whole list on every character.
 * `stored()` is not made reactive either, and for the opposite reason: its
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

import { createSubscriber } from 'svelte/reactivity';

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
 * **Every read verb is here, and that is now a rule the handle can keep.**
 * `create`, `update`, `delete`, `watch` and `subscribe` pass through the spread
 * untouched; they are writes or their own feeds. Nothing else is left. The
 * store used to carry `content`, `stored` and `ids` beside these, none of which
 * this adapter tracked and two of which an application could reach — which is
 * how two Skills editors came to wrap a non-reactive `content()` in `$derived`
 * and render nothing when a row arrived late. Those verbs are off the public
 * handle now, so "on the handle" and "reactive" mean the same thing.
 */
type AdaptableTable = {
	readonly rows: unknown[];
	readonly nonconforming: unknown[];
	get(rowId: string): unknown;
	subscribe(listener: () => void): () => void;
};

/** The slice of `KvHandle` the adapter touches: one read verb, one feed. */
type AdaptableKv = {
	get(): unknown;
	subscribe(listener: () => void): () => void;
};

/** What `fromData` needs from opened data: the declared view, no store. */
type AdaptableData = {
	tables: Record<string, AdaptableTable>;
	kv: AdaptableKv;
};

/**
 * One table, same verbs and types, reads reactive.
 *
 * Nothing is added any more. `rows` and `nonconforming` used to be this
 * adapter's own inventions over `list()`, because a template should not
 * destructure a tuple to iterate; the store grew them, so this wraps rather
 * than extends.
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
	}) as ReactiveData<TData>;
}

function reactiveTable<TTable extends AdaptableTable>(
	table: TTable,
): ReactiveTable<TTable> {
	// No snapshot cache, deliberately. The store flushes a commit in phases:
	// public `onCommitted` listeners run first, table invalidations after, so
	// a cache invalidated by the table subscription would still serve
	// pre-commit rows to an `onCommitted` reader (a composed follower reads in
	// exactly that phase). The handle's `rows` is a walk over a document already
	// in memory and builds a fresh array per access either way, so a
	// read-through is the store's own contract; this adapter adds tracking,
	// never a second copy of the data.
	const subscribe = createSubscriber((update) => table.subscribe(update));
	// Descriptors, not a spread. `rows` and `nonconforming` are GETTERS on the
	// handle, and `{ ...table }` would invoke them: wrapping a table would walk
	// every row once, before anything had read anything. `from-data.svelte.test`
	// caught exactly that, which is what "wrapping subscribes to nothing and
	// reads nothing" is there to hold.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(table),
				rows: {
					enumerable: true,
					get() {
						subscribe();
						return table.rows;
					},
				},
				nonconforming: {
					enumerable: true,
					get() {
						subscribe();
						return table.nonconforming;
					},
				},
				get: {
					enumerable: true,
					value: (rowId: string) => {
						subscribe();
						return table.get(rowId);
					},
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
	return Object.freeze({
		...kv,
		get: () => {
			subscribe();
			return kv.get();
		},
	}) as TKv;
}
