# 0130. Records replacement starts a new epoch without an online succession protocol

- **Status:** Accepted
- **Date:** 2026-07-13
- **Supersedes:** [ADR-0125](0125-record-schemas-are-immutable-evolution-creates-a-successor-database.md)
- **Amends:** [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md), [ADR-0122](0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md)

## Context

The first records-sync design treated schema evolution as a portable online
succession protocol. A client staged a candidate database, uploaded and sealed
its chunks, then asked the authority to activate it against a source head. That
turned one disruptive administrative operation into a shared lifecycle with
candidate state, five routes, source-head compare-and-swap, retained fenced
databases, and a second bootstrap path.

No released product needs that protocol. Restore and wholesale replacement
still need a hard boundary so a cursor or write from the old history cannot
enter the new one, but temporary upload storage is deployment infrastructure,
not a synchronization concept.

## Decision

A workspace has one active records epoch. A records epoch identifies one
continuous server-ordered records history and carries one records schema hash.
Positions and requests are qualified by `(recordsEpoch, sequence)`.

Every change to the synchronized records schema hash starts a new records
epoch. Epicenter does not classify schema changes as compatible, let several
schema hashes share one epoch, or translate mutations between schemas. Local
indexes and physical storage may change without starting a new epoch because
they do not change the synchronized records schema.

Ordinary record changes use ordinary mutations. Restore or wholesale
replacement is a disruptive administrative operation: the owner briefly rejects
writes, installs a complete logical snapshot as a new records epoch, and selects
that epoch durably. How a deployment receives and stages replacement bytes is
deployment-specific. The portable records protocol has no candidate, stage,
upload, seal, activate, discard, source-head compare-and-swap, or retained
database lifecycle.

This decision ships the epoch fence, not a portable replacement operation. Any
future deployment-owned replacement operation must close the acknowledged-write
window with exclusive authority access or an expected-sequence check. In one
atomic transition it must install the complete logical state, clear the previous
mutation log and snapshot state, set the new records schema hash, and mint a
never-reused records epoch. The caller cannot choose or reuse an epoch.

The authority transactionally rejects a request whose records epoch is not
current. `open` reports the current records epoch and records schema hash, even
when they differ from the caller's local binding. A replica that discovers an
epoch mismatch stops synchronization, preserves its local rows and unsynced
outbox, persists the refusal across restart, and requires explicit reload or
recovery. An old cursor never resumes inside a new epoch.

Logical snapshots remain the portable records format. A fresh replica
bootstraps the current epoch through the ordinary snapshot and mutation
protocol. Before binding that epoch, it verifies that the authority's records
schema hash equals the application definition's hash. It never adopts an
unknown schema merely because the authority reported it. Replacement does not
introduce a second bootstrap format or a shared multi-database authority.

The records schema hash covers every portable rule that changes which records
the application accepts or how their values are interpreted. Metadata may be
excluded only when changing it leaves those acceptance and interpretation
semantics unchanged. Local indexes and physical layout remain outside the hash.

`recordsEpoch` is records-specific. Workspace KV, child documents, and blobs
keep their own identities and lifecycles. Applications do not author epoch
values.

## Consequences

- Hosted Cloud and the self-hosted instance share one epoch fence, not a
  replacement transport.
- The records authority needs one durable current-epoch value. It does not need
  a workspace-family selector, candidate tables, database status values, or
  readable fenced predecessors.
- A replacement may require a short write pause. This is explicit operational
  disruption, not hidden optimistic concurrency.
- Pending work from an old epoch is preserved locally but never replayed into
  the new epoch automatically. Recovery is an explicit product or
  administrator action.
- Every synchronized records schema change starts a new epoch. The application
  or deployment may prepare transformed logical rows, but the shared sync
  engine sees only a complete replacement and the new epoch.
- Applications may preserve old descriptors and write one-off row transforms,
  but Epicenter provides no shared migration or online succession API.
- The SQLite records protocol is unreleased, so the clean break keeps no aliases,
  fallback readers, or compatibility routes for database-family vocabulary.

## Considered alternatives

- **Keep online succession only for schema migration.** Rejected: a rare
  administrative operation would still own a permanent candidate protocol and
  multi-database state machine in every deployment.
- **Let old requests continue by sequence alone.** Rejected: sequence values
  restart inside a new history, so an old cursor or write could be mistaken for
  current work.
- **Put the epoch on the whole workspace.** Rejected: KV, child documents, and
  blobs do not reset when records are replaced.
