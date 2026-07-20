# 0166. Import initializes an empty owner or explicitly replaces the whole owner

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0143](0143-account-open-never-consumes-device-data.md) and the import and lineage-continuation provisions of [ADR-0147](0147-cross-plane-transfer-and-recovery-use-logical-coordination-not-atomic-snapshots.md); ADR-0165 and ADR-0169 replace its export and stale-recovery provisions.
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0161](0161-each-local-owner-persists-one-sqlite-database-and-one-blob-directory.md), [ADR-0162](0162-portability-is-a-frozen-editable-projection-of-one-selected-owner.md), and [ADR-0165](0165-export-captures-the-complete-durable-state-of-one-selected-owner.md)

## Context

A detached editable artifact needs a supported return path, but applying it as
patches to a nonempty owner would require generic diffing, conflict semantics,
row lifetime collision rules, document merge policy, blob reconciliation, and
partial-failure recovery. Automatically consuming local data at sign-in would
hide the same merge behind authentication.

Whole-owner replacement is a different operation. It can validate a complete
candidate before changing authority and can invalidate every old replica without
pretending their histories continue.

## Decision

Import has exactly two modes:

1. Initialize an empty selected owner from one completely validated artifact.
2. Explicitly replace a nonempty selected owner with that complete artifact as
   a new owner generation.

The default import refuses a nonempty destination without mutation. Replacement
is a separately named destructive operation with explicit user confirmation. It
first exports a rollback artifact of the current owner, validates and stages the
entire candidate, then atomically activates the new SQLite state and blob set.
For a server owner, replacement stages blobs under generation-scoped physical
keys, stages scalar and document authority state under the same generation, and
atomically flips the active-generation pointer. Failure before activation leaves
the existing owner unchanged.

Replacement advances the owner generation. Every replica from the prior
generation becomes recovery-required and may export its still-valuable durable
local state before reinitializing. It cannot upload old scalar intent or
document state into the replacement generation. Row-document connections and
frames carry the owner generation; activation closes prior-generation sockets,
and the authority rejects delayed handshakes or updates from them before
mutation. Old generation blobs and state become inaccessible at the flip and
are swept after the rollback/recovery policy permits.

Import never merges, patches, writes back to the source artifact, preserves sync
lineage, federates owners, or remains linked as a checkout. Account open never
consumes local-owner data automatically. Leaving the local owner intact is the
default; deleting it is a separate explicit operation.

## Consequences

- Deliberately edited artifacts can return through a supported, failure-atomic
  path without creating a universal merge engine.
- Replacement can discard concurrent work on other devices. Those devices get
  a salvage-export path, not automatic reconciliation.
- Rollback costs one additional complete artifact and explicit storage during
  replacement.
- Import is a rare owner lifecycle operation, not an ordinary application
  mutation or synchronization mode.

## Considered alternatives

- **Merge into a live owner.** Rejected because every primitive would need
  conflict and partial-commit policy across rows, documents, and blobs.
- **Silently replace a nonempty owner.** Rejected because import can destroy
  accepted state and strand other replicas.
- **Keep old replicas valid after replacement.** Rejected because their pending
  state was based on a different complete owner lifetime.
- **Automatically move local data at sign-in.** Rejected because identity
  selection does not authorize mutation of either independent owner.
