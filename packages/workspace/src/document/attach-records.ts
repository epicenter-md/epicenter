/**
 * attachRecords(): make a row's child document a keyed bag of finished records.
 *
 * This is a child-doc body layout, the third shape alongside {@link attachRichText}
 * (a `Y.XmlFragment` body) and {@link attachPlainText} (a `Y.Text` body): where
 * those make the body prose, this makes it a collection of whole JSON records
 * keyed by id. All three are `(ydoc) => handle` functions handed to a table's
 * `.docs({ field })`.
 *
 * The store underneath is a {@link YKeyValueLww}, the one keyed last-write-wins
 * bag this package is built on. A table (`createTable`) and the KV slot
 * (`createKv`) are the other two lenses over that same substrate; this is the
 * lens with no column schema, no migration, and no materializer: just an open,
 * homogeneous keyset of one type `T`. Reserves `ydoc.getArray(key)` (default
 * `'entries'`); each key maps to one complete value, concurrent writes to the
 * same key resolve last-write-wins by timestamp, and storage scales with live
 * data rather than history (gc compacts overwrites and deletes). The Y types
 * stay inside the handle; callers see plain objects in, plain objects out.
 *
 * Use it when a row's document is a keyed bag of complete records rather than a
 * streamed body. Each value is written once, whole, the way a server would
 * persist a finished record:
 *
 * ```ts
 * defineTable({ id: field.string() })
 *   .docs({ items: (ydoc) => attachRecords<Item>(ydoc) });
 * // then tables.X.docs.items.open(rowId) returns this handle, keyed by item id.
 * ```
 *
 * Handle-style attachment: synchronous, no async teardown. Destroying the Y.Doc
 * disposes the underlying store and releases the array.
 */
import type * as Y from 'yjs';
import type { KvEntry } from './y-keyvalue/observable-kv-store.js';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/y-keyvalue-lww.js';

/**
 * The typed surface {@link attachRecords} returns over a child doc: the minimal
 * append-and-observe seam its one consumer, the agent loop, actually uses. The
 * backing {@link YKeyValueLww} can also read by key (`get`) and remove
 * (`delete`), but no consumer does, so the handle does not advertise them; a
 * future by-id reader would widen this type alongside a live caller.
 */
export type RecordsHandle<T> = {
	/** Write the complete value under `key`, overwriting any previous one. */
	set(key: string, value: T): void;
	/** Walk every stored value as a `{ key, val }` pair. */
	entries(): IterableIterator<KvEntry<T>>;
	/**
	 * Register a change handler and get back the function that removes it. The
	 * handler fires once per transaction, for local writes and synced remote ones
	 * alike, and carries no payload: a consumer re-reads {@link entries} to
	 * refresh. The underlying store computes a change set, but the only consumer of
	 * this handle (the agent loop) re-reads wholesale, so the seam is a bare change
	 * signal.
	 */
	observe(handler: () => void): () => void;
};

/**
 * Attach a key-value store to `ydoc` at `key` (default `'entries'`).
 *
 * @param ydoc - Y.Doc to attach to
 * @param key  - name of the `Y.Array` slot that backs the store
 */
export function attachRecords<T>(
	ydoc: Y.Doc,
	key = 'entries',
): RecordsHandle<T> {
	const store = new YKeyValueLww<T>(ydoc.getArray<YKeyValueLwwEntry<T>>(key));
	ydoc.once('destroy', () => store[Symbol.dispose]());
	return {
		set: (k, value) => store.set(k, value),
		entries: () => store.entries(),
		observe: (handler) => store.observe(handler),
	};
}
