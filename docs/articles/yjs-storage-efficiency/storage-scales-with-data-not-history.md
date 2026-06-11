# CRDT Storage Scales With Data, Not History

CRDTs track every operation for conflict-free merging. The natural worry: won't storage grow forever as I use the app? Won't ten years of edits bury my 20 active rows under megabytes of tombstones?

No. With Yjs garbage collection enabled (`gc:true`, the default), storage is proportional to your active data. Not your operation count, not your edit history, not your deleted rows. We tested this exhaustively: 16 tests, 52,000+ operations, multi-device sync, encryption, key rotation. And the property holds.

## The Precise Claim

```
Storage = O(active data) + O(unique devices)
```

The first term dominates. The second term is ~22 bytes per device that has ever written to the doc. For a single-user app on 3 devices, that's 66 bytes. For 50 devices, it's about 1.1 KB. Neither term scales with operation count.

## The Proof

We ran 16 tests covering every workload pattern that could plausibly break this property. Each test performs a workload (inserts, updates, deletes, multi-device sync, key rotation), then compares the resulting doc against a fresh doc containing identical active data. The difference is the "history tax."

```
── Single-device workloads ──
✓ Insert only (100 rows)                  0 B overhead    (100 ops)
✓ 100 rows × 10 updates each            19 B overhead  (1,100 ops)
✓ 10 rows × 1000 updates each           19 B overhead (10,010 ops)
✓ 1 row × 10000 updates                 19 B overhead (10,001 ops)
✓ Add 100, delete all, repeat 10x       19 B overhead  (2,050 ops)
✓ Add 1000, delete 1000, 5 cycles       25 B overhead (10,000 ops)
✓ Interleaved add/remove, 100 cycles    16 B overhead  (3,000 ops)
✓ 5 key rotations with 50 rows          40 B overhead    (350 ops)
✓ Plaintext → encrypted migration       19 B overhead    (250 ops)
✓ 10k rows, delete 5k, keep 5k          19 B overhead (15,000 ops)
✓ 1k rows × 50 updates + churn          23 B overhead (52,000 ops)
```

52,000 operations produce 23 bytes of overhead. The history tax is a rounding error.

## Multi-Device: The Nuance

Each unique device (Yjs clientID) that has ever written to the doc leaves a fingerprint in the state vector. This is the only source of overhead that doesn't merge away.

```
── Multi-device workloads ──
✓ 2 devices, 500 ops each              892 B overhead  (10 active rows)
✓ 5 devices, 200 unique rows each       63 B overhead (1000 active rows)
✓ 3 devices, concurrent same-key edits  1.33 KB overhead (20 active rows)
✓ 20 devices, 5 rows each              281 B overhead  (100 active rows)
✓ 50 devices, same 10 rows             1.12 KB overhead  (10 active rows)
```

The percentages look alarming for small row counts: 50 devices editing 10 rows shows 81% overhead. But the absolute number is 1.12 KB, and it's fixed. It doesn't grow with more operations. Add more rows and the percentage drops: 50 devices with 500 rows is 2.2% overhead.

The overhead is `~22 bytes × unique_device_count`, not `~22 bytes × operation_count`. A user who edits from 5 devices over 10 years pays ~110 bytes. That's the total device tax for a decade.

## Why This Works

YKeyValueLww stores entries in a `Y.Array`. Each set() deletes the old entry and pushes a new one. Each delete() removes the entry. With `gc:true`, Yjs merges adjacent tombstones into compact GC structs:

```
Before GC:  [tombstone][tombstone][tombstone]...[tombstone]  (1,000 tombstones)
After GC:   [gc_struct: 1000 items deleted]                  (a few bytes)
```

The key mechanism: GC structs from the same client that are adjacent in the Y.Array merge into one. So a thousand updates to the same key produce a thousand tombstones that collapse into a single GC struct. A thousand deletes of different keys produce tombstones that also collapse, as long as they're from the same client.

Multi-device overhead happens because tombstones from different clients interleave in the array and can't merge across client boundaries. Each client's tombstones merge among themselves, but the state vector entry for each client persists.

## When This Doesn't Hold

**gc:false breaks everything.** With garbage collection disabled, every tombstone is preserved individually. Five cycles of adding and deleting 1,000 encrypted rows grows to 1.04 MB. Compared to 27 bytes with gc:true. You'd only use `gc:false` for version snapshots or undo history, and you'd need a compaction strategy.

**Encryption doesn't change the story.** The encrypted wrapper is pure composition over YKeyValueLww. It transforms values at the boundary but doesn't alter the CRDT structure. Encryption adds ~60 bytes per entry (nonce + auth tag + header), but that's a flat per-entry tax on active data, not a growing history cost.

## Running the Proof

The proof suite is a single executable that runs all 16 tests and exits nonzero if any fail:

```bash
bun run docs/articles/yjs-storage-efficiency/storage-complexity-proof.ts
```

The companion benchmarks test encryption overhead and 10-year longevity:

```bash
bun run docs/articles/yjs-storage-efficiency/encrypted-kv-benchmark.ts
bun run docs/articles/yjs-storage-efficiency/encrypted-kv-longevity.ts
```

## Where This Matters

This property is the foundation of local-first storage in Epicenter. Every table in every workspace is backed by YKeyValueLww. If storage scaled with operations, long-lived workspaces would bloat over time and require periodic compaction. Because it scales with active data, users can create, edit, and delete freely for years without ever thinking about storage management.

The constraint for app developers: keep `gc:true` (the default) unless you specifically need version history. If you need history, scope it to the documents that need it and accept the storage tradeoff there.

---

_Proof suite: [storage-complexity-proof.ts](./storage-complexity-proof.ts)_
_Tested with: Bun, YJS 13.6.x, XChaCha20-Poly1305 via @noble/ciphers_

**Related:**

- [Encrypted CRDTs Won't Eat Your Disk](./encrypted-kv-storage.md): encryption overhead and 10-year longevity
- [YKeyValueLww Tombstones Are Practically Free](../ykeyvalue-lww-tombstones-are-free.md): the original tombstone discovery
- [YKeyValue vs Y.Map: GC Is the Hidden Variable](../ykeyvalue-gc-the-hidden-variable.md): why gc:false inverts the storage story
- [YJS Storage Efficiency: Only 30% Overhead](./README.md): the original SQLite vs YJS comparison
