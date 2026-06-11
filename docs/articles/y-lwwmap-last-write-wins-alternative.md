# y-lwwmap: A Last-Write-Wins Alternative to YKeyValue

There's another meta data structure in the Yjs ecosystem worth knowing about: [y-lwwmap](https://github.com/rozek/y-lwwmap). It solves a different problem than YKeyValue.

YKeyValue optimizes for storage efficiency. y-lwwmap optimizes for conflict resolution predictability.

## The Problem YKeyValue Doesn't Solve

YKeyValue is brilliant for storage. We've seen [1935x improvements](./ykeyvalue-migration-storage-gains.md) over Y.Map. But it has a subtle behavior that can surprise users during offline sync.

When two clients edit the same key offline and reconnect:

```typescript
// Client A (offline): sets key "foo" at 10:00am
ykeyvalue.set('foo', 'from-A');

// Client B (offline): sets key "foo" at 10:05am
ykeyvalue.set('foo', 'from-B');

// Both reconnect and sync
// Which value wins?
```

With YKeyValue: **unpredictable**. The winner depends on sync order, not chronology. Whoever's entry ends up rightmost in the internal array wins.

This mirrors how native Y.Map works. From dmonad:

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [dmonad, GitHub issue #520](https://github.com/yjs/yjs/issues/520)

This is fine for many use cases. But if users expect "my later edit should stick," it's confusing.

## How y-lwwmap Works

y-lwwmap takes a different approach: **timestamps determine the winner**. Later writes always supersede earlier ones.

The internal structure stores timestamps alongside values:

```typescript
// YKeyValue stores:
{ key: string, val: T }

// LWWMap stores:
{ Key: string, Value?: T, Timestamp: number }
```

Notice the optional `Value`. A missing value means "deleted". This is a tombstone entry.

### Synthetic Timestamps (Lamport-like)

Raw wall clock time has problems: clocks drift. Two clients might have different ideas about "now." y-lwwmap handles this with synthetic timestamps:

```typescript
const TimestampFactor = 3000; // allows ~3000 ops per ms

function getNextTimestamp() {
	return Math.max(lastTimestamp + 1, Date.now() * TimestampFactor);
}
```

This guarantees:

- Local operations always have monotonically increasing timestamps
- Even with slight clock drift, the system converges correctly
- Rapidly successive writes don't collide

When timestamps do collide (rare), MD5 hashes of the values break the tie deterministically.

### Tombstone Retention

Deletions are tricky in distributed systems. If Client A deletes a key at 10:00am and Client B updates it at 10:05am, the update should win. But if the deletion happened _after_ the update, the deletion should win.

y-lwwmap solves this by keeping tombstones:

```typescript
// Deletion at timestamp T
{ Key: 'foo', Timestamp: T }  // No Value = deleted

// Update at timestamp T+1
{ Key: 'foo', Value: 'bar', Timestamp: T+1 }  // This wins
```

Tombstones are kept for a configurable `RetentionPeriod` (default 30 days), then purged.

## The Tradeoff

| Aspect              | YKeyValue              | LWWMap                           |
| ------------------- | ---------------------- | -------------------------------- |
| Conflict Resolution | Positional (rightmost) | Timestamp (chronological)        |
| Predictability      | Sync-order dependent   | Last write wins                  |
| Deletion Handling   | Immediate removal      | Tombstones with retention        |
| Memory Overhead     | Lower                  | Higher (timestamps + tombstones) |
| Dependencies        | lib0 only              | lib0 + blueimp-md5               |
| Complexity          | ~180 lines             | ~450 lines                       |

## When to Use Which

**Use YKeyValue when:**

- You don't care which concurrent edit "wins"
- Clients are usually online and syncing immediately
- You want minimal overhead
- Deletions are rare

**Use LWWMap when:**

- Users work offline and reconnect later
- "Last write wins" semantics matter to users
- Deletions must propagate correctly after reconnection
- You can tolerate the extra memory for tombstones

## The Middle Ground

For many apps, neither extreme is ideal. If you rarely delete keys but want predictable conflict resolution, you could:

1. Use YKeyValue for storage efficiency
2. Add your own timestamp field to values
3. Resolve conflicts in application code

This gets you most of LWWMap's benefits without the tombstone overhead:

```typescript
type TimestampedValue<T> = {
	data: T;
	updatedAt: number;
};

// On sync conflict, compare updatedAt
```

The downside: you're responsible for conflict resolution logic that LWWMap handles automatically.

## In Practice

y-lwwmap is a drop-in replacement for YKeyValue. Same API, different internals. If you're hitting sync predictability issues with YKeyValue, it's worth evaluating.

That said, most collaborative apps can live with YKeyValue's behavior. The "random winner" scenario only matters when users actually notice which edit survived. And often they don't.

## Update (2026-01-27): We Built YKeyValueLww

We implemented our own LWW solution: `YKeyValueLww`. See [PR #1286](https://github.com/EpicenterHQ/epicenter/pull/1286).

```typescript
import { YKeyValueLww } from 'epicenter/core/utils/y-keyvalue-lww';

const kv = new YKeyValueLww(yarray);
kv.set('title', 'Final');  // Automatically timestamped
```

Key differences from y-lwwmap:

| Aspect | y-lwwmap | YKeyValueLww |
|--------|----------|--------------|
| Tie-breaker | MD5 hash | Positional (rightmost) |
| Tombstones | Yes (30-day retention) | No (immediate deletion) |
| Dependencies | lib0 + blueimp-md5 | lib0 only |
| Timestamp factor | 3000x (sub-ms precision) | 1x (ms precision + increment) |

We chose simpler defaults: millisecond timestamps with monotonic increment handle same-ms collisions, and positional tiebreaker for the rare equal-timestamp case. No tombstones means deletions don't propagate correctly in all edge cases, but that's acceptable for our use case where deletions are rare explicit user actions.

**When to use which**:

```
┌────────────────────────────────────────────────────────────────┐
│  Scenario                         │  Recommendation            │
├───────────────────────────────────┼────────────────────────────┤
│  Real-time collab, simple cases   │  YKeyValue (positional)    │
│  Offline-first, multi-device      │  YKeyValueLww (timestamp)  │
│  Need tombstone deletions         │  y-lwwmap                  │
│  Clock sync unreliable            │  YKeyValue (no clock dep)  │
└────────────────────────────────────────────────────────────────┘
```

---

## References

- [rozek/y-lwwmap](https://github.com/rozek/y-lwwmap): The implementation
- [yjs/y-utility](https://github.com/yjs/y-utility): Canonical YKeyValue implementation
- [YKeyValue deep dive](./ykeyvalue-meta-data-structure.md): How YKeyValue works internally
- [Yjs issue 520](https://github.com/yjs/yjs/issues/520): Discussion of conflict resolution unpredictability

## Related

- [YKeyValue: The Most Interesting Meta Data Structure in Yjs](./ykeyvalue-meta-data-structure.md)
- [How We Cut Our Yjs Document Size by 1935x](./ykeyvalue-migration-storage-gains.md)
- [Fractional Ordering: User-Controlled Item Order](./fractional-ordering-meta-data-structure.md): Drag-and-drop reordering without delete+insert
