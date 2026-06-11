# Never Underestimate In-Memory Database Performance

Databases are designed to persist data. So when we think about database performance, we instinctively think about disk I/O, write-ahead logs, fsync calls, and all the machinery that makes data durable.

But here's what's easy to forget: the fastest database operation is the one that never touches disk.

## The Mental Model

Most developers have this mental model:

```
┌─────────────────────────────────────────────────────────────┐
│                     "Database Speed"                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   PostgreSQL ──────────────────────────────── slow           │
│                                                              │
│   SQLite ──────────────────────────────────── fast           │
│                                                              │
│   In-memory (YJS, Redis, etc.) ────────────── ???            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

We know PostgreSQL has network overhead. We know SQLite is faster because it's embedded. But in-memory databases? We rarely benchmark them against SQLite because we assume they're "cheating" by not persisting.

That assumption misses the point.

## When Persistence Happens Matters

Consider two approaches to updating 100,000 records:

**Approach A: SQLite (write-through)**

```
For each update:
  1. Acquire lock
  2. Update in-memory page
  3. Write to WAL
  4. Release lock

Total: 100,000 × (lock + memory + disk)
```

**Approach B: YJS (batch then persist)**

```
For all updates:
  1. Update in-memory CRDT structure

Then once:
  2. Encode state
  3. Write to disk

Total: 100,000 × memory + 1 × disk
```

The disk write happens either way. The question is: does it happen 100,000 times or once?

## Real Numbers

From our [YJS vs SQLite benchmark](./yjs-storage-efficiency/README.md), updating 100,000 records:

```
┌────────────────────────┬─────────────┬─────────────────────┐
│ Operation              │ SQLite      │ YJS (in-memory)     │
├────────────────────────┼─────────────┼─────────────────────┤
│ Update 100k records    │ 210ms       │ 173ms               │
│ Read all 100k records  │ 42ms        │ 34ms                │
└────────────────────────┴─────────────┴─────────────────────┘
```

YJS, a CRDT library not optimized for raw speed, is **faster** than SQLite for bulk operations. Not because YJS is magic, but because JavaScript Map iteration is just that fast when you're not touching disk.

## The Surprise Factor

This surprises developers because we conflate two separate concerns:

1. **Durability**: Will my data survive a crash?
2. **Speed**: How fast can I read/write?

SQLite solves both simultaneously at the cost of write performance. In-memory structures solve speed first and let you choose when to pay the durability cost.

For many applications, that's the better tradeoff:

- Collaborative editors accumulate changes, persist periodically
- Game state updates hundreds of times per second, saves on checkpoints
- Real-time dashboards aggregate data in memory, snapshot to disk

## The Pattern

```typescript
// In-memory first, persist second
const doc = new Y.Doc();

// Fast: all in-memory
for (const item of items) {
	doc.getMap('items').set(item.id, item);
}

// Slow: one disk write
await Bun.write('state.yjs', Y.encodeStateAsUpdate(doc));
```

Compare to:

```typescript
// Persist on every write
const db = new Database('state.db');

// Slow: 100k disk operations
for (const item of items) {
	db.run('INSERT INTO items VALUES (?)', item);
}
```

## When to Use In-Memory

In-memory databases make sense when:

- You're batching writes anyway (collaborative apps, real-time systems)
- You need sub-millisecond reads (caching, hot paths)
- You're syncing state across devices (CRDTs handle conflicts)
- Data loss on crash is acceptable (ephemeral sessions, derived data)

They don't make sense when:

- Every write must be immediately durable (financial transactions)
- You need complex queries (joins, aggregations)
- Memory is constrained (embedded devices, serverless)

## The Takeaway

In-memory isn't cheating. It's choosing when to pay for durability instead of paying on every operation.

When you see "in-memory database," don't think "not a real database." Think "deferred persistence." The speed isn't an illusion. It's a deliberate tradeoff that might be exactly what your application needs.

---

_See also: [YJS Storage Efficiency](./yjs-storage-efficiency/README.md): benchmark showing YJS is only 30% larger than SQLite_
_See also: [The Three Tiers of Database Latency](./database-latency-tiers.md): understanding where latency comes from_
