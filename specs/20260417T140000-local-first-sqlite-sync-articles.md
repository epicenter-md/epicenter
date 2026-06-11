# Local-First SQLite Sync Articles

Three articles based on deep research into the local-first SQLite sync ecosystem, comparing it against Epicenter's Yjs CRDT architecture.

## Context

We dispatched 5 research agents plus direct web searches across the SQLite sync landscape (cr-sqlite, ElectricSQL, PowerSync, Zero, LiveStore, Turso, Litestream, LiteFS) and compared findings against our `packages/workspace` architecture. The research revealed a surprising convergence: every maintained SQLite sync project ends up server-authoritative. True peer-to-peer SQLite sync is effectively abandoned as a maintained product.

## Articles

### Article 1: `every-sqlite-sync-engine-ends-up-server-authoritative.md`

**Title**: Every SQLite Sync Engine Ends Up Server-Authoritative

**Thesis**: The only project that attempted true multi-master SQLite-to-SQLite CRDT sync (cr-sqlite) was abandoned. Its creator left to build a server-authoritative alternative. The entire industry quietly conceded that peer-to-peer relational sync is too hard.

**Key evidence to include**:
- cr-sqlite abandoned; Matt Wonlaw joined Rocicorp to build Zero (server-authoritative)
- GitHub issue #444 "Is this project dead?": effectively yes
- Fly.io's internal fork (`corrosion`) is the sole production deployment: 7.5M rows, 300K ops/sec, ~1000 nodes: but custom infrastructure, not general-purpose
- ElectricSQL 1.0: "Postgres sync engine" with shapes: server is the authority
- PowerSync: server writes, client reads local SQLite
- Zero: Postgres → IndexedDB client cache
- LiveStore: event-sourced SQLite, requires central sync backend
- johnny.sh tried 4 engines for one app; winner (Zero) isn't even SQLite sync
- ASCII diagram showing how every architecture converges on `Server DB → Sync Layer → Local Cache`

**Structure**: Comparison/tradeoff shape. Walk through what each project tried to be vs what it actually is. ~100-130 lines.

### Article 2: `why-we-picked-yjs-over-sqlite-sync.md`

**Title**: Why We Picked Yjs Over SQLite Sync

**Thesis**: We evaluated the SQLite sync landscape and found our existing Yjs CRDT architecture already solves the hard problems. And we materialize to SQLite anyway for queries. The SQLite sync world gives you SQL queries but makes you give up automatic merging.

**Key evidence to include**:
- Our architecture: Yjs source of truth → SQLite materializer for queries. Best of both worlds.
- Notion's offline mode (Dec 2025) uses SQLite locally with CRDTs for conflict resolution: same hybrid we built
- Linear uses LWW with centralized ordering for most data, CRDTs only for rich text: our YKeyValueLww is the same pattern
- migrate-on-read (`_v` field) is more elegant than anything in the SQLite sync world
- What SQLite sync would give us: ad-hoc SQL, large dataset perf, partial replication, relational integrity
- What it would cost us: Yjs automatic merging, Y.Text for rich editing, extension composition, and we'd pick from a fragmented ecosystem
- Reference existing article: "SQLite Is a Projection, Not the Database"

**Structure**: Problem → decision story. ~100-120 lines.

### Article 3: `conflict-resolution-is-the-least-of-your-problems.md`

**Title**: Conflict Resolution Gets All the Attention. It's the Least of Your Problems.

**Thesis**: The local-first community obsesses over CRDTs vs OT vs LWW. In practice, the unsolved problems that actually block production apps are permissions, schema migrations, partial replication, and tombstone GC.

**Key evidence to include**:
- joodaloop.com quote: "conflict resolution gets a comically disproportionate amount of attention"
- **Permissions**: client has data locally → how enforce access control? Zero uses server-side checks. Nobody has a P2P answer. The local-first premise is in direct tension with ACLs.
- **Schema migrations**: peer offline 3 weeks, you ship 4 schema changes, what happens? Most tools have no answer. Our migrate-on-read is one of the few clean solutions.
- **Partial replication**: "sync only what this user needs": ElectricSQL shapes, PowerSync buckets, but Yjs syncs full doc
- **Tombstones**: every CRDT accumulates delete markers forever. Fly.io's corrosion fork built custom compaction. Our YKeyValueLww + GC actually handles this well (see existing article on tombstones).
- **Server authority for business rules**: payments, uniqueness constraints, sequential IDs: some things genuinely need a server

**Structure**: Mechanism explainer with diagrams. Walk through each "real" problem. ~120-150 lines.

## Todo

- [x] Research landscape (5 background agents + direct searches)
- [x] Map current workspace architecture
- [x] Write spec
- [ ] Article 1: Every SQLite Sync Engine Ends Up Server-Authoritative
- [ ] Article 2: Why We Picked Yjs Over SQLite Sync
- [ ] Article 3: Conflict Resolution Gets All the Attention
- [ ] Review section

## File locations

All articles go in `docs/articles/`:
- `docs/articles/every-sqlite-sync-engine-ends-up-server-authoritative.md`
- `docs/articles/why-we-picked-yjs-over-sqlite-sync.md`
- `docs/articles/conflict-resolution-is-the-least-of-your-problems.md`
