# 0133. Row bodies are sequence-addressed update logs in the record authority

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md), [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md), [ADR-0131](0131-record-sync-folds-sealed-replica-rounds-without-refusal.md)

## Context

ADR-0130 makes a body row-owned with no public identity, but today's records
authority and Yjs rooms are independently addressable, so no single transaction
can prove a row is live while accepting or purging its body updates. The
open mechanisms were the authority topology, the update addressing, the
offline story before a create is accepted, and the browser durability
acknowledgement. A prototype (30 executable trace checks) ran the full
lifecycle against one candidate topology: body updates as commands in the
record authority's own order.

## Decision

A row body is a per-row log of opaque CRDT update payloads inside the record
authority, written by one new command: `bodyAppend(table, rowId, update)`.
The command rides the same outbox, sealed rounds, server order, state pages,
snapshots, and compaction floor as row commands.

- **Liveness is the fold rule.** `bodyAppend` on a live row appends;
  on an absent row (never created, or dead forever) it is an accepted
  deterministic no-op, exactly like `patchRow` on absence. `deleteRow` purges
  the row's authoritative body log in the same fold. There is no incarnation
  token, lifetime integer, or fencing state; late updates from a deleted
  lifetime are permanently inert because absence is permanent (ADR-0131).
- **Updates are addressed by their authority sequence,** never by a per-row
  array index. Positional addressing diverges after compaction reindexes a
  log; the sequence is the one stable, monotone address the protocol already
  owns.
- **Offline parking is outbox ordering.** A body opened and edited before its
  row's create is accepted needs no parking state: the create precedes its
  appends in the same round, so the authority folds them in order.
- **A replica drops queued body edits for a row the authority reports
  deleted** (the deletion fence). Appends already sealed into an in-flight
  round are immutable and rely on the authority fold instead.
- **Compaction merges a row's covered update prefix into one baseline** at the
  snapshot floor, through an injected merge function; the sync core stays
  CRDT-library-free and treats update bytes as opaque everywhere else.
  Snapshots carry the merged baseline per live row.
- **An edit is durable when the local SQLite transaction that stores its
  update and its outbox command commits.** The opened body exposes that
  acknowledgement (`whenDurable()`); whether editors await it per keystroke or
  only on close/discard is a browser measurement, not a semantic question.

## Consequences

- One authority, one order, one crash boundary: a body update concurrent with
  row deletion cannot survive it, and the deletion race, late-update,
  crash/reopen, catch-up, snapshot, and compaction traces are the row traces.
- Interior text merge stays earned: bodies keep a real CRDT merge engine while
  rows and KV stay plain JSON under server order.
- The authority gains one responsibility it did not have: merge-aware
  compaction of body bytes. Injection keeps the dependency at the composition
  seam (the same pattern as the injected `sha256`), but an authority that
  never compacts bodies keeps an unbounded per-row log between snapshots.
- Body bytes count against round and page budgets like any command payload;
  very large pastes page like any large state.
- Per-room Yjs transports for record-owned bodies are retired when this
  lands; body transport is the record sync exchange. (Free-standing
  collaborative documents outside tables are unaffected; ADR-0130 already
  removed them from workspace definitions.)

## Considered alternatives

- **Independent Yjs rooms keyed by row id (status quo).** Cannot atomically
  prove row liveness when accepting or purging body state; deletion and
  recreation races live in the seam between two authorities.
- **Authority-assigned row incarnation fencing.** Nothing left to fence under
  dead-forever ids; adds a lifetime fact to every row for races that fold
  rules already absorb.
- **Per-row positional update indexes.** Falsified live: a replica that pulls
  a reindexed update after compaction overwrites a different update stored at
  that index and diverges.
- **Unbounded append log without merge-aware compaction.** Keeps the core
  byte-opaque but lets a hot document's log grow without bound; refused.
