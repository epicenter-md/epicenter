/**
 * `createDisposableCache`: refcounted cache for disposable resources.
 *
 * ## What it does
 *
 * Maps an id to a single shared instance, tracks how many consumers are
 * currently using it, and tears it down (calls `[Symbol.dispose]()` on the
 * underlying value) a configurable grace period after the last consumer
 * leaves.
 *
 * Same id, same underlying instance. Different handles, shared state.
 *
 * ## Why it exists
 *
 * Three coupled problems show up whenever a resource is expensive to build,
 * stateful, and shared across UI surfaces:
 *
 * 1. **Concurrent consumers of the same id must share ONE instance.**
 *    Otherwise local state diverges. Two editors mounted on the same Y.Doc
 *    would only see each other's edits after a sync round-trip. A media
 *    player and a waveform view of the same audio file would each hold a
 *    decoder and double the memory.
 *
 * 2. **Sequential mount/unmount shouldn't rebuild expensive resources.**
 *    Route swaps, hot module reload, conditional rendering, split-pane
 *    close-then-reopen all produce rapid open/close/open sequences within
 *    milliseconds. `gcTime` keeps the instance alive briefly so the next
 *    `open` reuses it.
 *
 * 3. **Page exit / workspace teardown needs explicit disposal.** The cache
 *    itself is `Disposable`; `cache[Symbol.dispose]()` flushes every entry
 *    synchronously.
 *
 * Y.Docs are the most common case in this codebase. Audio decoders, worker
 * connections, MediaStreams, and native window handles fit the same shape
 * and should use this primitive rather than reinventing refcount + grace.
 *
 * ## Quick mental model
 *
 * ```ts
 * const cache = createDisposableCache(
 *   (id: string) => {
 *     const ydoc = new Y.Doc({ guid: id });
 *     return {
 *       ydoc,
 *       [Symbol.dispose]() { ydoc.destroy(); },
 *     };
 *   },
 *   { gcTime: 5_000 },
 * );
 *
 * const a = cache.open('doc-1');     // build runs; refcount 0 to 1
 * const b = cache.open('doc-1');     // cache hit; refcount 1 to 2
 *
 * // a and b are different handle objects, but they share the same
 * // underlying state via nested references:
 * a.ydoc === b.ydoc                  // true
 *
 * a[Symbol.dispose]();               // refcount 2 to 1
 * b[Symbol.dispose]();               // refcount 1 to 0; 5s grace timer armed
 *
 * // Within 5s, cache.open('doc-1') cancels the timer and reuses the
 * // same Y.Doc. After 5s with no reopen, the Y.Doc is destroyed and
 * // removed from the cache.
 *
 * cache[Symbol.dispose]();           // force-flush everything
 * ```
 *
 * Disposing the same handle twice is a no-op. If `build` throws, no entry
 * is stored and the next `open(sameId)` retries cleanly.
 *
 * ## How to use it from a UI framework
 *
 * The intended pattern: instantiate the cache once at module level, then
 * open in your reactive effect and dispose in cleanup. The cache handles
 * deduplication, grace periods, and teardown for you. Two components
 * mounting on the same id share one underlying value, so mutations made
 * through one component's handle are immediately visible through the other.
 *
 * ```ts
 * // Svelte 5
 * $effect(() => {
 *   const handle = cache.open(documentId);
 *   return () => handle[Symbol.dispose]();
 * });
 *
 * // React
 * useEffect(() => {
 *   const handle = cache.open(documentId);
 *   return () => handle[Symbol.dispose]();
 * }, [documentId]);
 *
 * // Vue 3
 * watchEffect((onCleanup) => {
 *   const handle = cache.open(documentId);
 *   onCleanup(() => handle[Symbol.dispose]());
 * });
 * ```
 *
 * Outside reactive contexts, `using` syntax is the cleanest match for the
 * `Disposable` shape. `open()` is synchronous:
 *
 * ```ts
 * function readDoc(id: string) {
 *   using handle = cache.open(id);
 *   return handle.ydoc.getMap('root').toJSON();
 * }
 * // handle disposed at scope exit; grace timer armed
 * ```
 *
 * If the returned value exposes readiness, await that field after opening:
 * `using handle = cache.open(id); await handle.whenReady;`.
 *
 * ## Constraint: `T` must be a plain object
 *
 * The handle is built by spreading the value's own enumerable properties:
 * `{ ...value, [Symbol.dispose]: ... }`. Spread doesn't copy prototype
 * methods, so a class instance returned directly will lose every method
 * that lives on its prototype.
 *
 * ```ts
 * // BAD: methods on Y.Doc.prototype (transact, getMap, on, ...) are LOST
 * createDisposableCache((id) => new Y.Doc({ guid: id }));
 * // handle.transact === undefined
 *
 * // GOOD: nest the class instance as a named field
 * createDisposableCache((id) => {
 *   const ydoc = new Y.Doc({ guid: id });
 *   return {
 *     ydoc,
 *     [Symbol.dispose]() { ydoc.destroy(); },
 *   };
 * });
 * // handle.ydoc.transact(() => { ... }) works
 * ```
 *
 * ## What this primitive does NOT do
 *
 * - **No async builder.** Construction is synchronous. If your `T` needs
 *   async readiness, expose a `whenReady: Promise<unknown>` field on it;
 *   the cache stays sync, readiness is a value-level concern.
 * - **No max size / LRU eviction.** Out of scope; add when needed.
 * - **No per-id force-close.** One way to release a handle: dispose it.
 *   Two ways means call sites that mismatch open/close. (`whenReleased(id)`
 *   only *observes* a release; it never triggers one.)
 * - **No subscriptions / change events.** Just construct, share, dispose.
 *
 * @module
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';

/** Errors surfaced by the cache's background disposal machinery. */
const DisposableCacheError = defineErrors({
	/**
	 * The user-supplied value's `[Symbol.dispose]` raised. The entry is already
	 * removed from the cache; the throw is informational.
	 */
	ValueDisposeThrew: ({ cause }: { cause: unknown }) => ({
		message: `[createDisposableCache] value [Symbol.dispose]() threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type DisposableCacheError = InferErrors<typeof DisposableCacheError>;

/**
 * Refcounted cache returned by `createDisposableCache`. Itself `Disposable`:
 * `cache[Symbol.dispose]()` flushes every entry immediately.
 */
export type DisposableCache<
	TId extends string | number,
	TValue extends Disposable,
> = ReturnType<typeof createDisposableCache<TId, TValue>>;

type CacheEntry<TValue extends Disposable> = {
	value: TValue;
	openCount: number;
	gcTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
	/** Resolvers for `whenReleased(id)` callers awaiting this entry's teardown. */
	releaseWaiters: Array<() => void>;
};

/**
 * Create a refcounted cache for disposable resources.
 *
 * @param build - Closure invoked on cache miss. Returns a disposable value.
 *                Runs synchronously; if it throws, the cache is unchanged
 *                (next `open(sameId)` re-runs the closure; no poisoned entry).
 * @param opts  - `gcTime` (default `5_000`ms): milliseconds to wait after the
 *                refcount reaches zero before tearing down the underlying value.
 *                `0` = synchronous teardown, no timer. `Infinity` = never
 *                auto-evict; only `cache[Symbol.dispose]()` can force teardown.
 *                A fresh `open` during the grace window cancels the pending
 *                teardown.
 */
export function createDisposableCache<
	TId extends string | number,
	TValue extends Disposable,
>(
	build: (id: TId) => TValue,
	{
		gcTime = 5_000,
		log = createLogger('createDisposableCache'),
	}: { gcTime?: number; log?: Logger } = {},
) {
	const entries = new Map<TId, CacheEntry<TValue>>();

	function disposeEntry(id: TId, entry: CacheEntry<TValue>): void {
		entry.disposed = true;
		if (entry.gcTimer !== null) {
			clearTimeout(entry.gcTimer);
			entry.gcTimer = null;
		}
		// Remove from cache synchronously so a concurrent `open()` constructs a
		// fresh entry rather than handing out the about-to-be-destroyed one.
		if (entries.get(id) === entry) {
			entries.delete(id);
		}
		try {
			entry.value[Symbol.dispose]();
		} catch (cause) {
			log.error(DisposableCacheError.ValueDisposeThrew({ cause }));
		}
		// Wake `whenReleased(id)` callers. `[Symbol.dispose]` ran synchronously
		// above, so the underlying teardown (e.g. `ydoc.destroy()`) has been
		// invoked before any waiter resumes.
		const waiters = entry.releaseWaiters;
		entry.releaseWaiters = [];
		for (const resolve of waiters) resolve();
	}

	const cache = {
		/**
		 * Open a handle. Increments the refcount for `id`. The returned handle is
		 * a fresh object built by spreading the underlying `T`'s own enumerable
		 * properties, plus its own `[Symbol.dispose]` that decrements *this
		 * handle's* refcount. It does NOT destroy the underlying `T` directly.
		 * The underlying `T[Symbol.dispose]()` is called once, by the cache, when
		 * the refcount reaches zero after `gcTime`.
		 *
		 * Each call returns a distinct handle (so `a !== b`), but their nested
		 * fields share references (so `a.ydoc === b.ydoc`). N opens require N
		 * disposes.
		 */
		open(id: TId) {
			let entry = entries.get(id);
			if (entry === undefined) {
				// User closure runs synchronously. If it throws, we DON'T insert
				// into the cache; next `open(sameId)` re-runs the closure (no
				// poisoned entry). The caller sees the thrown error.
				const value = build(id);
				entry = {
					value,
					openCount: 0,
					gcTimer: null,
					disposed: false,
					releaseWaiters: [],
				};
				entries.set(id, entry);
			}

			if (entry.gcTimer !== null) {
				clearTimeout(entry.gcTimer);
				entry.gcTimer = null;
			}
			entry.openCount++;

			let handleDisposed = false;
			const dispose = (): void => {
				if (handleDisposed) return;
				handleDisposed = true;
				if (entry.disposed) return;
				entry.openCount--;
				if (entry.openCount !== 0) return;

				if (gcTime === 0) {
					disposeEntry(id, entry);
					return;
				}
				if (gcTime === Number.POSITIVE_INFINITY) {
					// Never auto-evict; entry stays live until cache[Symbol.dispose]().
					return;
				}
				entry.gcTimer = setTimeout(() => {
					entry.gcTimer = null;
					disposeEntry(id, entry);
				}, gcTime);
			};

			// Spread shallow wrapper. Each handle is a new object with the
			// underlying value's own enumerable properties copied onto it.
			// Writes to top-level fields stay on the handle (each handle has
			// its own slot), but nested objects are shared by reference (so
			// e.g. every handle's `.ydoc` is the same Y.Doc). `[Symbol.dispose]`
			// is shadowed to call the per-handle dispose, not the underlying
			// value's destroy.
			return {
				...entry.value,
				[Symbol.dispose]: dispose,
			} as TValue;
		},

		/** Whether an instance is currently held (refcounted or in grace window). */
		has(id: TId) {
			return entries.has(id);
		},

		/**
		 * Resolve once the entry for `id` is no longer held: immediately if it is
		 * absent or already disposed, otherwise when its grace timer elapses and
		 * the underlying value is torn down.
		 *
		 * Read-only observation, NOT a force-close: it does not trigger disposal,
		 * it waits for the refcount to reach zero on its own. Callers that must act
		 * only after a shared resource is fully released (e.g. deleting a Y.Doc's
		 * local persistence after its handle unmounts) await this instead of
		 * racing the teardown.
		 */
		whenReleased(id: TId): Promise<void> {
			const entry = entries.get(id);
			if (entry === undefined || entry.disposed) return Promise.resolve();
			return new Promise<void>((resolve) => {
				entry.releaseWaiters.push(resolve);
			});
		},

		[Symbol.dispose]() {
			const snapshot = Array.from(entries.entries());
			entries.clear();
			for (const [id, entry] of snapshot) disposeEntry(id, entry);
		},
	};

	return cache;
}
