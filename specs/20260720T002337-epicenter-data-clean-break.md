# Epicenter data clean break

- **Status:** In Progress
- **Date:** 2026-07-20
- **Program:** greenfield breaking replacement
- **Decision owners:** [ADR-0160](../docs/adr/0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0161](../docs/adr/0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](../docs/adr/0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0163](../docs/adr/0163-latest-scalar-state-synchronizes-through-one-epicenter-exchange.md), [ADR-0164](../docs/adr/0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0165](../docs/adr/0165-browser-origins-contain-independent-epicenter-replicas.md), [ADR-0166](../docs/adr/0166-data-document-sync-and-agent-replace-workspace.md), [ADR-0167](../docs/adr/0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0168](../docs/adr/0168-lenses-are-complete-pure-json-interpretations.md), and [ADR-0169](../docs/adr/0169-row-references-are-non-enforcing-table-interpretations.md)

## Product sentence

Epicenter persists and synchronizes one person's rows, values, and row-owned
documents; applications bind pure JSON Lenses over durable namespaces in that
shared data.

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
- Namespaces structure durable addresses only. They never create storage,
  ownership, lifecycle, transaction, export, or synchronization scopes.
- Applications receive no SQL. Epicenter Home owns human and agent relational
  inspection over the logical Epicenter.
- Scalar facts converge independently. Epicenter exposes no public
  multi-address transaction and promises no atomic remote visibility across
  scalar addresses.
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
export const whisperingLens = defineLens({
  namespace: "so.epicenter.whispering",
  title: "Whispering",
  description: "Recordings and transcription settings.",
  tables: {
    recordings: defineTable({
      title: "Recordings",
      fields: {
        createdAt: field.instant(),
        transcript: field.string(),
        note: field.string(),
      },
      optional: ["note"],
    }),
  },
  values: {
    language: defineValue({
      title: "Language",
      value: field.string(),
    }),
  },
});

export const homeLens = defineLens({
  namespace: "so.epicenter.home",
  title: "Epicenter Home",
  description: "Conversations and Home-owned data.",
  tables: {
    conversations: defineTable({
      title: "Conversations",
      fields: { title: field.string() },
      optional: [],
    }),
  },
  values: {},
});

await using epicenter = await openEpicenter(options);

const data = epicenter.bind({
  whispering: whisperingLens,
  home: homeLens,
});

const recording = await data.whispering.tables.recordings.create({
  createdAt: Temporal.Now.instant(),
  transcript: "Hello",
});

const found = await data.whispering.tables.recordings.get(recording.id);
const page = await data.whispering.tables.recordings.list({
  orderBy: { field: "createdAt", direction: "desc" },
  limit: 100,
});
// page is { rows, nonconforming, nextCursor? }
await data.whispering.tables.recordings.update(recording.id, {
  note: undefined,
});

const stopRecordings = data.whispering.tables.recordings.subscribe((changedIds) => {
  // fires after committed local or synchronized changes
});
const stopLanguage = data.whispering.values.language.subscribe(() => {});

await using document = await data.home.tables.conversations.openDocument(
  conversationId,
);
await data.whispering.values.language.set("en");
await data.whispering.values.language.unset();

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

### Lenses and definitions

`defineLens`, `defineTable`, and `defineValue` return canonical pure JSON. A
Lens interprets one durable namespace; its `namespace`, `title`, and
`description` are required. The property names under `tables` and `values` are
the durable local keys. There is no redundant definition `key`, independent
Lens ID, database ID, workspace ID, schema registry, or complete model.

One application may bind several Lenses. Property names in that outer binding
are ergonomic aliases only. Multiple partial Lenses may interpret the same
namespace or address; none becomes canonical. Binding validates each Lens,
performs no I/O, creates no durable state, and returns synchronous borrowed
typed access.

The authoring helpers constrain `optional` entries to the table's field keys.
`parseLens(unknown)` validates the same closed JSON shape, supported field
vocabulary, and semantic cross-field rules for artifacts read from disk. A
runtime validator is derived and ephemeral, never persisted as Lens state.

Namespace keys use collision-resistant reverse-domain naming. Table and value
keys are short local identifiers. Freeze their bounded grammar once at the
shared protocol boundary without concatenating them into one prefixed string.

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

A value is a typed singleton at one structured value address. Its surface is `get`, `set`,
`unset`, and `subscribe`. Do not call it KV: the public object does not expose
an arbitrary key-value collection.

Row-owned Yjs documents are universal: every live row latently owns exactly
one document at the row's own address, and every table lens exposes
`openDocument(rowId)`, which checks liveness, returns a revocable handle, and
lazily attaches document sync when synchronization is attached. Row deletion,
through any lens or through synchronization, revokes open handles and removes
document bytes in the same transaction. The document is schema-free Yjs
infrastructure with no document IDs and no layout or touch policy. There is no
per-definition `document` declaration: definitions are borrowed release-local
lenses, and both storage authorities already enforce the document lifecycle
purely by row address and liveness, so a definition flag could only gate
client-side API visibility while letting independently authored definitions
sharing one structured row address disagree about a capability neither owns. Opening a
document on a table that never uses one is inert: no bytes exist until the
first update is persisted, and the row tombstone deletes whatever exists.

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
table row  (namespace key, table key, row ID)
value      (namespace key, value key)
document   (namespace key, table key, row ID)
```

Address kind distinguishes rows from values, so their local keys need not share
one flat key space. Two applications compose by declaring or installing Lenses
that name the same structured address. Different Lenses may interpret that
stored state differently across releases. Lens validation never rewrites
canonical state.

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
  address kind, namespace key, table-or-value key, optional row ID,
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
rows. The structured representation must be measured at the one-million-address
conformance envelope. Do not carry forward the earlier byte estimate for a flat
qualified key. The proof must include both namespace repetition and any compact
dictionary encoding chosen by a private live store.

Row deletion changes the latest state to a terminal tombstone and removes the
payload and row-document bytes. Later create and update operations for that row
address are no-ops. It does not append to a separate retired-row family. Value
unset stores payload-free latest state that a later set may replace.

## Scalar synchronization

The semantic contract is fixed at independently convergent addresses and one
whole-Epicenter synchronization scope. The transport mechanism below is the
current protocol candidate, not a reason to assume that batches, checkpoints,
receipts, cursors, or authority sequences have earned permanent product status.
ADR-0163 remains Proposed until an adversarial protocol review either proves
this candidate or replaces it with a smaller mechanism.

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
contains the namespace key, table key, and row ID. Frames carry Yjs protocol data,
not mutable subscriptions. Scalar liveness gates open and update acceptance.

Do not multiplex until iPhone Safari and installed-PWA smoke tests demonstrate
that realistic simultaneous document counts fail. If multiplexing becomes
necessary, replace the one-document topology; do not retain both modes.

The authority stores no permanently live `Y.Doc`. It may hydrate compact state
for admission and state-vector exchange. Compaction must preserve document
convergence but does not share retention or cursor semantics with scalar sync.

## SQL, inspection, and export

Applications have no SQL surface. Remove application-facing raw connections,
CTE injection, guarded SQL, projection DTOs, and dependencies on private
physical relation names.

Epicenter Home owns trusted human and agent relational inspection. It reaches a
live Epicenter through the storage owner, or opens an inert portable artifact,
and presents the stable logical relations:

```sql
rows(namespace_key, table_key, row_id, fields_json)
values(namespace_key, value_key, value_json)
```

Installed Lenses provide typed interpretations for Home's table browser. The
naming, collision behavior, and lifetime of optional Lens-generated friendly
SQL views remain open and are not implementation prerequisites for raw logical
inspection.

ADR-0167 defines portability as an identity-free artifact containing one
selected owner's complete accepted current logical state. It represents the
same logical Epicenter but is not the live replica file. Do not implement
export or initialization in this wave. When implementation is authorized, it
must not resurrect database scope, generic merge, or synchronization lineage.

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
  defineLens, parseLens, defineTable, defineValue, bind, local replica, sync attachment

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
- Freeze the structured namespace/local-key grammar and local
  principal-attachment invariant.

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

- Implement pure JSON `defineLens`, `parseLens`, nested table/value definitions,
  structured addresses, and one multi-Lens `bind` convention.
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
- Remove application SQL callers and examples. Route Home's trusted inspection
  through the live storage owner instead of a public application API.

At the end of this wave, no retained manifest or source file imports Workspace.
Workspace remains on disk but unreachable.

### Wave 5: verify before deletion

- Run targeted package tests and typechecks after each migrated owner.
- Run the complete monorepo tests, typechecks, lint/format, licenses, package
  graph, docs hygiene, and API path checks.
- Prove the whole-replica trade at 1,000,000 live scalar addresses and 512 MiB
  of canonical encoded logical state. Measure authority scan, transfer,
  browser and native installation, reopen, and peak memory. Inject crashes
  between pages and prove durable progress resumes without reinstalling prior
  pages. Treat this as a conformance envelope, not a hard product limit or a
  protocol constant.
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
application SQL escape hatches, private-schema dependencies, projection DTOs
flat qualified data keys, redundant table/value key properties
generic authority scheduler
workspace compatibility barrel
```

## Recognition criteria

The destination is recognizable when a new reader can answer these questions
without learning historical vocabulary:

- What data do I define? A pure JSON Lens for one namespace, with tables and
  values whose property names complete durable addresses.
- How do I use several namespaces? Bind several borrowed Lenses.
- Who owns the data? One person through one Epicenter.
- Where is it stored? One complete replica per adapter isolation boundary.
- What happens on first sign-in? The current replica permanently attaches and
  converges.
- How does deletion survive an offline device? The latest state is a permanent
  compact tombstone.
- How does scalar sync work? One whole-Epicenter latest-state exchange.
- How do documents sync? Lazily, one connection per open row document.
- Can applications run SQL on the live store? No.
- Who can inspect relationally? Epicenter Home, for people and agents, over one
  stable logical model.
- What replaces Workspace? Data, Document Sync, and Agent.

If an answer needs database IDs, workspace IDs, prefixes, catalogs, acquisition,
protocol floors, migration, or two local owners, the clean break is incomplete.

## Open decisions after the destination freeze

These questions must be resolved before their implementation wave. They do not
weaken the ADR destination above:

1. **Friendly Lens SQL views.** Decide whether Home needs generated SQL names in
   addition to the raw `rows` and `values` relations, and if so how installation
   aliases, collisions, quoting, and ephemeral lifetime work.
2. **Lens discovery and activation.** Decide whether app-bundled Lenses live only
   in the active app catalog, whether standalone Lens artifacts have a separate
   folder, and what uninstall removes. Discovery provenance must not enter data
   addresses or make a Lens authoritative.
3. **Structured row references.** ADR-0169 fixes references as non-enforcing
   table interpretations and removes them from the destination field
   vocabulary. Decide the exact pure JSON table metadata shape, typed query
   ergonomics, and Matter replacement before deleting the current shared
   `field.reference()` implementation.
