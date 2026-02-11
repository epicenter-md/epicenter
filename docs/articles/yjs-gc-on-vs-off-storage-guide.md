# Yjs Storage: The Complete GC On vs Off Guide

**TL;DR: With garbage collection ON, YKeyValue-style structures are 100-1000x smaller than Y.Map for update-heavy data. With GC OFF, Y.Map is 2x smaller. The GC setting determines which data structure wins.**

> Y.Map retains values. Y.Array retains tombstones. GC compacts tombstones but not values. This asymmetry is everything.

## How Each Structure Stores Updates

When you update the same key repeatedly, Y.Map and YKeyValue handle it differently:

```
Y.Map: Retains historical values
───────────────────────────────────────────────────────────
  map.set('x', 'A')  →  [value: 'A']
  map.set('x', 'B')  →  [value: 'A', value: 'B']
  map.set('x', 'C')  →  [value: 'A', value: 'B', value: 'C']

  After 1000 updates: 1000 values stored
  Each value: ~10-50 bytes depending on content

YKeyValue: Deletes old, appends new (creates tombstones)
───────────────────────────────────────────────────────────
  kv.set('x', 'A')   →  [entry: {key:'x', val:'A'}]
  kv.set('x', 'B')   →  [tombstone, entry: {key:'x', val:'B'}]
  kv.set('x', 'C')   →  [tombstone, tombstone, entry: {key:'x', val:'C'}]

  After 1000 updates: 1 value + 999 tombstones
  Tombstones: metadata only (no value content)
```

The key insight: Y.Map stores actual values in history. YKeyValue stores tombstones (deleted markers).

## What Garbage Collection Does

GC controls whether Yjs can merge and compact tombstones:

```
With GC ON (default):
───────────────────────────────────────────────────────────
  Y.Map:        values compacted somewhat     → moderate savings
  YKeyValue:    tombstones merged aggressively → massive savings

  [tomb][tomb][tomb][tomb][entry]
         ↓ GC merges adjacent tombstones
  [GC-struct: 4 items deleted][entry]
         ↓ further compaction
  [minimal metadata][entry]

With GC OFF:
───────────────────────────────────────────────────────────
  Y.Map:        all values preserved          → ~2x baseline
  YKeyValue:    all tombstones preserved      → ~800x baseline!

  [tomb][tomb][tomb][tomb][entry]
         ↓ nothing merged
  [tomb][tomb][tomb][tomb][entry]   (each ~40 bytes)
```

YKeyValue depends on GC to clean up its tombstones. Without GC, every update leaves permanent debris.

## The Numbers

Benchmarked: 10 keys updated 1000 times each (10,000 total operations).

```
┌─────────────────┬──────────────┬──────────────┬─────────────┐
│                 │   GC: true   │  GC: false   │    Δ GC     │
├─────────────────┼──────────────┼──────────────┼─────────────┤
│ Y.Map           │    88 KB     │    197 KB    │    2.2x     │
│ YKeyValueLww    │   446 B      │    392 KB    │    878x     │
├─────────────────┼──────────────┼──────────────┼─────────────┤
│ Ratio           │ YKV is 202x  │ Y.Map is 2x  │             │
│                 │   smaller    │   smaller    │             │
└─────────────────┴──────────────┴──────────────┴─────────────┘
```

Y.Map grows 2.2x when GC is disabled. YKeyValueLww grows 878x. That's the asymmetry.

## Why The Asymmetry Exists

Y.Map stores the actual value content in each historical entry. Disabling GC means keeping those values, but values were always being stored anyway; GC just affects how they're packed.

YKeyValueLww stores tombstones for deleted entries. With GC on, hundreds of tombstones merge into a single compact struct. With GC off, each tombstone is a separate item with its own metadata overhead.

```
Cost per update:
───────────────────────────────────────────────────────────
                        GC ON           GC OFF

Y.Map value             ~10 bytes       ~20 bytes
  (compacted)           (merged)        (separate)

YKeyValue tombstone     ~0.5 bytes      ~40 bytes
  (after merge)         (merged)        (separate, full metadata)

YKeyValue entry         ~30 bytes       ~30 bytes
  (current value)       (same)          (same)
```

With GC on, YKeyValue's tombstones are essentially free. With GC off, they're 4x more expensive than Y.Map's values.

## Add/Delete Cycles

The difference is even more dramatic for data that's created and deleted:

```
Scenario: Add 500 items, delete all, repeat 5 times
───────────────────────────────────────────────────────────
┌─────────────────┬──────────────┬──────────────┐
│                 │   GC: true   │  GC: false   │
├─────────────────┼──────────────┼──────────────┤
│ Y.Map           │    26 KB     │     52 KB    │
│ YKeyValueLww    │    27 B      │    104 KB    │
├─────────────────┼──────────────┼──────────────┤
│ Ratio           │  YKV 973x    │  Y.Map 2x    │
│                 │   smaller    │   smaller    │
└─────────────────┴──────────────┴──────────────┘
```

With GC on, YKeyValueLww returns to 27 bytes after all deletions; the tombstones get merged away. With GC off, every delete operation is preserved forever.

## Write-Once Data

For data that's never updated, neither structure benefits from GC:

```
Scenario: 1000 unique keys, each written once
───────────────────────────────────────────────────────────
┌─────────────────┬──────────────┬──────────────┐
│                 │   GC: true   │  GC: false   │
├─────────────────┼──────────────┼──────────────┤
│ Y.Map           │    26 KB     │     26 KB    │
│ YKeyValueLww    │    41 KB     │     41 KB    │
├─────────────────┼──────────────┼──────────────┤
│ Winner          │    Y.Map     │    Y.Map     │
│                 │    (1.6x)    │    (1.6x)    │
└─────────────────┴──────────────┴──────────────┘
```

Y.Map is 60% smaller for immutable data. YKeyValueLww has per-entry overhead from storing `{ key, val, ts }` in an array structure vs Y.Map's direct key-value storage.

## Decision Guide

```
┌────────────────────────────────────┬────────────┬──────────────┐
│           Your Use Case            │ GC Setting │ Best Choice  │
├────────────────────────────────────┼────────────┼──────────────┤
│ Normal operation, frequent updates │ GC ON      │ YKeyValueLww │
├────────────────────────────────────┼────────────┼──────────────┤
│ Need version history/snapshots     │ GC OFF     │ Y.Map        │
├────────────────────────────────────┼────────────┼──────────────┤
│ Write-once data (immutable)        │ Either     │ Y.Map        │
├────────────────────────────────────┼────────────┼──────────────┤
│ Offline-first + LWW semantics      │ GC ON      │ YKeyValueLww │
└────────────────────────────────────┴────────────┴──────────────┘
```

The rule is simple: if you need `gc: false` for any reason (snapshots, version history, debugging), use Y.Map. YKeyValueLww only makes sense when GC can do its job.

## Why You'd Disable GC

Yjs snapshots require `gc: false` to work. A snapshot captures the document state at a point in time, and restoring it requires the full operation history.

```typescript
// This requires gc: false
const snapshot = Y.snapshot(doc);

// Later...
const historicalState = Y.createDocFromSnapshot(doc, snapshot);
```

If you're building revision history (like Google Docs' version history), you need GC off. If you're building a normal collaborative app without time travel, keep GC on.

## Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                         GC ON (default)                         │
├─────────────────────────────────────────────────────────────────┤
│  Y.Map: Historical values get compacted into GC structs (tiny)  │
│  YKeyValue: Tombstones from deletes get merged (tiny)           │
│  Result: YKeyValue wins massively for update-heavy data         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                            GC OFF                               │
├─────────────────────────────────────────────────────────────────┤
│  Y.Map: Keeps all historical values (~10-20 bytes each)         │
│  YKeyValue: Keeps ALL tombstones (~40 bytes each, unmerged!)    │
│  Result: Y.Map wins because tombstones > values                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       Write-Once Data                           │
├─────────────────────────────────────────────────────────────────┤
│  No updates = no tombstones = no GC benefit                     │
│  Y.Map is ~60% smaller due to less per-entry overhead           │
│  Result: Y.Map wins regardless of GC setting                    │
└─────────────────────────────────────────────────────────────────┘
```

The GC setting isn't a performance tuning knob. It's a feature flag that determines which data structure is appropriate for your use case.

---

**Related:**

- [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md): TL;DR version with decision matrix
- [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md): The discovery story
- [YKeyValue: A Space-Efficient Key-Value Store](./ykeyvalue-space-efficient-kv-store.md): How YKeyValueLww works internally
- [Y.Array Tombstones Are Tiny](./y-array-tombstones-are-tiny.md): Why deletions are cheap (with GC on)

**References:**

- [Y.Doc gc option](https://docs.yjs.dev/api/y.doc): Official documentation
- [Yjs Snapshots](https://docs.yjs.dev/api/document-updates#snapshots): When you need gc: false
