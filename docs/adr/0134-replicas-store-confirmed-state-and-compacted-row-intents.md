# 0134. Replicas store confirmed state and compacted RowIntents

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md), [ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md), [ADR-0135](0135-row-bodies-have-one-content-root.md), [ADR-0136](0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)

## Context

The current replica mixes optimistic values into its canonical record table,
appends every local command to an outbox, copies sealed commands into another
request image, and stores local body updates in overlapping logs. Pull and
baseline acquisition then mutate the optimistic table and replay pending
commands. One
unacknowledged edit consequently has several durable owners.

## Decision

Canonical user state is:

```txt
confirmed authority state
+ compacted sealed and open RowIntents
= current application state
```

One workspace SQLite file has exactly four canonical tables:

```txt
records      confirmed schema-opaque field maps
bodies       confirmed merged Yjs body state
row_intents  at most one sealed and one open RowIntent per row address
replica      optional singleton protocol position and in-flight round digest
```

SQLite `PRAGMA user_version` owns the physical storage version. Rebuildable
current-state projections, release table views, and baseline-acquisition scratch
are not canonical tables.

Records and bodies remain physically separate because their payload sizes and
write patterns differ. They share one row lifecycle and transaction owner.
Row deletion removes both. An empty fixed body has no `bodies` row.

Within the open generation:

```txt
create + update   -> create(final fields, merged body)
create + delete   -> no intent
update + update   -> update(final set/unset, merged body)
update + delete   -> delete
```

Nothing compacts across the seal. Field operations compact to final absolute
set/unset changes. Body components compact using the workspace's selected Yjs
update encoding. Merging update bytes does not garbage-collect deleted structs;
baseline compaction hydrates a fresh confirmed-only document and re-encodes it.

The `row_intents` table stores the canonical semantic RowIntent directly. It
does not store command JSON or produce a copied sealed array. The `replica`
singleton owns checkpoint, replica id, accepted round, in-flight round, and
request digest. A sealed flag on each selected intent is enough because only
one round may be unresolved.

Current fields are a connection-local projection of confirmed records, sealed
field intent, then open field intent. A body handle hydrates confirmed body,
sealed body update, then open body update. The runtime exposes the one `content`
binding from ADR-0135. It is the real Yjs v14 shared type, but there is no direct
live-document or generic-root API.

A Yjs editor transaction is visible in memory before its SQLite write commits.
`whenDurable()` resolves only after the update merges into the open RowIntent.
A failed write poisons the handle; the caller must discard and reopen it. Every
body persistence transaction rechecks current row liveness. Local or remote
deletion revokes all handles and cannot be undone by a queued update.

Each response page installs confirmed outcomes and advances the checkpoint in
one transaction while keeping the sealed overlay. The final page at head retires
sealed intents and clears in-flight metadata. Open intent remains newer desired
state. If its target row died, the intent remains durable and automatically
eligible until the authority resolves it through the ordinary deterministic
no-op fold. No replay path writes pending values into confirmed storage.

Baseline acquisition replaces only confirmed records, confirmed bodies, and
the checkpoint. It preserves replica identity, exact-retry metadata, and every
open or sealed RowIntent. Elapsed time never expires intent or creates a review
gate. After promotion, sealed retry and newer open intent resume automatically.

Local-only and synchronized files use the same physical schema. In local-only
mode, writes go directly to records and bodies, `row_intents` remains empty,
and the `replica` singleton is absent. This refuses an in-place switch between
local-only and synchronized ownership while avoiding a second schema.

## Consequences

- Confirmed state has one owner and never changes before authority acceptance.
- The optimistic canonical table, append-only outbox, copied sealed request,
  permanent local body log, replay mutation, sealed-round singleton, generation
  counter, per-row authority sequence, contract table, and snapshot tables
  disappear.
- Four tables are the smallest honest canonical replica schema, not the entire
  distributed system. The authority still owns current content, retained
  outcomes, and exact-once round receipts.
- Losing projections or disposable baseline-acquisition scratch loses no unique
  user data.
- Existing independent document rooms require an explicit one-shot import or a
  deliberate clean break before their storage and routes are deleted.

## Considered alternatives

- **Keep optimistic records and replay pending commands.** Rejected because one
  table alternates between confirmed and current ownership.
- **Combine records and bodies.** Rejected because ordinary scalar installation
  would carry body-sized write amplification.
- **Combine row intents and replica state.** Rejected because address-cardinality
  mutation state and singleton protocol position have different owners.
- **Give local-only files a two-table schema.** Rejected because an empty intent
  table and absent replica row cost less than maintaining a second schema.
- **Persist baseline-acquisition staging in the workspace schema.** Rejected by
  ADR-0136: incomplete install data is disposable scratch, not canonical state.
