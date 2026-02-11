# Y.Array Tombstones Are Tiny: Why Add/Delete Cycles Don't Bloat Your Doc

**TL;DR**: Y.Array deletions create tombstones that only store metadata, not the full value. After 5 cycles of adding and deleting 1,000 items, the Y.Doc stays at **2 bytes**.

> When you delete from Y.Array, Yjs keeps just enough metadata to know something was deleted. The actual data gets garbage collected.

> **Important**: This only applies when garbage collection is enabled (`gc: true`, the default). With `gc: false`, tombstones cannot be merged and will consume ~40 bytes each. See [YKeyValue vs Y.Map: Why One Setting Inverts Everything](./ykeyvalue-vs-ymap-decision-guide.md) for the full comparison.

Run this stress test with vanilla Yjs:

```typescript
import * as Y from 'yjs';

const ydoc = new Y.Doc();
const yarray = ydoc.getArray('data');

for (let cycle = 0; cycle < 5; cycle++) {
  // Add 1,000 items
  for (let i = 0; i < 1_000; i++) {
    yarray.push([{ id: `id-${i}`, title: `Post ${i}`, views: i }]);
  }

  // Delete all 1,000 items (from end to avoid index shifting)
  for (let i = 999; i >= 0; i--) {
    yarray.delete(i);
  }

  console.log(`Cycle ${cycle + 1}: ${Y.encodeStateAsUpdate(ydoc).byteLength} bytes`);
}
```

Output:

```
Cycle 1: 2 bytes
Cycle 2: 2 bytes
Cycle 3: 2 bytes
Cycle 4: 2 bytes
Cycle 5: 2 bytes
```

Five thousand inserts. Five thousand deletes. 2 bytes.

This isn't a bug. Y.Array tombstones work differently than Y.Map's history retention.

## Y.Map vs Y.Array: Two Different Strategies

```
Y.Map behavior (problematic for KV stores):
┌─────────────────────────────────────────────────────┐
│ map.set('row1', data1)  → stores data1              │
│ map.set('row1', data2)  → stores data1 AND data2    │
│ map.set('row1', data3)  → stores data1, data2, data3│
│                                                     │
│ Result: 100k updates = 100k values retained         │
└─────────────────────────────────────────────────────┘

Y.Array behavior:
┌─────────────────────────────────────────────────────┐
│ array.push(entry1)      → stores entry1             │
│ array.delete(0)         → tombstone (no data)       │
│ array.push(entry2)      → stores entry2             │
│ array.delete(0)         → tombstone (no data)       │
│                                                     │
│ Result: Only live entries consume space             │
└─────────────────────────────────────────────────────┘
```

Y.Map retains historical values because it needs them for CRDT conflict resolution. Y.Array only needs to know that position X was deleted, not what was there.

## The Numbers

| Scenario | Y.Doc Size |
|----------|------------|
| Empty Y.Array | 2 bytes |
| 1,000 items | ~72 KB |
| 1,000 items added then deleted | 2 bytes |
| 5 cycles of 1,000 add/delete | 2 bytes |
| 10,000 items retained | ~733 KB |

The pattern holds: live data determines size, not operation history.

## Why This Matters

Traditional databases worry about transaction logs and vacuum operations. With Y.Array:

1. Users can create and delete freely without doc bloat
2. Temporary data (drafts, scratch work) disappears cleanly
3. No garbage collection or compaction needed

The 2-byte floor is just the minimal Y.Doc structure metadata. Your actual data lives and dies cleanly.

This property makes Y.Array the ideal foundation for building key-value stores on top of Yjs. See [YKeyValue: A Space-Efficient Key-Value Store on Yjs](./ykeyvalue-space-efficient-kv-store.md) for how to exploit this for table-like data patterns.
