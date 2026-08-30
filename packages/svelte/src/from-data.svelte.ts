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
 * Verbs not named here (`create`, `update`, `delete`, `content`, `stored`,
 * `subscribe`) pass through the spread untouched. A read verb the store grows
 * later must either be added here or be given a line in the module doc above
 * saying why it is better off untracked; silence is how `content` and `stored`
 * both arrived without anyone deciding.
 */
type AdaptableTable = {
	list(): { rows: unknown[]; nonconforming: unknown[] };
	get(rowId: string): unknown;
	ids(): string[];
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
 * One table, same verbs and types, reads reactive, plus `rows` and
 * `nonconforming` so a template does not destructure `list()` to iterate.
 */
export type ReactiveTable<TTable extends AdaptableTable> = TTable & {
	/** Reactive `list().rows`: every row this declaration reads whole. */
	readonly rows: ReturnType<TTable['list']>['rows'];
	/** Reactive `list().nonconforming`: rows stored here that this declaration cannot read. */
	readonly nonconforming: ReturnType<TTable['list']>['nonconforming'];
};

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
	// exactly that phase). The handle's
	// `list()` is a walk over a document already in memory and builds fresh
	// arrays per call either way, so a read-through is the store's own
	// contract; this adapter adds tracking, never a second copy of the data.
	const subscribe = createSubscriber((update) => table.subscribe(update));
	function list(): ReturnType<TTable['list']> {
		subscribe();
		return table.list() as ReturnType<TTable['list']>;
	}
	return Object.freeze({
		...table,
		list,
		get rows() {
			return list().rows;
		},
		get nonconforming() {
			return list().nonconforming;
		},
		get: (rowId: string) => {
			subscribe();
			return table.get(rowId);
		},
		ids: () => {
			subscribe();
			return table.ids();
		},
	}) as ReactiveTable<TTable>;
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
