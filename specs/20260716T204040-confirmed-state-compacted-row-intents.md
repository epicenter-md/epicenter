# Confirmed State And Compacted Row Intents

**Date**: 2026-07-16
**Status**: Draft
**Owner**: Braden
**Branch**: `codex/sqlite-sync-architecture`
**Decisions**: [ADR-0131](../docs/adr/0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0134](../docs/adr/0134-replicas-store-confirmed-state-and-compacted-row-intents.md), [ADR-0135](../docs/adr/0135-row-documents-have-application-owned-roots.md), [ADR-0136](../docs/adr/0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)
**Depends on**: [ADR-0130](../docs/adr/0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0132](../docs/adr/0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0133](../docs/adr/0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md)

## One sentence

Every ordinary row owns JSON fields and one lazy application-composed Yjs
document; `RowIntent` is its single compacted mutation representation on disk
and wire, and current state is confirmed authority state plus one sealed and
one open intent per row.

## Destination

```txt
row
|-- fields       schema-opaque JSON map
`-- document     one Yjs document, persisted only when nonempty
    |-- editor    application-owned root
    `-- ...       other application-owned roots

current = confirmed + sealed RowIntent + open RowIntent
```

Tables do not declare a document kind or roots. The application acquires a
disposable document lease through `table.document.open(rowId)`, then acquires
real Yjs v14 `Type` roots through `document.get(key)`. The API has no
text/rich-text mode, root registry, or raw `Y.Doc` accessor. Root closure is a
supported acquisition contract, not server-enforced byte validation.

CodeMirror's linear delta and ProseMirror's structured delta are different
interpretations. Each populated root keeps one application interpretation for
its lifetime. Epicenter does not provide a binding toggle or automatic
conversion.

## Canonical RowIntent

```ts
type RowAddress = {
	table: string;
	rowId: string;
};

type FieldChanges = {
	set: JsonObject;
	unset: string[];
};

type RowIntent =
	| (RowAddress & {
			kind: 'create';
			fields: JsonObject;
			documentUpdate?: Uint8Array;
	  })
	| (RowAddress &
			{ kind: 'update' } &
			(
				| { fields: FieldChanges; documentUpdate?: Uint8Array }
				| { fields?: never; documentUpdate: Uint8Array }
			))
	| (RowAddress & {
			kind: 'delete';
			fields?: never;
			documentUpdate?: never;
	  });
```

The update union proves the intended one-or-both rule:

```txt
fields only   valid
document only valid
both          valid
neither       invalid
```

Runtime normalization also rejects empty field changes, overlapping set/unset
keys, unbounded JSON, a noncanonical 24-character ordinary row id, document
bytes at the KV root, create/delete at the KV root, and an intent too large to
fit one round. The reserved KV address is the explicit runtime-owned exception
to the ordinary row-id shape. `undefined` normalizes to unset; `null` remains
JSON null. Public creation mints row ids from
`abcdefghijklmnopqrstuvwxyz0123456789`; conforming runtimes never reuse them,
and the authority retains no deleted-id tombstones.

The same semantic RowIntent exists in memory, SQLite, a sealed round, wire
encoding, and authority folding. `Uint8Array`, SQLite BLOB, and wire base64 are
physical encodings, not different command models.

## Compaction and sealing

Only open intent compacts:

```txt
create + update   -> create(final fields, merged document)
create + delete   -> no intent
update + update   -> update(final set/unset, merged document)
update + delete   -> delete
```

Document updates compact using the protocol's selected Yjs update encoding. Root
keys do not carry that version. When the merged open delta approaches its
ceiling, the runtime hydrates confirmed, sealed, and open state into a fresh
`gc: true` document and stores the smaller of a delta against
confirmed-plus-sealed state and a full state update. If the compact full state
exceeds the canonical document maximum, the edit fails persistence and poisons
the handle. No unsendable intent becomes durable.

The protocol fixes a canonical document maximum below the maximum document
component in one RowIntent. That component maximum remains below the sealed
round, request, and deployment-backend limits. Wave 0 selects concrete byte
values from measurements rather than guessing them here.

There is at most one sealed and one open intent per address. Nothing compacts
across the seal. Sealing selects a deterministic bounded subset of open intents,
persists the round number and canonical request digest, and leaves overflow
intents open. A lost response sends the identical sealed image. Newer edits stay
open for the next round.

## Authority fold and outcomes

A RowIntent is one lifecycle atom, not an all-or-nothing component atom:

```txt
create on absent    apply fields and optional document together
create on live      whole intent no-ops
update on absent    whole intent no-ops
update on live      fields and document fold independently
delete on live      delete fields and complete document together
delete on absent    no-op
```

An oversized initial document makes create no-op as a whole. On a live update,
the field component no-ops if it exceeds the row cap, while the document
component no-ops if its merged compact state would exceed the canonical document
maximum. Independent components prevent either capacity race from discarding
the other component. One applied intent consumes one authority sequence and
emits one composite row outcome with a complete field postimage, a document
update, or both. Delete emits one deletion outcome. Confirmed outcomes are
installation facts, not a second mutation API.

Scalar fields resolve only by authority acceptance order. Device clocks,
authorship timestamps, and offline duration are not fold inputs. An older-
authored absolute value may therefore replace a newer-authored value when it is
accepted later. Collaborative content uses Yjs merge. Workflows that cannot
tolerate last-accepted-wins use an application-specific authority operation
with its own validation and transaction, not another RowIntent variant.

The authority treats document layout as opaque. It knows neither root names,
root shapes, nor editor schemas. Applications own roots, so there are no table
contracts, contract pins, or contract outcomes. For every document-bearing
fold, the injected codec hydrates the baseline, retained tail, and candidate
update into a fresh `gc: true` document and encodes compact full state. An
oversized result deterministically no-ops the document component. Otherwise the
authority appends the original update bytes at the RowIntent sequence.

Each document stores a compacted baseline with its completed-through sequence
plus every retained update above it. The same codec periodically compacts the
tail through the retention floor. Authority admission and compaction are
merge-aware, while root layout and editor schema remain application-owned.

A deterministic no-op may consume an authority sequence without emitting a row
fact. Page checkpoints advance across such gaps.

## Canonical SQLite

The final workspace file has four canonical tables:

```txt
rows
documents
intents
replica
```

Illustrative ownership:

```sql
CREATE TABLE rows (
  table_key     TEXT NOT NULL,
  row_id        TEXT NOT NULL,
  fields_json   TEXT NOT NULL CHECK (json_valid(fields_json)),
  PRIMARY KEY (table_key, row_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE documents (
  table_key  TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  yjs_state  BLOB NOT NULL,
  PRIMARY KEY (table_key, row_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE intents (
  table_key    TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  sealed       INTEGER NOT NULL CHECK (sealed IN (0, 1)),
  kind         TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete')),
  fields_json  TEXT CHECK (fields_json IS NULL OR json_valid(fields_json)),
  document_update BLOB,
  PRIMARY KEY (table_key, row_id, sealed)
) WITHOUT ROWID, STRICT;

CREATE TABLE replica (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  replica_id                TEXT NOT NULL,
  accepted_round            INTEGER NOT NULL,
  checkpoint                INTEGER NOT NULL,
  in_flight_round           INTEGER,
  in_flight_request_digest  TEXT,
  CHECK ((in_flight_round IS NULL) =
         (in_flight_request_digest IS NULL))
) STRICT;
```

Final DDL adds kind-specific checks. `PRAGMA user_version` owns physical schema
versioning. It does not add storage metadata, document contracts, authority
sequence per row, intent generation, copied request JSON, a sealed-round
singleton, or snapshot tables.

The wire protocol major is a build constant carried by enrollment and sync
envelopes, not a durable `replica` column. A build supports exactly one active
major and refuses any other before enrollment or folding. Storage migration
completes before networking begins.

Rows and documents stay separate to avoid rewriting large document overflow
pages during ordinary field installation. Local-only files use the same schema:
`intents` is empty and the `replica` singleton is absent.

The workspace SQLite file is the only canonical local persistence owner. Row
documents do not also attach `y-indexeddb` or persist through browser IndexedDB.
Existing IndexedDB-backed workspace paths are deleted during the clean break.
The browser runtime uses the official SQLite WASM `opfs` VFS with
`journal_mode = DELETE` and `synchronous = EXTRA`; it does not enable WAL.

The physical SQLite file is runtime state, never a portability format. Explicit
logical export/import or publish operations rebuild canonical state when
ownership changes. Copying a database file is not a supported move or import.

## Replica enrollment and receipts

The authority explicitly enrolls a replica before ordinary synchronization:

```txt
enroll({ token, protocolMajor }) -> { replicaId }

sync({
  token,
  protocolMajor,
  replicaId,
  sealedRound?: { round, requestDigest, submission, intents[] }
})
```

Enrollment creates an authority receipt at accepted round zero with a
submission watermark of zero. Ordinary `sync` refuses an unseen client-supplied
replica id. Authentication controls workspace access; replica identity owns
only protocol position and exact retry. After a round folds, the authority
receipt stores the accepted round and request digest. The local singleton
stores the accepted round plus any unresolved in-flight round and digest; it
does not duplicate the accepted digest.

Every sealed-round transmission carries a `submission` number strictly greater
than any this replica has previously sent; the replica has one exclusive
writer process and submission monotonicity is scoped to that lease. The
authority durably advances the receipt's watermark to that number before
evaluating the round, atomically with any fold, retry-head advance, and
emitted outcomes; a transmission at or below the watermark receives a
retryable stale-submission response carrying the watermark and is otherwise
inert. Every definitive sealed-round response echoes the submission it
evaluated. Evaluation order is: protocol major, replica identity, submission
watermark, retry-head position, deployment capacity admission, then folding.
A definitive capacity refusal (ADR-0137) advances only the watermark; the
retry head does not move and nothing folds. A refusal is authoritative only
when it echoes the greatest submission the client has issued; older refusals
are ignored as superseded. On an authoritative refusal the client, in one
local transaction, clears in-flight metadata, reopens the refused intents into
open state, and reseals any delete intents under the same round number with a
new digest and fresh submission; creates and updates stay queued. The
watermark is what makes that round-number reuse safe: no outstanding copy of
the refused image carries a submission above the watermark the authoritative
refusal advanced, so no copy can fold later. Pull-only sync carries no
submission.

Receipts persist until workspace deletion. There is no replica-specific count,
slot, generation, eviction, expiration, revocation, or unenrollment lifecycle.
Hosted deployments bound all authority state with aggregate per-workspace
storage admission and throttle enrollment. Self-hosted operators own their
available storage and may run without a configured quota. These hosted controls
are launch requirements, not features already present in the authority path.

## Current state and durability

Fields use a connection-local projection:

```txt
rows -> sealed fields -> open fields -> current row
```

Documents hydrate lazily:

```txt
documents -> sealed document update -> open document update -> live Yjs document
```

`table.document.open(rowId)` is the supported document acquisition, and `get`
is the supported root acquisition. A Yjs editor transaction is visible before
its SQLite commit. `whenDurable()` resolves only after every local document
update observed before the call is included in a committed transaction in the
canonical workspace database. The browser OPFS path uses SQLite's DELETE journal
with `synchronous = EXTRA`, so no WAL checkpoint exists there. The method does
not wait for authority acceptance. Persistence begins automatically, so normal
editor code does not await this optional barrier. A failed persistence write
poisons the handle; reopen restores the last durable state. Every document write
rechecks row liveness. Synchronous lease disposal neither waits for nor cancels
queued persistence. Deletion revokes all handles.

## Page installation and baseline acquisition

Each ordinary response page installs composite outcomes and advances the
checkpoint in one transaction while retaining the sealed overlay. Only reaching
head retires sealed intents and clears in-flight metadata. Open intent remains;
lifecycle folding resolves edits against dead rows through the ordinary
deterministic no-op. The intent remains durable and eligible until that fold.

Above the retention floor, sync returns ordinary outcomes. A fresh replica or a
replica below the floor acquires a baseline:

1. Captures authority head `S` as the replay start.
2. Scans complete live rows in stable address order, merging each document's
   compacted baseline and retained tail.
3. Captures authority head `E` when scanning finishes.
4. Runs the ordinary outcome fold over scratch for every sequence in `(S, E]`.
5. Checks on every page that the retention floor has not overtaken the scratch
   fold cursor.
6. Atomically promotes only when the scratch fold cursor is exactly `E`.

Baseline acquisition exclusively owns the replica's network synchronization
lane. Local edits may continue into canonical open RowIntents, but no ordinary
page installs and no new or retry round submits until promotion completes.

The adapter owns one disposable sidecar containing only `rows` and `documents`.
Anchor `S`, address cursor, target `E`, and fold cursor live in memory. A live
process may retry stateless pages after a disconnect; a process crash or floor
race deletes the sidecar and restarts. The authority stores no snapshot
manifests, chunks, generations, refreshable downloads, scan sessions, or floor
pins. Completion requires one acquisition attempt to finish inside the retained
outcome window; unbounded continuous churn may force repeated safe restarts.
Deployments size that window generously from measured scan throughput,
workspace size, and mutation rate. The first implementation always restarts
from zero after a floor race; incremental restart earns a prototype only if
production measurements show an unsafe margin.

Replica id, open and sealed RowIntents, in-flight round, and request digest
remain canonical throughout baseline acquisition. Promotion takes an exclusive
workspace barrier: stop new canonical operations, drain emitted document
persistence, revoke every live document handle, freeze scratch, replace `rows`
and `documents`, set checkpoint `E`, rebuild projections, then release. Callers
explicitly reopen document handles. The authority retains each replica's
accepted round and digest independently of outcome-tail compaction, so a
lost-response retry cannot reapply a scalar field component.

The first ordinary exchange above `E` carries or retries the immutable sealed
round; newer open intent then seals normally. Elapsed time never changes intent
bytes or eligibility, and no expiry, recovery-copy, or stale-review branch
exists. Automatic submission does not promise that old intent wins; the
ordinary RowIntent fold resolves it.

This is distinct from ownership export/import and operator disaster-recovery
backups. Epicenter has no backup schedule, restore-point UI, retention policy,
or user-visible version history.

## Collapse prize

The destination deletes:

- `RecordCommand`, `createRow`, `patchRow`, `deleteRow`, and `bodyAppend`;
- command/intent adapters, append-only outbox, and ordinal replay;
- copied sealed request JSON and the sealed-round table;
- quarantine, actor rotation, rebootstrap receipts, and rejection history;
- permanent local Yjs update logs and overlapping hydration;
- scalar-before-document ordering and offline document parking;
- document declarations, contract IDs, authority pins, protocol facts, and tables;
- durable replica snapshot tables and authority snapshot publications;
- replica slots, expiry, revocation, unenrollment, and receipt garbage
  collection;
- top-level document catalogs, rooms, transports, and deletion policy.

It retains exact retry, authority round receipts, retained ordered outcomes,
separate row and document storage, ownership export, and operator backups because
those prove different non-negotiable invariants.

## Implementation path

### Wave 0: Prove the unstable edges

- [x] Verify `synchronous = EXTRA` with DELETE journaling on Chromium OPFS,
  including acknowledged-commit recovery and alternating-order latency samples.
- [ ] Repeat the OPFS durability and latency harness in Firefox and Safari.
- [ ] Pin the selected Yjs 14 release candidate exactly and prove several named
  roots through update-encoding round trips.
- [ ] Verify current CodeMirror and ProseMirror bindings accept the unified
  shared type.
- [ ] Edit application-owned roots through each binding in separate fixtures,
  compact updates, close, reopen, and compare state.
- [ ] Prove an untouched document persists no bytes.
- [ ] Benchmark canonical document, document-component, sealed-round, request,
  and backend limits, then freeze a strictly nested set of protocol constants.
- [ ] Prove two individually bounded offline documents whose merge exceeds the
  maximum deterministically no-op only the later document component.
- [ ] Prove anchored baseline acquisition under concurrent create, update, delete,
  compaction-floor advance, crash, and restart.
- [ ] Prove an unresolved sealed round and newer open intent survive baseline
  acquisition without scalar reapplication or intent loss.
- [ ] Prove arbitrary elapsed time does not change durable intent bytes or
  eligibility, and promotion automatically resumes sealed retry then open
  sealing.
- [ ] Prove scalar conflicts follow acceptance order regardless of authored
  timestamps or device clocks.
- [ ] Prove an undersized retained-outcome window causes a safe full retry, not
  partial promotion or durable acquisition state.
- [ ] Measure baseline scan throughput and mutation rates to choose a generous
  retained-outcome window before considering incremental restart.

### Wave 1: Replace protocol vocabulary

- [ ] Rename `packages/record-sync` to `packages/row-sync` with no compatibility
  package or re-export.
- [ ] Define one runtime-validated RowIntent schema.
- [ ] Add authority-controlled replica enrollment and reject unseen replica ids
  in ordinary sync.
- [ ] Persist exact-retry receipts until workspace deletion with no replica
  lifecycle API.
- [ ] Seal `intents[]`, fold RowIntents directly, and emit composite outcomes.
- [ ] Enforce the per-replica submission watermark and the definitive
  capacity-refusal admission order (major, identity, watermark, retry head,
  capacity, fold), with an injected deployment-neutral admission callback.
- [ ] Add canonical encoding and digest fixtures.
- [ ] Carry the one active protocol major in enrollment and sync envelopes; add
  no compatibility registry or document-contract admission.

### Wave 2: Build the four canonical tables

- [ ] Add rows, documents, intents, and replica behind a new storage version.
- [ ] Build current projections from confirmed plus sealed plus open.
- [ ] Point release table views and reserved KV reads at current rows.
- [ ] Use the same physical schema for local-only files.

### Wave 3: Move document durability into RowIntent

- [ ] Add `table.document.open(rowId)` and the native-shaped `RowDocument` with
  derived `get`, application-local `transact`, `whenDurable`, and cached-lease
  disposal.
- [ ] Store one merged open document component per touched row.
- [ ] Acknowledge only after SQLite commit.
- [ ] Revoke handles and recheck liveness in every document write transaction.

### Wave 4: Install outcomes and acquire baselines

- [ ] Retain sealed intent through every response page and retire only at head.
- [ ] Install outcome and checkpoint atomically.
- [ ] Implement the two-table disposable sidecar, exclusive sync lane, promotion
  barrier, and atomic replacement at checkpoint `E`.
- [ ] Restart acquisition from zero after a floor race.
- [ ] Automatically resume sealed retry and newer open sealing after promotion.
- [ ] Delete replay mutation and durable snapshot staging.

### Wave 5: Port consumers, stop imports, then delete

- [ ] Port row documents and typed KV across real consumers.
- [ ] Stop production imports of optimistic replicas, command outboxes, document
  rooms, `.docs`, and document declarations.
- [ ] Run crash, retry, backlog, two-replica, delete, document compaction, v14
  binding, live-scan, and local-only proof matrices.
- [ ] Delete old owners only after the new path is unimported and verified.
- [ ] Accept implemented ADRs, update current-truth references, delete this spent
  spec, and regenerate spec history.

## Known final-wave stragglers

Do not rewrite these as implemented truth before the runtime lands. The deletion
wave must nevertheless account for them explicitly:

- `docs/CONTEXT.md` and `docs/reference/workspace-data-model.md`: old command,
  replay, top-level document, and child-document vocabulary.
- `docs/architecture.md`: top-level text and key-value documents.
- `.agents/skills/workspace-api/references/primitive-api.md`: `.docs`, manual
  document handles, and separate document helpers.
- `.agents/skills/yjs/SKILL.md` and `.agents/skills/attach-primitive/SKILL.md`:
  old content roots, selectable document modes, and raw document composition.
- `specs/20260313T224500-unify-document-content-model.md`,
  `specs/20260417T180000-document-handle-facade.md`, and
  `specs/20260502T022408-browser-document-contract-clean-break.md`: obsolete
  document destinations. Harvest any still-live implementation checklist, then
  delete rather than amend them again.
- Existing `timeline`, `getText`, and `getXmlFragment` examples are migration
  evidence, never compatibility paths beside application-owned roots.

## Success criteria

- [ ] SQLite, sealed rounds, wire, and authority use RowIntent without command
  translation.
- [ ] Local writes never mutate confirmed state.
- [ ] Applications can compose named roots with no reserved key, declaration,
  negotiation, authority interpretation, or automatic conversion.
- [ ] SQLite has exactly four canonical tables for both sync modes.
- [ ] Exact retry, bounded backlog, deletion, independent component fold,
  durability, document compaction, baseline acquisition, non-expiry, and
  automatic submission proofs pass.
- [ ] Hosted aggregate storage admission and enrollment throttling bound
  authority growth without replica-count policy.
- [ ] Current-truth docs and skills are updated only after implementation lands.

## References

- `packages/row-sync/src/protocol.ts`
- `packages/row-sync/src/admission.ts`
- `packages/row-sync/src/fold.ts`
- `packages/row-sync/src/authority.ts`
- `packages/row-sync/src/baseline.ts`
- `packages/workspace/src/sqlite/canonical-rows.ts`
- `packages/workspace/src/sqlite/canonical-documents.ts`
- `packages/workspace/src/sqlite/canonical-intents.ts`
- `packages/workspace/src/sqlite/canonical-replica.ts`
