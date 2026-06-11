# The Single-Writer Keys Pattern: How to Never Lose Data in Distributed Systems

Here's a counter. Two users. Both clicking at the same time.

Watch what happens.

```typescript
function increment(map) {
	const count = map.get('count') || 0;
	map.set('count', count + 1);
}
```

User A clicks. Reads `5`. Sets `6`.
User B clicks. Reads `5`. Sets `6`.

Both clicked. Counter shows `6`. We lost a click.

This isn't a bug. This is how distributed systems break.

## The Problem

Both users read the same value before either write lands. They both compute `5 + 1 = 6`. They both write `6`. One write overwrites the other.

Add network latency and it gets worse. The counter can actually go _backwards_.

User A sees `10`. Clicks. Their update is in flight.
User B sees `10`. Clicks five times fast. Now they're at `15`.
User A's update finally arrives. Overwrites with `11`.

The count dropped from `15` to `11`. Four clicks vanished.

This isn't a bug. It's how CRDTs work. From the Yjs creator:

> "This is expected behavior. CRDT won't guarantee that result is always correct for each round, it only guarantees result is same for every client."
>
> Source: [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

## The Fix

Stop sharing the key.

Every writer gets their own key. No two writers ever touch the same key. Conflicts become impossible.

```typescript
function increment(map) {
	const myKey = map.doc.clientID; // unique to this device
	const myCount = map.get(myKey) || 0;
	map.set(myKey, myCount + 1);
}
```

User A writes to key `500`.
User B writes to key `800`.

They never collide. Ever.

## Reading the Total

Sum all the values:

```typescript
function getCount(map) {
	let total = 0;
	for (const value of map.values()) {
		total += value;
	}
	return total;
}
```

User A clicked 3 times. Key `500` = `3`.
User B clicked 7 times. Key `800` = `7`.
Total = `10`. Every click counted.

## Why This Works

Traditional thinking: one piece of data, one key.

Distributed thinking: one piece of data, one key _per writer_.

When you partition by writer, you eliminate the shared mutable state that causes conflicts. Each device owns its slice. Reads aggregate across all slices.

This is the core insight behind CRDTs like G-Counters. It's not magic. It's just careful key design.

## The Pattern Generalized

Any time you have:

- Multiple writers
- Incrementing or appending data
- No need for "this specific user's value"

Consider single-writer keys.

```typescript
// Voting system
function vote(votesMap, optionId) {
	const myKey = `${optionId}:${votesMap.doc.clientID}`;
	votesMap.set(myKey, true);
}

function countVotes(votesMap, optionId) {
	let count = 0;
	for (const [key, value] of votesMap.entries()) {
		if (key.startsWith(`${optionId}:`) && value) {
			count++;
		}
	}
	return count;
}
```

```typescript
// Collaborative presence
function setPresence(presenceMap, status) {
	presenceMap.set(presenceMap.doc.clientID, {
		status,
		lastSeen: Date.now(),
	});
}

function getActiveUsers(presenceMap) {
	return [...presenceMap.values()].filter(
		(p) => Date.now() - p.lastSeen < 30000,
	);
}
```

## The Tradeoff

More keys. More storage. Slightly more complex reads.

But zero conflicts. Zero lost data. Every write survives.

For counters, votes, presence, activity logs. Anywhere multiple writers append to the same concept. This pattern eliminates an entire class of distributed bugs.

One key per writer. That's it.

---

_This pattern is taught interactively in [Learn Yjs: Lesson 2 - Counter](https://learn.yjs.dev/lessons/02-counter/). The tutorial lets you add latency and watch the naive approach break before implementing the fix yourself._

## Related

- [Learn Yjs: The Best Interactive CRDT Tutorials I've Found](./learn-yjs-tutorials-overview.md)
- [The Surprising Truth About "Last Write Wins" in CRDTs](./crdt-last-write-wins-surprise.md)
- [CRDT Offline Sync: Why Determinism Beats "Fairness"](./crdt-offline-sync-determinism.md)
