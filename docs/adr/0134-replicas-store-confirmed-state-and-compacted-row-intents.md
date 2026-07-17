# 0134. Replicas store confirmed state and compacted RowIntents

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0133](0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), [ADR-0136](0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)

## Context

The current replica mixes optimistic values into its canonical row table,
appends every local command to an outbox, copies sealed commands into another
request image, and stores local document updates in overlapping logs. Pull and
baseline acquisition then mutate the optimistic table and replay pending
commands. One unacknowledged edit consequently has several durable owners.

## Decision

Canonical user state is:

```txt
confirmed authority state
+ compacted sealed and open RowIntents
= current application state
```

One workspace SQLite file has exactly four canonical tables:

```txt
rows       confirmed row liveness and schema-opaque field maps
documents  confirmed merged Yjs document state
intents    at most one sealed and one open RowIntent per row address
replica    optional singleton protocol position and in-flight round digest
```

The table names use the workspace file as their scope. `rows` owns row liveness
and fields; `documents` owns the physically separate collaborative state;
`intents` stores only RowIntents, so a `row_` prefix repeats information; and
`replica` names the singleton protocol participant that owns its identity and
position. The semantic TypeScript and wire type remains `RowIntent`, because an
unqualified `Intent` outside this database would erase its lifecycle owner.

SQLite `PRAGMA user_version` owns the physical storage version. Rebuildable
current-state projections, release table views, and baseline-acquisition scratch
are not canonical tables.

This SQLite file is the local persistence owner. The destination does not also
persist row documents through `y-indexeddb` or browser IndexedDB. Existing
IndexedDB-backed workspace paths are replaced rather than retained as a second
canonical store.

The browser runtime opens the official SQLite WASM `opfs` VFS with
`journal_mode = DELETE` and `synchronous = EXTRA`. In DELETE mode, EXTRA extends
FULL by requesting a sync of the directory entry after SQLite unlinks the
rollback journal. This path has no WAL checkpoint boundary. OPFS can technically
host WAL-mode SQLite under exclusive locking, but this destination does not
enable it. A disposable OPFS experiment verified the setting, recovery after
acknowledged commits, and no stable material latency penalty in Chromium. That
evidence does not prove physical power-loss durability or equivalent behavior
in every browser.

Rows and documents remain physically separate because their payload sizes and
write patterns differ. They share one row lifecycle and transaction owner.
Row deletion removes both. An empty document has no `documents` row.

Within the open intent state:

```txt
create + update   -> create(final fields, merged document)
create + delete   -> no intent
update + update   -> update(final set/unset, merged document)
update + delete   -> delete
```

Nothing compacts across the seal. Field operations compact to final absolute
set/unset changes. Document components compact using the workspace's selected
Yjs update encoding. When a merged open delta approaches its ceiling, the
runtime hydrates confirmed, sealed, and open state into a fresh `gc: true`
document and persists the smaller of a delta against confirmed-plus-sealed state
and a full state update. If a compact full state exceeds the canonical document
maximum, the edit is not committed and the handle is poisoned. No unsendable
intent becomes durable.

The `intents` table stores the canonical semantic RowIntent directly. It does
not store command JSON or produce a copied sealed array. The optional `replica`
singleton exists only in a synchronized file. It owns the authority-enrolled
replica id, confirmed checkpoint, accepted round, in-flight round, and request
digest. A sealed flag on each selected intent is enough because only one round
may be unresolved. The replica id is protocol position, not an authentication
secret or device credential.

The checkpoint is the greatest authority outcome installed in confirmed state.
The accepted round identifies the last sealed request the authority has durably
folded. The in-flight round and digest identify the immutable local retry image
that may still need that acknowledgement. The authority receipt, not the local
singleton, retains the accepted request digest. These are synchronization
metadata, not application history or additional user state. A newly enrolled
replica begins at accepted round zero.

The wire protocol major is a build constant carried by admission and request
envelopes, not another durable column in `replica`. A build supports one active
major and refuses any other before folding. `PRAGMA user_version` separately
owns the local physical SQLite schema version; storage migration completes
before networking begins.

Current fields are a connection-local projection of confirmed rows, sealed
field intent, then open field intent. A document handle hydrates the confirmed
document, sealed document update, then open document update. The runtime
exposes ADR-0135's native-shaped `RowDocument`; `get` returns real Yjs v14
shared types for application-owned roots, but there is no raw `Y.Doc` API.

A Yjs editor transaction is visible in memory before its SQLite write commits.
`whenDurable()` resolves only after every local document update observed before
the call is included in a committed transaction in the canonical workspace
database. On the browser OPFS path, that is a completed DELETE-journal
transaction with `synchronous = EXTRA`; there is no WAL checkpoint to await. It
does not wait for authority acceptance. Persistence starts automatically, so
ordinary editor code does not await this optional barrier. A failed write
poisons the handle; the caller must discard and reopen it. Every document
persistence transaction rechecks current row liveness. Local or remote deletion
revokes all handles and cannot be undone by a queued update.

Each response page installs confirmed outcomes and advances the checkpoint in
one transaction while keeping the sealed overlay. The final page at head retires
sealed intents and clears in-flight metadata. Open intent remains newer desired
state. If its target row died, the intent remains durable and automatically
eligible until the authority resolves it through the ordinary deterministic
no-op fold. No replay path writes pending values into confirmed storage.

Baseline acquisition replaces only confirmed rows, confirmed documents, and
the checkpoint. It preserves replica identity, exact-retry metadata, and every
open or sealed RowIntent. Elapsed time never expires intent or creates a review
gate. After promotion, sealed retry and newer open intent resume automatically.

Local-only and synchronized files use the same physical schema. In local-only
mode, writes go directly to rows and documents, `intents` remains empty,
and the `replica` singleton is absent. This refuses an in-place switch between
local-only and synchronized ownership while avoiding a second schema.

The physical SQLite file is runtime state, never a portability format. Moving
between local-only and synchronized ownership uses explicit logical
export/import or publish operations that rebuild canonical state for the new
owner. Copying a database file is not a supported move, copy, or import API.

## Consequences

- Confirmed state has one owner and never changes before authority acceptance.
- The optimistic canonical table, append-only outbox, copied sealed request,
  permanent local document log, replay mutation, sealed-round singleton,
  generation counter, per-row authority sequence, contract table, and snapshot
  tables disappear.
- Four tables are the smallest honest canonical replica schema, not the entire
  distributed system. The authority still owns current content, retained
  outcomes, and exact-once round receipts for explicitly enrolled replica ids.
- Authority receipts persist until workspace deletion. They have no local table
  cardinality counterpart, replica slots, generation, eviction, expiration, or
  unenrollment lifecycle. Hosted deployments bound them at enrollment-time
  capability admission and operational throttling (ADR-0137).
- Losing projections or disposable baseline-acquisition scratch loses no unique
  user data.
- A copied SQLite file carries runtime protocol position and is not a portable
  workspace. Only logical state crosses ownership boundaries.
- Existing independent document rooms require an explicit one-shot import or a
  deliberate clean break before their storage and routes are deleted.

## Considered alternatives

- **Keep optimistic rows and replay pending commands.** Rejected because one
  table alternates between confirmed and current ownership.
- **Combine rows and documents.** Rejected because ordinary scalar installation
  would carry document-sized write amplification.
- **Combine intents and replica state.** Rejected because address-cardinality
  mutation state and singleton protocol position have different owners.
- **Keep `records` and `row_intents`.** Rejected because `record` preserves the
  obsolete scalar-only aggregate, while `row_` repeats the database's only
  intent kind.
- **Rename `replica` to `sync` or `state`.** Rejected because those names describe
  an activity or generic contents rather than the participant owning identity,
  checkpoint, and retry position.
- **Give local-only files a two-table schema.** Rejected because an empty intent
  table and absent replica row cost less than maintaining a second schema.
- **Persist baseline-acquisition staging in the workspace schema.** Rejected by
  ADR-0136: incomplete install data is disposable scratch, not canonical state.
- **Use `synchronous = FULL` in browser OPFS.** Rejected because DELETE mode
  commits by unlinking the rollback journal, and EXTRA also requests a sync of
  that directory change. The prototype found no stable material latency penalty
  for matching the configured policy to the local durability boundary.
