# 0163. Latest scalar state synchronizes through one Epicenter exchange

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md), and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
- **Amends:** the scalar protocol in [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md)

## Context

Push, pull, and acquisition were consequences of workspace-scoped histories,
retention floors, and baseline recovery. Whole-Epicenter replication and a
zero-legacy-data launch permit a smaller protocol. The remaining hard case is
deletion: a replica may stay offline indefinitely and later present state that
was deleted elsewhere.

[ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
fixes the semantic unit at one independently convergent scalar address and
refuses commit semantics for transport grouping. The sequence, receipt,
pagination, and checkpoint-like mechanisms below remain a Proposed protocol
candidate until adversarial review proves that each one is necessary.

## Decision

Every scalar address stores exactly one winning latest-state record at the
authority: either live state or a deletion state. Each accepted change receives
a monotonically increasing authority sequence. Values use
`(namespace key, value key)` as the address; rows use
`(namespace key, table key, globally unique row ID)`.

A row tombstone is terminal synchronization state, not an application row. It
retains the address and winning version but no deleted payload or document
bytes. Row IDs are never reused by conforming runtimes; later create and update
operations at a tombstoned address are no-ops. Row tombstones remain permanently
unless a future compaction design proves, with a different protocol, that no
offline or restored replica can resurrect the address.

An unset value also has a payload-free latest state so replicas can observe the
unset, but it is not terminal: a later accepted `set` replaces it. Row and value
states may share one physical relation while their discriminator-aware folds
preserve this lifecycle difference.

Scalar synchronization uses one versioned exchange for the entire Epicenter:

```txt
POST /api/sync/v1

request  replica identity, last applied authority sequence,
         bounded pending local changes, optional page continuation
response accepted-local receipt, fixed page ceiling, latest-state records,
         next sequence or continuation
```

At the start of a paged response, the authority fixes `through` to its current
maximum sequence. It returns records whose latest `changed_sequence` is greater
than the replica's `after` and no greater than `through`, ordered by sequence.
If a record changes during paging, its latest sequence moves above `through`
and the next exchange returns it. The client advances to `through` only after
installing every page. The implementation must prove this pagination invariant
under concurrent writes before the protocol is accepted.

The exact request encoding, idempotency receipt, conflict ordering, batch
limits, and retry rules belong to the protocol implementation and conformance
tests. They must not split the product back into push, pull, acquire, database,
or table-specific network operations.

Synchronization starts automatically when an attached replica has credentials
and network access. Public status is observation only: idle, syncing, pending
for a small actionable reason, or authentication required. There is no public
settlement cut, protocol floor, acquisition mode, lineage recovery, or generic
authority scheduler. The scalar HTTP route version and row-document WebSocket
subprotocol version evolve independently.

Row documents remain a separate lazy plane because hydrating every Yjs document
would defeat table-shaped local reads. One authenticated WebSocket binds one
currently open row document. Multiplexing does not ship until measured browser
socket limits require it.

## Consequences

- Permanent compact row tombstones delete retention floors, deletion-history
  windows, baseline acquisition, replica acknowledgment catalogs, and offline
  migrators.
- A globally unique row ID prevents collisions and reuse, but does not by itself
  communicate deletion. The tombstone supplies the missing causal winner.
- New replicas start at sequence zero and learn the current latest state without
  a separate acquisition protocol.
- The authority retains one compact tombstone for every deleted row address.
  This is the deliberate storage cost of indefinite offline correctness. An
  unset value occupies one latest-state record only until a later set.

## Considered alternatives

- **Delete tombstones after all known replicas acknowledge them.** Rejected
  because it requires permanent replica membership, lost-device lifecycle, and
  restored-replica rules.
- **Compact tombstones behind a retention floor.** Rejected because it brings
  baseline acquisition and lineage recovery back.
- **Treat globally unique IDs as sufficient.** Rejected because an offline
  replica can upload an older state for the same legitimate ID.
- **Send the full live dataset on every exchange.** Rejected because physical
  absence can communicate deletion only at unbounded recurring bandwidth cost.
