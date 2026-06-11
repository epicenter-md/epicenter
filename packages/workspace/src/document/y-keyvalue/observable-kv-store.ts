/**
 * # ObservableKvStore
 *
 * The shared contract between `YKeyValueLww` and the encrypted wrapper.
 * both live in `@epicenter/workspace`. Consumers like
 * `createTable` / `createKv` depend on this interface, not on any specific
 * store implementation, so the same helper logic runs over plaintext and
 * encrypted stores alike.
 *
 * ## Why not `LwwStore<T>`?
 *
 * The old name leaked an implementation detail. Nothing in this interface
 * mentions timestamps or conflict-resolution policy; it's just a keyed store
 * that emits change events. "LWW" is how `YKeyValueLww` decides the winner
 * internally, but callers of this interface don't care.
 *
 * ## Entry shape
 *
 * `entries()` yields `[key, KvEntry<T>]` where `KvEntry<T> = { key, val }`.
 * The underlying LWW store stores a wider entry shape (`{ key, val, ts }`),
 * but `ts` is an implementation detail that doesn't cross this boundary.
 */

/** Public entry shape surfaced by `entries()`. */
export type KvEntry<T> = { key: string; val: T };

/** Change event emitted by the store's observer. */
export type KvStoreChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; newValue: T }
	| { action: 'delete' };

/** Signature of an observer registered via `observe()`. */
export type KvStoreChangeHandler<T> = (
	changes: Map<string, KvStoreChange<T>>,
	origin: unknown,
) => void;

/**
 * Observable, bulk-capable keyed store.
 *
 * Implemented by `YKeyValueLww` (unencrypted) and the encrypted wrapper in
 * `@epicenter/workspace`. `createTable` / `createKv` consume this interface
 * so they can wrap either backend without branching.
 */
export interface ObservableKvStore<T> {
	get(key: string): T | undefined;
	set(key: string, val: T): void;
	has(key: string): boolean;
	delete(key: string): void;
	bulkSet(entries: Array<KvEntry<T>>): void;
	bulkDelete(keys: string[]): void;
	observe(handler: KvStoreChangeHandler<T>): void;
	unobserve(handler: KvStoreChangeHandler<T>): void;
	entries(): IterableIterator<[string, KvEntry<T>]>;
	readonly size: number;
}
