# 0119. Complete metadata replicas sync through schema-blind server-ordered mutations

- **Status:** Accepted
- **Date:** 2026-07-11
- **Relates:** [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md), [ADR-0079 (cross-device is two planes)](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md), [ADR-0092 (identity is the partition)](0092-identity-is-the-partition.md)
- **Amended by:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md) (database-family succession is replaced by one active records epoch)

## Context

Epicenter currently keeps record metadata in Yjs workspace tables. That gives
every record CRDT history and requires clients to load the CRDT representation
before they can query it. Large personal collections instead need a directly
queryable local database, predictable memory use, and a synchronization model
that remains understandable when a phone has been offline for years. Epicenter
can accept a central authority because each synchronized database belongs to
exactly one principal and self-hosting provides the custody alternative.

## Decision

Each `(principal, workspace)` pair owns one active records epoch. The epoch
identifies one continuous records history under one portable records schema
hash. Actors, cursors, outboxes, mutations, and snapshots bind to that epoch;
the server compares records schema hashes as opaque strings and pauses writers
presenting a different one. Every synchronized device keeps a complete local
SQLite replica of the active records epoch.

Every synchronized records schema change, restore, or wholesale replacement
starts a new records epoch through the administrative boundary in ADR-0130. The
shared synchronization protocol does not stage or activate a successor. It only
discovers the current epoch and rejects work bound to another one.

Clients send atomic logical mutations to a schema-blind authoritative server;
the server accepts them into one monotonically ordered sequence, folds them into
canonical current state, and serves the accepted mutations back through a
cursor-based pull protocol. A WebSocket is only a wake-up hint to pull after the
client's cursor.

Every ordinary write transaction atomically verifies that the request names the
active records epoch, folds the mutation, advances that epoch's sequence, and
commits. A replacement operation briefly rejects writes while it installs and
selects a new epoch. No write admitted against the old epoch may commit after
that selection.

The server understands database, table, row, field, JSON value, actor, mutation,
and sequence identity. It does not understand app-specific schemas or run
app-specific queries. The same protocol and fold sit behind a Durable Object
SQLite adapter in Epicenter Cloud and a Bun SQLite adapter in the self-hosted
instance.

The mutation log is transport state, not product history. The server may replace
an accepted prefix with one logical snapshot and permanently delete that prefix.
A stale client installs the snapshot, reapplies its durable pending mutations,
and continues from the snapshot sequence. The protocol promises no partial
replicas, row filters, peer-to-peer merge, or permanent audit log.

## Consequences

- Local reads, filtering, sorting, and indexing use ordinary SQLite even when no
  server exists.
- A replica materializes live metadata directly in typed application tables.
  Its durable sync state is the outbox, cursor/actor state, and quarantine for
  nonconforming rows; it does not keep a second canonical client shadow.
  [Gate 1](../../demos/local-first-sync/gates/GATE1-EVIDENCE.md)
  found no schedule that earned one.
- A device synchronizes all metadata for an app database or does not synchronize
  that database. Large bodies and blobs use separate lazy planes.
- Server acceptance order is the only scalar conflict clock. Device wall clocks,
  hybrid logical clocks, and per-cell timestamp metadata do not participate.
- Every actor preserves its own mutation order. Mutations may change multiple
  rows and tables, and the server accepts or pauses the whole mutation
  atomically.
- Rows have an explicit lifecycle: `createRow` materializes an absent identity,
  `updateRow` changes named cells of a live row, and `deleteRow` physically
  removes it. An update or delete whose row is absent folds to a deterministic
  accepted no-op; the server never drops one operation and continues with later
  operations from the mutation. A `createRow` whose identity is already live is
  not a routine no-op: it is refused as a replica invariant violation, and the
  submitting replica discards its state and rebootstraps from the authority.
- Deletion knowledge is not retained. A deleted row is physically absent from
  canonical state and from snapshots; resurrection is prevented by explicit
  creation plus one-lifetime row identities, not by tombstone records.
- Authentication, protocol incompatibility, corruption, sequence gaps, and
  account-wide limits pause synchronization instead of selectively rewriting a
  client's outbox.
- Current state, a compact bootstrap snapshot, per-actor accepted high-water
  marks, and the uncompacted log tail are durable. Old mutation history is not.
  Snapshots freeze live rows and actor high-water marks from one read state at
  one server sequence; snapshot size follows the live dataset, not the
  database's lifetime deletion history.
- The server publishes only a current-head logical snapshot. One immutable
  generation is addressable at a time; a client whose abandoned generation was
  replaced restarts from the current manifest. Clients stage and verify chunks
  without changing visible state, then install, prune contained outbox entries,
  replay remaining pending intent, and advance the cursor atomically.
  [Gate 2](../../demos/local-first-sync/gates/GATE2-EVIDENCE.md) proves this is
  sufficient for permanent log-prefix deletion.
- Active actor high-water marks grow with a records epoch's lifetime actor
  churn. This is stated cost, not hidden: the bound is per epoch, actor
  identities never reset within one, and a replacement starts a fresh actor set.
- The explicit lifecycle asks more of writers: an update cannot materialize a
  missing row, a purged row identity has exactly one lifetime, and restoring
  purged content copies it into a fresh identity. In exchange the durable
  system keeps no tombstone state in replicas, snapshots, compaction, imports,
  or schema transitions.
- App-specific cloud workers remain outside the sync engine. A worker that writes
  data acts as a named server-side actor and submits an ordinary mutation through
  the owning database authority.
- Existing ADRs that describe Yjs as the whole synchronized workspace plane must
  be reconciled before this ADR is accepted. Yjs survives for declared child
  documents, not record metadata.

## Considered alternatives

- **Synchronize SQLite files or WAL pages.** Rejected: independently writable
  files do not provide a safe logical merge boundary and couple the protocol to
  one physical SQLite implementation.
- **Use HLC or wall-clock LWW per cell.** Rejected: it retains a clock beside every
  cell, expands snapshots and migrations, and lets a bad future device clock
  dominate otherwise valid writes.
- **Use a partial-replication service such as a query subscription engine.**
  Rejected: every device needs the complete metadata database, so filters and
  dependency tracking would preserve a second product Epicenter does not need.
- **Keep the oplog as permanent history.** Rejected: version history is an app
  feature, not a transport obligation. Apps that need history model it as data.
- **Fold creation and update into one upsert and retain tombstones.** Rejected:
  an upsert makes absence ambiguous, so permanent deletion must become a second
  kind of durable row that every replica, snapshot, compaction pass, import,
  and schema transition carries forever. Splitting creation from update lets a
  delayed edit fold to a no-op and lets deletion mean physical absence again.
- **Retain an eternal used-identity registry.** Rejected: it defends only
  against a trusted client minting a fresh `createRow` for an old purged UUID,
  which conforming typed APIs never do, and it would regrow exactly the
  unbounded deletion history the tombstone removal deletes.
