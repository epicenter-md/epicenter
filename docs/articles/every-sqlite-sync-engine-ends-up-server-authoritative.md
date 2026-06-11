# Every SQLite Sync Engine Ends Up Server-Authoritative

The only project that attempted true multi-master SQLite-to-SQLite CRDT sync. Cr-sqlite. Was abandoned. Its creator joined the company building a server-authoritative alternative. ElectricSQL, PowerSync, Zero, LiveStore: all require a central server. The entire industry quietly conceded that peer-to-peer relational sync is too hard, and converged on the same architecture.

```
What everyone drew on the whiteboard:

  ┌──────────┐         ┌──────────┐
  │ Device A │ ◄─────► │ Device B │
  │ (SQLite) │         │ (SQLite) │
  └──────────┘         └──────────┘
       Peer-to-peer. No server. CRDTs handle merges.

What everyone actually shipped:

  ┌──────────┐    ┌──────────────┐    ┌──────────┐
  │ Device A │    │   Server DB  │    │ Device B │
  │ (SQLite  │◄──│  (Postgres)  │──►│  (SQLite  │
  │  cache)  │    │  + Sync Layer│    │   cache)  │
  └──────────┘    └──────────────┘    └──────────┘
       Server is the authority. Clients hold read caches.
```

## cr-sqlite tried. Then its creator left.

cr-sqlite was Matt Wonlaw's attempt at the top diagram. A SQLite extension that turned regular tables into CRRs (conflict-free replicated relations) with per-column CRDT semantics. Two devices write offline, come back online, merge without conflict. The merge happened at the SQL layer:

```sql
-- Pull changes from a peer
SELECT "table", "pk", "cid", "val", "col_version", "db_version",
       COALESCE("site_id", crsql_site_id()), "cl", "seq"
FROM crsql_changes
WHERE db_version > :last_seen AND site_id IS NULL;
```

It worked. The project hit 4K GitHub stars. Then Wonlaw joined Rocicorp full-time to build Zero. A server-authoritative cache over Postgres. Development stopped. The community opened GitHub issue #444: "Is this project dead?" The answer was effectively yes.

The one exception is Fly.io. They forked cr-sqlite into `corrosion` and run it in production: 7.5M rows shared globally across ~1,000 machines, handling 300K operations per second with a p99 replication time of ~1 second. But they had to fundamentally modify the core. Repurposing `db_version` to be monotonically incrementing per `site_id` so they could detect gaps in the change stream. It's custom infrastructure for their specific use case, not a general-purpose library.

## The landscape converged on one pattern

| Project | Architecture | Status (2026) | Multi-master? | Production signal |
|---|---|---|---|---|
| cr-sqlite | CRDT columns in SQLite | Abandoned (Fly fork alive) | Yes | Fly.io: 7.5M rows, 1K nodes |
| ElectricSQL | Postgres → SQLite via shapes | 1.0 GA (Mar 2025) | No, server-authoritative | Trigger.dev uses it. Mixed reviews. |
| PowerSync | Postgres → client SQLite via sync service | Production-grade | No, server writes | Most battle-tested enterprise option |
| Zero | Postgres → IndexedDB cache | Active (alpha→beta) | No, server-authoritative | "Zero just works": johnny.sh |
| LiveStore | Event-sourced SQLite, central sync | Active (3.5K stars) | Central backend required | 1 user = 1 SQLite instance |
| Turso | Embedded replicas (edge read) | Legacy feature | No, primary-replica | Edge caching, not sync |
| Litestream | WAL streaming to S3 | Mature | No, single-writer DR | Disaster recovery, not sync |

Every row except cr-sqlite has "No" in the multi-master column. And cr-sqlite is the one that's abandoned.

## One developer tried four engines for the same app

johnny.sh built a real-time multiplayer font editor and documented the journey. Triplit first. Worked well until Supabase acqui-hired the team and it became community-maintained. ElectricSQL next. Two months of spare time trying to make it work, gave up. LiveStore after that. Fast and well-designed, but the one-user-one-SQLite-instance limitation meant sharing data between users was architecturally hard.

The winner was Zero. And Zero isn't even SQLite sync. It's Postgres replicated to an IndexedDB cache on the client. The solution to "how do I sync SQLite between peers" turned out to be: don't. Let the server be the source of truth and cache locally.

## Why the industry gave up on peer-to-peer

True multi-master SQLite sync requires solving problems that a central server sidesteps entirely.

Permissions: when the client has the data locally, how do you enforce who can see or edit what? Zero answers this with server-side permission checks on the cache layer. PowerSync delegates to your backend API. Nobody has a peer-to-peer answer because the local-first premise, "you own your data," is in direct tension with access control.

Schema migrations: if a peer goes offline for three weeks and you ship four schema changes, what happens when they reconnect? A central server can gate connections by schema version. Two peers with different schemas merging CRDT changesets is an open research problem.

Partial replication: "sync only what this user needs" is table stakes for anything beyond a toy app. ElectricSQL has shapes, PowerSync has sync buckets. Implementing this peer-to-peer means every node needs to know what every other node wants, which starts looking a lot like a server.

A central server doesn't solve these problems philosophically, but it makes them tractable. That's why every maintained project chose it.

## The bottom diagram is the honest one

The local-first community spent years drawing the top diagram. Peer-to-peer, no single point of failure, CRDTs handle everything. The engineering reality pushed every team toward the bottom one: a server you trust, clients that cache locally, and a sync layer in between. The only production exception runs on custom infrastructure inside Fly.io's internal network.

If you're evaluating SQLite sync in 2026, you're not choosing between peer-to-peer approaches. You're choosing which flavor of server-authoritative caching you prefer.
