# YJS Storage Efficiency: Only 30% Overhead for Full CRDT Capabilities

There's a common assumption in the developer community that CRDTs are storage-heavy. The intuition makes sense: if you're tracking every operation for conflict-free merging, surely that metadata adds up, right?

I ran the numbers. The reality is surprisingly different.

## The Benchmark

I stored 100,000 identical records in both YJS (a popular CRDT library) and SQLite, then measured file sizes through various operations: bulk inserts, updates, deletes, and re-inserts.

Each record contained 8 fields averaging 485 bytes of JSON:

```typescript
{
  id: string,
  title: string,
  content: string,      // 100-500 chars
  category: string,
  views: number,
  created_at: string,
  updated_at: string,
  is_published: number
}
```

## The Results

| Stage                   | SQLite   | YJS      | Overhead |
| ----------------------- | -------- | -------- | -------- |
| Initial bulk insert     | 42.05 MB | 54.57 MB | +30%     |
| After full update pass  | 46.09 MB | 57.61 MB | +25%     |
| After delete + reinsert | 46.09 MB | 55.72 MB | +21%     |
| After 3 update rounds   | 46.09 MB | 62.88 MB | +36%     |

YJS is consistently 1.2-1.4x the size of SQLite. For 100k records, that's 10-20 MB of overhead.

## Tombstone Overhead is Minimal

One concern with CRDTs is tombstone accumulation; when you delete data, the deletion marker sticks around for sync purposes. I tested this explicitly by deleting all 100k records and reinserting them.

The result: YJS grew from 54.57 MB to 55.72 MB. That's **2.1% growth** from a full delete-reinsert cycle. Not the ballooning storage you might expect.

## Performance Comparison

Write performance favors SQLite, but not by as much as you'd think:

```
Bulk Insert (100k records):
  SQLite: 131ms  (760k records/sec)
  YJS:    219ms  (457k records/sec)

Full Update Pass:
  SQLite: 210ms  (476k records/sec)
  YJS:    173ms  (576k records/sec)
```

Read performance is where it gets interesting. YJS actually beats SQLite for full table scans:

```
Read All Records:
  SQLite: 42ms  (2.4M records/sec)
  YJS:    34ms  (2.9M records/sec)
```

SQLite wins on filtered queries (it has indexes), but for iteration over all data, the in-memory Y.Map is faster.

## What You Get for 30%

That 30% storage overhead buys you:

**Conflict-free merging.** Two users edit the same document offline. When they reconnect, changes merge automatically without conflicts. No "your changes were overwritten" dialogs.

**Real-time collaboration.** Changes propagate to all connected clients instantly. The same infrastructure that handles offline sync handles live collaboration.

**Offline-first by default.** The local YJS document is the source of truth. Network is optional. Sync happens opportunistically.

**Built-in undo/redo.** YJS tracks operation history. Implementing undo is trivial.

**No sync server logic.** The sync protocol is generic. Your server just relays binary updates; it doesn't need to understand your data model.

## Running the Benchmark Yourself

The benchmark is a single TypeScript file with two dependencies: Bun (for `bun:sqlite`) and the `yjs` package.

```bash
# Setup
mkdir yjs-benchmark && cd yjs-benchmark
bun init -y
bun add yjs

# Download the benchmark
curl -O https://raw.githubusercontent.com/EpicenterHQ/epicenter/main/docs/articles/yjs-storage-efficiency/benchmark.ts

# Run it
bun run benchmark.ts           # Default: 100k records
bun run benchmark.ts 50000     # Custom count
```

The benchmark creates a `.yjs-benchmark` directory with the output files so you can inspect them directly.

## When SQLite is Still Better

This isn't a "YJS beats SQLite" story. SQLite is the right choice when:

- You need complex queries (joins, aggregations, full-text search)
- Storage size is critical and you don't need sync
- You're building a traditional server-side application
- You need ACID transactions across multiple tables

YJS makes sense when:

- You're building collaborative or offline-first applications
- You want sync without building sync infrastructure
- You can tolerate 30% storage overhead for CRDT benefits
- Your data model is document-oriented

## The Takeaway

CRDTs aren't as expensive as their reputation suggests. For YJS specifically, you're looking at 30% storage overhead in the typical case, scaling to maybe 40% under heavy update loads.

If you've been avoiding CRDTs because of storage concerns, the benchmark data might change your calculus. Thirty percent overhead for conflict-free sync, offline support, and real-time collaboration is a trade many applications should be making.

---

_Benchmark code: [benchmark.ts](./benchmark.ts)_
_Tested with: Bun 1.x, YJS 13.6.x, bun:sqlite_

## Related Articles

- [Why YJS Is Surprisingly Fast](../why-yjs-is-surprisingly-fast.md): understanding the performance characteristics
- [The Three Tiers of Database Latency](../database-latency-tiers.md): where YJS fits in the performance hierarchy
- [Never Underestimate In-Memory Performance](../in-memory-database-performance.md): the general principle behind YJS speed
- [Stop Passing Clients as Arguments](../stop-passing-clients-as-arguments.md): the factory pattern used in the benchmark
