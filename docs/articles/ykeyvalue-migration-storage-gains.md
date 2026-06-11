# How We Cut Our Yjs Document Size by 1935x

> **Deprecated (2026-01-08)**: We reverted this YKeyValue migration. The 1935x benchmark was
> a worst-case comparison against uncompacted Y.Map. With epoch-based compaction, native Y.Map
> is actually ~6% smaller. The dramatic gains didn't materialize in practice, and YKeyValue's
> unpredictable conflict resolution (earlier edits overwriting later ones) was a footgun.
> See [PR #1226](https://github.com/EpicenterHQ/epicenter/pull/1226) for the revert.

We were building a collaborative app with Yjs when we hit a wall: documents kept growing. A workspace that should have been a few KB was ballooning to hundreds of KB after normal usage. Users were complaining about slow sync times.

The culprit? Y.Map.

## The Problem

Yjs is a CRDT library. CRDTs solve a hard problem: when two users edit simultaneously without coordination, how do you merge their changes? The answer involves keeping historical context.

Y.Map keeps _all_ historical context. When you call `ymap.set('key', value)`, Yjs doesn't just overwrite the old value. It creates a new internal item and tombstones the previous one. Those tombstones stick around forever because a remote peer might have operations referencing them.

Here's what happens with alternating updates:

```typescript
ymap.set('row1', data1); // 1 item stored
ymap.set('row2', data2); // 2 items stored
ymap.set('row1', data3); // 3 items stored (old row1 tombstoned, not deleted)
ymap.set('row2', data4); // 4 items stored
// ... repeat 100k times
```

After 100k operations on 10 keys, you have 100k internal items. Document size scales with _operation count_, not _current data size_.

For a table with 10 rows that gets updated frequently? Disaster.

## The Discovery

Buried in the Yjs organization is [y-utility](https://github.com/yjs/y-utility), a collection of helper structures. One of them is YKeyValue, and it's brilliant.

The insight: represent a map using a Y.Array instead.

```typescript
// Instead of Y.Map<T>
// Use Y.Array<{ key: string; val: T }>
```

When you "set" a key: delete the old entry for that specific key, push a new `{ key, val }` to the end. Other keys are untouched. When you "get": maintain an in-memory Map for O(1) lookups (rebuilt on init, updated via observer). Each key operates independently; updating one key doesn't affect others.

Why does this work? Y.Array tombstones are _positional_. A deleted array element becomes "there used to be something at position X." The application-level key isn't embedded in the CRDT structure; it's inside the value object, which is gone.

Y.Map tombstones retain the key. Every overwrite creates a new entry struct with that key embedded, forever.

## The Numbers

We benchmarked 100k operations on 10 keys:

| Structure       | Size          |
| --------------- | ------------- |
| Y.Map           | 524,985 bytes |
| YKeyValue       | 271 bytes     |
| **Improvement** | **1935x**     |

At 500k operations on 10 keys, the gap widens to 8160x.

Y.Map grows with history. YKeyValue grows with current data.

## The Tradeoff

Nothing is free. YKeyValue trades write performance for storage:

| Operation | YKeyValue    | Y.Map             |
| --------- | ------------ | ----------------- |
| Read      | O(1)         | O(1)              |
| Write     | O(n)         | ~O(1)             |
| Storage   | Current data | Operation history |

The O(n) write cost comes from scanning the array to find and delete the old entry. For 10k rows, that's 10k iterations per write.

But for most collaborative apps:

- Reads are frequent (fast in both)
- Writes are occasional (O(n) is tolerable)
- Document size matters (sync, storage, bandwidth)

If you're doing high-frequency writes on massive datasets, YKeyValue's linear scan becomes a problem. For everything else, the storage win dominates.

## When to Use Each

**Use YKeyValue when:**

- Values are JSON-serializable (no nested Y.Text/Y.Array)
- Each key's value is replaced entirely on update (not partial field merges)
- Keys get updated over time
- Document size matters

**Use Y.Map when:**

- You have a bounded set of keys (settings, config)
- Keys rarely change after creation
- You need nested collaborative types per value
- Write performance is critical

## Our Implementation

We ported YKeyValue to TypeScript with no external dependencies. Tables now use it for row storage:

```typescript
const ytableArrays = ydoc.getMap<Y.Array<{ key: string; val: Row }>>('tables');
```

A Y.Map at the root (table names rarely change), with YKeyValue-backed arrays for each table's rows.

The migration was straightforward. Our documents went from ballooning after normal usage to staying proportional to actual data. Sync is fast again.

## The Lesson

Y.Map looks like a map, but it doesn't _behave_ like one under repeated updates. Understanding what CRDTs retain internally, what gets tombstoned, what retains metadata, lets you pick structures that match your actual access patterns.

YKeyValue is a meta structure: a map interface built on array primitives. It's uglier internally, but 271 bytes vs 524,985 bytes isn't a minor optimization. It's the difference between a practical collaborative app and an unusable one.

## Update (2026-01-08): Epoch-Based Compaction Changes the Calculus

Our benchmarks used an extreme case: 100k updates on 10 keys. In realistic scenarios, Y.Map's overhead is often acceptable:

| Scenario           | Updates     | Y.Map Size | Acceptable? |
| ------------------ | ----------- | ---------- | ----------- |
| 100 blog posts     | 110 edits   | 59 KB      | Yes         |
| User settings      | 100 changes | 1.6 KB     | Yes         |
| Collab spreadsheet | 100 edits   | 3.2 KB     | Yes         |

More importantly, if your architecture includes **epochs** (versioned workspace snapshots), you get free compaction:

```typescript
// Compact any Y.Doc by re-encoding current state
const snapshot = Y.encodeStateAsUpdate(dataDoc);
const freshDoc = new Y.Doc({ guid: dataDoc.guid });
Y.applyUpdate(freshDoc, snapshot);
// freshDoc has same content, NO tombstone history
```

This works for Y.Map too, not just YKeyValue. The 1935x benchmark assumes no compaction ever happens, which isn't true in an epoch-based architecture.

See [Native Y.Map Storage Architecture](/specs/20260108T084500-ymap-native-storage-architecture.md) for the full analysis.

---

**References:**

- [yjs/y-utility](https://github.com/yjs/y-utility): The canonical implementation
- [YKeyValue deep dive](./ykeyvalue-meta-data-structure.md): Technical details on how it works
- [PR #1217: Port YKeyValue to TypeScript](https://github.com/EpicenterHQ/epicenter/pull/1217): Our TypeScript implementation

  > YKeyValue (from yjs/y-utility) solves this by storing {key, val} pairs in a Y.Array. When you set a key, it deletes the old entry and appends a new one. Y.Array tombstones are positional and get cleaned up, while Y.Map tombstones retain per-key metadata forever. We ported YKeyValue to TypeScript with no external dependencies and now use it for both table rows and KV settings.
