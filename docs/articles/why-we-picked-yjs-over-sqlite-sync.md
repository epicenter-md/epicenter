# Why We Picked Yjs Over SQLite Sync

We looked at every SQLite sync option and kept coming back to the same conclusion: our existing Yjs CRDT architecture already solves the hard problems, and we materialize to SQLite anyway for queries. The SQLite sync world would give us SQL but take away automatic merging. That's the wrong trade.

## The architecture we already have

```
┌─────────────────────────────────────────────────────┐
│  Yjs Y.Doc (source of truth)                        │
│                                                     │
│  Tables:     YKeyValueLww  (row-level LWW + CRDT)   │
│  KV stores:  YKeyValueLww                           │
│  Documents:  Y.Text / Y.XmlFragment (rich text)     │
│                                                     │
│  Sync:       WebSocket (delta exchange, awareness)   │
│  Cross-tab:  BroadcastChannel                       │
└──────────────────┬──────────────────────────────────┘
                   │ observer mirrors on change
                   ▼
┌─────────────────────────────────────────────────────┐
│  SQLite (read cache)                                │
│                                                     │
│  Full SQL queries, FTS5, vector embeddings          │
│  Rebuilt from Yjs if deleted. Never the authority.   │
└─────────────────────────────────────────────────────┘
```

Yjs handles conflict resolution and sync. SQLite handles queries. Every write goes through the CRDT; the materializer keeps the SQL tables current. Delete the SQLite file, open the app, and it rebuilds from the Y.Doc. Nothing is lost because nothing was stored there in the first place. (See [SQLite Is a Projection, Not the Database](./sqlite-is-a-projection-not-a-database.md) for the full breakdown.)

This gives us both sides: CRDT merging for correctness and SQL for querying. The SQLite sync ecosystem asks you to choose one.

## Notion and Linear landed on the same pattern

Notion shipped offline mode in December 2025. Under the hood: local SQLite cache with CRDTs for conflict resolution. They built a hybrid. SQLite for reads, CRDTs for writes and merges. Independent of us, they arrived at the same architecture.

Linear. The poster child for local-first done right. Uses last-write-wins with centralized ordering for most data. CRDTs handle rich text only. Our `YKeyValueLww` is essentially the same bet: LWW for structured row data, Yjs CRDTs for collaborative text editing. The pattern works because most workspace data has a single author at a time, and the rare conflicts resolve cleanly with timestamp-based LWW.

## What SQLite sync would give us

Ad-hoc SQL everywhere. Our materializer provides SQL reads, but writes still go through the TypeScript workspace API. A pure SQLite sync engine would let any tool read and write via SQL. No wrapper needed. For large datasets (100K+ rows), native SQLite indexing and paging would outperform scanning a Yjs doc in memory.

Partial replication is the other gap. ElectricSQL has shapes; PowerSync has sync buckets. Our Yjs sync exchanges the full document (delta-optimized, but no per-table subscription). For workspaces with thousands of items where a client only needs a subset, that's a real limitation.

Relational integrity would come free: foreign keys, unique constraints, CHECK clauses. Yjs has none of these. Our table IDs are unique by convention, not by enforcement.

## What it would cost us

Automatic conflict resolution. Yjs resolves concurrent edits across devices without any application logic. Two users edit the same document offline, both edits survive in the CRDT, and the merge is deterministic. Every SQLite sync engine either uses LWW (someone's edit gets silently dropped) or punts conflict handling to you. Merge is the famous reason, but it is not even the main one for a single-user tool; the quieter and stronger reason is that an in-memory observable document lets local edits and remote syncs drive the same materialize callback (see [You Keep Yjs for the Callback, Not the Conflict](./20260602T220000-keep-yjs-for-the-callback-not-the-conflict.md)).

Rich text collaboration. Y.Text is the battle-tested CRDT for collaborative text editing. It powers Tiptap, BlockNote, and dozens of production editors. No SQLite sync tool has anything equivalent. If we switched, we'd bolt Yjs back on for text editing anyway.

The extension architecture. Our workspace composes persistence, sync, materializers, and encryption as independent extensions on a builder pattern. SQLite sync tools are monolithic. You get their sync, their persistence, their conflict model, or nothing.

Schema evolution. We handle migrations with a `_v` discriminant on every row. Old data stays in the Y.Doc; the `migrate()` function transforms it at read time. No coordinator, no "everyone stop, we're migrating." Peers running different app versions coexist naturally because the schema is a lens over the data, not a constraint on it. (See [Schema Evolution Without Migrations](./schema-evolution-without-migrations.md).) Most SQLite sync tools have no migration story at all. LiveStore uses event-sourcing to sidestep it. ElectricSQL propagates DDL through a replication stream, which requires a central server to coordinate.

## The evaluation matrix

| Capability | Yjs + SQLite materializer | Pure SQLite sync |
|---|---|---|
| Conflict resolution | Automatic (CRDT + LWW) | LWW or DIY |
| Rich text editing | Y.Text, battle-tested | None. Bolt on Yjs anyway |
| Ad-hoc SQL queries | Read-only via materializer | Full read/write SQL |
| Large datasets (100K+) | Memory pressure in Y.Doc | Native SQLite performance |
| Partial replication | Full doc sync (delta-optimized) | Shapes, buckets, sync rules |
| Schema migrations | migrate-on-read, no coordinator | Mostly unsolved |
| Offline-first | Yes | Yes |
| Extension composition | Builder pattern, mix and match | Monolithic |

The left column is weaker on SQL writes, large datasets, and partial replication. The right column is weaker on everything else. For a workspace product. Where collaboration, offline reliability, and schema flexibility matter more than ad-hoc SQL writes. The left column wins.

## The grass is a different color

We expected the SQLite sync ecosystem to have a clean answer for peer-to-peer data sync. It doesn't. Every maintained project is server-authoritative with local SQLite as a read cache. (See [Every SQLite Sync Engine Ends Up Server-Authoritative](./every-sqlite-sync-engine-ends-up-server-authoritative.md).) Our Yjs architecture is actually closer to true peer-to-peer than any of them.

The path forward isn't replacing Yjs with SQLite sync. It's strengthening the materializer. More query capabilities, better indexing, partial doc loading. So we get the SQL benefits without giving up the CRDT foundation. The source of truth stays in the Y.Doc. Everything else is a projection.
