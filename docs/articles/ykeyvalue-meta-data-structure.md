# YKeyValue: The Most Interesting Meta Data Structure in Yjs

> **Note**: YKeyValue uses the same clientID-based conflict resolution as Y.Map under the hood.
> The original deprecation claimed "unpredictable LWW" behavior, but this was misleading—both
> Y.Map and YKeyValue resolve conflicts using Yjs's deterministic clientID ordering.
> YKeyValue remains useful for long-lived collaborative documents without epoch compaction.

YKeyValue is one of the most interesting meta Yjs data structures I've encountered.

I've talked before about how you can build complex data structures with Yjs primitives—often to make them more performant or more memory efficient. Well, this one takes the cake. It's also one of the few that's canonically inside the Yjs organization itself (in [yjs/y-utility](https://github.com/yjs/y-utility)).

The core insight: we represent something that _looks_ like a `Y.Map` (key-value pairs) using a `Y.Array` instead. And it works dramatically better for certain workloads.

## The Problem with Y.Map

A traditional `Y.Map` tracks way too much. Every time you call `ymap.set(key, value)`, Yjs creates a new internal item and tombstones the previous one. Those tombstones stick around—Yjs can't garbage collect them because a remote peer might have operations referencing them.

Here's what happens with alternating updates:

```typescript
ymap.set('a', 1); // Item 1: a=1
ymap.set('b', 1); // Item 2: b=1
ymap.set('a', 2); // Item 3: a=2, Item 1 tombstoned
ymap.set('b', 2); // Item 4: b=2, Item 2 tombstoned
// ... repeat 100k times
```

After 100k operations on 10 keys, you have 100k internal items. The document size scales with _operation count_, not with _current data size_.

The benchmark numbers are staggering:

| Operations | Keys | YKeyValue       | Y.Map           | Factor |
| ---------- | ---- | --------------- | --------------- | ------ |
| 100k       | 10   | **271 bytes**   | 524,985 bytes   | 1935x  |
| 100k       | 100  | **2,817 bytes** | 578,231 bytes   | 205x   |
| 500k       | 10   | **329 bytes**   | 2,684,482 bytes | 8160x  |

Y.Map grows with history. YKeyValue grows with current data.

## How YKeyValue Works

Instead of a map that tracks every historical value per key, YKeyValue stores entries in a `Y.Array`:

```typescript
// Internal structure
Y.Array<{ key: string; val: T }>;
```

When you "set" a key:

1. Find and delete the existing entry (if any)
2. Push a new `{ key, val }` object to the end of the array

```typescript
set(key, val) {
  this.doc.transact(() => {
    if (this.map.has(key)) {
      this.delete(key);  // Remove old entry
    }
    this.yarray.push([{ key, val }]);  // Append new entry
  });
}
```

The trick: `Y.Array` deletions are structural. When you delete an array element and it gets garbage collected, it's actually gone. With `Y.Map`, the tombstoned entry retains metadata forever because it's keyed by that specific map key.

YKeyValue maintains a local JavaScript `Map` for O(1) reads:

```typescript
get(key) {
  return this.map.get(key)?.val;
}
```

So reads are fast. You pay the cost on writes.

## The Tradeoff: Storage vs Write Performance

This is the real story. YKeyValue isn't strictly "better"—it's a different tradeoff:

| Aspect  | YKeyValue                | Y.Map                         |
| ------- | ------------------------ | ----------------------------- |
| Read    | O(1)                     | O(1)                          |
| Write   | O(n)                     | ~O(1)                         |
| Storage | Scales with current data | Scales with operation history |

The O(n) write cost comes from scanning the array to find and delete the old entry. For 10k rows, you're doing 10k iterations per write.

Why does this matter? Because for most "table-like" workloads:

- You have frequent reads (fast in both)
- You have occasional writes (O(n) is tolerable)
- You care about document size (YKeyValue wins dramatically)

If you're doing high-frequency writes on massive datasets, YKeyValue's linear scan becomes a problem. But for most collaborative apps—where you're syncing documents across devices, storing them in IndexedDB, sending them over the wire—storage efficiency dominates.

## Why Array Tracking Beats Map Tracking

The fundamental difference is in what the CRDT must retain.

**Y.Map tombstones retain the key.** A tombstoned map entry still knows it was for key `'a'`. This metadata is part of how Yjs resolves conflicts among entries for the same key. Every overwrite creates a new entry struct with that key embedded.

**Y.Array tombstones are positional.** A deleted array element becomes "there used to be something at position X." The application-level key (`'a'`) isn't embedded in the CRDT structure—it's inside the value object, which is gone.

So even though both use tombstones, map tombstones are heavier. They carry per-key conflict resolution metadata that array tombstones don't need.

YKeyValue exploits this. By encoding "current value for key" as "rightmost surviving entry with that key in an array," you get CRDT convergence without per-key overwrite chains.

## When to Use Each

**Use YKeyValue when:**

- Your values are JSON-serializable (no nested Y.Text/Y.Array)
- Updates are whole-object replaces or merges
- You have many keys that get updated over time
- Document size matters (sync, storage, bandwidth)

**Use Y.Map when:**

- You have a bounded set of keys (settings, config, metadata)
- Keys rarely change after creation
- You need nested collaborative types per value
- Write performance is critical and you'll handle compaction separately

## In Epicenter

We use YKeyValue for table storage. Tables have rows, rows have IDs, and rows change frequently. The storage savings are massive—we went from documents that ballooned after normal usage to documents that stay proportional to actual data.

The implementation is straightforward:

```typescript
const ytableArrays =
	ydoc.getMap<Y.Array<{ key: string; val: StoredRowData }>>('tables');
```

A `Y.Map` at the root (table names rarely change), with `YKeyValue`-backed arrays for each table's rows.

## The Lesson

Not every Yjs data structure maps directly to what you'd reach for in non-collaborative code. `Y.Map` looks like a map, but it doesn't _behave_ like one under repeated updates. Understanding the CRDT's internal tracking—what gets tombstoned, what retains metadata—lets you pick structures that match your actual access patterns.

YKeyValue is a meta structure: a map interface built on array primitives. It's uglier internally, but the results speak for themselves. 271 bytes vs 524,985 bytes isn't a minor optimization—it's the difference between a practical collaborative app and an unusable one.

## Update (2026-02-01): GC Setting Is the Hidden Variable

The benchmarks in this article assume `gc: true` (the default). **With `gc: false`, Y.Map is actually 2x more efficient than YKeyValue** because YKeyValue's tombstones can't be merged. See [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md) for the full comparison.

## Update (2026-01-08): When Y.Map Actually Works Better

After extensive benchmarking, we discovered that Y.Map's storage overhead is often acceptable for **realistic workloads**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  REALISTIC STORAGE NUMBERS (Y.Map of Y.Maps)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Scenario                    Data              Updates    Size              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Blog posts                  100 posts         110 edits  59 KB             │
│  User settings               1 user            100 edits  1.6 KB            │
│  Collaborative spreadsheet   10 rows           100 edits  3.2 KB            │
│  Worst case (counter)        1 key             1000 edits 17.5 KB           │
│                                                                             │
│  The 1935x benchmark used 100k updates on 10 keys - an extreme case.        │
│  Most apps won't hit this pattern.                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**The epoch-based compaction insight**: If your architecture includes epochs (versioned Y.Doc snapshots), you get **free compaction** via `Y.encodeStateAsUpdate()`. This strips all tombstone history, resetting storage to current state only.

```typescript
// Compact a Y.Doc by re-encoding current state
const snapshot = Y.encodeStateAsUpdate(dataDoc);
const freshDoc = new Y.Doc({ guid: dataDoc.guid });
Y.applyUpdate(freshDoc, snapshot);
// freshDoc has same content, no history overhead
```

**Decision tree**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  WHEN TO USE WHICH                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Use Y.Map when:                                                            │
│  • You have epoch-based compaction (snapshot strips history)                │
│  • You want zero custom CRDT code                                           │
│  • Updates are moderate (not 100k+ per key)                                 │
│  • You trust YJS's battle-tested implementation                             │
│                                                                             │
│  Use YKeyValue when:                                                        │
│  • You have extreme update frequency (counters, real-time data)             │
│  • You cannot use epoch-based compaction                                    │
│  • Storage must stay bounded without external intervention                  │
│                                                                             │
│  Consider YKeyValue-LWW when:                                               │
│  • Users complain about "wrong" conflict winners                            │
│  • Same-cell offline conflicts are common                                   │
│  • You need auditable "who won and why"                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

See [Native Y.Map Storage Architecture](/specs/20260108T084500-ymap-native-storage-architecture.md) for the full analysis.

---

## References

- [yjs/y-utility](https://github.com/yjs/y-utility): The canonical implementation
- [y-keyvalue.js source](https://github.com/yjs/y-utility/blob/main/y-keyvalue.js): See exactly how it works
- [Epicenter's TypeScript implementation](https://github.com/EpicenterHQ/epicenter/blob/main/packages/epicenter/src/core/utils/y-keyvalue.ts): Our local TypeScript port with no external dependencies
- [PR #1217: Port YKeyValue to TypeScript](https://github.com/EpicenterHQ/epicenter/pull/1217): The implementation PR

  > YKeyValue (from yjs/y-utility) solves this by storing {key, val} pairs in a Y.Array. When you set a key, it deletes the old entry and appends a new one. Y.Array tombstones are positional and get cleaned up, while Y.Map tombstones retain per-key metadata forever. We ported YKeyValue to TypeScript with no external dependencies and now use it for both table rows and KV settings.

- [Yjs internals discussion](https://discuss.yjs.dev/): Community discussions on map vs array tradeoffs

## Related

- [Migrating to YKeyValue: 1935x Storage Reduction](./ykeyvalue-migration-storage-gains.md): How we migrated Epicenter's table storage to YKeyValue
- [y-lwwmap: A Last-Write-Wins Alternative](./y-lwwmap-last-write-wins-alternative.md): Timestamp-based conflict resolution
- [Fractional Ordering: User-Controlled Item Order](./fractional-ordering-meta-data-structure.md): Drag-and-drop reordering without delete+insert
