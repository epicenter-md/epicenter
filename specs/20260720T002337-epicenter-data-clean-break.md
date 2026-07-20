# Epicenter data clean break

- **Status:** In Progress
- **Date:** 2026-07-20
- **Program:** greenfield breaking replacement
- **Decision owners:** [ADR-0160](../docs/adr/0160-applications-bind-typed-data-definitions-without-an-application-namespace.md), [ADR-0161](../docs/adr/0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](../docs/adr/0162-live-epicenter-stores-expose-no-sql.md), [ADR-0163](../docs/adr/0163-latest-scalar-state-synchronizes-through-one-epicenter-exchange.md), [ADR-0165](../docs/adr/0165-browser-origins-contain-independent-epicenter-replicas.md), and [ADR-0166](../docs/adr/0166-data-document-sync-and-agent-replace-workspace.md)

## Product sentence

Epicenter persists and synchronizes one person's rows, values, and row-owned
documents; applications bind typed definitions to that shared data.

## Accepted premises

- There is no legacy user data to preserve.
- This is intentionally a breaking change.
- Epicenter is a curated personal universe, not an ingestion lake or a
  projection store, with an expected ceiling around one million rows.
  Ingested mirrors (mail, accounting, photos, tabs) and derived projections
  keep their own disposable app-local stores outside the synchronized plane;
  admission limits, paging, and indexes are sized for curated personal scale,
  never for bulk ingestion throughput.
- Every attached replica synchronizes the person's whole Epicenter.
- One person has one logical Epicenter and one server authority.
- Each adapter isolation boundary has one complete local replica.
- Applications and definition groups have no durable storage identity.
- Live stores expose no SQL. Offline inspection is separate.
- Row IDs are globally unique, runtime-minted, and never reused.
- Compact row tombstones are permanent synchronization facts.

If any premise changes before merge, stop. Do not hide the change behind an
alias, migration bridge, optional scope, or second runtime.

## The asymmetric refusal

Product promise:

> A person's data works locally and converges across their signed-in devices.

Refused promise:

> One physical replica can switch among several principals while preserving a
> separate anonymous dataset and offering automatic merge choices.

The first sign-in permanently attaches the current local replica to one
principal and converges its existing content. Signing out pauses sync without
changing ownership. Another principal requires a fresh replica or explicit
destructive clearing.

This refusal deletes Device-versus-Account owners, profile catalogs, adoption
modes, per-owner directories, rekeying, aliases, parallel data handles, merge
choice UI, and account-switch recovery. The user loss is that switching people
inside one installation is not a seamless toggle.

Permanent row tombstones are the companion asymmetric trade. A small durable
record per row deletion deletes acknowledgment catalogs, deletion-retention
floors, baseline acquisition, stale-replica recovery, and the possibility that
an old offline replica resurrects a deleted row. Value unset remains
nonterminal: a later set may replace it.

## Public destination

```ts
export const recordings = defineTable({
  key: "so.epicenter.whispering.recordings",
  fields: {
    createdAt: field.instant(),
    transcript: field.string(),
    note: optional(field.string()),
  },
});

export const conversations = defineTable({
  key: "so.epicenter.home.conversations",
  fields: { title: field.string() },
  document: true,
});

export const language = defineValue({
  key: "so.epicenter.whispering.transcription.language",
  value: field.string(),
});

await using epicenter = await openEpicenter(options);

const whispering = epicenter.bind({
  tables: { recordings, conversations },
  values: { language },
});

const recording = await whispering.tables.recordings.create({
  createdAt: Temporal.Now.instant(),
  transcript: "Hello",
});

const found = await whispering.tables.recordings.get(recording.id);
const page = await whispering.tables.recordings.list({
  orderBy: { field: "createdAt", direction: "desc" },
  limit: 100,
});
// page is { rows, nonconforming, nextCursor? }
await whispering.tables.recordings.update(recording.id, {
  note: undefined,
});

const stopRecordings = whispering.tables.recordings.subscribe((changedIds) => {
  // fires after committed local or synchronized changes
});
const stopLanguage = whispering.values.language.subscribe(() => {});

await using document = await whispering.tables.conversations.openDocument(
  conversationId,
);
await whispering.values.language.set("en");
await whispering.values.language.unset();

await epicenter.attachSync(session);
```

The exact environment factory may be `openEpicenter`, `openBrowserEpicenter`,
or `openBunEpicenter` depending on adapter packaging. There is one returned
runtime shape. There are no Device and Account runtime types.

`attachSync` is allowed only when the replica is unattached or already attached
to the same stable principal identity. Credentials may rotate; the attachment
does not. The call starts or resumes background synchronization and returns no
second Epicenter.

The attachment record is exactly `{ deploymentId, principalId }`, persisted in
the local replica's metadata inside the same durable transaction that enables
synchronization. `deploymentId` is the canonical deployment base URL (the full
`new URL(...).href`, never the bare host). `principalId` comes only from the
authenticated session endpoint: Better Auth's stable `user.id` on hosted Cloud,
the literal `instance` principal on self-host. Tokens, email, and provider
account IDs never enter the record. Enforcement is the local replica boundary:
compare before installing credentials into sync; refuse a differing pair before
any push. Sign-out clears credentials only, never the attachment. A self-host
deployment that moves to a new URL is a different deployment identity; the
replica refuses it rather than silently rebinding. Server-side replica
enrollment is not built: a modified client uploading its own data into a
different principal it holds valid credentials for is self-harm confined to
that principal's data, matching the existing non-conforming-client stance.

### Definitions

`defineTable` and `defineValue` return inert definitions. Each owns one globally
qualified durable key. There is no automatic prefix, app ID, database ID,
workspace ID, schema registry, or complete model.

`epicenter.bind({ tables, values })` validates duplicate durable keys and returns
a synchronous borrowed lens whose property names come from the input object.
Binding performs no I/O and creates no durable state. Direct binding of a single
definition may be added only if a real caller is clearer than the grouped form;
do not ship two equivalent conventions speculatively.

Qualified keys should use reverse-domain ownership and a final domain noun, for
example `so.epicenter.whispering.recordings`. Freeze the grammar once in the
protocol leaf. Do not create a namespace or prefix helper in the public API.

### Tables and values

Rows have `id` plus definition fields. The runtime mints a 24-character NanoID
or another collision-equivalent ID. Callers cannot supply `id` to `create`.
Optional field `undefined` means remove the field and is lowered before JSON
serialization. `null` remains an ordinary accepted value.

Use one bounded `list` surface for ordinary equality filters, ordering, cursor,
and limit. Do not preserve both `scan` and `query` unless conformance diagnostics
prove they are two real workflows. Reads report nonconforming stored data
without silently repairing it. The page shape is
`{ rows, nonconforming, nextCursor? }`; ordering is stable with the row ID as
the final tie-break, and a cursor observes continuing live state, not a
snapshot. Callers that need everything loop pages; evidence shows every current
production read is exhaustive and only one flow (client-side substring search)
needs anything beyond this vocabulary, and it stays client-side.

Tables and values expose committed-change observation: `subscribe` on a bound
table receives the changed row IDs after a committed local write or an
installed synchronized change, and `subscribe` on a value fires on committed
set or unset. Both return an unsubscribe function. This is the only data
observation primitive; there are no live query objects, projections, or cache
runtimes. Evidence: Whispering bridges three observable domains into Svelte
through `createSubscriber` today; a replicated store without invalidation
cannot support any live UI.

A value is a typed singleton at one qualified key. Its surface is `get`, `set`,
`unset`, and `subscribe`. Do not call it KV: the public object does not expose
an arbitrary key-value collection.

Row-owned Yjs documents are per-table opt-in: `defineTable({ ..., document:
true })`. Only opted-in tables expose `openDocument(rowId)`, which checks
liveness, returns a revocable handle, and lazily attaches document sync when
synchronization is attached. Row deletion revokes the handle and removes
document bytes in the same transaction. The document is schema-free Yjs
infrastructure: the flag declares availability only, never layout or touch
policy, and there are no document IDs. Evidence for opt-in over a universal
latent document: one of five scoped production tables uses documents, two of
ten older definitions opted into `.docs()`, and a universal method would
advertise meaningless capability on every lookup table while hiding which
tables actually carry collaborative state.

### Status and errors

Expose only states a maintained UI actually distinguishes. A starting candidate
is `local`, `syncing`, `idle`, `offline`, and `authentication-required`, plus a
generic last error for diagnostics. Status is observation, not settlement. Do
not expose `settle`, `synchronizeThrough`, protocol floors, lineage recovery,
database transitions, or storage migration errors.

Ordinary `get` absence is `undefined`; ordinary delete reports whether a row
was deleted. Use typed Results at unsafe storage, validation, auth, and network
boundaries, not around every expected collection operation by reflex.

## One logical address space

```txt
table row  (qualified table key, row ID)
value      (qualified value key)
document   (qualified table key, row ID)
```

Application identity does not participate. Two applications compose by
importing and binding the same definition. Different definitions with the same
qualified key intentionally address the same stored state and may interpret it
differently across releases. Definition validation never rewrites canonical
state.

## Minimal physical model

Relation names below describe responsibilities, not a public SQL contract. The
implementation should collapse relations further when constraints and adapter
support permit it.

Authority responsibilities:

```txt
metadata
  physical format version and next authority sequence

replicas
  replica ID, last accepted local batch, request digest, receipt

state
  address kind, qualified key, optional row ID,
  live-or-deleted state, JSON payload when live, changed sequence

document updates
  row address, ordered baseline-or-update bytes
```

Local responsibilities:

```txt
metadata
  physical format version, replica ID, optional attached principal,
  last fully applied authority sequence

state
  the same latest live-or-deleted scalar shape

outbox
  bounded ordered local scalar changes awaiting authority receipt

document updates
  row address, ordered baseline-or-update bytes
```

Do not create `__epicenter_databases`, database aliases, retired-row tables,
catalog generations, protocol floors, transition tables, capture sessions, or
migration registries. The one metadata responsibility exists because adapters
must reject unknown physical formats and a local replica must remember its
principal attachment. It is not an application-facing catalog and does not
make the store portable SQL.

Rows and values share one physical state relation, settled by schema analysis:
the dominant sync query is one global `changed_sequence` range scan, which one
relation serves with one unique index while also enforcing global sequence
uniqueness directly. Values use an empty row-ID sentinel guarded by CHECK
constraints on an address-kind discriminator (`row` requires a nonempty row ID
and `live`/`deleted`; `value` requires the empty sentinel and `live`/`unset`;
payload is non-null exactly when live). The 24-character lowercase row-ID
grammar is thereby a permanent storage invariant, and the sentinel never
appears in protocol or public types. The fold distinguishes terminal row
deletion from nonterminal value unset through the discriminator.

Each store's metadata is one explicit single-row table with named columns, not
`PRAGMA user_version` (unsupported on Durable Object SQLite) and not key-value
rows. A permanent row tombstone costs roughly 158 bytes with a 31-byte
qualified key (paid twice: state B-tree plus sequence index), about 151 MiB at
one million deletions; acceptable against the 10 GB authority ceiling and
realistic personal deletion volume, and far smaller than the acknowledgment,
retention, and acquisition machinery it deletes.

Row deletion changes the latest state to a terminal tombstone and removes the
payload and row-document bytes. Later create and update operations for that row
address are no-ops. It does not append to a separate retired-row family. Value
unset stores payload-free latest state that a later set may replace.

## Scalar synchronization

One endpoint synchronizes the complete scalar Epicenter:

```txt
POST /api/sync/v1
```

The wire owns one bounded bidirectional exchange. Request and response names
should describe cursors, batches, records, and receipts, not push, pull, or
acquire product operations.

The authority assigns every accepted latest-state change a unique increasing
`changed_sequence`. A response fixes `through` before paging and returns latest
records in `(after, through]`. Updating a record while a response is paged moves
that record above `through`; the next exchange returns it. The client persists
`through` only after every page is installed.

The pagination and retry invariants are model-checked and proven. A bounded
executable model (`tmp/pagination-model/`, 9 tests, 240 assertions, all
passing; Wave 2 moves it into the owning package as protocol model tests)
verified all of:

1. Concurrent changes to an unreturned address do not cause it to be skipped.
2. Concurrent changes to an already returned address are seen next exchange.
3. Retrying the same local batch returns the same receipt and applies it once.
4. A fresh replica at sequence zero receives all current live states and
   tombstones through bounded pages.
5. An offline replica's stale live row loses to the authority tombstone.
6. A failed page install cannot advance the durable cursor.
7. Continuous concurrent replacement cannot livelock the reader: `through` is
   fixed at exchange start, so the cursor makes strict progress each exchange.

The receipt contract is minimal: the authority stores one row per replica with
the last accepted batch sequence, request digest, and receipt. The client
assigns each sealed batch a per-replica monotonically increasing sequence and
never sends batch N+1 before holding batch N's receipt. An exact retry returns
the stored receipt without reapplying; a skipped sequence is refused. The model
proved a full receipt table adds nothing under this discipline.

A forked replica (a restored file copy submitting the same batch sequence with
a different digest) receives a batch-conflict refusal and mutates nothing. Its
recovery is local and tiny: mint a fresh replica ID, keep the applied cursor
(pull cursors are client-held), and resubmit pending outbox changes as new
batches; unique row IDs and idempotent folding make the resubmission safe.
There is no lineage-recovery protocol, acquisition mode, or recovery-required
verdict. The only other refusal is a retryable storage-limit at the physical
wall, unchanged from ADR-0145.

The endpoint route carries scalar protocol version `v1`. Row-document sockets
negotiate their own version, such as `epicenter-document-v1`. Physical SQLite
format versions remain adapter-local. Do not persist a cross-product of
protocol floors.

## Row-document synchronization

Keep one authenticated WebSocket per currently open row document. Its route
contains the qualified table key and row ID. Frames carry Yjs protocol data,
not mutable subscriptions. Scalar liveness gates open and update acceptance.

Do not multiplex until iPhone Safari and installed-PWA smoke tests demonstrate
that realistic simultaneous document counts fail. If multiplexing becomes
necessary, replace the one-document topology; do not retain both modes.

The authority stores no permanently live `Y.Doc`. It may hydrate compact state
for admission and state-vector exchange. Compaction must preserve document
convergence but does not share retention or cursor semantics with scalar sync.

## SQL, inspection, and export

The live runtime has no SQL surface. Remove TEMP views, CTE injection, guarded
SQL, query-only connections, projection DTOs, and public raw relation names.

For native debugging, stop or checkpoint the owner, copy the SQLite file and
sidecars safely, and inspect the copy as a private versioned implementation.
This workflow is documentation or tooling, not an application API.

Do not implement capture, import, merge, recovery, or queryable export in this
wave. If a concrete portability workflow returns, design one whole-Epicenter
logical artifact from that workflow. It must not resurrect database scope.

## Target package graph

```txt
field -----> data <----- document-sync -----> sync
                \
                 +-----> sqlite

agent -----> small data interface

portable scalar/document protocols -----> server -----> api, self-host
```

Candidate packages:

```txt
@epicenter/data
  defineTable, defineValue, bind, local replica, sync attachment

@epicenter/document-sync
  row-document protocol, persistence, connection, presence

@epicenter/agent
  agent loop over an explicit table/value capability

@epicenter/sqlite
  domain-free adapters only
```

Do not create packages for database address, database control, database
migration, inventory, capture, or lifecycle. `row-sync` does not earn a
package: the caller map found 17 server files and zero client files importing
it outside the legacy Workspace tree. The portable scalar wire schemas, fold,
admission limits, and digest live in `@epicenter/data` under a protocol subpath
export that `@epicenter/server` consumes; the MIT leaf direction is already how
server consumes `@epicenter/sqlite` and `@epicenter/identity`. Delete
`packages/row-sync` after both sides import the new protocol leaf.

`@epicenter/server` owns the authority schema and transactions. It must not
import application definitions or the local Data runtime. MIT code may not be
copied from AGPL owners without an explicit relicensing decision.

`@epicenter/workspace` is obsolete. Migrate retained callers to Data, Document
Sync, or Agent. Stop all imports while Workspace remains on disk, verify the
required graph, then delete it and sweep stale exports, tests, examples, docs,
and manifest dependencies. Do not leave a compatibility barrel.

## Execution waves

### Wave 1: freeze proof contracts

- Replace the database ADR/spec vocabulary with the decisions above. Done in
  this spec revision.
- Add protocol model tests for latest-state pagination, idempotency, deletion,
  and first attachment. Done as `tmp/pagination-model/`; Wave 2 adopts them
  into the owning package.
- Inventory exact retained Workspace callers and classify each as migrate,
  delete, or temporarily break. Done; the caller map, schema inventory, API
  evidence, and identity trace live in `tmp/architecture-evidence/`.
- Freeze the qualified-key grammar and local principal-attachment invariant.

Rollback point: docs and tests only.

### Wave 2: build the new scalar core

- Implement the minimal latest-state and tombstone fold independently of the
  old Workspace runtime.
- Implement one sync exchange and authority conformance suite.
- Implement the local replica schema, outbox, cursor installation, and sync
  attachment.
- Prove that one local store reopens identically and refuses another principal.

Rollback point: the old path still exists and no caller imports the new core.

### Wave 3: build typed Data

- Implement qualified `defineTable`, `defineValue`, and one `bind` convention.
- Implement table CRUD, bounded `list`, value operations, observation, and
  nonconforming read behavior.
- Bind row-owned documents through Document Sync.
- Add browser and native adapter conformance tests.

Rollback point: production callers still use Workspace.

### Wave 4: migrate retained callers

The maintained migration surface from the caller map: apps/epicenter (3
runtime files SQLite family, 8 agent files), apps/whispering (7 runtime
files), packages/skills (5 runtime files), apps/honeycrisp, packages/chat
(delete `legacy-root-yjs.ts`), packages/app-shell (delete the sign-in
migration and workspace-gate adoption surfaces outright; migrate agent-chat),
packages/svelte-utils (`from-table`/`from-kv` become Data-backed), packages/ui
(relocate the natural-language date-input's Workspace utility imports),
packages/server (`room/core.ts` presence import moves to Document Sync), and
packages/cli (daemon/mount: six runtime files; decide migrate-to-data-backed
mounts versus explicit retirement before this wave ends; it migrates last
either way).

- Migrate Epicenter, Whispering, and other maintained applications from their
  composition roots inward.
- Migrate Server to the one scalar route and new document addresses.
- Migrate Agent through its explicit data interface.
- Remove imports of database-address, database-control, database-migration, and
  provisional database inventory/scheduler code.
- Remove live SQL callers and examples instead of adapting them.

At the end of this wave, no retained manifest or source file imports Workspace.
Workspace remains on disk but unreachable.

### Wave 5: verify before deletion

- Run targeted package tests and typechecks after each migrated owner.
- Run the complete monorepo tests, typechecks, lint/format, licenses, package
  graph, docs hygiene, and API path checks.
- Smoke first sign-in with local data, sign-out/reopen, same-principal sign-in,
  wrong-principal refusal, two-device convergence, offline deletion, and browser
  multi-tab writes.
- Verify one to eight simultaneous document sockets on iPhone Safari and an
  installed PWA before reconsidering multiplexing.

Rollback point: restore imports to the old on-disk path if proof fails.

### Wave 6: delete the old graph

- Delete `packages/workspace` and its compatibility exports.
- Delete provisional database packages, inventory, control, migration,
  scheduler, floors, aliases, rekeying, capture, SQL projection, and per-database
  lifecycle code.
- Delete or explicitly retire deferred apps that have not migrated.
- Re-run stale-name searches for Workspace and Database platform nouns, allowing
  only unrelated SQL/database terminology and historical superseded ADRs.
- Delete this spec after the implementation lands and mark its ADRs Accepted.

## Deletion ledger

```txt
defineWorkspace, WorkspaceId, workspace prefixes
defineDatabase, defineDatabaseModel, DatabaseId, DatabaseModel
epicenter.database(...), per-database sync/status/lifecycle
Device and Account parallel local stores
database catalogs, inventory, aliases, grants, generations
rekeying, bridge layouts, protocol floors, offline migrators
push, pull, acquire as separate public/network operations
retention floors, acquisition scratch, lineage recovery
per-database clear, capture, merge, reset, export state machines
permanent retired-row relation separate from latest state
live SQL, TEMP views, CTE injection, projection DTOs
generic authority scheduler
workspace compatibility barrel
```

## Recognition criteria

The destination is recognizable when a new reader can answer these questions
without learning historical vocabulary:

- What data do I define? A table or a value with a qualified key.
- How do I use several definitions? Bind them together as one borrowed lens.
- Who owns the data? One person through one Epicenter.
- Where is it stored? One complete replica per adapter isolation boundary.
- What happens on first sign-in? The current replica permanently attaches and
  converges.
- How does deletion survive an offline device? The latest state is a permanent
  compact tombstone.
- How does scalar sync work? One whole-Epicenter latest-state exchange.
- How do documents sync? Lazily, one connection per open row document.
- Can applications run SQL on the live store? No.
- What replaces Workspace? Data, Document Sync, and Agent.

If an answer needs database IDs, workspace IDs, prefixes, catalogs, acquisition,
protocol floors, migration, or two local owners, the clean break is incomplete.
