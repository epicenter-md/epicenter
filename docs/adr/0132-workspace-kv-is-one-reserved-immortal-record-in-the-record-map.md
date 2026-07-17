# 0132. Workspace KV is one reserved immortal record in the record map

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

ADR-0130 fixes the public KV contract (typed per-key `get`/`set`/`unset`/
observe over one bounded schema-blind map; per-key merge units under authority
order; unknown and nonconforming values preserved) but deliberately leaves the
internal encoding open. A falsification harness ran the full KV proof matrix
against two funded encodings and both passed every trace identically, so
semantics cannot pick the winner; the counted set of permanent invariants can.
An independent audit counted 8 permanent obligations for a reserved record,
12 for a dedicated KV table, and 12 for first-class KV wire vocabulary. The
prior killer objection to the reserved record (an ensure-create quarantine
race) died with ADR-0131.

## Decision

Canonical workspace KV is one reserved immortal record inside the existing
record map, at the runtime-reserved address `__epicenter_kv/workspace`.
`kv.set(key, value)` normalizes to a field-bearing `RowIntent` update that sets
the key; `kv.unset(key)` normalizes to an update that unsets it. Absence of a
key in the newest image is the entire unset story; no tombstone exists.

The encoding costs exactly these permanent rules, and no new wire, state,
bootstrap, or authority vocabulary:

- An update on the absent reserved address folds from `{}`; the physical map
  materializes on first write. No eager provisioning row is required.
- `create` and `delete` intents are inadmissible at the reserved prefix; the
  record is immortal and lifecycle-free by construction.
- Body-bearing intents are inadmissible at the reserved address. The workspace
  root is scalar-only: the fixed row body belongs only to ordinary table rows.
- The reserved row's capacity cap is 64 KiB aggregate instead of the general
  row cap, enforced by the ADR-0131 capacity fold rule: a later update whose
  composed image exceeds the cap is accepted and folds to a deterministic
  no-op. Confirmed outcome pages then install the same resulting map on every
  replica.

Per-key value bounds and declared-key counts are typed-lens validation in the
client release, not fold or admission rules; only the aggregate cap is
permanent. The fold exception is a semantic wire change even though no
vocabulary changes (an older authority would silently no-op reserved patches
while advancing sequence), so it ships inside ADR-0131's protocol major 5.

## Consequences

- KV inherits compacted RowIntents, sealed rounds, authority order, paging,
  live-baseline bootstrap, and crash recovery with zero duplicated machinery; the
  proof matrix (current-state reconstruction, unknown-value preservation,
  same-key order, crash, catch-up, baseline bootstrap, cap race) is the row
  proof matrix.
- Every KV change ships the whole map image on the pull/page direction.
  Measured: the real 39-key Whispering map is 1,595 bytes and a one-key change
  costs ~300 bytes up and one map image back; at the 64 KiB ceiling the fold
  is sub-millisecond. Accepted as the cost of aggregate state.
- The reserved prefix must stay unreachable from application table names
  (already enforced: `__epicenter_` names are rejected at definition time).
- The public model stays lifecycle-free even though the encoding is a row;
  nothing public can create, delete, query, or enumerate the reserved record.

## Considered alternatives

- **Dedicated KV table beside the record map.** 12 permanent obligations: a
  second singleton slot, its own pull/state-entry branch, and a bootstrap
  section on both sides, for identical semantics.
- **First-class `kvSet`/`kvUnset` wire vocabulary.** 12 permanent obligations:
  two command variants, a state-entry kind, dedicated storage and bootstrap
  sections. The wire matches the public model exactly, which buys nothing the
  lens does not already provide. (Recorded Codex dissent position.)
- **Append-only KV event log, folded latest-per-key at read.** Re-derives at
  read time the fold the authority performs at accept time (identical results
  by construction), while adding per-event storage, unset tombstones, a second
  compaction lifecycle, and read-fold caching. Its one prize, per-key pull
  granularity, is bounded by the measured 64 KiB ceiling per change. It is the
  right shape only without an authority order, which is the Yjs world being
  left.
