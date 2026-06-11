# Encrypted CRDTs Won't Eat Your Disk. Even After 10 Years

Encryption adds overhead to every value in the CRDT. Nonces, auth tags, binary headers. Roughly 60 extra bytes per entry. So what happens when you encrypt a YKeyValueLww store, use it daily for a decade, and never compact anything?

The storage stays proportional to your active data. Not your operation history. Not the number of times you edited a row. The data you have *right now*.

## The Encryption Tax

Each encrypted entry wraps the JSON value in an XChaCha20-Poly1305 blob: 2-byte header, 24-byte nonce, 16-byte auth tag, plus the ciphertext. For a typical skill record (~80 bytes of JSON), that's about 60 bytes of overhead per entry.

```
Plaintext (100 rows):   15.11 KB
Encrypted (100 rows):   20.97 KB
Encryption overhead:    38.8%
Per-entry overhead:     ~60 bytes/entry
```

At 10,000 rows the ratio holds steady: 37% overhead. The encryption tax is flat and predictable. It doesn't compound with updates.

## Tombstones Are Free (gc:true)

Add 1,000 encrypted skills. Delete them all. Repeat five times. The doc is 27 bytes.

```
Cycle 1:       27 B  (0 active)
Cycle 2:       27 B  (0 active)
Cycle 3:       27 B  (0 active)
Cycle 4:       27 B  (0 active)
Cycle 5:       27 B  (0 active)
```

Five thousand encrypted inserts, five thousand deletes, same 27 bytes every cycle. Yjs merges adjacent tombstones into compact GC structs that cost a few bytes total, regardless of how much data was deleted. The encryption layer doesn't interfere. It's pure composition over the CRDT, so the garbage collection behavior is identical to plaintext.

Turn GC off and the story inverts completely:

```
Cycle 1:  213.46 KB  (0 active)
Cycle 2:  426.90 KB  (0 active)
Cycle 3:  640.34 KB  (0 active)
Cycle 4:  853.78 KB  (0 active)
Cycle 5:    1.04 MB  (0 active)
```

With `gc:false`, every tombstone is preserved individually: ~213 KB per cycle of encrypted blobs that can't be merged. This is the only scenario where storage grows unboundedly. You'd only use `gc:false` for version snapshots or undo history, and you'd want a compaction strategy if you did.

## Updates Have Near-Zero Overhead

Editing the same 50 keys 100 times each (5,000 total mutations) produces a doc that's 0.2% larger than a fresh doc with the same final data:

```
After initial 50 rows:  10.48 KB
After 5,000 updates:     8.35 KB
Fresh (same data):       8.33 KB
Overhead:                0.2%
```

The doc actually *shrank* after the updates because Yjs merged GC structs from the initial insertions with tombstones from the update cycle. The mechanism: each `set()` in YKeyValueLww deletes the old entry and pushes a new one. With GC on, those deletions collapse into compact metadata that merges with adjacent tombstones.

## Ten Years of Daily Use

The real question isn't "what happens in a benchmark loop" but "what happens after a decade of normal use." We simulated two scenarios with encrypted entries.

### Growing collection: 20 → 140 skills over 10 years

Monthly pattern: 2 new skills created, 1 deleted, 5 edited.

```
Initial (20 skills):    4.05 KB
Year  5 (80 active):   17.13 KB
Year 10 (140 active):  30.22 KB
Fresh (same 140):      28.92 KB
Accumulated overhead:   1.30 KB  (4.5%)
```

The growth from 4 KB to 30 KB is the data getting bigger. More skills means more storage. The overhead from ten years of operation history is 1.3 KB. That's the total cost of ~240 creates, ~120 deletes, and ~600 edits.

### Constant ~20 skills, heavy churn

Monthly pattern: 3 creates, 3 deletes, 10 edits. The collection stays at ~20 skills for the full decade.

```
Initial (20 skills):    4.05 KB
Year  5 (20 active):    4.38 KB
Year 10 (20 active):    4.35 KB
Fresh (same 20):        4.16 KB
Accumulated overhead:   202 B  (4.7%)
```

360 creates, 360 deletes, 1,200 edits over ten years. The doc fluctuates by a few hundred bytes around the baseline and never trends upward. 202 bytes of accumulated overhead from a decade of churn.

## The Add-Then-Delete Question

If you have 3 skills, add a 4th, then delete it. Do you get back to the exact same size?

```
3 skills (baseline):    632 B
After adding 4th:       837 B
After deleting 4th:     648 B  (+16 bytes)
After 100 add/deletes:  648 B  (+16 bytes)
After 150 edits:        648 B  (+16 bytes)
Fresh (same 3 skills):  629 B
```

Not exactly. There's a 16-byte GC struct recording "something was deleted at this position in the Y.Array." But that 16 bytes is a one-time cost. The next 100 add/delete cycles and 150 edits add *zero* additional bytes, because new tombstones merge into the existing GC struct.

## When Storage Does Grow

Two things make storage grow:

Active data. More rows means more storage. This is obvious and unavoidable. You're storing more stuff.

Unique client IDs. Each device that has ever written to the doc leaves a small footprint in the Yjs state vector (a few bytes per device). A user who edits from 5 different devices over 10 years adds maybe 50 bytes of state vector overhead. This is negligible.

One thing that does *not* make storage grow with `gc:true`: operation history. Edits, deletes, and re-inserts are absorbed by garbage collection. The doc tracks what exists now, not what happened before.

## Run the Benchmarks

Both benchmarks are standalone scripts with no dependencies beyond Bun and the workspace package:

```bash
# Per-entry overhead, tombstone behavior, update costs
bun run docs/articles/yjs-storage-efficiency/encrypted-kv-benchmark.ts

# 10-year simulation: growing collection, heavy churn, add-then-delete
bun run docs/articles/yjs-storage-efficiency/encrypted-kv-longevity.ts
```

---

_Benchmark code: [encrypted-kv-benchmark.ts](./encrypted-kv-benchmark.ts), [encrypted-kv-longevity.ts](./encrypted-kv-longevity.ts)_
_Tested with: Bun, YJS 13.6.x, XChaCha20-Poly1305 via @noble/ciphers_

**Related:**

- [YJS Storage Efficiency: Only 30% Overhead](./README.md): the original SQLite vs YJS benchmark
- [YKeyValueLww Tombstones Are Practically Free](../ykeyvalue-lww-tombstones-are-free.md): plaintext version of the tombstone test
- [YKeyValue vs Y.Map: GC Is the Hidden Variable](../ykeyvalue-gc-the-hidden-variable.md): why `gc:false` inverts everything
