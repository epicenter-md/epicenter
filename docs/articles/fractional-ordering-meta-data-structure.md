# Fractional Ordering: User-Controlled Item Order in Yjs

Fractional ordering is a meta pattern for implementing drag-and-drop reordering in collaborative applications. This is covered excellently in the [Learn Yjs: Todo List](https://learn.yjs.dev/lessons/03-todo-list/) tutorial by Jamsocket, which walks through the problem interactively. Much of what follows is based on that tutorial.

The core insight: instead of relying on Y.Array's native position, add an `index` property to each item and sort by it. Reordering becomes updating a single field rather than delete+insert, which avoids Yjs's fundamental limitation that shared types cannot move once added to a document.

## The Problem with "Moving" Items

In Yjs, once you add a shared type to a document, **it can never be moved**. When you "move" an item in an array, you're actually doing delete + insert:

```typescript
function move(yarray, from, to) {
	const [item] = yarray.delete(from, 1); // Delete from old position
	yarray.insert(to, [item]); // Insert at new position
}
```

Yjs doesn't understand there's a connection between the delete and insert. They're independent operations. This causes two distributed problems:

### 1. Lost Updates

Client A checks a todo's checkbox. Client B moves the same todo. The move deletes the original (with the checkbox state) and inserts a copy without it.

```
Client A: Check todo "Buy milk" ✓
Client B: Drag "Buy milk" to top of list

After sync: "Buy milk" is at top, but unchecked □
```

The checkbox update applied to an item that got deleted. The inserted copy doesn't have it.

### 2. Duplicates

Two clients move the same item to different positions. Both deletes happen (idempotent), but both inserts also happen (not idempotent).

```
Client A: Drag "Buy milk" to position 1
Client B: Drag "Buy milk" to position 3

After sync: Two copies of "Buy milk" at positions 1 and 3
```

## How Fractional Ordering Works

Instead of relying on array position, add an `index` property to each item:

```typescript
type OrderedItem = {
	id: string;
	text: string;
	done: boolean;
	index: number; // Fractional index between 0 and 1
};
```

Items are sorted by `index` for display. Position in the underlying Y.Array doesn't matter.

```typescript
function getOrderedItems(yarray) {
	return [...yarray].sort((a, b) => a.get('index') - b.get('index'));
}
```

### Moving = Updating a Property

To move an item, set its `index` to a fraction between the two adjacent items' indices:

```typescript
function move(yarray, from, to) {
	const sorted = getOrderedItems(yarray);
	const item = sorted[from];
	if (!item) return;

	// Find neighbors at target position
	const earlier = from > to;
	const before = sorted[earlier ? to - 1 : to];
	const after = sorted[earlier ? to : to + 1];

	// Boundaries: 0 if moving to start, 1 if moving to end
	const start = before?.get('index') ?? 0;
	const end = after?.get('index') ?? 1;

	// New index = midpoint
	item.set('index', (start + end) / 2);
}
```

Why 0 and 1 as boundaries? Items never have index exactly 0 or 1, so they serve as virtual anchors for moving to extremes.

### Why This Works

Reordering is now a **single property update** on an existing Y.Map. No delete, no insert. The item stays in place; only its `index` field changes.

- **No lost updates**: Checkbox changes apply to the same Y.Map that gets reordered
- **No duplicates**: There's only one item, and we're updating it, not deleting and reinserting

## The Collision Problem

There's a subtle issue. If two clients move different items to the same slot simultaneously:

```
Client A: Move "Check mail" to position 1
Client B: Move "Buy milk" to position 1

Both calculate: (0 + 0.5) / 2 = 0.25
```

Now both items have index `0.25`. You can never insert between them (their average is still 0.25).

### Solution: Add Randomness

Instead of pure averages, pick a random number between the bounds:

```typescript
function move(yarray, from, to) {
	// ... same setup ...

	const start = before?.get('index') ?? 0;
	const end = after?.get('index') ?? 1;

	// Random instead of midpoint
	const index = (end - start) * (Math.random() + Number.MIN_VALUE) + start;
	item.set('index', index);
}
```

Or add jitter to the average:

```typescript
const average = (start + end) / 2;
const range = (end - start) * 1e-10;
const jitter = -range / 2 + Math.random() * range;
const index = average + jitter;
```

Neither approach guarantees zero collisions, but in practice collisions become astronomically unlikely.

### Arbitrary Precision

JavaScript's `Number` has limited precision (~15-17 significant digits). After many reorderings in the same spot, you could exhaust precision.

Production implementations use arbitrary-precision decimals (strings or libraries) instead of floats. But for most apps, floats work fine. You'd need pathological usage patterns to hit the limit.

## The Tradeoff

| Aspect           | Native Y.Array Position | Fractional Ordering |
| ---------------- | ----------------------- | ------------------- |
| Move operation   | Delete + Insert         | Update property     |
| Lost updates     | Yes (common)            | No                  |
| Duplicates       | Yes (on conflict)       | No                  |
| Storage overhead | None                    | 8 bytes per item    |
| Complexity       | Simple                  | Moderate            |
| Precision limits | None                    | Exists (can hit)    |

## When to Use Each

**Use native Y.Array ordering when:**

- Items are append-only (logs, chat messages)
- Order doesn't change after creation
- You don't need drag-and-drop reordering

**Use fractional ordering when:**

- Users reorder items (todos, kanban, playlists)
- Order is user-controlled, not system-controlled
- You need to preserve updates during concurrent reorders

## Implementation Patterns

### With Y.Map Items

If your items are Y.Maps, add index as a field:

```typescript
const item = new Y.Map();
item.set('id', generateId());
item.set('text', 'New todo');
item.set('done', false);
item.set('index', getNextIndex()); // Fractional index

yarray.push([item]);
```

### With YKeyValue

If you're using YKeyValue for storage efficiency, the index lives inside the value:

```typescript
// YKeyValue stores { key: string, val: T }
ykeyvalue.set(id, {
	text: 'New todo',
	done: false,
	index: 0.5,
});
```

### Getting the Next Index

For new items, assign an index after the last item:

```typescript
function getNextIndex(yarray) {
	const sorted = getOrderedItems(yarray);
	const last = sorted.at(-1);
	const lastIndex = last?.get('index') ?? 0;
	// Place after last, but before 1
	return (lastIndex + 1) / 2 + 0.5 * Math.random();
}
```

## The Lesson

Y.Array's native ordering is optimized for append operations, not arbitrary reordering. The delete+insert pattern for moves is a fundamental mismatch with how CRDTs track changes.

Fractional ordering sidesteps this by moving the "order" concept from the data structure level (array position) to the data model level (a property). Reordering becomes a property update. Something Yjs handles cleanly with last-write-wins semantics.

The 8-byte overhead per item is negligible compared to the correctness guarantees. Lost updates and duplicates aren't edge cases; they're predictable outcomes of concurrent reordering with delete+insert. Fractional ordering eliminates them.

---

## References

- [Learn Yjs: Todo List](https://learn.yjs.dev/lessons/03-todo-list/): Interactive tutorial demonstrating the problem and solution
- [Implementing Fractional Indexing](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/): Figma's deep dive on their implementation
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing): A production library for arbitrary-precision fractional indexing

## Related

- [YKeyValue: The Most Interesting Meta Data Structure in Yjs](./ykeyvalue-meta-data-structure.md): Storage-efficient map backed by Y.Array
- [y-lwwmap: A Last-Write-Wins Alternative](./y-lwwmap-last-write-wins-alternative.md): Timestamp-based conflict resolution
