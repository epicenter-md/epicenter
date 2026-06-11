# Learn Yjs: The Best Interactive CRDT Tutorials I've Found

I stumbled on [Learn Yjs](https://learn.yjs.dev/) from a Hacker News thread a while back, and it's become my go-to recommendation for anyone getting into collaborative apps. Jamsocket built something genuinely useful here: interactive tutorials with live code editors and two-client simulations running side by side.

Most Yjs documentation tells you _what_ the API does. These tutorials show you _why_ certain patterns exist by letting you break things first. You add latency, watch conflicts happen, then implement the fix yourself. It's the kind of learning that sticks.

There are three lessons available (with more coming). Each one builds on the last and teaches a concept that's easy to get wrong if you're just reading docs.

## Lesson 1: Introduction

[learn.yjs.dev/lessons/01-introduction](https://learn.yjs.dev/lessons/01-introduction/)

The fundamentals. You create a `Y.Doc`, learn about shared types (`Y.Map`, `Y.Array`, `Y.Text`), and see how changes sync between clients automatically.

The key insight here is understanding **clientID**. Every Yjs document gets a random client ID on creation. This number becomes important later because Yjs uses it for conflict resolution. When two clients write to the same key simultaneously, the higher clientID wins. Not the later timestamp.

This is confirmed by dmonad (Yjs creator):

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

This trips people up constantly.

The lesson also clarifies that shared types hold references to their parent and document. Once you add a shared type to a document, it's connected to that document's CRDT structure permanently.

## Lesson 2: Counter

[learn.yjs.dev/lessons/02-counter](https://learn.yjs.dev/lessons/02-counter/)

The "hello world" of distributed systems problems: a click counter shared between two clients.

The naive implementation looks obvious:

```typescript
function increment(ymap) {
	const count = ymap.get('count') || 0;
	ymap.set('count', count + 1);
}
```

Works perfectly with zero latency. Add 200ms of network delay and clicks start disappearing. Sometimes the counter even goes _down_.

The problem: both clients read the same value, increment locally, then overwrite each other. If both read `5`, both write `6`. You lost a click.

The solution uses clientID as a per-client namespace:

```typescript
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

Each client only ever writes to its own key. No conflicts possible. Total count sums all keys. This pattern. Partitioning state by client. Shows up everywhere in CRDT design.

## Lesson 3: Todo List

[learn.yjs.dev/lessons/03-todo-list](https://learn.yjs.dev/lessons/03-todo-list/)

This one's the most important. It teaches a lesson that's counterintuitive if you're coming from regular JavaScript: **don't trust Y.Array for reordering**.

The setup: a todo list where users can drag items to reorder. Naive approach uses `splice`:

```typescript
function move(todos, from, to) {
	const [todo] = todos.splice(from, 1); // delete
	todos.splice(to, 0, todo); // insert
}
```

Breaks immediately with latency. You get duplicates, lost checkmarks, items appearing in wrong places.

The core insight: **once you add a shared type to a Yjs document, it can never be moved**. What looks like a "move" is actually delete + insert. Yjs doesn't know these operations are related. Two problems emerge:

1. **Lost updates**: You check a todo's checkbox. Someone else "moves" that todo. The move deletes the original (with your checkbox state) and inserts a copy without it.

2. **Duplicates**: Two clients move the same item to different positions. Both deletes happen (idempotent). Both inserts happen (not idempotent). Now you have two copies.

The solution: **fractional indexing**. Instead of relying on array position, add an `index` property to each item. Sort by index for display. Reordering becomes updating a single property, not delete+insert.

```typescript
function move(yarray, from, to) {
	const sorted = [...yarray].sort((a, b) => a.get('index') - b.get('index'));
	const item = sorted[from];

	const earlier = from > to;
	const before = sorted[earlier ? to - 1 : to];
	const after = sorted[earlier ? to : to + 1];

	const start = before?.get('index') ?? 0;
	const end = after?.get('index') ?? 1;

	item.set('index', (start + end) / 2);
}
```

The lesson even covers the collision edge case: two clients moving different items to the same slot get identical indices (same neighbors, same midpoint). Solution: add randomness instead of pure averages.

I wrote a deeper dive on this pattern: [Fractional Ordering: User-Controlled Item Order in Yjs](./fractional-ordering-meta-data-structure.md).

## Why These Tutorials Matter

Yjs documentation is fine for API reference. But CRDTs have failure modes that aren't obvious until you hit them. These tutorials manufacture the failures in a controlled environment so you understand _why_ the patterns exist.

The two-client simulation with adjustable latency is particularly valuable. Most local development happens with zero latency, so you never see the distributed edge cases until production.

## Related Deep Dives

If you want to go deeper after the tutorials:

- [Fractional Ordering: User-Controlled Item Order in Yjs](./fractional-ordering-meta-data-structure.md): Full implementation of the Lesson 3 pattern
- [YKeyValue: The Most Interesting Meta Data Structure in Yjs](./ykeyvalue-meta-data-structure.md): Building a map interface on array primitives for storage efficiency
- [The Surprising Truth About "Last Write Wins" in CRDTs](./crdt-last-write-wins-surprise.md): Why clientID ordering isn't what you expect
- [CRDT Offline Sync: Why Determinism Beats "Fairness"](./crdt-offline-sync-determinism.md): The philosophy behind Yjs's conflict resolution
- [y-lwwmap: A Last-Write-Wins Alternative](./y-lwwmap-last-write-wins-alternative.md): When you actually want timestamp-based ordering

---

## References

- [Learn Yjs](https://learn.yjs.dev/): The interactive tutorial series
- [Jamsocket](https://jamsocket.com/): The team behind Learn Yjs
- [Y-Sweet](https://jamsocket.com/y-sweet/): Jamsocket's open source Yjs server
- [Yjs Documentation](https://docs.yjs.dev/): Official API reference
