# The Three Tiers of Database Latency

When developers think about database performance, they usually compare PostgreSQL vs MySQL vs MongoDB. But they're all in the same tier. The real performance differences come from architectural choices that determine where your data lives and how you access it.

## The Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DATABASE LATENCY TIERS                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  TIER 3: Client-Server (PostgreSQL, MySQL, MongoDB)                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  App ───TCP/IP───► Database Server ───► Disk                │   │
│  │                                                              │   │
│  │  Latency: network + query parsing + execution + disk        │   │
│  │  Typical: 1-10ms per query                                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  TIER 2: Embedded File (SQLite, DuckDB, LevelDB)                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  App ───────────► Embedded Engine ───► Disk                 │   │
│  │                                                              │   │
│  │  Latency: execution + disk (no network!)                    │   │
│  │  Typical: 0.01-1ms per query                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  TIER 1: In-Memory (YJS, Redis, Memcached, SQLite :memory:)        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  App ───────────► In-Memory Structure                       │   │
│  │                                                              │   │
│  │  Latency: execution only (no network, no disk!)             │   │
│  │  Typical: 0.001-0.1ms per operation                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Each tier eliminates a source of latency. Understanding which tier you're in helps you set realistic performance expectations.

## Tier 3: Client-Server

**Examples**: PostgreSQL, MySQL, MongoDB, CockroachDB

```
Your App                    Database Server
   │                              │
   │ ──── TCP Connection ───────► │
   │ ──── SQL Query ────────────► │
   │                              │ ──► Parse query
   │                              │ ──► Plan execution
   │                              │ ──► Read from disk/cache
   │ ◄──── Results ────────────── │
   │                              │
```

**Latency sources**:

- Network round-trip: 0.1-10ms (localhost to cross-region)
- Connection overhead: protocol negotiation, authentication
- Query parsing and planning
- Disk I/O (mitigated by caching)

**Why use it**: ACID transactions across multiple clients, horizontal scaling, centralized data, complex queries.

**Typical latency**: 1-10ms per query (localhost), 10-100ms (remote)

## Tier 2: Embedded File

**Examples**: SQLite, DuckDB, LevelDB, RocksDB

```
Your App
   │
   │ ──► Embedded Engine (in-process)
   │         │
   │         │ ──► File System
   │         │ ◄──
   │ ◄───────┘
   │
```

**Latency sources**:

- Disk I/O (but no network!)
- File locking (for concurrent access)
- Query execution (in-process, no parsing overhead for prepared statements)

**What you eliminate**: Network latency, connection overhead, IPC

**Why use it**: Single-user applications, edge computing, mobile apps, CLI tools.

**Typical latency**: 0.01-1ms per query

## Tier 1: In-Memory

**Examples**: YJS, Redis (local), Memcached (local), SQLite `:memory:`

```
Your App
   │
   │ ──► Data Structure (same process, same memory)
   │ ◄──
   │
```

**Latency sources**:

- CPU execution only
- Memory allocation (minor)

**What you eliminate**: Network, disk, even function call overhead in some cases

**Why use it**: Caching, real-time systems, collaborative editing, session state.

**Typical latency**: 0.001-0.1ms per operation

## Real Benchmark: Reading 100k Records

From our [YJS vs SQLite benchmark](./yjs-storage-efficiency/README.md):

```
┌────────────────────────┬─────────────┬───────────────┐
│ Database               │ Read 100k   │ Records/sec   │
├────────────────────────┼─────────────┼───────────────┤
│ SQLite (file)          │ 42ms        │ 2.4 million   │
│ YJS (in-memory)        │ 34ms        │ 2.9 million   │
└────────────────────────┴─────────────┴───────────────┘
```

YJS (Tier 1) beats SQLite (Tier 2) by 20% on bulk reads. Not because SQLite is slow: 2.4M records/sec is incredible. But because even file I/O adds up.

For writes, the difference is more dramatic:

```
┌────────────────────────┬─────────────┬───────────────┐
│ Database               │ Insert 100k │ Records/sec   │
├────────────────────────┼─────────────┼───────────────┤
│ SQLite (file)          │ 131ms       │ 760k          │
│ YJS (in-memory)        │ 219ms       │ 457k          │
└────────────────────────┴─────────────┴───────────────┘
```

Wait, SQLite wins here? Yes, because SQLite's write path is heavily optimized. But note that YJS still achieves 457k inserts/second. That's fast enough for any real-time application.

## Choosing Your Tier

```
┌─────────────────────────────────────────────────────────────────┐
│                    DECISION MATRIX                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Need multiple clients?                                         │
│    YES ──► Tier 3 (PostgreSQL, etc.)                           │
│    NO  ──► Continue                                             │
│                                                                 │
│  Need durability on every write?                                │
│    YES ──► Tier 2 (SQLite)                                     │
│    NO  ──► Continue                                             │
│                                                                 │
│  Need maximum speed, can batch persistence?                     │
│    YES ──► Tier 1 (In-memory)                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Hybrid Approaches

The tiers aren't mutually exclusive. Modern architectures often combine them:

**Pattern: In-memory with periodic flush**

```typescript
// Tier 1: Fast writes
const doc = new Y.Doc();
doc.getMap('state').set('key', value);

// Tier 2: Periodic persistence
setInterval(() => {
	fs.writeFileSync('state.yjs', Y.encodeStateAsUpdate(doc));
}, 5000);
```

**Pattern: Cache layer**

```typescript
// Tier 1: Fast reads
const cache = new Map();
const value = cache.get(key);

// Tier 2/3: Cache miss falls through
if (!value) {
	value = await db.query('SELECT * FROM items WHERE key = ?', key);
	cache.set(key, value);
}
```

**Pattern: Write-ahead log**

```typescript
// Tier 1: In-memory state
const state = new Map();

// Tier 2: Append-only log for durability
const log = fs.createWriteStream('wal.log', { flags: 'a' });

function set(key, value) {
	state.set(key, value); // Fast: in-memory
	log.write(JSON.stringify({ key, value }) + '\n'); // Durable: disk
}
```

## The Takeaway

Database performance isn't about which database is "fastest." It's about understanding where latency comes from and choosing the right tier for your access patterns.

- **Tier 3** (client-server): When you need coordination across clients
- **Tier 2** (embedded file): When you need durability without network overhead
- **Tier 1** (in-memory): When you need maximum speed and can defer persistence

The best architectures often use multiple tiers strategically, keeping hot data in memory while ensuring durability where it matters.

---

_See also: [Never Underestimate In-Memory Performance](./in-memory-database-performance.md): why in-memory is faster than you think_
_See also: [YJS Storage Efficiency](./yjs-storage-efficiency/README.md): benchmark comparing YJS to SQLite_
