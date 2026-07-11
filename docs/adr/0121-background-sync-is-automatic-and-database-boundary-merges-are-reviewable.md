# 0121. Background sync is automatic and database-boundary merges are reviewable

- **Status:** Proposed
- **Date:** 2026-07-11
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0092](0092-sign-in-migration-child-doc-guids-are-derived-from-the-schema.md)

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

Explicit database-boundary operations are reviewable logical merges. Import,
restore-as-copy, local-to-account migration, Cloud-to-self-host movement, and
self-host-to-Cloud movement compare source and destination application state by
table, row, and cell. The user may apply a bulk preference and inspect differing
cells. The selected result is emitted as ordinary `patchRow` and `deleteRow`
mutations; the sync protocol has no separate merge verb.

A local-only database carries application tables and child documents, but no
actor identity, cursor, sync outbox, or dormant mutation history. Enabling sync
opens or creates the account database, installs its current snapshot, imports
the local rows and child docs logically, and begins recording normal mutations.
The source stays intact until the imported mutations are accepted.

Application identity is portable; replica identity is not. Logical exports keep
stable row ids and content but omit actor identity, cursors, and outboxes. A
physical backup may restore a lost replica. Opening a copy while the original
remains writable requires an explicit import-as-new-replica flow that mints a
new actor identity.

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
- The general merge editor is useful beyond sign-in: it can compare compatible
  local files, backups, Cloud databases, and self-hosted databases through one
  logical snapshot interface.
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
