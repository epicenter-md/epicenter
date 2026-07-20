# 0169. Scalar convergence retains one bounded deletion and retry horizon

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md), [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md), and the stale-lineage recovery provisions of [ADR-0147](0147-cross-plane-transfer-and-recovery-use-logical-coordination-not-atomic-snapshots.md); ADR-0165 and ADR-0166 replace its export and import provisions.
- **Relates:** [ADR-0165](0165-export-captures-the-complete-durable-state-of-one-selected-owner.md) and [ADR-0166](0166-import-initializes-an-empty-owner-or-explicitly-replaces-the-whole-owner.md)

## Context

Permanent deletion tombstones, replica registrations, and retry receipts allow
an arbitrarily stale replica to replay mutations into the live authority. One
abandoned device can therefore make identity and deletion memory permanent.

Epicenter accepts a rare manual recovery workflow in exchange for bounded
authority state. Generated row IDs are never intentionally reused, so stale
replay needs protection only while its accepted scalar base remains inside the
retained horizon.

## Decision

The scalar authority stores current rows, a bounded change and deletion feed,
bounded exact-retry receipts, and one monotonically advancing retention floor.
The floor advances under server-owned storage policy and is never pinned by a
replica.

A sealed scalar mutation identifies its exact content and the oldest accepted
authority base on which its included intents depend. That base is pinned when
the local mutation generation begins and does not advance when later edits
compact into it. The authority checks the base before folding. A base below the
retention floor returns recovery-required without mutating current rows.

Exact retry is retained only inside the same bounded safety interval. A retained
mutation identity with the same digest returns its original receipt; the same
identity with different content halts without mutation. Compaction may delete
change markers, deletion markers, and retry receipts whose safety interval lies
at or below the floor. There is no permanent retired-row registry, replica
enrollment registry, round counter, or receipt kept for the owner lifetime.

Pull remains current-state pagination after a scalar sequence. A pull position
below the floor requires recovery; it does not rebase stale local intents onto a
fresh authority base. A replica with no previous accepted base may initialize
from complete current authority state.

A stale replica first exports any valuable durable local state through the
selected-owner artifact, or explicitly discards it. It then reinitializes its
private replica state and synchronizes again. It never uploads the stale scalar
generation into the live authority. Durable local row documents travel only in
the salvage artifact; their mathematical Yjs mergeability does not override the
invalid scalar row lifetime.

Public live creation always mints a fresh random row ID. Whole-owner artifact
initialization or replacement may preserve artifact IDs under a new owner
generation; that is not mutation replay into an existing authority.

## Consequences

- A replica is not guaranteed transparent reconnection after being offline
  indefinitely. The user may need to export, reinitialize, and manually recreate
  valuable changes.
- Permanent tombstones, eternal replica identity, unbounded deletion feeds, and
  arbitrarily stale mutation replay disappear.
- Once a retry receipt is pruned, an uncertain old retry becomes recovery rather
  than another permanent receipt family.
- Safety comes from the horizon gate, generated non-reused IDs, and owner
  generations, not an eternal identity registry.

## Considered alternatives

- **Retain permanent tombstones and receipts.** Rejected because one abandoned
  replica makes authority state permanent.
- **Automatically rebase stale intents.** Rejected because it can reinterpret
  updates after deletions and lens changes.
- **Let replicas pin the floor.** Rejected because abandoned devices restore
  unbounded retention.
- **Acknowledge scalar and document state on every device.** Rejected because it
  recreates the coordination family this bounded contract deletes.
