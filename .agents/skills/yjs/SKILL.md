---
name: yjs
description: Yjs CRDT patterns, shared types, conflict resolution, and meta data structures. Use when building collaborative apps with Yjs, handling Y.Map/Y.Array/Y.Text, implementing drag-and-drop reordering, or optimizing document storage.
metadata:
  author: epicenter
  version: '1.0'
---

# Yjs CRDT Patterns

## Core Concepts

### Shared Types

Yjs provides six shared types. You'll mostly use three:

- `Y.Map` - Key-value pairs (like JavaScript Map)
- `Y.Array` - Ordered lists (like JavaScript Array)
- `Y.Text` - Rich text with formatting

The other three (`Y.XmlElement`, `Y.XmlFragment`, `Y.XmlText`) are for rich text editor integrations.

### Client ID

Every Y.Doc gets a random `clientID` on creation. This ID is used for conflict resolution—when two clients write to the same key simultaneously, the **higher clientID wins**, not the later timestamp.

```typescript
const doc = new Y.Doc();
console.log(doc.clientID); // Random number like 1090160253
```

From dmonad (Yjs creator):

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> — [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

The actual comparison in source ([updates.js#L357](https://github.com/yjs/yjs/blob/main/src/utils/updates.js#L357)):

```javascript
return dec2.curr.id.client - dec1.curr.id.client; // Higher clientID wins
```

This is deterministic (all clients converge to same state) but not intuitive (later edits can lose).

### Shared Types Cannot Move

Once you add a shared type to a document, **it can never be moved**. "Moving" an item in an array is actually delete + insert. Yjs doesn't know these operations are related.

## Critical Patterns

### 1. Single-Writer Keys (Counters, Votes, Presence)

**Problem**: Multiple writers updating the same key causes lost writes.

```typescript
// BAD: Both clients read 5, both write 6, one click lost
function increment(ymap) {
	const count = ymap.get('count') || 0;
	ymap.set('count', count + 1);
}
```

**Solution**: Partition by clientID. Each writer owns their key.

```typescript
// GOOD: Each client writes to their own key
function increment(ymap) {
	const key = ymap.doc.clientID;
	const count = ymap.get(key) || 0;
	ymap.set(key, count + 1);
}

function getCount(ymap) {
	let sum = 0;
	for (const value of ymap.values()) {
		sum += value;
	}
	return sum;
}
```

### 2. Fractional Indexing (Reordering)

**Problem**: Drag-and-drop reordering with delete+insert causes duplicates and lost updates.

```typescript
// BAD: "Move" = delete + insert = broken
function move(yarray, from, to) {
	const [item] = yarray.delete(from, 1);
	yarray.insert(to, [item]);
}
```

**Solution**: Add an `index` property. Sort by index. Reordering = updating a property.

```typescript
// GOOD: Reorder by changing index property
function move(yarray, from, to) {
	const sorted = [...yarray].sort((a, b) => a.get('index') - b.get('index'));
	const item = sorted[from];

	const earlier = from > to;
	const before = sorted[earlier ? to - 1 : to];
	const after = sorted[earlier ? to : to + 1];

	const start = before?.get('index') ?? 0;
	const end = after?.get('index') ?? 1;

	// Add randomness to prevent collisions
	const index = (end - start) * (Math.random() + Number.MIN_VALUE) + start;
	item.set('index', index);
}
```

### 3. Nested Structures for Conflict Avoidance

**Problem**: Storing entire objects under one key means any property change conflicts with any other.

```typescript
// BAD: Alice changes nullable, Bob changes default, one loses
schema.set('title', {
	type: 'text',
	nullable: true,
	default: 'Untitled',
});
```

**Solution**: Use nested Y.Maps so each property is a separate key.

```typescript
// GOOD: Each property is independent
const titleSchema = schema.get('title'); // Y.Map
titleSchema.set('type', 'text');
titleSchema.set('nullable', true);
titleSchema.set('default', 'Untitled');
// Alice and Bob edit different keys = no conflict
```

## Storage Optimization

### Y.Map vs Y.Array for Key-Value Data

`Y.Map` tombstones retain the key forever. Every `ymap.set(key, value)` creates a new internal item and tombstones the previous one.

For high-churn key-value data (frequently updated rows), consider `YKeyValue` from `yjs/y-utility`:

```typescript
// YKeyValue stores {key, val} pairs in Y.Array
// Deletions are structural, not per-key tombstones
import { YKeyValue } from 'y-utility/y-keyvalue';

const kv = new YKeyValue(yarray);
kv.set('myKey', { data: 'value' });
```

**When to use Y.Map**: Bounded keys, rarely changing values (settings, config).
**When to use YKeyValue**: Many keys, frequent updates, storage-sensitive.

### Epoch-Based Compaction

If your architecture uses versioned snapshots, you get free compaction:

```typescript
// Compact a Y.Doc by re-encoding current state
const snapshot = Y.encodeStateAsUpdate(doc);
const freshDoc = new Y.Doc({ guid: doc.guid });
Y.applyUpdate(freshDoc, snapshot);
// freshDoc has same content, no history overhead
```

## Common Mistakes

### 1. Assuming "Last Write Wins" Means Timestamps

It doesn't. Higher clientID wins, not later timestamp. Design around this or add explicit timestamps with `y-lwwmap`.

### 2. Using Y.Array Position for User-Controlled Order

Array position is for append-only data (logs, chat). User-reorderable lists need fractional indexing.

### 3. Forgetting Document Integration

Y types must be added to a document before use:

```typescript
// BAD: Orphan Y.Map
const orphan = new Y.Map();
orphan.set('key', 'value'); // Works but doesn't sync

// GOOD: Attached to document
const attached = doc.getMap('myMap');
attached.set('key', 'value'); // Syncs to peers
```

### 4. Storing Non-Serializable Values

Y types store JSON-serializable data. No functions, no class instances, no circular references.

### 5. Expecting Moves to Preserve Identity

```typescript
// This creates a NEW item, not a moved item
yarray.delete(0);
yarray.push([sameItem]); // Different Y.Map instance internally
```

Any concurrent edits to the "moved" item are lost because you deleted the original.

## Debugging Tips

### Inspect Document State

```typescript
console.log(doc.toJSON()); // Full document as plain JSON
```

### Check Client IDs

```typescript
// See who would win a conflict
console.log('My ID:', doc.clientID);
```

### Watch for Tombstone Bloat

If documents grow unexpectedly, check for:

- Frequent Y.Map key overwrites
- "Move" operations on arrays
- Missing epoch compaction

## References

- [Learn Yjs](https://learn.yjs.dev/) - Interactive tutorials
- [Yjs Documentation](https://docs.yjs.dev/) - API reference
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - How Yjs works internally
- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Conflict resolution discussion with dmonad
- [yjs/y-utility](https://github.com/yjs/y-utility) - YKeyValue and helpers
- [y-lwwmap](https://github.com/rozek/y-lwwmap) - Timestamp-based LWW
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing) - Production library
- [YATA paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) - Academic foundation
