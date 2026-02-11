# Y.Map Is Not a Hash Map (But It Acts Like One)

When I first dug into Yjs internals, I made a claim: "Y.Map lookup is O(n) because it's a list of operations." I was wrong—but interestingly wrong.

Y.Map uses a JavaScript `Map` for lookups (O(1)), but the underlying CRDT is indeed a linked list. Understanding this duality explains both why Y.Map is fast and why it has surprising memory characteristics.

## The Dual Data Structure

From `ytype.js` in the Yjs source:

```javascript
export class YType {
	constructor(name = null) {
		// ...
		/**
		 * @type {Map<string,Item>}
		 */
		this._map = new Map(); // ← Hash map for O(1) lookups
		/**
		 * @type {Item|null}
		 */
		this._start = null; // ← Linked list head for CRDT ordering
		// ...
	}
}
```

Y.Map maintains **two** data structures simultaneously:

1. A JavaScript `Map` for fast key lookups
2. A doubly-linked list of `Item` structs for CRDT conflict resolution

## How Operations Work

### Get: O(1)

From `typeMapGet` in `ytype.js`:

```javascript
export const typeMapGet = (parent, key) => {
	parent.doc ?? warnPrematureAccess();
	const val = parent._map.get(key); // ← Direct Map lookup
	return val !== undefined && !val.deleted
		? val.content.getContent()[val.length - 1]
		: undefined;
};
```

Lookups go straight to the JS Map. No iteration required.

### Set: O(1) amortized

From `typeMapSet`:

```javascript
export const typeMapSet = (transaction, parent, key, value) => {
	const left = parent._map.get(key) || null; // Get existing item
	// ... create new Item with CRDT metadata ...
	// The new Item is integrated and becomes the current value
};
```

And from `Item.js`, when an item is integrated:

```javascript
if (this.right !== null) {
	this.right.left = this;
} else if (this.parentSub !== null) {
	// Set as current parent value if right === null
	/** @type {YType} */ (this.parent)._map.set(this.parentSub, this);
	if (this.left !== null) {
		// This is the current attribute value of parent. Delete right.
		this.left.delete(transaction);
	}
}
```

When you set a key, Yjs:

1. Creates a new `Item` with CRDT metadata (clientID, clock, origin pointers)
2. Links it into the item list
3. Updates `_map` to point to the new item
4. Marks the old item as deleted (but keeps it for CRDT consistency)

### Delete: O(1)

```javascript
export const typeMapDelete = (transaction, parent, key) => {
	const c = parent._map.get(key);
	if (c !== undefined) {
		c.delete(transaction); // Marks as deleted, doesn't remove
	}
};
```

Deletion just marks the item—it doesn't remove it from the linked list.

## The Hidden Cost: Tombstones

Here's where my intuition was partially right. From `INTERNALS.md`:

> Maps are lists of entries. The last inserted entry for each key is used, and all other duplicates for each key are flagged as deleted.

Every time you update a key, the old value becomes a tombstone:

```
Y.Map with key "title" updated 5 times:

Linked list (internal):
┌─────────────────────────────────────────────────────────────────┐
│  Item("title", v1, deleted=true)                                │
│  → Item("title", v2, deleted=true)                              │
│  → Item("title", v3, deleted=true)                              │
│  → Item("title", v4, deleted=true)                              │
│  → Item("title", v5, deleted=false)  ← _map points here        │
└─────────────────────────────────────────────────────────────────┘

_map (for lookups):
{ "title" → Item("title", v5) }
```

The `_map` always points to the current (non-deleted) item, giving O(1) lookups. But the linked list keeps growing with every update.

## Memory Implications

This means Y.Map memory is proportional to **total operations**, not just current entries:

```javascript
const map = doc.getMap('test');

// Set same key 1000 times
for (let i = 0; i < 1000; i++) {
	map.set('counter', i);
}

// Map has 1 logical entry
console.log(map.size); // 1

// But internally: 1000 Items (999 tombstones + 1 current)
```

### Garbage Collection

Yjs can GC tombstones when enabled:

```javascript
const doc = new Y.Doc({ gc: true }); // Default
```

With GC enabled, deleted content is replaced with lightweight `GC` structs. But the **structure** (the fact that there was an item there) is preserved—only the content is discarded.

## Why This Design?

The dual structure serves different purposes:

| Structure       | Purpose                                    |
| --------------- | ------------------------------------------ |
| `_map` (JS Map) | Fast runtime lookups for application code  |
| Linked list     | CRDT conflict resolution and sync protocol |

When two clients concurrently set the same key, the linked list preserves both operations. The CRDT algorithm in `Item.integrate()` determines the winner based on client IDs and clocks. The `_map` always points to the current winner.

## The Sync Story

From `INTERNALS.md`:

> All items are referenced in insertion order inside the struct store. This is used to find an item with a given ID (using binary search). It is also used to efficiently gather the operations a peer is missing during sync.

When syncing, Yjs doesn't send the `_map`—it sends the linked list of Items. The receiving client:

1. Integrates each Item into its linked list
2. Runs CRDT conflict resolution
3. Updates its `_map` to point to the winners

This is why Y.Map can sync correctly even with concurrent updates to the same key.

## Performance Characteristics

| Operation         | Time Complexity | Notes                                      |
| ----------------- | --------------- | ------------------------------------------ |
| `get(key)`        | O(1)            | JS Map lookup                              |
| `set(key, value)` | O(1) amortized  | Creates new Item, updates Map              |
| `delete(key)`     | O(1)            | Marks as deleted                           |
| `has(key)`        | O(1)            | JS Map lookup                              |
| `forEach`         | O(n)            | Iterates all current (non-deleted) entries |
| Memory            | O(total ops)    | Tombstones accumulate                      |

## The Real Bottleneck

The actual performance issue isn't Y.Map size—it's **client count**. From [Yjs issue #415](https://github.com/yjs/yjs/issues/415):

> Slower transactions with many past clients

Every transaction iterates the state vector to find insertion positions. With thousands of unique clients having edited a document, this becomes the bottleneck—not the number of keys in a Y.Map.

## Practical Takeaways

1. **Y.Map lookups are fast** — O(1), use it like a normal Map
2. **Updates accumulate** — Each `set()` creates a tombstone
3. **Memory grows with history** — Not just current state
4. **GC helps but doesn't eliminate** — Structure is preserved
5. **Client count matters more** — For very collaborative documents

## Related

- [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md) — When to use each data structure
- [Yjs Storage: The Complete GC On vs Off Guide](./yjs-gc-on-vs-off-storage-guide.md) — How GC affects Y.Map vs YKeyValue storage

## Sources

- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) — Official internals documentation
- [ytype.js](https://github.com/yjs/yjs/blob/main/src/ytype.js) — Y.Map implementation
- [Item.js](https://github.com/yjs/yjs/blob/main/src/structs/Item.js) — Item integration logic
- [YATA Paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) — The underlying CRDT algorithm
- [Yjs Issue #415](https://github.com/yjs/yjs/issues/415) — Client count performance issue

---

_Correction: An earlier version of this article incorrectly stated Y.Map lookups were O(n). They're O(1) via the internal JS Map cache. The linked list is for CRDT operations, not lookups._
