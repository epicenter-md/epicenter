# YKeyValue: A Space-Efficient Key-Value Store on Yjs

**TL;DR**: By building a key-value store on Y.Array instead of Y.Map, we get **1935x better space efficiency** for update-heavy workloads. 100k operations on 10 keys: 271 bytes vs 524,985 bytes.

> Y.Map retains all historical values. Y.Array tombstones are tiny. Build your KV store on Y.Array.

> **Important**: These benchmarks assume `gc: true` (the default). With `gc: false` (needed for version history/snapshots), Y.Map is actually 2x MORE efficient because YKeyValue's tombstones can't be merged. See [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md) for the full comparison.

## The Problem with Y.Map

Y.Map looks like the obvious choice for key-value data. But it has a fatal flaw for update-heavy patterns:

```typescript
const ymap = ydoc.getMap('settings');

// Update the same key 1000 times
for (let i = 0; i < 1000; i++) {
  ymap.set('theme', { mode: 'dark', version: i });
}

Y.encodeStateAsUpdate(ydoc).byteLength;  // ~50KB for ONE key!
```

Y.Map keeps every historical value for CRDT conflict resolution. For collaborative text editing, this makes sense. For key-value storage where you only care about the current value, it's catastrophic.

## The Solution: Append-and-Cleanup

YKeyValue uses Y.Array with a simple strategy:

```
set('user-1', {name: 'Alice'})
┌────────────────────────────────────────┐
│ 1. Push new entry to end of array      │
│    [{key:'user-1', val:{name:'Alice'}}]│
│                                        │
│ 2. Delete any old entry with same key  │
│    (becomes tiny tombstone)            │
└────────────────────────────────────────┘

set('user-1', {name: 'Alicia'})  // Update
┌────────────────────────────────────────┐
│ 1. Push new entry                      │
│    [..., {key:'user-1', val:'Alicia'}] │
│                                        │
│ 2. Delete old 'user-1' entry           │
│    (old value garbage collected)       │
│                                        │
│ Result: Still just ONE entry per key   │
└────────────────────────────────────────┘
```

The magic comes from [Y.Array's tombstone behavior](./y-array-tombstones-are-tiny.md): deletions only store metadata, not the value.

## Stress Test: 100k Operations

```typescript
import * as Y from 'yjs';
import { YKeyValue } from './y-keyvalue';

const ydoc = new Y.Doc();
const yarray = ydoc.getArray('data');
const kv = new YKeyValue(yarray);

// Hammer 10 keys with 100k total operations
for (let i = 0; i < 100_000; i++) {
  kv.set(`key-${i % 10}`, { value: i, data: 'some payload' });
}

console.log(`Final size: ${Y.encodeStateAsUpdate(ydoc).byteLength} bytes`);
console.log(`Keys in store: ${kv.map.size}`);
```

Output:

```
Final size: 271 bytes
Keys in store: 10
```

271 bytes. After 100,000 updates. Each key was overwritten 10,000 times, but only the final 10 values exist.

| Approach | Size after 100k ops | Per-key overhead |
|----------|---------------------|------------------|
| YKeyValue (Y.Array) | 271 bytes | ~27 bytes |
| Y.Map | 524,985 bytes | ~52,498 bytes |
| **Improvement** | **1935x smaller** | |

## YKeyValueLww: Same Efficiency, Better Conflict Resolution

The timestamp-based variant adds 8 bytes per entry for last-write-wins semantics:

```typescript
// YKeyValue entry
{ key: 'user-1', val: { name: 'Alice' } }

// YKeyValueLww entry
{ key: 'user-1', val: { name: 'Alice' }, ts: 1706200000000 }
```

Same stress test with YKeyValueLww:

```typescript
const kv = new YKeyValueLww(yarray);

for (let i = 0; i < 100_000; i++) {
  kv.set(`key-${i % 10}`, { value: i });
}

Y.encodeStateAsUpdate(ydoc).byteLength;  // 356 bytes
```

| Variant | Size (100k ops) | Overhead vs YKeyValue |
|---------|-----------------|----------------------|
| YKeyValue | 271 bytes | baseline |
| YKeyValueLww | 356 bytes | +31% (timestamp field) |

The timestamp adds ~8 bytes per entry but enables proper offline-first conflict resolution where the later edit wins, regardless of sync order.

## Add/Delete Cycles: No Bloat

```typescript
for (let cycle = 0; cycle < 5; cycle++) {
  // Add 1,000 entries
  for (let i = 0; i < 1_000; i++) {
    kv.set(`id-${i}`, { title: `Post ${i}` });
  }

  // Delete all 1,000
  for (let i = 0; i < 1_000; i++) {
    kv.delete(`id-${i}`);
  }

  console.log(`Cycle ${cycle + 1}: ${Y.encodeStateAsUpdate(ydoc).byteLength} bytes`);
}
```

```
Cycle 1: 34 bytes
Cycle 2: 34 bytes
Cycle 3: 34 bytes
Cycle 4: 34 bytes
Cycle 5: 34 bytes
```

Five thousand inserts, five thousand deletes. Back to 34 bytes every time. The Y.Array tombstones consume essentially nothing.

## How It Works

```
User calls kv.set('foo', value)
         │
         ▼
┌─────────────────────────────┐
│ Check: does 'foo' exist?    │
│        this.map.has('foo')  │
└─────────────────────────────┘
         │
    ┌────┴────┐
    │         │
   Yes        No
    │         │
    ▼         │
┌─────────┐   │
│ Delete  │   │
│ old     │   │
│ entry   │   │
└─────────┘   │
    │         │
    └────┬────┘
         │
         ▼
┌─────────────────────────────┐
│ Push new entry to Y.Array   │
│ yarray.push([{key, val}])   │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Observer fires, updates     │
│ in-memory Map for O(1) gets │
└─────────────────────────────┘
```

The in-memory Map gives O(1) lookups. The Y.Array provides CRDT sync. Deletions become tiny tombstones. Everyone wins.

## When to Use Which

| Use Case | Recommendation |
|----------|----------------|
| Real-time collab, reliable clocks | YKeyValue |
| Offline-first, multi-device | YKeyValueLww |
| Heavy update frequency | Either (both are space-efficient) |
| Need "last edit wins" semantics | YKeyValueLww |

Both variants inherit Y.Array's space efficiency. The choice is about conflict resolution strategy, not storage overhead.
