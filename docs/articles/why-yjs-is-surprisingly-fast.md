# Why YJS Is Surprisingly Fast

YJS is a CRDT library. CRDTs have a reputation for being complex and slow. All that vector clock bookkeeping, tombstone tracking, and conflict resolution. So when you benchmark YJS against SQLite and see comparable performance, it feels wrong.

It's not wrong. YJS is fast because it's in-memory JavaScript, and we consistently underestimate how fast that is.

## The Benchmark Results

From our [YJS vs SQLite benchmark](./yjs-storage-efficiency/README.md), operating on 100,000 records:

```
┌────────────────────────┬─────────────┬─────────────┐
│ Operation              │ SQLite      │ YJS         │
├────────────────────────┼─────────────┼─────────────┤
│ Bulk Insert (100k)     │ 131ms       │ 219ms       │
│ Read All (100k)        │ 42ms        │ 34ms        │
│ Update All (100k)      │ 210ms       │ 173ms       │
│ Filtered Read (20k)    │ 1ms         │ 3ms         │
└────────────────────────┴─────────────┴─────────────┘
```

YJS wins on full reads and updates. SQLite wins on inserts and filtered queries (it has indexes). But they're in the same ballpark. Hundreds of milliseconds for 100k operations.

## Why This Happens

### 1. JavaScript Iteration Is Fast

A `Map` in V8 is highly optimized. Iterating over 100,000 entries:

```javascript
const map = new Map();
// ... fill with 100k entries

const start = performance.now();
for (const [key, value] of map) {
	// do something
}
console.log(performance.now() - start); // ~20-30ms
```

That's millions of iterations per second, in JavaScript, with no native code. The "JavaScript is slow" narrative comes from DOM manipulation and memory allocation, not raw iteration.

### 2. YJS Is Just Maps

Under the hood, YJS stores data in `Y.Map` structures. When you read all records:

```typescript
// This is essentially what happens
for (const [id, rowMap] of recordsMap) {
	const row = {
		id: rowMap.get('id'),
		title: rowMap.get('title'),
		// ...
	};
	results.push(row);
}
```

No disk I/O. No query parsing. No index lookups. Just Map iteration.

### 3. SQLite Pays for Features You Might Not Use

SQLite is incredible, but every query involves:

```
SQL string ──► Parser ──► Query planner ──► Bytecode ──► VM execution ──► Results
```

Even with prepared statements, there's overhead. That overhead pays for powerful features (joins, aggregations, constraints), but if you're just iterating over all records, you're paying for features you're not using.

## Where SQLite Still Wins

### Filtered Queries

```
SQLite: SELECT * FROM records WHERE category = 'tech'  →  1ms
YJS:    iterate all, filter in JS                      →  3ms
```

SQLite has indexes. YJS iterates everything. For selective queries, this matters.

### Complex Queries

```sql
SELECT category, COUNT(*), AVG(views)
FROM records
GROUP BY category
HAVING COUNT(*) > 100
ORDER BY AVG(views) DESC
```

Good luck doing this efficiently in JavaScript. SQLite's query planner handles this in milliseconds.

### Persistence

SQLite writes to disk automatically with ACID guarantees. YJS keeps everything in memory until you explicitly save:

```typescript
// You have to do this yourself
await Bun.write('state.yjs', Y.encodeStateAsUpdate(doc));
```

If your process crashes between writes, you lose data.

## The Performance Intuition

```
┌─────────────────────────────────────────────────────────────────┐
│                 WHERE YJS EXCELS                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✓ Bulk operations (process everything once)                    │
│  ✓ Full scans (no index needed)                                │
│  ✓ Real-time updates (no disk on every change)                 │
│  ✓ Collaborative sync (CRDT merging is the feature)            │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                 WHERE SQLITE EXCELS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✓ Selective queries (indexes matter)                          │
│  ✓ Complex queries (aggregations, joins)                       │
│  ✓ Guaranteed durability (ACID)                                │
│  ✓ Large datasets (doesn't need to fit in memory)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Why This Matters for Architecture

If you're building a collaborative app, you might assume YJS is a "slow but necessary" choice for sync. The benchmarks show that's wrong.

YJS is fast enough that you can use it as your primary data layer for real-time operations, not just as a sync mechanism. The architecture becomes:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   User Action                                               │
│        │                                                    │
│        ▼                                                    │
│   ┌─────────┐                                              │
│   │   YJS   │ ◄──── Real-time reads/writes (fast)          │
│   │ (CRDT)  │                                              │
│   └────┬────┘                                              │
│        │                                                    │
│        │ Periodic sync                                      │
│        ▼                                                    │
│   ┌─────────┐                                              │
│   │ SQLite  │ ◄──── Complex queries, persistence           │
│   └─────────┘                                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

YJS handles the hot path. SQLite provides durability and query power. You get the best of both.

## The Takeaway

YJS isn't fast despite being a CRDT. It's fast because:

1. It's in-memory (no disk I/O on reads/writes)
2. It's just Maps (V8 is incredibly optimized)
3. It skips features you don't need (no query parsing, no indexes)

For bulk operations and full scans, in-memory JavaScript can match or beat embedded databases. That's not a bug in the benchmark. It's the natural result of eliminating I/O from the critical path.

---

_See also: [YJS Storage Efficiency](./yjs-storage-efficiency/README.md): full benchmark with storage comparison_
_See also: [The Three Tiers of Database Latency](./database-latency-tiers.md): where YJS fits in the performance hierarchy_
_See also: [Never Underestimate In-Memory Performance](./in-memory-database-performance.md): the general principle_
