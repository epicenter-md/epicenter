# Gate 3 evidence: exact schema epochs cross through new incarnations

Date: 2026-07-11

## Result

Gate 3 passes. One active incarnation accepts exactly one schema epoch. A
logical schema change freezes its canonical server head, builds one resumable
successor baseline, activates that successor atomically, and routes every
replica-private difference through ordinary mutations under the new identity.

```txt
active I1 / epoch E1
        |
        | preflight zero-to-one identity map
        v
frozen I1 ---- durable batched transform ----> preparing I2 / epoch E2
   |                                                |
   | lease expiry: delete I2, unfreeze I1           | activate atomically
   v                                                v
active I1 again                              active I2, I1 superseded
                                                     |
replica-private transformed visible state -------- import ordinary mutations
```

There is no in-place shared-database migration, compatibility reader, outbox
rewrite, actor-preserving restore, or special mutation verb for an epoch change.

## Evidence run

```sh
bun x tsc -p demos/local-first-sync/tsconfig.json --noEmit
bun test demos/local-first-sync/gates/
```

Result: 23 tests passed, 0 failed across Gates 1-3. Gate 3 specifically proves:

- additive field, table, enum, and nullability identities are refused when they
  do not exactly equal the active epoch;
- schema mismatch pauses remote acceptance while local SQLite writes continue;
- source freeze rejects writes while the successor is preparing;
- baseline row progress persists and resumes after reopening SQLite;
- activation refuses an incomplete baseline and commits ownership atomically;
- lease expiry deletes the partial target and reactivates the source;
- the global baseline excludes every replica-private pending overlay;
- transformed private differences become ordinary target mutations and equal
  content emits nothing;
- one-to-many and many-to-one identity transforms fail before source freeze;
- live rows and tombstones use the same identity map across skipped epochs;
- a physical copy cannot reuse its source actor and imports under a fresh actor.

The transition and mutation behavior is implemented independently by an
in-memory authority and a real Bun SQLite authority and compared after every
state transition.

## Selected transition state

```txt
family: activeIncarnationId
incarnation: id, epochId, status, canonical rows, actor high-waters, head
transition: source, target, lease, expiry, nextRowIndex, totalRows, transform
```

Every table rule maps a source identity to zero or one destination identity.
Field rules may rename, drop, or default cells without deriving identity from
mutable values.

## What this does not prove

Gate 3 proves metadata and lifecycle invariants, not production workspace APIs,
document-body transfer, transform sandboxing, distributed lease transport,
runtime adapters, or large-scale throughput. Those belong to later waves.
