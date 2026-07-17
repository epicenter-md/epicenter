# 0136. Replica bootstrap uses a disposable anchored live scan

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md), [ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

A replica below the authority's retained-outcome floor needs a complete baseline.
Persisted snapshot publications and resumable replica installs create manifests,
chunks, generations, cleanup, recovery, and another long-lived data product.
Bootstrap only needs a correct current baseline plus ordinary outcomes after one
anchor.

Bootstrap is required by the combination of three promises:

```txt
authority outcome history is bounded
replicas may return after arbitrary offline time
durable local intent is not discarded
```

Incremental catch-up cannot cross a history gap. Removing every full-state path
therefore requires refusing at least one of those promises, not merely choosing
a different transfer protocol.

## Decision

One sync operation serves both catch-up and bootstrap. Above the retention floor,
the authority returns ordinary ordered outcomes. Below it, bootstrap:

1. Captures authority head `S` as the replay start.
2. Scans live rows in stable address order. Each row read atomically returns its
   complete fields and the complete body composite defined by ADR-0133.
3. Captures authority head `E` when the scan finishes.
4. Runs the ordinary confirmed-outcome fold over scratch for every sequence in
   `(S, E]`.
5. Promotes only when the scratch fold cursor is exactly `E`.
6. Continues ordinary catch-up above `E` after promotion.

The scan is intentionally not a historical snapshot as of `S`: different rows
may include later state. Complete scalar postimages and idempotent Yjs updates
make replay converge at `E`. During replay, a composite outcome carrying fields
installs its complete live row postimage even when scratch lacks that row; a
body-only outcome on an absent row and a deletion of an absent row no-op. These
rules are safe because row ids are never reused.

The retention floor must remain at or below the scratch fold cursor throughout
the scan and replay. Every page checks it. If the floor overtakes the cursor,
the adapter discards scratch and restarts with a new anchor.

The adapter may use a temporary database, sidecar file, or other bounded scratch
large enough for the workspace. Scratch is disposable, not necessarily in
memory. It is outside the four canonical tables, never an ownership export or
backup, and is not resumed after process restart. Promotion preserves the old
canonical file until an adapter-specific atomic swap or transaction installs the
complete scratch baseline.

An existing device remains usable from its old complete baseline plus local
RowIntents while scratch is built. It never exposes partially scanned scratch.
A brand-new device has no complete baseline and therefore waits until promotion
before workspace reads become available.

Replica identity, the sealed-round retry chain, and every open or sealed
RowIntent remain in canonical storage throughout bootstrap. A crash discards
only scratch. An already accepted sealed round is answered from the authority's
durable receipt without reapplying its scalar component.

The authority stores current rows, body baselines plus retained tails, ordered
outcomes, exact-retry receipts, and its compaction floor. It does not publish or
retain snapshot manifests, chunks, generations, or refreshable download sessions.

## Consequences

- Durable replica snapshot tables and authority snapshot-publication families
  disappear.
- Bootstrap may redo work after a crash or floor race. That is the deliberate
  cost of refusing resumability for a rare, derivable operation.
- An existing device can remain usable while bootstrapping, but may show stale
  confirmed data plus its durable local intent until atomic promotion. A new
  device waits for the initial complete baseline.
- Bootstrap uses the ordinary confirmed-outcome fold, checkpoint, and retry
  identity. It adds no second replay vocabulary.
- Logical ownership export/import and operator disaster-recovery backups remain
  separate concerns. Epicenter gains no restore-point UI, backup schedule,
  retention policy, or version-history product.

## Considered alternatives

- **Persist resumable install state.** Rejected because it turns disposable
  transfer progress into canonical schema and recovery policy.
- **Publish immutable authority snapshots.** Rejected because current state plus
  an anchored idempotent outcome tail proves the same result with fewer owners.
- **Retain every outcome forever.** Rejected because it deletes bootstrap by
  making authority history unbounded.
- **Expire replicas below the retention floor.** Rejected because a device that
  returns late would need to discard or manually export its durable local work.
- **Let the oldest replica pin compaction.** Rejected because one abandoned
  device could prevent authority history from ever becoming bounded.
- **Keep scratch only in memory.** Rejected because large workspaces may require
  disk; disposability is the relevant property.
- **Conflate export with bootstrap.** Rejected because ownership portability and
  synchronization recovery have different consumers and lifecycle promises.
