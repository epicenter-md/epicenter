/**
 * # YKeyValueLww - Last-Write-Wins Key-Value Store for Yjs
 *
 * A timestamp-based variant of YKeyValue that uses last-write-wins (LWW) conflict
 * resolution instead of positional ordering.
 *
 * **See also**: `y-keyvalue.ts` for the simpler positional (rightmost-wins) version.
 *
 * ## When to Use This vs YKeyValue
 *
 * | Scenario | Use `YKeyValue` | Use `YKeyValueLww` |
 * |----------|-----------------|-------------------|
 * | Real-time collab | Yes | Either |
 * | Offline-first, multi-device | No | Yes |
 * | Clock sync unreliable | Yes | No |
 * | Need "latest edit wins" | No | Yes |
 *
 * ## How It Works
 *
 * Each entry stores a timestamp alongside the key and value:
 *
 * ```
 * { key: 'user-1', val: { name: 'Alice' }, ts: 1706200000000 }
 * ```
 *
 * When conflicts occur (two clients set the same key while offline), the entry
 * with the **higher timestamp wins**. This gives intuitive "last write wins"
 * semantics.
 *
 * ```
 * Client A (2:00pm): { key: 'x', val: 'A', ts: 1706200400000 }
 * Client B (3:00pm): { key: 'x', val: 'B', ts: 1706204000000 }
 *
 * After sync: B wins (higher timestamp), regardless of sync order
 * ```
 *
 * ## Timestamp Generation
 *
 * Uses a monotonic clock that guarantees:
 * - Local writes always have increasing timestamps (no same-millisecond collisions)
 * - Clock regression is handled (ignores backward jumps)
 * - Cross-device convergence by adopting higher timestamps from synced entries
 *
 * ```typescript
 * // Simplified logic:
 * const now = Date.now();
 * this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
 * return this.lastTimestamp;
 * ```
 *
 * Tracks the maximum timestamp from both local writes and remote synced entries.
 * Devices with slow clocks "catch up" after syncing, preventing their writes from
 * losing to stale timestamps.
 *
 * ## Tiebreaker
 *
 * When timestamps are equal (rare - requires synchronized clocks AND coincidental
 * timing), falls back to positional ordering (rightmost wins). This is deterministic
 * because Yjs's CRDT merge produces consistent ordering based on clientID.
 *
 * ## Limitations
 *
 * - Future clock dominance: If a device's clock is far in the future, its writes dominate
 *   indefinitely. All devices adopt the highest timestamp seen, so writes won't catch up
 *   until wall-clock reaches that point. Rare with NTP, but be aware in environments with
 *   unreliable time sync.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { YKeyValueLww } from './y-keyvalue-lww';
 *
 * const doc = new Y.Doc();
 * const yarray = doc.getArray<{ key: string; val: any; ts: number }>('data');
 * const kv = new YKeyValueLww(yarray);
 *
 * kv.set('user1', { name: 'Alice' });  // ts auto-generated
 * kv.get('user1');  // { name: 'Alice' }
 * ```
 */
import type * as Y from 'yjs';

/**
 * Entry stored in the Y.Array. The `ts` field enables last-write-wins conflict resolution.
 *
 * Field names are intentionally short (`val`, `ts`) to minimize serialized storage size -
 * these entries are persisted and synced.
 */
export type YKeyValueLwwEntry<T> = { key: string; val: T; ts: number };

export type YKeyValueLwwChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; oldValue: T; newValue: T }
	| { action: 'delete'; oldValue: T };

export type YKeyValueLwwChangeHandler<T> = (
	changes: Map<string, YKeyValueLwwChange<T>>,
	transaction: Y.Transaction,
) => void;

export class YKeyValueLww<T> {
	/** The underlying Y.Array that stores `{key, val, ts}` entries. */
	readonly yarray: Y.Array<YKeyValueLwwEntry<T>>;

	/** The Y.Doc that owns this array. Required for transactions. */
	readonly doc: Y.Doc;

	/**
	 * In-memory index for O(1) key lookups. Maps key -> entry object.
	 *
	 * **Important**: This map is ONLY written to by the observer. The `set()` method
	 * never directly updates this map. This "single-writer" architecture prevents
	 * race conditions when operations are nested inside outer Yjs transactions.
	 *
	 * @see pending for how immediate reads work after `set()`
	 */
	readonly map: Map<string, YKeyValueLwwEntry<T>>;

	/**
	 * Pending entries written by `set()` but not yet processed by the observer.
	 *
	 * ## Why This Exists
	 *
	 * When `set()` is called inside a batch/transaction, the observer doesn't fire
	 * until the outer transaction ends. Without `pending`, `get()` would return
	 * undefined for values just written.
	 *
	 * ## Data Flow
	 *
	 * ```
	 * set('foo', 1) is called:
	 * ─────────────────────────────────────────────────────────────
	 *
	 *   set()
	 *     │
	 *     ├───► pending.set('foo', entry)    ← For immediate reads
	 *     │
	 *     └───► yarray.push(entry)           ← Source of truth (CRDT)
	 *                 │
	 *                 │  (observer fires after transaction ends)
	 *                 ▼
	 *           Observer
	 *                 │
	 *                 ├───► map.set('foo', entry)      ← Observer writes to map
	 *                 │
	 *                 └───► pending.delete('foo')      ← Clears pending
	 *
	 *
	 * get('foo') is called:
	 * ─────────────────────────────────────────────────────────────
	 *
	 *   get()
	 *     │
	 *     ├───► Check pending.get('foo')  ← If found, return it
	 *     │
	 *     └───► Check map.get('foo')      ← Fallback to map
	 * ```
	 *
	 * ## Who Writes Where
	 *
	 * | Writer   | `pending` | `Y.Array` | `map`     |
	 * |----------|-----------|-----------|-----------|
	 * | `set()`  | ✅ writes | ✅ writes | ❌ never  |
	 * | Observer | ❌ never  | ❌ never  | ✅ writes |
	 */
	private pending: Map<string, YKeyValueLwwEntry<T>> = new Map();

	/** Registered change handlers. */
	private changeHandlers: Set<YKeyValueLwwChangeHandler<T>> = new Set();

	/**
	 * Last timestamp used for monotonic clock.
	 *
	 * **Primary purpose**: Ensures rapid writes on the SAME device get sequential timestamps,
	 * preventing same-millisecond collisions where two writes would get identical timestamps.
	 *
	 * Tracks the highest timestamp seen from BOTH local writes and remote synced entries.
	 * This ensures:
	 * 1. **Same-millisecond writes on same device**: Always get unique, sequential timestamps
	 *    - Write at t=1000 → ts=1000
	 *    - Write at t=1000 (same ms!) → ts=1001 (incremented)
	 *    - Write at t=1000 (same ms!) → ts=1002 (incremented again)
	 *
	 * 2. **Clock regression**: If system clock goes backward (NTP adjustment), continue
	 *    incrementing from lastTimestamp instead of going backward
	 *
	 * 3. **Self-healing from clock skew**: After syncing with devices that have faster clocks,
	 *    adopt their higher timestamps so future local writes win conflicts
	 *    - Example: Device A's clock at 1000ms syncs entry from Device B with ts=5000ms
	 *    - Device A's lastTimestamp becomes 5000, next write uses 5001 (not 1001)
	 *    - Prevents Device A from writing "old" timestamps that would lose to Device B
	 */
	private lastTimestamp = 0;

	/**
	 * Create a YKeyValueLww wrapper around an existing Y.Array.
	 *
	 * On construction:
	 * 1. Scans the array to build the in-memory Map, keeping highest-timestamp entries
	 * 2. Removes duplicate keys (losers based on timestamp comparison)
	 * 3. Sets up an observer to handle future changes with LWW semantics
	 */
	constructor(yarray: Y.Array<YKeyValueLwwEntry<T>>) {
		this.yarray = yarray;
		this.doc = yarray.doc as Y.Doc;
		this.map = new Map();

		const entries = yarray.toArray();
		const indicesToDelete: number[] = [];

		// First pass: find winners by timestamp
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			const existing = this.map.get(entry.key);

			if (!existing) {
				this.map.set(entry.key, entry);
			} else {
				if (entry.ts > existing.ts) {
					// New entry wins, mark old for deletion
					const oldIndex = entries.indexOf(existing);
					if (oldIndex !== -1) indicesToDelete.push(oldIndex);
					this.map.set(entry.key, entry);
				} else if (entry.ts < existing.ts) {
					// Old entry wins, mark new for deletion
					indicesToDelete.push(i);
				} else {
					// Equal timestamps: keep later one (rightmost), delete earlier
					const oldIndex = entries.indexOf(existing);
					if (oldIndex !== -1 && oldIndex < i) {
						indicesToDelete.push(oldIndex);
						this.map.set(entry.key, entry);
					} else {
						indicesToDelete.push(i);
					}
				}
			}

			// Track max timestamp for monotonic clock (including remote entries)
			// This ensures our next local write will have a higher timestamp than
			// any entry we've seen, preventing us from writing "old" timestamps
			// that would lose conflicts to devices with faster clocks
			if (entry.ts > this.lastTimestamp) this.lastTimestamp = entry.ts;
		}

		// Delete losers
		if (indicesToDelete.length > 0) {
			this.doc.transact(() => {
				// Sort descending to preserve indices during deletion
				indicesToDelete.sort((a, b) => b - a);
				for (const index of indicesToDelete) {
					yarray.delete(index);
				}
			});
		}

		// Set up observer for future changes
		yarray.observe((event, transaction) => {
			const changes = new Map<string, YKeyValueLwwChange<T>>();
			const addedEntries: YKeyValueLwwEntry<T>[] = [];

			// Collect added entries
			for (const addedItem of event.changes.added) {
				for (const addedEntry of addedItem.content.getContent() as YKeyValueLwwEntry<T>[]) {
					addedEntries.push(addedEntry);

					// Track max timestamp from synced entries (self-healing behavior)
					if (addedEntry.ts > this.lastTimestamp)
						this.lastTimestamp = addedEntry.ts;
				}
			}

			// Handle deletions first
			event.changes.deleted.forEach((deletedItem) => {
				deletedItem.content
					.getContent()
					.forEach((entry: YKeyValueLwwEntry<T>) => {
						// Reference equality: only process if this is the entry we have cached
						if (this.map.get(entry.key) === entry) {
							this.map.delete(entry.key);
							changes.set(entry.key, { action: 'delete', oldValue: entry.val });
						}
					});
			});

			// Process added entries with LWW logic
			const indicesToDelete: number[] = [];

			/**
			 * Lazy array snapshot for conflict resolution.
			 *
			 * Why lazy? The `toArray()` call is O(n), copying every entry. For bulk inserts
			 * of NEW keys (the common case), we never need to find indices because there's
			 * nothing to delete. By deferring `toArray()` until the first `indexOf()` call,
			 * we skip the O(n) copy entirely when there are no conflicts.
			 *
			 * Performance impact:
			 *   Before: 10k inserts took ~240ms (toArray called, then indexOf never used)
			 *   After:  10k inserts take ~68ms (toArray never called)
			 *
			 * When IS toArray called? Only when a key already exists in the map, meaning
			 * we have a conflict that requires finding the old entry's index to delete it.
			 */
			let allEntries: YKeyValueLwwEntry<T>[] | null = null;
			const getAllEntries = () => {
				allEntries ??= yarray.toArray();
				return allEntries;
			};

			for (const newEntry of addedEntries) {
				const existing = this.map.get(newEntry.key);

				if (!existing) {
					// New key: just update the map. No array operations needed.
					const deleteEvent = changes.get(newEntry.key);
					if (deleteEvent && deleteEvent.action === 'delete') {
						// Was deleted in same transaction, now re-added
						changes.set(newEntry.key, {
							action: 'update',
							oldValue: deleteEvent.oldValue,
							newValue: newEntry.val,
						});
					} else {
						changes.set(newEntry.key, {
							action: 'add',
							newValue: newEntry.val,
						});
					}
					this.map.set(newEntry.key, newEntry);
				} else {
					// Conflict: key exists in map. Must compare timestamps to determine winner,
					// then find the loser's index in the array to delete it. This is the only
					// path that calls getAllEntries(), triggering the O(n) toArray() copy.
					if (newEntry.ts > existing.ts) {
						// New entry wins: delete old from array
						changes.set(newEntry.key, {
							action: 'update',
							oldValue: existing.val,
							newValue: newEntry.val,
						});

						// Mark old entry for deletion
						const oldIndex = getAllEntries().indexOf(existing);
						if (oldIndex !== -1) indicesToDelete.push(oldIndex);

						this.map.set(newEntry.key, newEntry);
					} else if (newEntry.ts < existing.ts) {
						// Old entry wins: delete new from array
						const newIndex = getAllEntries().indexOf(newEntry);
						if (newIndex !== -1) indicesToDelete.push(newIndex);
					} else {
						// Equal timestamps: positional tiebreaker (rightmost wins)
						const oldIndex = getAllEntries().indexOf(existing);
						const newIndex = getAllEntries().indexOf(newEntry);

						if (newIndex > oldIndex) {
							// New is rightmost, it wins
							changes.set(newEntry.key, {
								action: 'update',
								oldValue: existing.val,
								newValue: newEntry.val,
							});
							if (oldIndex !== -1) indicesToDelete.push(oldIndex);
							this.map.set(newEntry.key, newEntry);
						} else {
							// Old is rightmost, delete new
							if (newIndex !== -1) indicesToDelete.push(newIndex);
						}
					}
				}

				// Clear from pending once processed (whether entry won or lost).
				// Use reference equality to only clear if it's the exact entry we added.
				if (this.pending.get(newEntry.key) === newEntry) {
					this.pending.delete(newEntry.key);
				}
			}

			// Delete loser entries
			if (indicesToDelete.length > 0) {
				this.doc.transact(() => {
					indicesToDelete.sort((a, b) => b - a);
					for (const index of indicesToDelete) {
						yarray.delete(index);
					}
				});
			}

			// Emit change events
			if (changes.size > 0) {
				for (const handler of this.changeHandlers) {
					handler(changes, transaction);
				}
			}
		});
	}

	/**
	 * Generate a monotonic timestamp for local writes.
	 *
	 * **Core guarantee**: Returns a timestamp that is ALWAYS strictly greater than the
	 * previous one, ensuring sequential ordering of writes on this device.
	 *
	 * Handles three edge cases:
	 * 1. **Same-millisecond writes** (primary use case):
	 *    Multiple rapid writes in same millisecond get sequential timestamps
	 *    - kv.set('x', 1) at t=1000 → ts=1000
	 *    - kv.set('y', 2) at t=1000 → ts=1001 (incremented, not duplicate)
	 *    - kv.set('z', 3) at t=1000 → ts=1002 (incremented again)
	 *
	 * 2. **Clock regression**:
	 *    If system clock goes backward (NTP adjustment), continue incrementing
	 *    instead of going backward (maintains monotonicity)
	 *
	 * 3. **Post-sync convergence**:
	 *    After syncing entries with higher timestamps from other devices,
	 *    local writes continue from the highest timestamp seen (self-healing)
	 *
	 * Algorithm:
	 * - If Date.now() > lastTimestamp: use wall clock time (normal case)
	 * - Otherwise: increment lastTimestamp by 1 (handles all three edge cases)
	 */
	private getTimestamp(): number {
		const now = Date.now();
		this.lastTimestamp =
			now > this.lastTimestamp ? now : this.lastTimestamp + 1;
		return this.lastTimestamp;
	}

	/**
	 * Delete the entry with the given key from the Y.Array.
	 *
	 * The data structure maintains at most one entry per key (duplicates are
	 * cleaned up on construction and during sync), so this only deletes one entry.
	 */
	private deleteEntryByKey(key: string): void {
		const index = this.yarray.toArray().findIndex((e) => e.key === key);
		if (index !== -1) this.yarray.delete(index);
	}

	/**
	 * Check if the Y.Doc is currently inside an active transaction.
	 *
	 * Uses Yjs internal `_transaction` property. This is stable across Yjs versions
	 * but is technically internal API (underscore prefix).
	 */
	private isInTransaction(): boolean {
		return this.doc._transaction !== null;
	}

	/**
	 * Set a key-value pair with automatic timestamp.
	 * The timestamp enables LWW conflict resolution during sync.
	 *
	 * ## Single-Writer Architecture
	 *
	 * This method writes to `pending` and `Y.Array`, but NEVER directly to `map`.
	 * The observer is the sole writer to `map`. This prevents race conditions when
	 * `set()` is called inside an outer transaction (e.g., batch operations).
	 *
	 * ```
	 * set()
	 *   │
	 *   ├───► pending.set(key, entry)    ← For immediate reads via get()
	 *   │
	 *   └───► yarray.push(entry)         ← Source of truth
	 *               │
	 *               ▼
	 *         Observer fires (after transaction ends)
	 *               │
	 *               ├───► map.set(key, entry)
	 *               └───► pending.delete(key)
	 * ```
	 */
	set(key: string, val: T): void {
		const entry: YKeyValueLwwEntry<T> = { key, val, ts: this.getTimestamp() };

		// Track in pending for immediate reads via get()
		this.pending.set(key, entry);

		const doWork = () => {
			// Check map for existing entry (pending entries aren't in yarray yet)
			if (this.map.has(key)) this.deleteEntryByKey(key);
			this.yarray.push([entry]);
		};

		// Avoid nested transactions - if already in one, just do the work
		if (this.isInTransaction()) {
			doWork();
		} else {
			this.doc.transact(doWork);
		}

		// DO NOT update this.map here - observer is the sole writer to map
	}

	/**
	 * Delete a key. No-op if key doesn't exist.
	 *
	 * Removes from `pending` immediately and triggers Y.Array deletion.
	 * The observer will update `map` when the deletion is processed.
	 *
	 * ## Known Limitation
	 *
	 * When deleting a **pre-existing key** during a batch, `has()` will still
	 * return `true` until the batch ends (because `map` hasn't been updated yet).
	 *
	 * ```typescript
	 * kv.set('foo', 'bar');  // foo in map
	 *
	 * ydoc.transact(() => {
	 *     kv.delete('foo');
	 *     kv.has('foo');     // TRUE (stale map)
	 * });
	 *
	 * kv.has('foo');         // FALSE (observer updated map)
	 * ```
	 */
	delete(key: string): void {
		// Remove from pending if present. If it was pending, the entry is in the
		// Y.Array (set() pushes immediately) but not yet in map (observer deferred).
		const wasPending = this.pending.delete(key);

		if (!this.map.has(key) && !wasPending) return;

		this.deleteEntryByKey(key);
		// DO NOT update this.map here - observer is the sole writer to map
	}

	/**
	 * Get value by key. O(1) via in-memory Map.
	 *
	 * Checks `pending` first (for values written but not yet processed by observer),
	 * then falls back to `map` (authoritative cache updated by observer).
	 */
	get(key: string): T | undefined {
		// Check pending first (written by set() but observer hasn't fired yet)
		const pending = this.pending.get(key);
		if (pending) return pending.val;

		return this.map.get(key)?.val;
	}

	/**
	 * Check if key exists. O(1) via in-memory Map.
	 *
	 * Checks both `pending` and `map` to handle values written but not yet
	 * processed by the observer.
	 */
	has(key: string): boolean {
		return this.pending.has(key) || this.map.has(key);
	}

	/**
	 * Iterate over all entries (both pending and confirmed).
	 *
	 * Yields entries from both `pending` and `map`, with pending taking
	 * precedence for keys that exist in both. This is necessary for code
	 * that needs to iterate over all current values inside a batch.
	 *
	 * @example
	 * ```typescript
	 * for (const [key, entry] of kv.entries()) {
	 *   console.log(key, entry.val);
	 * }
	 * ```
	 */
	*entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]> {
		// Track keys we've already yielded from pending
		const yieldedKeys = new Set<string>();

		// Yield pending entries first (they take precedence)
		for (const [key, entry] of this.pending) {
			yieldedKeys.add(key);
			yield [key, entry];
		}

		// Yield map entries that weren't in pending
		for (const [key, entry] of this.map) {
			if (!yieldedKeys.has(key)) {
				yield [key, entry];
			}
		}
	}

	/** Register an observer. Called when keys are added, updated, or deleted. */
	observe(handler: YKeyValueLwwChangeHandler<T>): void {
		this.changeHandlers.add(handler);
	}

	/** Unregister an observer. */
	unobserve(handler: YKeyValueLwwChangeHandler<T>): void {
		this.changeHandlers.delete(handler);
	}
}
