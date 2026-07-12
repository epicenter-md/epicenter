# Gate 3 evidence: exact schema epochs cross through new incarnations

Date: 2026-07-11 (re-proved on the three-verb protocol, no tombstone carriage)

## Result

Gate 3 passes. One active incarnation accepts exactly one schema epoch. A
logical schema change freezes its canonical server head, builds one resumable
successor baseline from live rows only, activates that successor atomically,
and routes every replica-private difference through ordinary mutations under
the new identity. Deleted rows are physically absent from the frozen snapshot
the transform reads, so no deletion mapping and no tombstone carriage exist
anywhere in the transition.

```txt
active I1 / epoch E1
        |
        | preflight zero-to-one identity map (live rows only)
        v
frozen I1 at head H ---- durable batched transform ----> preparing I2 / epoch E2
   |                                                          |
   | lease expiry: delete I2, unfreeze I1                     | activate atomically
   v                                                          v
active I1 again                                        active I2, I1 superseded
                                                              |
replica overlay ------- reviewable comparison ------- ordinary mutations
  equal cells -> nothing
  differing cells -> updateRow
  source-only, cursor == H -> provably pending creation, auto createRow
  source-only, cursor <  H -> possible upstream deletion, review-excluded
```

There is no universal import planner. Movement splits by what it may honestly
promise about identity:

- fresh-incarnation adoption (`planAdoption`) requires a destination with zero
  live rows and streams transformed rows as `createRow` mutations after a
  mapped-identity collision preflight;
- a replica's private overlay after activation enters through
  `planOverlayImport`, whose source-only classification is the explicit
  cursor-equals-frozen-head rule;
- an excluded review row is restorable only under a NEW row identity;
- a physical copy adopts through the same door and must mint a fresh actor.

There is no in-place shared-database migration, compatibility reader, outbox
rewrite, actor-preserving restore, or special mutation verb for an epoch change.

## Evidence run

```sh
bun x tsc -p demos/local-first-sync/tsconfig.json --noEmit
bun test demos/local-first-sync/gates/
```

Result: 27 tests passed, 0 failed across Gates 1-3. Gate 3 specifically proves:

- additive field, table, enum, and nullability identities are refused when they
  do not exactly equal the active epoch;
- schema mismatch pauses remote acceptance while local SQLite writes continue;
- source freeze rejects writes while the successor is preparing;
- baseline row progress persists and resumes after reopening SQLite;
- activation refuses an incomplete baseline and commits ownership atomically;
- lease expiry deletes the partial target and reactivates the source;
- the global baseline excludes the initiator's private pending overlay;
- after activation the initiator's overlay imports as ordinary mutations:
  equal canonical content emits nothing, a private same-cell edit becomes one
  `updateRow`, and its pending creation auto-applies as `createRow` because
  its applied cursor equals the frozen head of the old incarnation;
- a second import naming an already-imported identity is refused atomically
  with `create-conflict` by both authorities;
- a stale replica that skipped two epochs composes the authored identity maps
  over its local state; a row the shared database deleted in a skipped epoch
  is absent from the new baseline and surfaces as the excluded-by-default
  review case instead of silently resurrecting, and restoring it mints a new
  row identity;
- one-to-many and many-to-one identity transforms fail before source freeze;
- adoption refuses a non-empty destination and a mapped-identity collision;
- a physical copy cannot reuse its source actor and adopts under a fresh actor.

The transition and mutation behavior is implemented independently by an
in-memory authority and a real Bun SQLite authority and compared after every
state transition. Both authorities implement the three-verb fold with physical
deletion and the atomic `create-conflict` push refusal.

## Selected transition state

```txt
family: activeIncarnationId
incarnation: id, epochId, status, live canonical rows, actor high-waters, head
transition: source, target, lease, expiry, nextRowIndex, totalRows, transform
```

Every table rule maps a source identity to zero or one destination identity.
Field rules may rename, drop, or default cells without deriving identity from
mutable values. The frozen head of the superseded incarnation stays readable,
which is what lets a returning replica prove (or fail to prove) that its
source-only rows are its own pending creations.

## What this does not prove

Gate 3 proves metadata and lifecycle invariants, not production workspace APIs,
document-body transfer, transform sandboxing, distributed lease transport,
runtime adapters, or large-scale throughput. Those belong to later waves.
