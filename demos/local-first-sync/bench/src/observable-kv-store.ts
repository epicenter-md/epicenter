/**
 * # ObservableKvStore
 *
 * The shared contract between `YKeyValueLww` and consumers like
 * `createTable` / `createKv`.
 *
 * ## Why not `LwwStore<T>`?
 *
 * The old name leaked an implementation detail. Nothing in this interface
 * mentions timestamps or conflict-resolution policy; it's just a keyed store
 * that emits change events. "LWW" is how `YKeyValueLww` decides the winner
 * internally, but callers of this interface don't care.
 *
 * ## Read Shape
 *
 * A plaintext store can only surface a value or no value. `get(key)` returns
 * that value or `undefined`; `has(key)` is `get(key) !== undefined`; `entries()`
 * walks the stored values as `{ key, val }`.
 *
 * ## Write shape
 *
 * `bulkSet()` takes `KvEntry<T> = { key, val }`. The underlying LWW store keeps
 * a wider shape (`{ key, val, ts }`), but `ts` is an implementation detail that
 * doesn't cross this boundary.
 */

/** Key/value pair accepted by `bulkSet()`. */
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
 * Observable, bulk-capable keyed store. Implemented by `YKeyValueLww`.
 */
export type ObservableKvStore<T> = {
	/** The value stored under `key`, or `undefined` when it is absent. */
	get(key: string): T | undefined;
	set(key: string, val: T): void;
	/** Whether a stored value is present under `key`. Equivalent to `get(key) !== undefined`. */
	has(key: string): boolean;
	delete(key: string): void;
	bulkSet(entries: Array<KvEntry<T>>): void;
	bulkDelete(keys: string[]): void;
	/**
	 * Register a change handler and get back the function that removes it. The
	 * store hands out its own unsubscribe rather than a separate `unobserve(h)`
	 * the caller has to pair by hand: every consumer wraps observation in a
	 * disposer, so the disposer is the contract.
	 */
	observe(handler: KvStoreChangeHandler<T>): () => void;
	/** Walk every stored value as a `{ key, val }` pair. */
	entries(): IterableIterator<KvEntry<T>>;
	/** Number of observer-confirmed stored entries after conflict resolution. */
	readonly size: number;
};
