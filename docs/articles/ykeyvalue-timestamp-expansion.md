# YKeyValue Conflict Resolution: Understanding the Last-Write-Wins Problem

> **Update (2026-01-27)**: We implemented `YKeyValueLww` with timestamp-based conflict resolution.
> See [PR #1286](https://github.com/EpicenterHQ/epicenter/pull/1286). The static API now uses
> `YKeyValueLww` by default, giving offline-first workspaces intuitive "later edit wins" semantics.
>
> _Previous update (2026-01-08)_: We had temporarily reverted to Y.Map, but restored YKeyValue
> in [PR #1278](https://github.com/EpicenterHQ/epicenter/pull/1278) for the stable ID schema pattern.

We discovered a conflict resolution problem in our YKeyValue implementation while researching [y-lwwmap](https://github.com/rozek/y-lwwmap). This article documents the problem, confirms it with tests, and discusses mitigation strategies.

## The Discovery

YKeyValue is a meta data structure that provides a Map interface backed by a Y.Array. We chose it for its [dramatic storage efficiency](./ykeyvalue-migration-storage-gains.md) over Y.Map: 1935x smaller in our benchmarks.

But while reading through y-lwwmap's documentation, we noticed it explicitly addresses a problem we hadn't considered: conflict resolution predictability.

## The Problem: Positional Conflict Resolution

Our original YKeyValue used "rightmost wins" conflict resolution. When two entries exist for the same key, the one further right in the array wins:

```typescript
// After CRDT merge, array might contain:
[
	{ key: 'x', val: 'A' },
	{ key: 'x', val: 'B' },
][
	// Cleanup scans right-to-left, keeps rightmost:
	{ key: 'x', val: 'B' }
]; // B wins
```

This is deterministic given a specific array state. But the array state after CRDT merge depends on Yjs's internal ordering algorithm, which considers client IDs and vector clocks.

From the user's perspective, **the winner is unpredictable**.

## Confirming the Problem with Tests

We wrote tests to verify this behavior. Two clients set the same key while offline, then sync:

```typescript
// Client 1 sets value (imagine this is at 10:00am)
kv1.set('doc', 'from-client-1');

// Client 2 sets value (imagine this is at 10:05am - LATER)
kv2.set('doc', 'from-client-2');

// Sync both ways
Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

// Which value wins?
```

Running this test multiple times with different client IDs:

```
Concurrent update winners: [
  "value-from-2-iteration-0",
  "value-from-2-iteration-1",
  "value-from-2-iteration-2",
  "value-from-1-iteration-3",  // Client 1 won
  "value-from-1-iteration-4",  // Client 1 won
  "value-from-2-iteration-5",
  "value-from-2-iteration-6",
  "value-from-2-iteration-7",
  "value-from-1-iteration-8",
  "value-from-1-iteration-9"
]
```

The winner varies between iterations. Sometimes client 1 wins, sometimes client 2. For an offline-first editor where users expect "my later edit should stick," this is a problem.

## The Real Problem: Earlier Edits Can Overwrite Later Ones

We confirmed the problem with additional tests. The critical finding:

```
Time gap test: Winner is "A edits at 10:00am"
(B edited 100ms AFTER A, but winner is unpredictable)
```

**B edited LATER than A, but A won.** This is exactly what y-lwwmap describes:

> "former changes may overwrite later ones when synchronized"

The winner is determined by Yjs internals (client IDs assigned randomly at Y.Doc creation), NOT by chronological order. Users expect "my later edit should stick" but that's not guaranteed.

This is confirmed by dmonad (Yjs creator):

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

The actual comparison happens in Yjs source ([updates.js#L357](https://github.com/yjs/yjs/blob/main/src/utils/updates.js#L357)):

```javascript
// Different clients: higher clientID wins
return dec2.curr.id.client - dec1.curr.id.client;
```

## What "Concurrent" Actually Means

"Concurrent" in CRDT terms means **causally concurrent**: neither operation happened-before the other. This occurs when clients are **offline** and don't see each other's changes before making their own.

It does NOT mean "same millisecond." Two edits made hours apart are still "concurrent" if neither client synced in between.

## Reducing Conflict Surface Area: Cell-Level Storage

Separately from the LWW problem, we use cell-level storage where each column is a separate YKeyValue entry:

```typescript
// Each cell stored separately
Table = Y.Map<
	rowId,
	Y.Array<
		{ key: 'title'; val: '...' },
		{ key: 'views'; val: 100 },
		{ key: 'published'; val: true }
	>
>;
```

This means **different columns merge independently**:

```typescript
// User A edits title, User B edits views (different columns)
tables1.posts.update({ id: 'post-1', title: 'Updated by A' });
tables2.posts.update({ id: 'post-1', views: 100 });

// After sync: BOTH changes preserved!
// { title: 'Updated by A', views: 100 }
```

**Important**: Cell-level storage is orthogonal to the LWW problem. It reduces how often conflicts occur (different columns don't conflict), but when two users edit the **same column** while offline, the earlier-overwrites-later problem persists.

## When Timestamps Still Matter

For the remaining conflict case (same column, concurrent edits), timestamps provide predictable resolution. y-lwwmap uses this approach, adding a timestamp field to each entry:

```typescript
// Before
type Entry<T> = { key: string; val: T };

// After
type Entry<T> = { key: string; val: T; timestamp: number };
```

### Lamport-like Timestamps

Raw wall clock time has problems. Clocks drift between devices. We use synthetic timestamps inspired by Lamport clocks:

```typescript
private lastTimestamp = 0;

private getNextTimestamp(): number {
  const now = Date.now();
  this.lastTimestamp = Math.max(this.lastTimestamp + 1, now);
  return this.lastTimestamp;
}
```

This guarantees:

- Local operations always have monotonically increasing timestamps
- Even with slight clock drift, the system converges correctly
- Rapidly successive writes don't collide

### Conflict Resolution with Timestamps

During cleanup, instead of keeping the rightmost entry, we keep the one with the highest timestamp:

```typescript
// Before: position-based
if (addedVals.get(currVal.key) === currVal) {
	// This entry is rightmost, keep it
}

// After: timestamp-based
if (existing && existing.timestamp > currVal.timestamp) {
	// Existing is newer, remove this entry
	continue;
}
```

### Timestamp Collision Handling

y-lwwmap uses MD5 hashes to break ties when timestamps collide. We considered this but found it unnecessary for our use case. Millisecond-precision timestamps with Lamport incrementing makes collisions extremely rare.

If you need deterministic tie-breaking, comparing the hash of serialized values works:

```typescript
if (timestamp1 === timestamp2) {
	return hash(JSON.stringify(val1)) > hash(JSON.stringify(val2));
}
```

## What About Deletions?

y-lwwmap uses tombstones: entries with a timestamp but no value. To handle deletions correctly:

```typescript
// Tombstone: deletion at timestamp T
{ key: 'foo', timestamp: 1704672000000 }  // No value = deleted
```

This ensures a later deletion beats an earlier update, and vice versa.

We chose not to implement tombstones for two reasons:

1. **Deletions are rare in Epicenter.** All our deletions are explicit user actions (delete row, clear table). There's no automatic cleanup.

2. **Tombstones have storage cost.** They persist for a retention period (y-lwwmap defaults to 30 days) before being garbage collected.

For our use case, the delete-vs-update race condition is rare enough that we accept the unpredictability. If this changes, we can add tombstones later.

## Storage Overhead

Each entry grows by 8 bytes (the timestamp as a float64 in JSON). For typical row data of 100-1000 bytes, this is a 0.8-8% increase.

Given YKeyValue's 1935x improvement over Y.Map, 8 bytes per entry is negligible.

## The Lesson

CRDTs guarantee eventual consistency. All clients converge to the same state. But they don't guarantee the state you expect. Understanding your CRDT's conflict resolution semantics is critical for offline-first applications.

As one community member noted:

> "This is expected behavior. CRDT won't guarantee that result is always correct for each round, it only guarantees result is same for every client."
>
> Source: [GitHub issue #520 discussion](https://github.com/yjs/yjs/issues/520)

Two separate concerns:

1. **Conflict surface area (cell-level storage)**: By storing each column separately, different columns merge perfectly. This reduces how _often_ conflicts occur.

2. **Conflict resolution (timestamps vs positional)**: When conflicts _do_ occur (same cell, offline edits), positional resolution can cause earlier edits to overwrite later ones. Timestamps ensure chronological order.

These are orthogonal. Cell-level storage doesn't solve the LWW problem. It just makes conflicts rarer.

**Current state**: We use cell-level storage but haven't yet implemented timestamps. The earlier-overwrites-later problem persists when two users edit the same column while offline. For most use cases this is acceptable; if users report "my edit disappeared" issues, we'll add timestamps.

YKeyValue's positional resolution is acceptable when:

- Conflicts to the same cell are rare (cell-level helps here)
- Users are mostly online with fast sync
- The "winner" doesn't significantly impact user experience

Timestamp-based resolution is worth the overhead when:

- Users work offline for extended periods
- Users expect chronological precedence ("my later edit should stick")
- You need predictable behavior for debugging sync issues

## Current Decision (2026-01-27): Implemented as YKeyValueLww

After the journey of adding, removing, and re-adding YKeyValue, we implemented proper LWW timestamps in [PR #1286](https://github.com/EpicenterHQ/epicenter/pull/1286).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TWO IMPLEMENTATIONS, DIFFERENT TRADE-OFFS                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  YKeyValue (positional)           │  YKeyValueLww (timestamp)               │
│  ─────────────────────────────────┼─────────────────────────────────────────│
│  • Simpler, no clock dependency   │  • Intuitive "later edit wins"          │
│  • ~50% chance earlier wins       │  • 100% correct winner                  │
│  • Entry: { key, val }            │  • Entry: { key, val, ts }              │
│  • Best for real-time collab      │  • Best for offline-first               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

The static API (`create-kv`, `create-tables`, `table-helper`) now uses `YKeyValueLww` by default. Both implementations share the same API surface, making them drop-in replacements for each other.

See [specs/20260127T120000-ykeyvalue-dual-implementation.md](/specs/20260127T120000-ykeyvalue-dual-implementation.md) for guidance on when to use each.

---

## References

- [YKeyValue: The Most Interesting Meta Data Structure in Yjs](./ykeyvalue-meta-data-structure.md)
- [How We Cut Our Yjs Document Size by 1935x](./ykeyvalue-migration-storage-gains.md)
- [y-lwwmap: A Last-Write-Wins Alternative](./y-lwwmap-last-write-wins-alternative.md)
- [rozek/y-lwwmap](https://github.com/rozek/y-lwwmap): The implementation that inspired this work
- [Lamport timestamps](https://lamport.azurewebsites.net/pubs/time-clocks.pdf): The theoretical foundation
