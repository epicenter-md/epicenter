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
 * | Offline-first, multi-node | No | Yes |
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
 * - Cross-node convergence by adopting higher timestamps from synced entries
 *
 * ```typescript
 * // Simplified logic:
 * const now = Date.now();
 * this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
 * return this.lastTimestamp;
 * ```
 *
 * Tracks the maximum timestamp from both local writes and remote synced entries.
 * Nodes with slow clocks "catch up" after syncing, preventing their writes from
 * losing to stale timestamps.
 *
 * ## Tiebreaker
 *
 * When timestamps are equal (rare - requires synchronized clocks AND coincidental
 * timing), falls back to positional ordering (rightmost wins). This is deterministic
 * because Yjs's CRDT merge produces consistent ordering based on clientID.
 *
 * ## Storage Complexity
 *
 * With `gc:true` (the default), storage is `O(active data) + O(unique nodes)`.
 * Deleted entries, overwritten values, and edit history are garbage collected into
 * compact GC structs. A store with 20 active keys stays at roughly the same size
 * whether it was created yesterday or has processed 52,000 operations. The only
 * additional overhead is ~22 bytes per unique Yjs clientID that has ever written
 * to the doc. With `gc:false`, this property breaks; storage grows with operation
 * count. See `docs/articles/yjs-storage-efficiency/storage-scales-with-data-not-history.md`.
 *
 * ## Performance Architecture: Single vs Bulk Operations
 *
 * This class exposes two pairs of write methods:
 *
 * | Operation | Single-row | Bulk |
 * |-----------|------------|------|
 * | Insert/update | `set()` | `bulkSet()` |
 * | Delete | `delete()` | `bulkDelete()` |
 *
 * Both pairs produce identical results. The difference is internal:
 *
 * **`set()` eagerly cleans up old entries** before pushing the new one.
 * It calls `deleteEntriesByKey()` which scans the Y.Array (O(n)) to find and
 * remove matching entries. The observer then sees a clean add with no conflicts. This
 * is fast for individual calls but O(n²) when called 10K times in a loop,
 * because each call re-scans the (mutating) array.
 *
 * **`bulkSet()` defers cleanup to the observer.** It pushes all entries without
 * deleting old ones, then the observer fires once, builds an entry→index Map from
 * one `toArray()` call, and resolves all conflicts with O(1) Map lookups. Total:
 * O(n) instead of O(n²). The observer's cleanup deletion uses `DEDUP_ORIGIN` so
 * its queued follow-up observer pass can return immediately.
 *
 * **`delete()` eagerly scans** to remove matching visible entries. Same O(n) as `set()`.
 *
 * **`bulkDelete()` scans once** to collect all matching indices, then batch-deletes
 * right-to-left. Unlike `bulkSet`, it does NOT defer anything to the observer:
 * deletions happen directly, no DEDUP_ORIGIN needed.
 *
 * ```
 * Single ops (fine for individual use, O(n²) in a loop):
 *   set():    deleteEntriesByKey O(n) + push O(1) → observer: no conflicts
 *   delete(): deleteEntriesByKey O(n)              → observer: processes deletion
 *
 * Bulk ops:
 *   bulkSet():    push × N + observer resolves all via Map   [DEDUP_ORIGIN]
 *   bulkDelete(): scan once + batch delete right-to-left     [no DEDUP_ORIGIN]
 * ```
 *
 * ## Real-World Bottlenecks (Measured)
 *
 * The cost profile is NOT what Big-O suggests. `toArray()` is ~0.04ms even at
 * 25K entries, which is negligible. The actual bottleneck is `Y.Array.delete(index)`, which
 * walks Yjs's internal linked list. This cost scales non-linearly within large
 * transactions due to structural fragmentation:
 *
 * - **For `bulkDelete`**: Deleting 25K items in one transaction is ~3x slower than
 *   chunking into groups of 2500. The Yjs linked-list walk compounds when many
 *   deletes happen in a single transaction.
 * - **For `bulkSet`**: Inserting 25K items in one call forces the observer to build
 *   one massive entry-position map. Chunking into groups of 1000 is ~10x faster.
 *
 * Because of this, the `Table` layer (in `create-table.ts`) wraps these
 * methods with chunked async loops. The optimal chunk sizes differ:
 * - `bulkSet`: 1000 (observer conflict resolution is the bottleneck)
 * - `bulkDelete`: 2500 (Yjs linked-list deletion is the bottleneck)
 *
 * Constructor hydration, bulk writes, and multi-node sync all enter the same
 * reconciliation pipeline. It selects one winner per affected key, updates the
 * confirmed index, deletes visible losers, and emits one change batch.
 *
 * ## Limitations
 *
 * - Future clock dominance: If a node's clock is far in the future, its writes dominate
 *   indefinitely. All nodes adopt the highest timestamp seen, so writes won't catch up
 *   until wall-clock reaches that point. Rare with NTP, but be aware in environments with
 *   unreliable time sync.
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
import type {
	KvEntry,
	KvStoreChange,
	KvStoreChangeHandler,
	ObservableKvStore,
} from './observable-kv-store.js';

/**
 * Entry stored in the Y.Array. The `ts` field enables last-write-wins conflict resolution.
 *
 * Field names are intentionally short (`val`, `ts`) to minimize serialized storage size -
 * these entries are persisted and synced.
 *
 * Storage-only type: `ts` is internal. The public `ObservableKvStore.entries()`
 * surfaces only `key` and `val`.
 */
export type YKeyValueLwwEntry<T> = { key: string; val: T; ts: number };

/**
 * Transaction origin that marks observer cleanup deletions as internal.
 *
 * ## When this fires
 *
 * The observer resolves LWW conflicts by keeping the winner and deleting losers.
 * Yjs queues a transaction opened from an observer until the current transaction
 * finishes its observer and update lifecycle. The deletion mutates the array
 * immediately, but its observer notification is a later follow-up pass. This
 * origin lets that pass return without reconciling an already-confirmed result.
 *
 * ## What triggers conflicts
 *
 * 1. `bulkSet()`: pushes entries without deleting old ones, observer resolves
 * 2. Multi-node sync: two clients set the same key offline, observer resolves
 * 3. Constructor initial dedup: runs before this observer is registered
 *
 * Note: `set()` eagerly deletes via `deleteEntriesByKey` so the observer sees no
 * conflicts. `delete()` and `bulkDelete()` only remove entries, so there are no conflicts.
 * DEDUP_ORIGIN is only relevant for the conflict-resolution path.
 *
 * Keeps the observer from re-processing its own cleanup transaction.
 */
const DEDUP_ORIGIN = Symbol('dedup');

type PendingIntent<T> =
	| {
			action: 'set';
			entry: YKeyValueLwwEntry<T>;
			transaction: Y.Transaction;
	  }
	| { action: 'delete'; transaction: Y.Transaction };

type Reconciliation<T> = {
	addedEntries: YKeyValueLwwEntry<T>[];
	deletedEntries: Set<YKeyValueLwwEntry<T>>;
	origin: unknown;
	snapshot?: YKeyValueLwwEntry<T>[];
	cleanupOrigin: unknown;
};

/**
 * Select one LWW winner. Timestamp is the policy; final Y.Array position is the
 * deterministic equal-timestamp boundary.
 */
function selectWinner<T>(
	candidates: YKeyValueLwwEntry<T>[],
	positionOf: (entry: YKeyValueLwwEntry<T>) => number,
): YKeyValueLwwEntry<T> | undefined {
	let winner = candidates[0];
	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i];
		if (!candidate || !winner) continue;
		if (candidate.ts > winner.ts) {
			winner = candidate;
			continue;
		}
		if (
			candidate.ts === winner.ts &&
			positionOf(candidate) > positionOf(winner)
		) {
			winner = candidate;
		}
	}
	return winner;
}

export class YKeyValueLww<T> implements ObservableKvStore<T>, Disposable {
	/** The underlying Y.Array that stores `{key, val, ts}` entries. */
	readonly yarray: Y.Array<YKeyValueLwwEntry<T>>;

	/** The Y.Doc that owns this array. Required for transactions. */
	readonly doc: Y.Doc;

	/** Mutable in-memory index. Written exclusively by the constructor and observer. */
	private readonly _map = new Map<string, YKeyValueLwwEntry<T>>();

	/**
	 * Read-only view of the in-memory index for O(1) key lookups.
	 *
	 * Written exclusively by the observer and constructor. External consumers read
	 * via iteration, `.get()`, and `.size`. The `set()` method never writes to
	 * this map. The observer is the sole writer.
	 *
	 * @see pending for the transaction-local read overlay
	 */
	readonly map: ReadonlyMap<string, YKeyValueLwwEntry<T>> = this._map;

	/**
	 * Local writes that have reached the Y.Array but not the observer-backed map.
	 *
	 * Yjs observers run when the current transaction closes. If a caller opens a
	 * transaction, `set()` mutates the Y.Array immediately, but `_map` remains one
	 * observer turn behind. This overlay provides read-your-writes behavior until
	 * the observer catches up.
	 *
	 * ```text
	 * caller-owned transaction opens
	 *   set(key, value)
	 *     pending.set(key, { action: 'set', entry }) // visible to reads now
	 *     yarray.push([entry])          // CRDT source-of-truth write
	 *
	 *   delete(key) when present
	 *     pending.set(key, { action: 'delete' }) // reads report absence
	 *     deleteEntriesByKey(key)              // deletes visible versions
	 *
	 *   read view
	 *     a pending delete hides the key
	 *     a pending set overrides _map
	 *
	 * transaction closes
	 *   observer reconciles _map and acknowledges the transaction overlay
	 * ```
	 *
	 * Outside a caller-owned transaction, `set()` opens and closes its own
	 * transaction, so the observer normally clears this overlay before `set()`
	 * returns.
	 */
	private readonly pending = new Map<string, PendingIntent<T>>();

	/** Registered change handlers. */
	private changeHandlers: Set<KvStoreChangeHandler<T>> = new Set();

	/** Stored observer reference for cleanup in [Symbol.dispose](). */
	private _observer!: (
		event: Y.YArrayEvent<YKeyValueLwwEntry<T>>,
		transaction: Y.Transaction,
	) => void;

	/** Number of entries in the map. */
	get size(): number {
		return this._map.size;
	}

	/**
	 * Last timestamp used for monotonic clock.
	 *
	 * **Primary purpose**: Ensures rapid writes on the SAME node get sequential timestamps,
	 * preventing same-millisecond collisions where two writes would get identical timestamps.
	 *
	 * Tracks the highest timestamp seen from BOTH local writes and remote synced entries.
	 * This ensures:
	 * 1. **Same-millisecond writes on same node**: Always get unique, sequential timestamps
	 *    - Write at t=1000 → ts=1000
	 *    - Write at t=1000 (same ms!) → ts=1001 (incremented)
	 *    - Write at t=1000 (same ms!) → ts=1002 (incremented again)
	 *
	 * 2. **Clock regression**: If system clock goes backward (NTP adjustment), continue
	 *    incrementing from lastTimestamp instead of going backward
	 *
	 * 3. **Self-healing from clock skew**: After syncing with nodes that have faster clocks,
	 *    adopt their higher timestamps so future local writes win conflicts
	 *    - Example: Node A's clock at 1000ms syncs entry from Node B with ts=5000ms
	 *    - Node A's lastTimestamp becomes 5000, next write uses 5001 (not 1001)
	 *    - Prevents Node A from writing "old" timestamps that would lose to Node B
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

		const snapshot = yarray.toArray();
		this.reconcile({
			addedEntries: snapshot,
			deletedEntries: new Set(),
			origin: undefined,
			snapshot,
			cleanupOrigin: null,
		});

		// Set up observer for future changes
		this._observer = (event, transaction) => {
			// Cleanup is a queued follow-up transaction. It cannot acknowledge a
			// newer overlay created by a change handler, so return before detaching it.
			if (transaction.origin === DEDUP_ORIGIN) return;

			// YEvent changes are only safe to derive before another mutation. Capture
			// the net entries now, before reconciliation deletes any losers.
			const addedEntries: YKeyValueLwwEntry<T>[] = [];
			const deletedEntries = new Set<YKeyValueLwwEntry<T>>();
			const eventChanges = event.changes;
			for (const addedItem of eventChanges.added) {
				for (const addedEntry of addedItem.content.getContent() as YKeyValueLwwEntry<T>[]) {
					addedEntries.push(addedEntry);
				}
			}
			for (const deletedItem of eventChanges.deleted) {
				for (const deletedEntry of deletedItem.content.getContent() as YKeyValueLwwEntry<T>[]) {
					deletedEntries.add(deletedEntry);
				}
			}

			// Acknowledge only intents owned by this transaction. Another observer may
			// already have queued a later transaction whose read overlay must survive
			// this pass and the DEDUP follow-up.
			for (const [key, intent] of this.pending) {
				if (intent.transaction !== transaction) continue;
				this.pending.delete(key);
			}

			this.reconcile({
				addedEntries,
				deletedEntries,
				origin: transaction.origin,
				cleanupOrigin: DEDUP_ORIGIN,
			});
		};
		yarray.observe(this._observer);
	}

	/**
	 * Reconcile one final Y.Array state through five explicit phases: collect the
	 * affected candidates, select winners, commit the confirmed index, delete
	 * losers, and emit the observable change batch.
	 */
	private reconcile({
		addedEntries,
		deletedEntries,
		origin,
		snapshot: initialSnapshot,
		cleanupOrigin,
	}: Reconciliation<T>): void {
		const additionsByKey = new Map<string, YKeyValueLwwEntry<T>[]>();

		// Deleted keys lead so public change ordering matches the previous observer.
		for (const entry of deletedEntries) additionsByKey.set(entry.key, []);
		for (const entry of addedEntries) {
			const additions = additionsByKey.get(entry.key);
			if (additions) additions.push(entry);
			else additionsByKey.set(entry.key, [entry]);
			if (entry.ts > this.lastTimestamp) this.lastTimestamp = entry.ts;
		}

		// Positions are irrelevant on the no-conflict fast path. When conflicts do
		// need them, preserve the measured small-batch indexOf optimization and use
		// one entry-index map for large bulk reconciliation.
		let snapshot = initialSnapshot;
		let positions: Map<YKeyValueLwwEntry<T>, number> | undefined;
		const getSnapshot = (): YKeyValueLwwEntry<T>[] =>
			(snapshot ??= this.yarray.toArray());
		const positionOf = (entry: YKeyValueLwwEntry<T>): number => {
			if (addedEntries.length <= 4) return getSnapshot().indexOf(entry);
			if (!positions) {
				positions = new Map();
				const entries = getSnapshot();
				for (let i = 0; i < entries.length; i++) {
					const current = entries[i];
					if (current) positions.set(current, i);
				}
			}
			return positions.get(entry) ?? -1;
		};

		const changes = new Map<string, KvStoreChange<T>>();
		const losers: YKeyValueLwwEntry<T>[] = [];

		for (const [key, additions] of additionsByKey) {
			const before = this._map.get(key);
			const candidates: YKeyValueLwwEntry<T>[] = [];
			if (before && !deletedEntries.has(before)) candidates.push(before);
			candidates.push(...additions);

			const winner = selectWinner(candidates, positionOf);
			for (const candidate of candidates) {
				if (candidate !== winner) losers.push(candidate);
			}

			if (winner) this._map.set(key, winner);
			else this._map.delete(key);

			if (winner === before) continue;
			if (before) {
				changes.set(
					key,
					winner
						? { action: 'update', newValue: winner.val }
						: { action: 'delete' },
				);
				continue;
			}
			if (winner) {
				// Preserve the existing event contract: if an absent key changes winner
				// within one transaction, the final action is update rather than add.
				changes.set(key, {
					action: winner === additions[0] ? 'add' : 'update',
					newValue: winner.val,
				});
			}
		}

		if (losers.length > 0) {
			const indices = losers
				.map(positionOf)
				.filter((index) => index !== -1)
				.sort((a, b) => b - a);
			const deleteLosers = () => {
				for (const index of indices) this.yarray.delete(index);
			};
			this.doc.transact(deleteLosers, cleanupOrigin);
		}

		if (changes.size > 0) {
			for (const handler of this.changeHandlers) handler(changes, origin);
		}
	}

	/**
	 * Generate a monotonic timestamp for local writes.
	 *
	 * **Core guarantee**: Returns a timestamp that is ALWAYS strictly greater than the
	 * previous one, ensuring sequential ordering of writes on this node.
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
	 *    After syncing entries with higher timestamps from other nodes,
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
	 * Delete every visible entry with the given key from the Y.Array.
	 *
	 * Confirmed state has at most one entry per key, but a caller-owned transaction
	 * can append several unconfirmed writes before the observer runs. Removing all
	 * matches makes a final delete authoritative without observer-only repair logic.
	 */
	private deleteEntriesByKey(key: string): void {
		const entries = this.yarray.toArray();
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]?.key === key) this.yarray.delete(i);
		}
	}

	/**
	 * Set a key-value pair with automatic timestamp.
	 * The timestamp enables LWW conflict resolution during sync.
	 *
	 * For existing keys, eagerly deletes the old entry before pushing the new one.
	 * This keeps the observer's job simple: it sees a clean add with no conflicts.
	 *
	 * For bulk updates (1K+ rows), use {@link bulkSet} instead. It skips the
	 * per-key delete and lets the observer batch-resolve all conflicts in one pass,
	 * turning O(n²) into O(n). See `bulkSet` JSDoc for the full explanation.
	 *
	 * ## Why `set()` eagerly deletes but `bulkSet()` defers
	 *
	 * `deleteEntriesByKey()` scans the Y.Array to find old entries: O(n) per call.
	 * For a single `set()`, that O(n) is fine. For 10K `set()` calls in a loop,
	 * it's 10K × O(n) = O(n²). `bulkSet` avoids this by pushing all entries first,
	 * then letting the observer find and remove old entries using a pre-built index
	 * Map (one O(n) scan + O(1) per lookup = O(n) total).
	 *
	 * ```
	 * set('foo', newVal) where 'foo' exists:
	 *   ┌─ same transaction ───────────────────────────────────┐
	 *   │  deleteEntriesByKey('foo') ← O(n) scan, removes old entries │
	 *   │  yarray.push([newEntry])  ← O(1)                         │
	 *   └────────────────────────────────────────────────┘
	 *   observer fires ONCE → sees 1 delete + 1 add → emits 'update'
	 *   no conflicts, no DEDUP_ORIGIN needed
	 *
	 * bulkSet(10K entries) where keys exist:
	 *   ┌─ single transaction ─────────────────────────────────┐
	 *   │  for each: yarray.push([entry])  ← O(1) × 10K, NO delete  │
	 *   └────────────────────────────────────────────────┘
	 *   observer fires (1st) → 10K conflicts → position Map → batch delete losers
	 *   observer fires (2nd) → DEDUP_ORIGIN → skipped (free)
	 * ```
	 */
	set(key: string, val: T): void {
		const entry: YKeyValueLwwEntry<T> = { key, val, ts: this.getTimestamp() };

		// Yjs reuses an active outer transaction, so this preserves the caller's
		// origin and batches observer delivery until that transaction closes.
		this.doc.transact((transaction) => {
			// Keep reads transaction-local until this transaction's observer updates
			// the confirmed index.
			this.pending.set(key, { action: 'set', entry, transaction });
			if (this._map.has(key)) this.deleteEntriesByKey(key);
			this.yarray.push([entry]);
		});

		// DO NOT update this.map here - observer is the sole writer to map
	}

	/**
	 * Set many key-value pairs in one transaction.
	 *
	 * Unlike {@link set}, this intentionally skips `deleteEntriesByKey()` for existing
	 * keys. Instead, all entries are pushed to the Y.Array, and the observer resolves
	 * duplicate-key conflicts in a single pass when the transaction ends.
	 *
	 * ## Why this is faster than calling `set()` in a loop
	 *
	 * `set()` calls `deleteEntriesByKey()` per key: an O(n) array scan. In a loop:
	 * N calls × O(n) scan = O(n²). `bulkSet` defers all cleanup to the observer,
	 * which builds an entry-position Map from one `toArray()` call
	 * and resolves each conflict with an O(1) Map lookup. Total: O(n).
	 *
	 * The observer's conflict resolution already exists for multi-node sync.
	 * When two clients set the same key offline, `bulkSet` reuses that exact same path.
	 *
	 * ## When to use
	 *
	 * - Importing 1K+ rows: `ykv.bulkSet(entries)` opens one transaction
	 * - For chunked imports with progress, use `Table.bulkSet()` which wraps
	 *   this method with chunking, `onProgress`, and event-loop yielding
	 * - For fewer than 100 rows, repeated `set()` calls are usually simpler. Wrap
	 *   them in `doc.transact()` when they form one logical change.
	 *
	 * @example
	 * ```typescript
	 * ykv.bulkSet([
	 *   { key: 'row-1', val: { title: 'First' } },
	 *   { key: 'row-2', val: { title: 'Second' } },
	 * ]);
	 * ```
	 */
	bulkSet(entries: Array<{ key: string; val: T }>): void {
		this.doc.transact((transaction) => {
			for (const { key, val } of entries) {
				const entry: YKeyValueLwwEntry<T> = {
					key,
					val,
					ts: this.getTimestamp(),
				};

				this.pending.set(key, { action: 'set', entry, transaction });
				this.yarray.push([entry]);
			}
		});
	}

	/**
	 * Delete a key. No-op if key doesn't exist.
	 *
	 * Scans the Y.Array to find and remove the entry: O(n) per call.
	 * For bulk deletions (1K+ keys), use {@link bulkDelete} which does
	 * one scan for all keys instead of one scan per key.
	 *
	 * Replaces any pending set intent with a delete intent, removes every visible
	 * version in one transaction, and lets the observer update `_map`.
	 */
	delete(key: string): void {
		const pending = this.pending.get(key);
		if (pending?.action === 'delete') return;
		if (!this._map.has(key) && pending?.action !== 'set') return;

		this.doc.transact((transaction) => {
			this.pending.set(key, { action: 'delete', transaction });
			this.deleteEntriesByKey(key);
		});
		// DO NOT update this.map here - observer is the sole writer to map
	}

	/**
	 * Delete many keys in one scan plus one batched transaction.
	 *
	 * Unlike calling {@link delete} in a loop (which scans the array per call,
	 * O(n²) for N deletions), this collects all matching entry indices in a single
	 * `toArray()` scan, then deletes them right-to-left so indices stay stable.
	 *
	 * ## How this differs from `bulkSet`
	 *
	 * `bulkSet` defers cleanup to the observer (which triggers a second, skipped
	 * observer call via DEDUP_ORIGIN). `bulkDelete` does NOT defer anything: it
	 * performs the deletions directly in one transaction. The observer fires once,
	 * sees the deletions, and updates `_map`. No conflicts, no DEDUP_ORIGIN needed.
	 *
	 * Note: despite what Big-O analysis might suggest, the `toArray()` scan is NOT
	 * the bottleneck (~0.04ms at 25K entries). The real cost is the `yarray.delete()`
	 * calls inside the transaction. Each one walks Yjs's internal linked list. This is
	 * why the `Table` layer chunks calls to this method rather than passing all
	 * IDs at once (large single transactions are slower due to linked-list fragmentation).
	 *
	 * ## Why right-to-left?
	 *
	 * Deleting at index 9000 doesn't change the position of index 50. By processing
	 * indices in descending order, all pre-computed indices remain valid throughout
	 * the batch. No re-scanning needed.
	 *
	 * @example
	 * ```typescript
	 * ykv.bulkDelete(['key-1', 'key-2', 'key-3']);
	 * ```
	 */
	bulkDelete(keys: string[]): void {
		const keySet = new Set(keys);
		const entries = this.yarray.toArray();
		const indicesToDelete: number[] = [];

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry || !keySet.has(entry.key)) continue;

			indicesToDelete.push(i);
		}

		if (indicesToDelete.length === 0) return;

		this.doc.transact((transaction) => {
			for (const index of indicesToDelete) {
				const entry = entries[index];
				if (entry)
					this.pending.set(entry.key, { action: 'delete', transaction });
			}
			for (let i = indicesToDelete.length - 1; i >= 0; i--) {
				const index = indicesToDelete[i];
				if (index !== undefined) this.yarray.delete(index);
			}
		});
	}

	/**
	 * Get value by key. O(1) via in-memory Map.
	 *
	 * Reads the observer-backed map plus the transaction-local overlay.
	 *
	 * A pending delete wins over a pending set: `set(); delete(); get()` inside one
	 * outer transaction reads absent, matching the final confirmed state.
	 */
	get(key: string): T | undefined {
		const pending = this.pending.get(key);
		if (pending?.action === 'delete') return undefined;
		if (pending?.action === 'set') return pending.entry.val;

		const entry = this._map.get(key);
		return entry?.val;
	}

	/** Whether a key has a stored value. O(1). Equivalent to `get(key) !== undefined`. */
	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	/**
	 * Walk every stored entry from the observer-backed map plus the
	 * transaction-local overlay. Pending writes take precedence over `_map`; pending
	 * deletes hide `_map` entries until the observer catches up.
	 *
	 * @example
	 * ```typescript
	 * for (const { key, val } of kv.entries()) {
	 *   console.log(key, val);
	 * }
	 * ```
	 */
	*entries(): IterableIterator<KvEntry<T>> {
		// Track keys already yielded from the write overlay.
		const yieldedKeys = new Set<string>();

		// Yield transaction-local writes first because they take precedence.
		for (const [key, intent] of this.pending) {
			if (intent.action === 'delete') continue;
			yieldedKeys.add(key);
			yield { key, val: intent.entry.val };
		}

		// Then yield indexed entries not replaced or deleted by the overlay.
		for (const [key, entry] of this._map) {
			if (yieldedKeys.has(key) || this.pending.get(key)?.action === 'delete')
				continue;
			yield { key, val: entry.val };
		}
	}

	/**
	 * Register an observer (called when keys are added, updated, or deleted) and
	 * return the function that removes it.
	 */
	observe(handler: KvStoreChangeHandler<T>): () => void {
		this.changeHandlers.add(handler);
		return () => this.changeHandlers.delete(handler);
	}

	/**
	 * Unregister the Y.Array observer. Call when this wrapper is no longer needed
	 * but the underlying Y.Array continues to exist.
	 */
	[Symbol.dispose](): void {
		this.yarray.unobserve(this._observer);
	}
}
