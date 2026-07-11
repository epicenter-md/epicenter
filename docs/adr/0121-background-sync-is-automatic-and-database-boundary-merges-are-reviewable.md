# 0121. Background sync is automatic and database-boundary merges are reviewable

- **Status:** Proposed
- **Date:** 2026-07-11
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0092 (sign-in migration child-doc guids)](0092-sign-in-migration-child-doc-guids-are-derived-from-the-schema.md) (note: the number 0092 is currently shared with `0092-identity-is-the-partition.md`; resolve the collision before acceptance)

## Context

Reviewable conflicts are valuable when a user deliberately combines two complete
databases. They are a different product during continuous synchronization:
detecting and retaining every overwritten scalar value requires per-cell causal
metadata, conflict records, acknowledgement, resolution mutations, garbage
collection, and UI that can block or trail background work. Most routine edits
touch different cells, while content that cannot tolerate scalar replacement is
already a Yjs document.

## Decision

Background synchronization never interrupts the user for scalar conflicts.
Causally ordered writes preserve their order; genuinely concurrent assignments
to different cells compose; concurrent assignments to the same cell resolve by
server acceptance order. Epicenter does not retain a background conflict inbox,
expose per-edit discard, or promise recovery of every overwritten scalar value.

Explicit database-boundary operations go through one reviewable import
planner. Import, restore, local-to-account promotion, Cloud-to-self-host
movement, self-host-to-Cloud movement, physical-clone adoption, and
schema-epoch upgrade compare pinned source and destination logical snapshots
by table, row, and cell. Unambiguous work applies without review: source-only
rows, equal cells, and carried tombstones. The user applies a bulk preference
to differing cells and reviews genuine ambiguity; a source row the destination
terminally deleted defaults to the deletion and can only be restored under a
new row id through an app-owned copy flow; the generic first-wave planner does
not guess how to remap inbound references. Applying a plan revalidates the
destination head, and the selected result is emitted as ordinary `patchRow` and
`deleteRow` mutations; the sync protocol has no separate merge verb.

For a schema-epoch upgrade, the new incarnation's global baseline is transformed
from the old incarnation's frozen canonical server snapshot, never from one
replica's private pending overlay. After activation, every replica transforms
its own visible local state and imports only its difference through this same
planner. This keeps global cutover resumable and gives no initiating device a
special merge authority.
[Gate 3](../../demos/local-first-sync/gates/GATE3-EVIDENCE.md) proves that split:
the successor baseline contains the frozen canonical value, then the initiating
replica's transformed private value arrives as an ordinary post-activation
mutation. Equal content emits no import operation.

A local-only database carries application tables and child documents, but no
actor identity, cursor, sync outbox, or dormant mutation history. Enabling sync
opens or creates the account database, installs its current snapshot, imports
the local rows and child docs logically, and begins recording normal mutations.
The source stays intact until the imported mutations are accepted.

Application identity is portable; replica identity is not. Logical exports keep
stable row ids and content but omit actor identity, cursors, and outboxes.
Every physical restore or copy — including a backup of a genuinely lost
replica — opens as an import source and mints a new actor identity: the
protocol cannot distinguish a restored lost replica from a live clone, and an
actor-preserving restore silently discards divergent writes when a reused
sequence number was already accepted with a different payload. Reopening the
same durable file after a crash is not a restore; its actor and outbox
continue, and sequence deduplication absorbs the retry.

## Consequences

- A long-offline device may overwrite a same-cell assignment made later by
  another device when its mutation reaches the server later. This is the stated
  tiebreak for concurrent scalar intent, not an attempt to infer human chronology
  from unreliable device clocks.
- There is no permanent version-history product hidden inside synchronization.
  Normal Undo emits another mutation. Replacing local state from Cloud is an
  explicit destructive rebootstrap, not selective outbox surgery.
- A signed-in replica may remain offline indefinitely. On return it installs the
  current server snapshot, reapplies its pending mutations, and continues without
  requiring retained log history.
- The import planner is useful beyond sign-in: it compares compatible local
  files, backups, Cloud databases, self-hosted databases, and superseded-epoch
  replicas through one logical snapshot interface. The first implementation is
  a planner with a summary and bulk preference; a per-cell editor is built only
  when review volume earns it.
- A development-only observer may count remote operations that overlap a pending
  local cell, but aggregate diagnostics do not create a conflict-review product
  contract.
- Fields where losing one concurrent assignment is unacceptable must use a Yjs
  document or domain operations represented as rows. Counters, ledgers, and
  append-only facts are not implemented as read-modify-write scalar cells.

## Considered alternatives

- **Show a conflict editor after every background sync collision.** Rejected: it
  turns transport into permanent user data and recreates the causal metadata,
  resolution lifecycle, and history this design removes.
- **Use device timestamps or HLCs to approximate human chronology.** Rejected:
  clock skew has an unbounded failure mode and the metadata remains with every
  cell. The central sequencer already provides a deterministic order.
- **Copy the local SQLite file over the account database on sign-in.** Rejected:
  it destroys destination-only fields, replica metadata, and pending account
  work. Logical import uses the same mutation path as every other write.
- **Record a local-only outbox in case the user signs in later.** Rejected: a user
  who never signs in would accumulate unbounded transport history. Sign-in imports
  current state, not every historical keystroke.
