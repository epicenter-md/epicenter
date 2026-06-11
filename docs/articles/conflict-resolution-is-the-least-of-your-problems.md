# Conflict Resolution Gets All the Attention. It's the Least of Your Problems.

Every local-first discussion starts with conflict resolution. CRDTs vs OT vs LWW, which merge strategy, how to handle concurrent edits. It's the sexiest part of the problem. It's also the most solved. The things that actually block production local-first apps. Permissions, schema migrations, partial replication, tombstone growth. Get a fraction of the attention and none of the good answers.

As one developer put it after building multiple local-first apps: "Of these open problems, conflict resolution gets a comically disproportionate amount of attention."

## Permissions: the client has your data. Now what?

Local-first means the data lives on the device. That's the whole point. Offline access, no server dependency, user ownership. It's also a security nightmare.

If a user has a local copy of the database, how do you enforce that they can't read another team's records? How do you revoke access after someone leaves an organization? In a server-first world, the answer is trivial: the server checks permissions on every request. In a local-first world, the data is already on the device.

```
Server-first access control:

  Client → "GET /records" → Server checks permissions → Returns allowed rows

Local-first access control:

  Client already has the rows. Now what?
  Option A: Trust the client (security theater)
  Option B: Encrypt per-permission-group (complex key management)
  Option C: Don't sync restricted data to unauthorized clients (partial replication)
```

Every production local-first tool picks some variant of Option C, which means you need a server deciding what to sync to whom. Zero does this with server-side permission checks on the cache layer. PowerSync delegates to your backend API. ElectricSQL uses shapes that the server evaluates.

Notice the pattern: enforcing permissions reintroduces the server. The more granular your access control needs, the more your "local-first" architecture starts looking like a traditional client-server app with a local cache. Nobody has a peer-to-peer answer to this because the premise, "you own your data," is in direct tension with "but not that data, that belongs to your coworker."

## Schema migrations: your peers are running last month's code

Traditional migration: write a script, run it against the database, every client connects to the same schema. Done.

Local-first migration: your users have different versions of the app on different devices. Some devices have been offline for weeks. When they reconnect, they're pushing data shaped by a schema you've since changed three times.

```
Timeline:
  Jan 1: Schema v1 shipped (posts table has title, body)
  Jan 8: Schema v2 shipped (posts table adds status field)
  Jan 15: Schema v3 shipped (status renamed to publishState)
  Jan 20: Offline device from Jan 5 reconnects, pushes v1 data

  What happens to the v1 data in a v3 world?
```

Most SQLite sync tools have no answer. ElectricSQL propagates DDL changes through the Postgres replication stream, which requires a central server to coordinate. LiveStore sidesteps the problem with event-sourcing: events are immutable, read models are rebuilt from scratch, so the "schema" is just how you interpret the event log.

Our approach: every row carries a `_v` discriminant. When you read a row, the workspace validates it against the current schema. If it's an old version, a `migrate()` function transforms it at read time. Old data stays untouched in the CRDT; the schema is a lens over it. Peers running different app versions coexist because no migration coordinator is needed. Each client interprets the data through its own schema version.

This works. But it's not free: if you change a field type incompatibly, old values become inaccessible through the new schema. They're still in the document, just not readable. For a workspace where notes and tasks are the primary data, that's an acceptable trade-off. For financial records, it isn't.

## Partial replication: sync everything or build a server

"Sync only what this user needs" sounds like a feature. It's actually an architecture decision that cascades through your entire system.

A workspace with 50,000 items where each user cares about 500 needs partial replication. Syncing the full dataset to every client wastes bandwidth, memory, and battery. But deciding what subset to sync requires knowledge of the user's context. Their team, their permissions, their current view.

ElectricSQL solves this with shapes: declarative subscriptions that define subsets of Postgres data. PowerSync uses sync rules with bucket-based partitioning. Both require a server to evaluate the rules and stream the right subset.

Yjs syncs the full Y.Doc. It's delta-optimized. After the initial load, only changes are exchanged. But there's no per-table or per-query subscription. Every peer gets everything. For a personal workspace (one user, all their data), this is fine. For a team workspace with shared and private data, it's the next problem to solve.

Implementing partial replication peer-to-peer means every node needs to know what every other node wants. That starts looking like a routing table. Which starts looking like a server.

## Tombstones: your database only grows

Every CRDT system accumulates delete markers. When you delete a row, the CRDT can't just remove it. Other peers might not have seen it yet. Instead, it marks the item as deleted (a tombstone) and keeps it forever, because any peer might sync at any time and needs to learn that this item was deleted.

```
Y.Array after creating and deleting 1,000 items:

  With GC:    [gc_struct: length=1000]       (compact, a few bytes)
  Without GC: [tombstone][tombstone]...[×1000] (grows forever)
```

Yjs handles this well when garbage collection is enabled. Deleted items in a Y.Array merge into a single compact `GC` struct. But GC can't run if you need version history (snapshots require the full tombstone chain). And even with GC, the document grows monotonically. There's no way to shrink a Y.Doc without re-creating it from scratch.

Fly.io's corrosion fork of cr-sqlite hit this at scale. They built custom compaction logic and a separate tracking table to manage change gaps across 1,000 nodes. Every CRDT system eventually needs a compaction story, and most don't have one.

Our `YKeyValueLww` storage helps here: updating a row replaces the old entry in the Y.Array, and GC merges the tombstones into a single struct. After 300 saves to the same row, the overhead is 37 bytes. (See [Why YKeyValue, Not Y.Map](./why-ykeyvalue-not-ymap-for-workspace-storage.md) for the benchmarks.) But this only works with GC enabled, and it doesn't solve the fundamental monotonic-growth property of CRDTs.

## Server authority for things that need it

Some operations genuinely require a central authority. Payments can't be local-first. You need a server to charge the card. Sequential IDs require a coordinator. Uniqueness constraints (only one user can claim this username) need a single source of truth.

Every local-first system carves out exceptions for these. That's not a failure of the architecture; it's inherent to distributed systems. The important thing is knowing where the boundary is. Data that needs to be authoritative goes through the server. Data that needs to be available offline lives in the CRDT. The art is drawing the line in the right place.

## The hierarchy of hard problems

If you're building a local-first app, conflict resolution is solved. Pick Yjs, Automerge, or LWW timestamps. Any of them work for most use cases. Spend your time on the problems that don't have clean answers yet:

```
Solved:       Conflict resolution (CRDTs, LWW, OT. Pick one)
Manageable:   Tombstone growth (GC, compaction, careful storage design)
Hard:         Schema migrations (migrate-on-read, event-sourcing, or prayer)
Harder:       Partial replication (requires server-like coordination)
Unsolved:     Peer-to-peer permissions (reintroduces the server every time)
```

The conference talks about CRDTs are interesting. The production blockers are everything else.
