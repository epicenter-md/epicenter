# YKeyValue vs Y.Map: Quick Decision Guide

**TL;DR: A single boolean (`gc: true` vs `gc: false`) completely flips which data structure is more efficient—by 100-1000x.**

## Which Should You Use?

```
┌────────────────────────────────────┬────────────┬──────────────┐
│           Your Situation           │ GC Setting │    Winner    │
├────────────────────────────────────┼────────────┼──────────────┤
│ Frequent updates, no history needed│   GC ON    │ YKeyValueLww │
│ Need version history / snapshots   │   GC OFF   │ Y.Map        │
│ Write-once data (immutable)        │   Either   │ Y.Map        │
└────────────────────────────────────┴────────────┴──────────────┘
```

If you're unsure: use YKeyValueLww with `gc: true` (the default) for data that gets updated. Use Y.Map for write-once data or when you specifically need revision history.

## Why GC Setting Matters

YKeyValueLww deletes the old entry and appends a new one on every update. Each delete creates a tombstone.

With GC on, Yjs merges those tombstones into tiny metadata. With GC off, every tombstone is preserved at ~40 bytes each. A thousand updates means a thousand unmerged tombstones.

Y.Map stores historical values directly. GC affects packing, but values were always stored. Turning GC off roughly doubles size, not 1000x.

```
                       GC ON              GC OFF
                    ─────────────────────────────────
YKeyValueLww        Tombstones merged    Tombstones preserved
                    (near-zero cost)     (~40 bytes each)

Y.Map               Values compacted     Values preserved
                    (~10 bytes each)     (~20 bytes each)
```

## When YKeyValueLww Wins: GC ON + Frequent Updates

```
Scenario: 10 keys updated 1,000 times each
───────────────────────────────────────────
Y.Map:           88 KB
YKeyValueLww:   446 bytes

YKeyValueLww is 202x smaller.
```

GC merges all tombstones into a few bytes. Only the current 10 entries consume real space. Y.Map retains all 10,000 historical values.

Choose YKeyValueLww when: frequent updates, no revision history needed, storage/sync efficiency matters.

## When Y.Map Wins: GC OFF + Frequent Updates

```
Scenario: 10 keys updated 1,000 times each (GC OFF)
───────────────────────────────────────────────────
Y.Map:           197 KB
YKeyValueLww:    392 KB

Y.Map is 2x smaller.
```

Without GC, YKeyValueLww's 10,000 tombstones can't merge. Each costs ~40 bytes. Y.Map's historical values cost ~20 bytes each. Values are cheaper than unmerged tombstones.

Choose Y.Map when: you need `gc: false` for snapshots, version history, or time-travel features.

## When Y.Map Wins: Write-Once Data

```
Scenario: 1,000 unique keys, each written once
─────────────────────────────────────────────
Y.Map:           26 KB
YKeyValueLww:    41 KB

Y.Map is 1.6x smaller.
```

YKeyValueLww stores `{ key, val, ts }` in an array. Y.Map stores values directly. No updates means no tombstones, so GC has nothing to merge.

Choose Y.Map when: immutable data, write-once patterns, bounded config values.

## Summary

```
┌─────────────────────────────────────────────────────────────────┐
│ GC ON (default)                                                 │
│ • YKeyValueLww: 100-1000x smaller for update-heavy data         │
│ • Y.Map: 1.6x smaller for write-once data                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ GC OFF (for version history)                                    │
│ • Y.Map: Always wins—2x smaller for updates, 1.6x for write-once│
└─────────────────────────────────────────────────────────────────┘
```

The rule: if you need `gc: false`, use Y.Map. YKeyValueLww only wins when GC can merge tombstones.

---

**Related:**
- [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md): How we discovered this
- [Yjs Storage: The Complete GC On vs Off Guide](./yjs-gc-on-vs-off-storage-guide.md): Deep dive into the mechanics
- [YKeyValue: A Space-Efficient Key-Value Store](./ykeyvalue-space-efficient-kv-store.md): How YKeyValueLww works internally
