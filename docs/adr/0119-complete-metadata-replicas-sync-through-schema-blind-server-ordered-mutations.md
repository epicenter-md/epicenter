# 0119. Complete metadata replicas sync through schema-blind server-ordered mutations

- **Status:** Proposed
- **Date:** 2026-07-11
- **Relates:** [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md), [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md), [ADR-0092](0092-identity-is-the-partition.md)

## Context

Epicenter currently keeps record metadata in Yjs workspace tables. That gives
every record CRDT history and requires clients to load the CRDT representation
before they can query it. Large personal collections instead need a directly
queryable local database, predictable memory use, and a synchronization model
that remains understandable when a phone has been offline for years. Epicenter
can accept a central authority because each synchronized database belongs to
exactly one principal and self-hosting provides the custody alternative.

## Decision

Each `(principal, app)` pair owns one logical metadata database. Every
synchronized device keeps a complete local SQLite replica of that database.
Clients send atomic logical mutations to a schema-blind authoritative server;
the server accepts them into one monotonically ordered sequence, folds them into
canonical current state, and serves the accepted mutations back through a
cursor-based pull protocol. A WebSocket is only a wake-up hint to pull after the
client's cursor.

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
- A device synchronizes all metadata for an app database or does not synchronize
  that database. Large bodies and blobs use separate lazy planes.
- Server acceptance order is the only scalar conflict clock. Device wall clocks,
  hybrid logical clocks, and per-cell timestamp metadata do not participate.
- Every actor preserves its own mutation order. Mutations may patch multiple rows
  and tables, and the server accepts or pauses the whole mutation atomically.
- Every structurally valid authenticated mutation enters server order. Operations
  that no longer apply fold to deterministic no-ops; the server never drops one
  operation and continues with later operations from the mutation.
- Authentication, protocol incompatibility, corruption, sequence gaps, and
  account-wide limits pause synchronization instead of selectively rewriting a
  client's outbox.
- Current state, a compact bootstrap snapshot, per-actor accepted high-water
  marks, terminal row tombstones, and the uncompacted log tail are durable. Old
  mutation history is not.
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
