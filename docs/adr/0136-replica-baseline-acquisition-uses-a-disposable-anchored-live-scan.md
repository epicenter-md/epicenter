# 0136. Replica baseline acquisition uses a disposable anchored live scan

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md), [ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

A new device has no confirmed state. A device returning after a long offline
period may have a complete old baseline and durable RowIntents, but its
checkpoint can fall below the authority's retained-outcome floor. Incremental
catch-up cannot cross that history gap.

The product keeps three promises:

```txt
authority outcome history is bounded
replicas are not expired because of arbitrary offline time
durable RowIntents remain automatically eligible for synchronization
```

Some complete confirmed-state acquisition is therefore irreducible. The design
question is whether that operation becomes a durable snapshot product or stays
a disposable synchronization phase.

## Decision

Initial bootstrap and long-offline reseeding are two entry conditions for one
operation named **baseline acquisition**:

```txt
acquire complete confirmed state
preserve canonical authored intent
promote atomically
resume ordinary synchronization
```

Above the retention floor, a replica uses ordinary ordered outcomes. A fresh
replica or a replica below the floor acquires a baseline:

1. Capture authority head `S` as the replay anchor.
2. Scan live rows through stateless pages in stable address order. Each row read
   atomically returns its complete fields and the complete body composite from
   ADR-0133.
3. Capture authority head `E` with the final scan page.
4. Apply the ordinary confirmed-outcome fold over scratch for every sequence in
   `(S, E]`.
5. Promote only when the scratch fold cursor is exactly `E`.
6. Continue ordinary catch-up above `E`.

Baseline acquisition exclusively owns the replica's network synchronization
lane. Local edits may continue into canonical open RowIntents, but the replica
installs no ordinary outcome pages and submits no new or retry round until
promotion completes. The canonical checkpoint therefore cannot advance past
the acquisition target while scratch is built.

The address scan is intentionally not a historical snapshot as of `S`.
Different rows may include later state, and a row created after the scan passed
its address may be absent. Complete scalar postimages, delete outcomes, and
idempotent Yjs updates make the `(S, E]` fold converge scratch to one coherent
authority state at `E`. A composite outcome carrying fields installs its
complete live postimage even when scratch lacks that row. A body-only outcome
on an absent row and a deletion of an absent row no-op. Row ids are never reused.

Keeping the `(S, E]` fold inside hidden scratch is deliberate. Promoting the
fuzzy address scan at `S` and catching up visibly could temporarily regress a
field when an earlier postimage replays over a later value already seen by the
scan. Exact promotion at `E` preserves the replica checkpoint as the installed
confirmed-state cursor.

The retention floor must remain at or below the scratch fold cursor. Every scan
and outcome page reports the floor. If it overtakes the cursor, the replica
deletes scratch and starts again with a new anchor. This guarantees safety, not
completion under unbounded authority churn: one attempt must finish within the
retained-outcome window. The authority holds no scan session, compaction lease,
or per-replica liveness promise.

## Disposable scratch and promotion

The baseline-acquisition adapter owns one disposable sidecar with only:

```txt
records  scanned and folded confirmed field maps
bodies   scanned and folded confirmed body state
```

Anchor `S`, address cursor, target `E`, and fold cursor live only in the running
operation. Stateless page requests may retry while that process remains alive.
The cursors are not sidecar tables or crash-resumable state. The sidecar
is never an ownership export, backup, canonical workspace, or fifth replica
table. Deleting it is the entire crash-recovery policy before promotion.

The canonical workspace continues to own `row_intents` and `replica`. An
existing device may keep serving its old complete confirmed baseline plus local
RowIntents while the sidecar is built. A new device waits because it has no
complete baseline. Partially acquired state is never visible.

Promotion takes an exclusive workspace barrier. It stops new canonical
operations, drains already-emitted body persistence, revokes every live body
handle, and freezes scratch. It then reads the sidecar and, in one transaction
on the canonical workspace:

1. Replaces `records`.
2. Replaces `bodies`.
3. Sets `replica.checkpoint` to `E`.
4. Preserves replica id, accepted round, in-flight round and digest, and every
   open or sealed RowIntent.

A crash during promotion leaves either the old canonical state or the complete
new state. After commit, current projections rebuild before the barrier releases.
Callers explicitly reopen body handles from the new confirmed baseline plus
intent, and the sidecar is deleted. No read or write observes the promoted
checkpoint through a pre-promotion projection or handle. The first ordinary
exchange above `E` carries or retries the sealed round; newer open intent then
seals normally. There is no recovery-specific submission phase.

## Long-offline intent

Elapsed time never expires, gates, or changes a durable RowIntent. After
baseline promotion, the replica automatically retries its immutable sealed
round and seals newer open intent through the ordinary protocol. The authority's
durable `(replicaId, acceptedRound, requestDigest)` receipt prevents an already
accepted sealed round from folding twice even when its outcome has been
compacted into the acquired baseline.

Automatic submission does not promise that old intent wins. Update against an
absent row, delete against absence, and create collision retain their ordinary
deterministic no-op rules. An absolute scalar change against a live row enters
normal authority order; a Yjs body update enters normal CRDT merge. Time creates
no second conflict doctrine and no stale-change review state.

The authority stores current rows, body baselines plus retained tails, bounded
ordered outcomes, one exact-retry receipt per replica, and its compaction floor.
It publishes no snapshot artifact and stores no transfer progress.

## Consequences

- Durable snapshot tables, authority snapshot publications, transfer manifests,
  refreshable downloads, scan sessions, compaction leases, expired-replica
  state, recovery copies, and stale-change review UI disappear.
- Acquisition may redo all work after a process crash or floor race. A live
  process may retry stateless pages after a transient disconnect. This is the
  deliberate boundary of refusing durable resumability for derived state.
- Automatic retry is guaranteed; completion under unbounded continuous churn
  is not. The authority must retain enough outcomes for one acquisition to
  finish. Epicenter refuses per-replica floor pins and restarts acquisition when
  that window is unavailable.
- Initial bootstrap and long-offline reseeding use one protocol path.
- Baseline acquisition reuses the ordinary confirmed-outcome fold, checkpoint,
  retry identity, and RowIntent rules. It adds no mutation vocabulary.
- Logical ownership export/import and operator disaster-recovery backups remain
  separate concerns. Epicenter gains no restore-point UI, backup schedule,
  retention policy, or version-history product.

## Considered alternatives

- **Promote the fuzzy scan at `S` and converge visibly.** Rejected because an
  earlier postimage can temporarily regress a later value already read by the
  scan. Keeping the ordinary `(S, E]` fold in hidden scratch preserves exact
  checkpoint meaning without adding another fold language.
- **Use one streaming response with an ephemeral floor pin.** Rejected because
  it moves cheap client restart into shared server liveness, timeout, abuse, and
  compaction coordination while fighting bounded request runtimes.
- **Persist resumable acquisition state.** Rejected because it turns disposable
  transfer progress into canonical schema and recovery policy.
- **Publish immutable authority snapshots.** Rejected because current state plus
  an anchored idempotent outcome tail proves the same result with fewer owners.
- **Expire replicas below the retention floor.** Rejected because a fresh
  replacement still needs baseline acquisition while expiry creates recovery,
  divergent-copy, cleanup, and explanation policy for acknowledged local work.
- **Review old intent before submission.** Rejected because elapsed time would
  create a second intent lifecycle and opaque Yjs updates cannot support one
  honest generic review surface.
- **Retain every outcome forever.** Rejected because it deletes baseline
  acquisition by making authority history and catch-up work unbounded.
- **Let the oldest replica pin compaction.** Rejected because one abandoned
  device could prevent authority history from ever becoming bounded.
- **Conflate export with baseline acquisition.** Rejected because ownership
  portability and synchronization recovery have different consumers and
  lifecycle promises.
