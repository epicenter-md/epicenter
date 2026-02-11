# YKeyValue vs Y.Map: Garbage Collection Is the Hidden Variable

**TL;DR: YKeyValueLww destroys Y.Map in storage benchmarks—but only when garbage collection is enabled. Turn GC off and Y.Map wins. This single boolean flips the entire recommendation.**

> The choice between Y.Map and YKeyValue isn't about the data structure. It's about whether you need revision history.

We built YKeyValueLww as a space-efficient key-value store on top of Yjs. The benchmarks were incredible: 200x-900x smaller than Y.Map for update-heavy workloads. We wrote articles about it. We migrated our entire codebase.

Then we ran the benchmark with `gc: false`.

## The Benchmark That Changed Everything

Same operations. Same data. One boolean difference.

```
Scenario: 10 keys × 1,000 alternating updates
┌────────────────────────────────────────────────────────────┐
│                        GC: true         GC: false          │
├────────────────────────────────────────────────────────────┤
│  Y.Map                  88 KB            197 KB            │
│  YKeyValueLww          446 B             392 KB            │
├────────────────────────────────────────────────────────────┤
│  Winner            YKeyValueLww          Y.Map             │
│  Ratio                 202x               0.5x             │
└────────────────────────────────────────────────────────────┘

Scenario: Add/delete 500 items × 5 cycles
┌────────────────────────────────────────────────────────────┐
│                        GC: true         GC: false          │
├────────────────────────────────────────────────────────────┤
│  Y.Map                  26 KB             52 KB            │
│  YKeyValueLww           27 B             104 KB            │
├────────────────────────────────────────────────────────────┤
│  Winner            YKeyValueLww          Y.Map             │
│  Ratio                 973x               0.5x             │
└────────────────────────────────────────────────────────────┘
```

With GC on, YKeyValueLww is 973x smaller. With GC off, Y.Map is 2x smaller. The data structure that's "obviously better" completely inverts based on one setting.

## Why This Happens

YKeyValueLww works by deleting the old entry and pushing a new one for every update:

```
kv.set('user', { name: 'Alice' })
  → push({key:'user', val:{name:'Alice'}, ts:1000})

kv.set('user', { name: 'Alicia' })
  → delete old entry (becomes tombstone)
  → push({key:'user', val:{name:'Alicia'}, ts:1001})
```

With GC enabled, Yjs merges adjacent tombstones into compact GC structs. A thousand deletes become a few bytes of metadata.

With GC disabled, every tombstone is preserved individually. A thousand updates create a thousand tombstones, each ~40 bytes. The space efficiency vanishes.

Y.Map has the opposite profile. It retains historical values directly (not as tombstones), so GC has minimal effect:

```
With GC on:   Y.Map compacts history    → 88 KB
With GC off:  Y.Map keeps raw history   → 197 KB  (2.2x larger)

With GC on:   YKeyValueLww compacts tombstones → 446 B
With GC off:  YKeyValueLww keeps all tombstones → 392 KB  (878x larger!)
```

YKeyValueLww's storage explodes 878x when GC is disabled. Y.Map only doubles.

## The Write-Once Exception

For data that's written once and never updated, neither structure benefits from GC:

```
Scenario: 1,000 unique keys, written once
┌────────────────────────────────────────────────────────────┐
│                        GC: true         GC: false          │
├────────────────────────────────────────────────────────────┤
│  Y.Map                  26 KB             26 KB            │
│  YKeyValueLww           41 KB             41 KB            │
├────────────────────────────────────────────────────────────┤
│  Winner                Y.Map             Y.Map             │
│  Ratio                  0.6x              0.6x             │
└────────────────────────────────────────────────────────────┘
```

Y.Map is 40% smaller for write-once data because YKeyValueLww has per-entry overhead from the timestamp and array structure. No updates means no tombstones, so GC has nothing to do.

## The Decision Matrix

```
                    ┌─────────────────┬─────────────────┐
                    │    GC: true     │    GC: false    │
                    │  (no history)   │ (with history)  │
┌───────────────────┼─────────────────┼─────────────────┤
│ Frequent updates  │  YKeyValueLww   │     Y.Map       │
│ (same keys)       │    (200-900x)   │     (2x)        │
├───────────────────┼─────────────────┼─────────────────┤
│ Write-once data   │     Y.Map       │     Y.Map       │
│ (immutable)       │    (1.6x)       │     (1.6x)      │
└───────────────────┴─────────────────┴─────────────────┘
```

The pattern: YKeyValueLww wins exactly when (a) keys are updated frequently AND (b) GC is enabled. Otherwise, Y.Map wins or ties.

## What GC Actually Controls

Yjs garbage collection (`doc.gc`) isn't about freeing memory in the JavaScript heap. It controls whether tombstones can be merged and compacted in the serialized document state.

```typescript
const doc = new Y.Doc({ gc: true }); // Default: tombstones get merged
const doc = new Y.Doc({ gc: false }); // Tombstones preserved for snapshots
```

When `gc: false`, Yjs preserves the full operation history. This enables features like version snapshots (think Google Docs revision history) where you can restore any previous state. But it means every delete operation lives forever.

YKeyValueLww's entire value proposition is deleting old entries and relying on GC to clean them up. Disable GC and you're paying for both the new entry AND the tombstone of the old entry on every update.

## How This Changed Our Architecture

We're building Epicenter, a local-first workspace platform. We have two API surfaces: a "dynamic" API for real-time collaboration and a "static" API for batch operations.

Originally we thought the choice was simple: always use YKeyValueLww for better storage. The GC benchmark revealed we actually have a 2×2 matrix:

```
                    ┌─────────────────┬─────────────────┐
                    │  Without        │  With           │
                    │  Revision       │  Revision       │
                    │  History        │  History        │
┌───────────────────┼─────────────────┼─────────────────┤
│ Dynamic API       │  YKeyValueLww   │     Y.Map       │
│ (real-time)       │  gc: true       │     gc: false   │
├───────────────────┼─────────────────┼─────────────────┤
│ Static API        │  YKeyValueLww   │     Y.Map       │
│ (batch ops)       │  gc: true       │     gc: false   │
└───────────────────┴─────────────────┴─────────────────┘
```

Four implementations. Two API shapes. The underlying data structure is determined entirely by whether the user wants revision history.

This was actually liberating. Instead of one "best" solution that we'd need to justify everywhere, we have a clear rule: check if revision history is needed. That single boolean picks the implementation. No judgment calls.

## The Benchmark Code

Run this yourself to see the difference:

```typescript
import * as Y from 'yjs';
import { YKeyValueLww } from './y-keyvalue-lww';

function benchmark(gc: boolean) {
	// YKeyValueLww
	const ykvDoc = new Y.Doc({ gc });
	const yarray = ykvDoc.getArray('data');
	const ykv = new YKeyValueLww(yarray);

	for (let round = 0; round < 1000; round++) {
		for (let k = 0; k < 10; k++) {
			ykv.set(`key-${k}`, { value: round * 10 + k });
		}
	}

	// Y.Map
	const ymapDoc = new Y.Doc({ gc });
	const ymap = ymapDoc.getMap('data');

	for (let round = 0; round < 1000; round++) {
		for (let k = 0; k < 10; k++) {
			ymap.set(`key-${k}`, { value: round * 10 + k });
		}
	}

	console.log(`GC: ${gc}`);
	console.log(
		`  YKeyValueLww: ${Y.encodeStateAsUpdate(ykvDoc).byteLength} bytes`,
	);
	console.log(
		`  Y.Map:        ${Y.encodeStateAsUpdate(ymapDoc).byteLength} bytes`,
	);
}

benchmark(true);
benchmark(false);
```

Output:

```
GC: true
  YKeyValueLww: 446 bytes
  Y.Map:        90061 bytes

GC: false
  YKeyValueLww: 401780 bytes
  Y.Map:        201685 bytes
```

## The Lesson

Benchmarks without context are dangerous. We benchmarked YKeyValueLww with the default settings (`gc: true`) and declared victory. We never questioned whether that default applied to all our use cases.

The GC setting isn't obscure. It's on the front page of the Y.Doc API docs. We just didn't think it was relevant to our storage benchmarks because we didn't understand the mechanism.

Now we know: YKeyValueLww's efficiency comes from generating tombstones that GC can merge. Disable GC and you're not using a space-efficient data structure—you're using a space-inefficient one that happens to have a nice API.

---

**Related:**

- [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md): TL;DR version with decision matrix
- [Yjs Storage: The Complete GC On vs Off Guide](./yjs-gc-on-vs-off-storage-guide.md): Deep dive into the mechanics
- [YKeyValue: A Space-Efficient Key-Value Store](./ykeyvalue-space-efficient-kv-store.md): How YKeyValueLww works internally
- [Y.Array Tombstones Are Tiny](./y-array-tombstones-are-tiny.md): Why deletions don't bloat Y.Array (when GC is on)

**References:**

- [Y.Doc API](https://docs.yjs.dev/api/y.doc): The `gc` option documentation
- [Yjs Internals](https://github.com/yjs/yjs/blob/main/INTERNALS.md): How tombstones and GC structs work
