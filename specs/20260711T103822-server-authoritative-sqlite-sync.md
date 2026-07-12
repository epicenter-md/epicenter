# Server-authoritative SQLite synchronization

**Date**: 2026-07-11
**Status**: Draft
**Owner**: Epicenter

## One Sentence

Each Epicenter app keeps a complete local SQLite replica of one database that
lives in exactly one schema epoch; every write inside the epoch synchronizes
silently under server acceptance order, and everything that crosses a database
boundary (sign-in, restore, endpoint movement, epoch upgrade) arrives through
one reviewable import applied as ordinary mutations.

## How to read this spec

Read first:

- One Sentence
- Product Contract
- Target Shape
- Protocol Invariants
- Falsification Gates
- Success Criteria

Read when challenging the architecture:

- Refusals
- Representation Questions
- Rejected Alternatives
- ADR Reconciliation

Read when implementing:

- Conceptual Storage Owners
- Lifecycle Flows
- Schema Evolution
- Implementation Waves
- Verification Matrix

## Overview

Epicenter will replace Yjs tables as the general record-metadata store with
ordinary local SQLite tables and a small logical mutation protocol. Every app
continues to work without an account or server. Signing in adds an authoritative
ordered server, complete metadata replication, snapshots, and wake-up hints.
Large collaborative bodies remain independent lazy Yjs documents.

This spec plans and falsifies the architecture. It does not make the existing
demo or its current table shapes production truth.

## Durable decisions

This spec implements and tests three Proposed ADRs:

- [ADR-0119](../docs/adr/0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md): complete metadata replicas use schema-blind server-ordered mutations.
- [ADR-0120](../docs/adr/0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md): persisted fields are atomic cells and collaborative bodies are Yjs documents.
- [ADR-0121](../docs/adr/0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md): background sync is automatic and database-boundary merges are reviewable.

The ADR numbers are provisional until merge.

## Product contract

### Local operation

- Every app opens and remains useful without sign-in.
- A local-only database may be used forever without a synchronization service.
- Local-only databases store application data, not a dormant outbox.
- Local reads and queries never require a server.
- A local write commits to application SQLite before the UI reports success.

### Synchronized operation

- Each logical synchronized database belongs to exactly one principal.
- The logical database family key is `(principalId, appId)`. Each family has
  exactly one active database incarnation, and each incarnation lives in
  exactly one schema epoch: an opaque identity derived from the complete
  canonical synchronized schema plus the ordered authored semantic epoch lineage.
- A logical schema change never migrates the shared database in place. It
  creates a new incarnation in the new epoch; old replicas stay readable and
  exportable and enter the new epoch through an explicit import.
- Every synchronized device keeps a complete record-metadata replica.
- A client may remain offline indefinitely and later submit its pending mutations.
- The server is authoritative by acceptance order, not device clock.
- Different-cell assignments compose. Concurrent same-cell assignments resolve
  silently by server acceptance order.
- Every authenticated, structurally valid mutation enters the canonical order.
- Semantic inapplicability produces a deterministic no-op. It does not reject one
  operation while accepting later operations from the mutation.
- Authentication, corruption, protocol mismatch, actor sequence gaps, and
  account-wide limits pause synchronization at the database boundary.
- The transport log is compactable and provides no permanent history promise.

### Data modeling

- Persisted table and KV schemas use `field.*`, optionally wrapped in
  `nullable(...)`.
- `field.json(schema)` is the only structured atomic escape hatch.
- `undefined` is invalid on the wire. `null` means cleared or absent.
- A table column is replaceable scalar or atomic JSON metadata.
- A collaborative body is a separate `Y.Text` or `Y.XmlFragment` document.
- A field that cannot tolerate one concurrent assignment losing is not modeled
  as an ordinary cell.
- Row ids are generated locally, remain stable through logical import, and are
  never reused after terminal deletion.

### Explicit database movement

- Import, restore, local-to-account promotion, endpoint movement,
  physical-clone adoption, and epoch upgrade use one logical import planner.
- The planner compares pinned source and destination logical snapshots by
  table, row, and cell after an optional deterministic identity-preserving
  transform.
- Unambiguous work (source-only rows, equal cells, tombstone imports) applies
  without review. Users apply a bulk preference to differing cells and review
  only genuine ambiguity. A source row the destination terminally deleted is
  retained for review but the generic planner lets the deletion win. Restoring
  it under a new row id is an app-owned copy flow because generic field metadata
  cannot safely remap inbound references.
- Plan application revalidates the destination head; cells that changed since
  planning are re-diffed rather than silently overwritten.
- Import output is ordinary mutations, not a second write protocol. The source
  stays intact and read-only until the destination durably accepts the result.
- Application row identity is portable. Replica actor identity, cursors, and
  outboxes are not: every physical restore or copy mints a new actor.

## Refusals

The target stays small by refusing these products:

```txt
No SQLite file, WAL, or page replication
No peer-to-peer record merge
No device-wall-clock conflict authority
No HLC metadata per cell
No partial metadata replicas or query subscriptions
No permanent mutation history
No background conflict inbox
No selective pending-edit rejection or discard
No per-field merge-policy configuration
No arbitrary persisted-schema language beside field.*
No server-side app schema or app-specific SQL queries
No row-level ACLs inside one database
No reuse of a deleted row identity
No active clone of one replica identity
No in-place breaking migration of a shared database
No actor-preserving physical restore
No epoch-transform identities derived from mutable cell values
No rewriting of pending outbox operations, ever
```

The costs are explicit:

- A long-offline same-cell assignment may overwrite a change made later by human
  wall-clock time on another device.
- A complete metadata replica consumes local storage on every synchronized
  device.
- Server-side app search, indexing, automation, and AI require separate derived
  workers or services.
- Restoring a deleted record creates a new identity.
- Opening any physical copy or backup is a boundary import under a new actor,
  even when the original replica is truly lost.
- A breaking schema change costs every device an explicit epoch-upgrade import;
  devices that have not upgraded pause sync (local work continues).
- Epoch transforms that would merge several source rows into one target row, or
  key new rows by cell values, are refused in the first wave.

## Current state

The repository currently uses Yjs workspace tables and KV stores for record
metadata. Child documents already exist for larger content. Representative
current shapes include:

- Honeycrisp metadata rows plus a `body` rich-text child doc.
- Whispering scalar transcript columns.
- Todo and Wiki scalar body columns.
- Environment-injected IndexedDB or SQLite Yjs persistence.
- Relay synchronization for root and child Yjs documents.

The untracked `demos/local-first-sync/` directory contains research artifacts:

- a browser SQLite versus Yjs/TinyBase-style storage benchmark;
- a Bun server with per-principal SQLite state;
- a client SQLite outbox and pull cursor;
- twelve semantic demonstrations;
- a decision memo;
- a hardened gate design and protocol skeleton.

The hardened gate design is useful evidence but predates the final refusal pass.
It currently assumes a physical schema-blind canonical client store, integer row
generations, both mutation UUIDs and actor sequences, and a separate typed
projection. Those are hypotheses to challenge, not compatibility obligations.

## Target shape

```txt
Local-only app
  application SQLite tables
  local Yjs body storage
  no actor, cursor, or outbox

Synchronized app replica
  application SQLite tables
  small internal sync state
  durable mutation outbox
  provisional nonconforming-row quarantine
  local lazy Yjs body storage
          |
          | push mutations / pull after cursor
          v
Schema-blind database authority
  canonical logical rows
  ordered mutation tail
  compact bootstrap snapshot
  actor high-water marks
  WebSocket poke
          |
          +-- Durable Object SQLite in Epicenter Cloud
          |
          +-- Bun SQLite in the self-hosted instance
```

### Runtime ownership

```txt
App schema
  owns field names, field kinds, nullability, defaults, and child-doc layout

Local SQLite adapter
  owns typed DDL, transactions, local queries, and reactive invalidation

Sync engine
  owns mutation identity, outbox, cursor, fold, snapshots, and convergence

Server adapter
  owns durable transactions and wake-up delivery for one logical database

Yjs provider
  owns updates, state vectors, persistence, and lazy body synchronization

Import planner
  owns explicit source/destination comparison, plan actions, and user choices
```

The sync engine does not own app validation or editor widgets. The field schema
does not own server routing or conflict clocks. Yjs does not own record metadata.

## Field and document model

### Persisted fields

The closed storage vocabulary is:

```ts
field.string<TBrand?>()
field.reference<TBrand?>(table)
field.url()
field.number()
field.integer()
field.boolean()
field.date()
field.instant()
field.datetime()
field.select(values)
field.multiSelect(values)
field.tags()
field.json(schema)
nullable(field)
```

All kinds share atomic replacement semantics. Their differences drive static
typing, validation, SQLite storage, and generic editor widgets.

Examples:

```txt
field.select        one TEXT cell, one selected value wins
field.tags          one JSON/TEXT cell, the whole array wins
field.json          one JSON/TEXT cell, the whole payload wins
field.reference     one TEXT cell, app tooling knows its target table
nullable(field)     null clears the cell
```

When independent contributions must compose, model independent rows. A counter
uses contribution rows or a named domain operation. A financial balance derives
from ledger rows. A collaborative body uses Yjs.

KV does not add a wire operation. Each declared key compiles to one row in a
reserved logical namespace:

```txt
table:  reserved KV namespace
rowId:  declared dot-namespaced key
cell:   value
```

`kv.set(key, value)` becomes `patchRow(..., {value})`; clearing a key patches
`value: null`; the declared default factory supplies the local read default.
The public table and KV APIs remain distinct ergonomic surfaces over one record
protocol.

### Child documents

Tables declare large bodies next to their metadata:

```ts
const notes = defineTable({
	id: field.string<NoteId>(),
	title: field.string(),
	pinned: field.boolean(),
}).docs({
	body: attachRichText,
});
```

Normal app definitions choose only:

```txt
attachPlainText  -> Y.Text
attachRichText   -> Y.XmlFragment
```

The schema owns deterministic child-doc identity. Bodies load and synchronize
when opened or when an explicit database migration needs them. Record snapshots
carry references and metadata, not Yjs history.

## Logical mutation protocol

### Mutation

The minimal shape (2026-07-11 review):

```ts
type Mutation = {
	actorId: string;
	actorSequence: number;
	operations: Operation[];
};
```

`(actorId, actorSequence)` is the idempotency key. A separate mutation UUID is
refused: retry, duplicate delivery, and lost acknowledgement are handled by
sequence dedup; clone and restore are handled by the new-actor flow; a
concurrent service worker allocates its sequence from the database authority
atomically. A UNIQUE-index-on-UUID "for defense in depth" is exactly the
retained-metadata smell this design refuses.

`protocolMajor`, `schemaEpochId`, `appId`, and the server-minted
`databaseIncarnationId` travel once in the request/connection envelope, never
per mutation: they are negotiation and routing facts shared by every mutation
a client sends, and copying them into each outbox and log row is dead weight.

`schemaEpochId` replaces the earlier count-derived `appSchemaMajor`. The build
derives it from the canonical complete synchronized schema plus the ordered
authored semantic epoch lineage. Structural changes cannot accidentally retain
compatibility, while a meaning-only or transform change forces a new identity by
minting a new authored component. The schema-blind server stores the result at incarnation creation and
compares only opaque equality; mismatch pauses the writer with an explicit
upgrade-or-export choice.

`databaseIncarnationId` replaces the earlier `databaseId`/`databaseGeneration`
hypotheses: a random identity the server mints when a database incarnation is
created. Two events mint a new incarnation: destroying and recreating the
database (account reset) and an epoch upgrade (the new epoch is a new
incarnation with a fresh actor set). Actors, cursors, outboxes, and snapshots
bind to the incarnation. On mismatch the client pauses with an explicit
import-or-export choice; it never silently reuses a cursor or outbox against a
different incarnation. In-flight response isolation across profile or database
switches is a volatile connection epoch, not durable state.

All operations in one mutation commit together. Actor sequence allocation,
application-table changes, and outbox persistence happen in one local SQLite
transaction.

### Operations

```ts
type Operation =
	| {
			kind: 'patchRow';
			table: string;
			rowId: string;
			cells: Record<string, JsonValue>;
	  }
	| {
			kind: 'deleteRow';
			table: string;
			rowId: string;
	  };
```

Fold rules:

| Operation | Unknown row | Live row | Deleted row |
| --- | --- | --- | --- |
| `patchRow` | Create with named cells | Replace named cells | No-op |
| `deleteRow` | Create tombstone | Replace with tombstone | No-op |

Within `patchRow`, omitted fields are untouched and named `null` fields are
cleared. No operation replaces an entire serialized row.

### Semantic fold totality and local constraints

The logical fold is total: every structurally valid accepted operation has a
deterministic state transition or no-op. Persistence can still fail because of
disk exhaustion, corruption, or runtime faults; those failures pause and retry
the database instead of becoming alternate semantics. A schema constraint must
never reject data another replica already accepted. Consequences:

- Synchronized application tables may mirror exact per-row schema conformance
  with `NOT NULL` or `CHECK` constraints because classification happens before
  materialization. They do not enforce cross-row `UNIQUE` or foreign-key
  constraints that valid independently accepted rows could violate.
- Validation is a write-API boundary concern. Honest clients never emit
  invalid cells; dishonest or buggy cells are stored, never crash the fold,
  and never block sync.
- Nonconforming rows live in one internal QUARANTINE table (marked
  provisional, 2026-07-11 pass 3): after applying a whole accepted mutation,
  the fold validates each affected row against the epoch schema and moves
  nonconforming rows to `(table, rowId, cells JSON, firstSeenSeq, reason)`;
  a later patch that completes the row moves it back, in both directions.
  Quarantine is derived local state and never enters the wire protocol. Every
  replica in an incarnation uses the same exact logical schema identity, so
  classification is one deterministic projection rule. The payoff: typed reads
  and raw SQL over application tables see ONE row population by construction.
  The rejected alternative (permissive
  rows filtered at the typed read boundary) makes `sql('SELECT count(*)…')`
  and `list().length` silently disagree, and honest naming does not fix a
  count a developer will still trust.
- UNIQUE beyond `id` is refused as DDL because two offline devices can both
  take the "unique" value and both writes enter server order. Uniqueness is
  an application invariant enforced at the write API, advisory only.
- Secondary indexes are fine and expected; they carry no constraint.

This also answers Open Question 12: incomplete, partial, or malformed creates
are physically storable as complete quarantine rows; the fold never attempts an
invalid typed-table insert, and completion promotes them atomically.

### Server acceptance

The candidate server transition is:

```txt
accept(mutation), in one transaction:
  authenticate principal and resolve (principal, app)
  validate protocol envelope and bounded JSON values
  read accepted high-water for actor
  if actorSequence <= high-water: return existing acknowledgement
  if actorSequence != high-water + 1: pause on actor gap
  allocate next server sequence
  append whole mutation to mutation tail
  fold every operation into canonical current rows
  advance actor high-water
  commit
```

The server records accepted mutations even when one or more operations fold to
no-ops. Every replica that folds the ordered sequence reaches the same logical
state.

### Push and acknowledgement

Clients push outbox mutations in actor-sequence order. Delivery may duplicate,
drop, or retry messages.

A push acknowledgement does not remove a mutation from the outbox. The client
removes it only when:

- its accepted echo arrives through ordered pull; or
- an installed snapshot proves, through the actor high-water mark, that the
  mutation is already contained in canonical state.

This rule prevents a successful push followed by a lost response or delayed echo
from transiently hiding the user's pending intent.

### Pull

Each synchronized replica stores the last server sequence it has durably folded.

```txt
pull(cursor):
  cursor before compaction watermark -> snapshot required
  otherwise -> ordered mutations after cursor, aligned to mutation boundaries
```

Each page applies, prunes contained outbox entries, updates visible state, and
advances the cursor in one local transaction. Responses are tagged with the
active database/connection generation and ignored after a profile or database
switch. Cursor compare-and-swap makes duplicate and stale pages inert.

The WebSocket sends only a poke that newer data may exist. Losing a poke cannot
lose data because pull after cursor is authoritative.

## Conceptual storage owners

Table count is not the optimization target. Each durable owner must explain one
invariant and survive a mental-inline pass.

### Client hypothesis

```txt
application tables
  visible, typed, locally queryable conforming state for the exact epoch

__epicenter_state
  one replica's actor identity, next actor sequence, pull cursor, the
  server-minted database incarnation id, the schema epoch id, applied schema
  revision, and sync-storage version (a meta row, NOT PRAGMA user_version:
  Durable Object SQLite does not support that pragma, so all engines share
  the table mechanism)

__epicenter_outbox
  one immutable row per pending atomic mutation

__epicenter_tombstones
  terminally deleted (table, rowId) pairs; consulted when pending
  mutations replay so a late patch cannot resurrect a deleted row

__epicenter_quarantine
  accepted rows, including unknown tables or fields, that do not conform to the
  exact epoch schema
  (table, rowId, cells JSON, firstSeenSeq, reason); provisional, see
  fold totality

Yjs update storage
  separate persistence for opened child docs
```

The first gate must determine whether nonconforming rows and terminal tombstones
can live in reserved internal columns on application rows or earn separate tables.
It must also determine whether application tables can be the only physical
materialization or whether a schema-blind canonical shadow is unavoidable.

The target starts with no canonical shadow. A proof may earn one by presenting a
minimal trace where accepted current state cannot be recovered after outbox
pruning, snapshot installation, or crash.

Gate 1 passed on 2026-07-11 without earning that shadow. The selected client
shape is typed application tables plus outbox, state, tombstones, and
quarantine. The control implementation remains in the proof directory, and the
measurements and scope limits are recorded in
`demos/local-first-sync/gates/GATE1-EVIDENCE.md`.

### Server hypothesis

```txt
sync_state
  sequence head, compaction watermark, snapshot generation, protocol version,
  bounded actor high-water map

canonical_rows
  current generic logical state keyed by table and row id, including tombstones

mutation_log
  whole accepted mutations newer than the compaction watermark

snapshot_chunks
  one immutable, consistently pageable logical snapshot generation
```

Candidate collapses to test:

- Keep one outbox row per whole mutation, not normalized transaction and
  operation tables.
- Keep one mutation-log row per whole mutation.
- Keep replica metadata in one singleton state row.
- Keep a bounded actor high-water map in state unless row-per-actor storage earns
  clearer ownership or better transaction behavior.
- Build snapshots only at the current head. Do not promise arbitrary historical
  `compact(upTo)` snapshots that current canonical rows cannot reconstruct.
- Keep at most one durable snapshot generation unless concurrent bootstrap proof
  requires two during replacement.

## Representation questions

### Can the client omit a canonical shadow?

The desired physical invariant is:

```txt
visible application tables = accepted server prefix folded with pending outbox
```

The client may be able to apply an incoming accepted operation directly to the
typed rows and replay remaining pending operations for affected cells in the same
transaction. Terminal deletion, no selective rejection, no pending-edit discard,
and assignment-only operations make this plausible.

The proof must cover the hard case: when an outbox entry is pruned, can the typed
tables reveal the accepted value underneath without a second durable source of
truth? If not, the canonical shadow earns itself. Convenience for the harness is
not evidence.

### How are tombstones stored locally?

Deletion permanently retires `(table, rowId)`. A synchronized replica therefore
needs deletion knowledge even when the app hides deleted rows. Candidates:

- reserved hidden metadata on the typed row;
- a compact internal tombstone table;
- a canonical shadow, if Gate 1 independently earns it.

The choice must preserve non-null typed columns, snapshot replacement, and direct
local queries without teaching app code about sync tombstones.

### How are nonconforming rows stored?

Exact schema epochs remove the cross-version unknown-field and unknown-table
problem. A structurally valid mutation can still name an unknown table or carry
invalid cells because the server is schema-blind. The preferred candidate is one
generic quarantine row keyed by `(table, rowId)` containing the complete logical
cells plus diagnostic metadata. A later completing patch promotes the row into
typed storage. Gate 1 compares this focused exceptional representation against
permissive application rows and a complete canonical shadow; it must not assume
quarantine wins merely because it is smaller on paper.

### Does actor sequence replace mutation UUID?

An actor submits contiguous immutable mutations. The server retains its accepted
high-water through compaction. Under that invariant, `(actorId, actorSequence)`
appears sufficient for idempotency and outbox pruning.

The proof must include database backup, restore, clone, actor re-registration,
lost acknowledgement, duplicate delivery, and concurrent queue-worker completion.
If the composite fails, the result must name the exact additional identity a UUID
owns rather than retaining both as defense in depth.

## Lifecycle flows

### Local write in a synchronized database

```txt
BEGIN local SQLite transaction
  apply typed application changes
  allocate actorSequence
  append one mutation to __epicenter_outbox
COMMIT
notify reactive queries
schedule push when connected
```

Local-only databases perform only the application-table transaction and local
Yjs persistence.

### First sign-in or enabling sync

```txt
local-only database                 account database
        |                                  |
        |                         open or create replica
        |                         install server snapshot
        |                                  |
        +--- logical rows and docs --------+
                                           |
                                  preview differing cells
                                  apply chosen patches
                                  enqueue ordinary mutations
                                  synchronize to acceptance
```

The source remains untouched until acceptance. Users may then keep, archive, or
delete it. A brand-new empty account follows the same semantics even if an
implementation later optimizes the copy.

### Import and endpoint movement

One import planner owns every explicit database boundary. Its seams (pass 3,
derived from the enumerated state machine in the review memo):

```ts
type LogicalRow =
	| { kind: 'live'; table: string; rowId: string; cells: Record<string, JsonValue> }
	| { kind: 'tombstone'; table: string; rowId: string };

type LogicalSnapshotReader = {
	/** Identifies the pinned, internally consistent read view. */
	readonly snapshotId: string;
	readRows(): AsyncIterable<LogicalRow>;
	readDocumentManifest(): AsyncIterable<DocumentRef>;
	readDocument(ref: DocumentRef): Promise<Uint8Array | undefined>;
};

type MergeDestination = {
	applyRows(operations: Operation[]): Promise<AcceptanceReceipt>;
	applyDocuments(writes: DocumentWrite[]): Promise<AcceptanceReceipt>;
};
```

One reader INTERFACE, two reader INSTANCES: comparison needs both the source
and the destination pinned. The `live | tombstone` row encoding is the same
logical encoding server snapshots and exports use; the planner does not invent
a second format. The plan's per-row actions are exactly: no-op (equal,
absent/absent, absent/anything), auto-apply (source-only rows, source-only
cells, tombstone imports), bulk-preference-with-review-list (differing cells;
source-tombstone over destination-live row), review-required (source-live over
destination-tombstone: restore only under a NEW id), and plan-error
(transformed source-internal id collisions; any plan error blocks apply).

Bodies ride the SAME plan as a second row-gated lane: a destination-absent doc
copies, shared Yjs history auto-merges by update application, unrelated
histories are a review choice (keep destination or merge histories; source-only
replacement is refused until a document-reset contract exists). Excluding a row
suppresses its body; restoring over a tombstone remaps the body to the new id.

An empty destination streams imports without materializing a diff — but empty
means zero live rows AND zero tombstones from one consistent snapshot, and the
transform preflight (collision check) still runs first. Apply revalidates the
destination head: cells that changed after planning re-diff instead of being
silently overwritten. The planner does not copy SQLite pages or sync metadata,
and it never participates in background synchronization.

### Replica restore and clone

The actor-preserving "restore lost replica" path is DELETED (pass 3). Its
safety preconditions — the restored file is provably the only process that
will ever submit as that actor, and the server high-water has not passed any
sequence absent from the backup — are user promises the protocol cannot check:
the server owns a high-water and an acknowledgement, not payload comparison or
actor fencing, so it cannot distinguish "restored lost replica" from "live
clone." The directed trace: backup at seq 1, original pushes seq 2 then dies,
restored file allocates seq 2 for a DIFFERENT payload, server silently returns
the existing acknowledgement, echo prunes the restored outbox, the write is
gone with no error.

The smallest safe restore contract:

```txt
Every physical backup or copy opens as a logical import source:
  discard its actor, next-sequence, cursor, and outbox as identity
  keep its application tables, tombstones, and lanes as local state
  mint a new actor
  compare against the live destination by stable row id and cell
  unchanged cells emit nothing; differences are the ordinary review
  retain the source until the emitted mutations are accepted

Reopening the same durable file after a crash is NOT a restore:
  the actor and outbox continue; sequence dedup absorbs the retry
```

When the destination is unchanged since the backup, the diff is exactly the
backup's pending writes and applies without review. When a third device wrote
the same cell in between, the value resurfaces as a reviewable difference
instead of being silently deduplicated — which is the honest outcome. The
product does not support two live files with one actor identity, and no
sanctioned flow ever presents a copied actor to the server.

### Service actor

App-specific cloud work is deferred from the first implementation. The future
boundary remains small:

```txt
job worker completes idempotent job
  -> owning database authority allocates service actor sequence
  -> result folds as ordinary mutation
  -> devices pull it normally
```

Cloudflare Queue delivery and a self-hosted SQLite job loop may differ. Mutation
acceptance does not.

## Snapshot and compaction

The server snapshots only current canonical head state.

```txt
in one server transaction:
  snapshotSequence = current head
  materialize immutable logical snapshot generation
  include rows, tombstones, and actor high-water state
  publish snapshot generation and watermark
  delete mutation_log rows <= snapshotSequence
```

The freeze is one invariant, not three: rows, tombstones, AND actor
high-waters are captured from the same read state at snapshotSequence. A
builder that copies rows early and reads high-waters at a later head publishes
a snapshot whose high-water prunes a pending mutation the rows never folded —
permanent silent loss (directed trace in the pass 3 review). For the same
reason, ordinary pull pages prune outbox entries only by exact contained
echoes; a page never carries a head high-water a client could prune by. Only
an installed snapshot's frozen high-waters prune by containment.

Large snapshots must remain consistently pageable while later writes continue.
Gate 2 selected immutable fixed-size chunks with a generation id, sequence,
count, and cryptographic checksum. The current-head rows, tombstones, actor
high-waters, manifest, watermark, and log deletion are captured and published in
one server transaction. One generation is addressable at a time: after atomic
replacement, abandoned clients receive `snapshot-replaced` and restart. No
durable build generation or arbitrary historical generation earned itself.

A stale client:

```txt
verify snapshot manifest and chunks
install snapshot current state
set cursor to snapshot sequence
prune outbox entries included by this actor's high-water
replay remaining outbox
continue pulling after snapshot sequence
```

Snapshot installation and visible-state reconstruction are one durable local
transition.

## Schema evolution

Five version axes stay separate:

```txt
App schema revision (local)
  1 + ordered migrations array length; drives eager local representation
  migration without a separately maintained version number

Schema epoch (sync compatibility)
  exact identity derived from the canonical synchronized schema plus an
  ordered authored semantic epoch lineage; travels in the request envelope; any logical
  table, field, or meaning change produces a new identity while the
  schema-blind server performs only opaque equality

Database incarnation (replica coordination universe)
  server-minted random id; actors, cursors, outboxes, and snapshots bind to
  it; a new epoch or an account reset mints a new incarnation

Client sync-storage version
  __epicenter_* local DDL (meta-table row)

Server sync-storage version
  generic canonical/log/snapshot DDL (meta-table row)

Wire protocol major
  mutation and snapshot encoding (request envelope)
```

Cloudflare Durable Object class migrations are deployment declarations, not a
substitute for SQL schema migrations inside each object. `PRAGMA user_version`
is not supported in Durable Object SQLite; every engine tracks storage
versions in a meta table so the mechanism does not fork by runtime.

### Migration model (2026-07-11 pass 3: schema epochs)

Per-row `_v` and migrate-on-read are deleted. The caller census found all 41
production tables single-version: the per-row machinery has zero
multi-version producers, hides migration failures inside reads, and its
version diversity was a Yjs-era artifact (rewriting a CRDT was expensive;
rewriting SQLite is ordinary).

The earlier in-place breaking model (server pauses lower majors, first
upgraded replica transforms shared rows as ordinary mutations, client rewrites
its pending outbox through the transform) is DELETED. The independent second
review falsified it: deterministic transforms do not commute with concurrent
new-schema user writes, and arbitrary pending patches cannot generally be
transformed through a row migration. Pass 3's adversarial seam confirmed no
counterexample forces it back.

- `defineWorkspace` declares the CURRENT synchronized schema, an authored
  semantic epoch id, and one ordered migrations array. The local storage
  revision is derived as `1 + migrations.length`; there is no second version
  number that can disagree with a sparse manifest. The runtime derives the
  exact schema identity from the canonical
  schema plus that authored id. A changed synchronized declaration with the
  same derived identity fails before opening or connecting.
- **Representation-only revisions migrate eagerly in place.** Indexes, internal
  encodings, and other changes that leave the logical synchronized schema
  identical use the local storage version and a hand-authored `apply(tx)`.
  Crash mid-migration rolls back and reruns. Adding or changing a synchronized
  table, field, or meaning is not a representation migration; it creates a new
  schema epoch.
- **Every logical schema revision carries an epoch transform** used at import
  time. A synchronized replica never transforms the shared database in place
  and never rewrites its outbox. A local-only workspace has one writer and may
  apply the same transform eagerly in place.
- **One identity map owns rows and tombstones.** `mapIdentity(table, rowId)`
  returns zero or one target identity using only the durable source identity,
  never mutable cells. The row transform receives that mapped identity and
  changes cells only; tombstones use the same mapping automatically. One-to-many
  splits and many-to-one merges are refused in the first wave. This removes two
  independently authored identity transforms and makes resurrection safety
  mechanically reviewable.
- **Epoch cutover is a leased server-owned state machine:**

  ```txt
  ACTIVE old incarnation
    -> begin(expected active incarnation, target schema identity)
    -> FROZEN old incarnation at canonical head H
    -> PREPARING new incarnation under an expiring transition lease
    -> transform canonical snapshot at H into the target baseline
    -> seal and verify baseline
    -> atomically activate new incarnation and retire old incarnation

  abort or lease expiry before activation
    -> delete partial target
    -> unfreeze old incarnation
  ```

  The global baseline comes only from the frozen canonical server snapshot, so
  another authenticated upgrader can resume an abandoned deterministic build.
  A creator's private pending overlay never contaminates the shared baseline.
  After activation, every replica imports its transformed local state through
  the ordinary planner; equal canonical content becomes a no-op while private
  pending intent appears as an explicit addition or difference. Only the
  authenticated principal may initiate, abort, or resume the opaque transition;
  the server learns no app schema.
- **A stale old-epoch device returning later** keeps a readable, exportable
  replica. Its local tables already contain accepted-prefix ⊕ its pending
  writes; upgrade composes the authored per-epoch transforms across any
  skipped epochs (the single identity maps compose safely; intermediate deletes
  arrive in the destination as transformed tombstones) and enters the
  current epoch through the ordinary import plan. Its old outbox dies with
  the old incarnation — unrewritten, because its effects are already in the
  tables the transform reads.
- Downgrade is refused: a binary older than the local revision opens
  read-only or refuses.

### App schema rules

- Every logical table or field addition, removal, rename, type change, enum
  change, nullability change, or semantic reinterpretation creates a new exact
  schema epoch. Compatible cross-version synchronization is refused initially;
  it may be earned later from concrete upgrade pressure.
- Indexes, query plans, and internal SQLite encodings may change within an epoch
  because they do not change the logical synchronized state.
- A schema-epoch mismatch pauses remote sync while the old replica continues
  local work and remains readable and exportable.
- A logical export and epoch transform read typed rows, quarantine, and
  tombstones. There are no separate unknown-field or unknown-table promotion
  paths.

### Server schema rules

The shared sync engine owns one ordered migration manifest. Bun self-hosting may
run pending migrations eagerly at process startup. Each Durable Object runs the
same idempotent migration sequence when activated. The domain fold and
conformance suite must not fork by runtime.

## Falsification gates

The architecture does not proceed to production until three independent gates
pass against a pure reference model and real SQLite implementations.

### Gate 1: Pending-write visibility and physical client shape

Claim:

```txt
No schedule, retry, crash, or pull page makes accepted or pending user intent
transiently disappear from visible application state.
```

Required directed traces:

- local write, successful push, lost acknowledgement;
- push acknowledgement before echo pull;
- remote same-cell mutation before pending local acceptance;
- pending local mutation accepted before later remote mutation;
- duplicate and reordered pull responses;
- crash before and after local mutation commit;
- crash during pull-page application;
- profile or database switch with requests in flight;
- terminal delete racing late patches;
- mutation spanning multiple rows and tables;
- actor sequence duplicate and gap;
- malformed or partial create quarantined, then promoted when a later patch
  completes it (sql/list agreement before and after);
- patch, delete, crash, and pending replay against a quarantined row;
- full drain convergence across at least three replicas.

Every Gate 1 trace runs within ONE schema epoch and one database incarnation:
epoch upgrade and boundary import are planner scope, not sync-engine scope,
and the gate must not smuggle them in. The request envelope under test is
`{protocolMajor, schemaEpochId, databaseIncarnationId, mutations|cursor}`.

Run the same traces against:

```txt
A. schema-blind canonical client state + typed projection + outbox
B. typed application tables as the only materialization + outbox
```

Choose B unless A has a minimal counterexample B cannot satisfy under the
settled product refusals. Report table count, code size, SQLite bytes, and first-
read complexity for both.

### Gate 2: Snapshot bootstrap and permanent compaction

Claim:

```txt
The server may permanently delete every mutation through a snapshot sequence
without stranding a new or years-stale client or losing its pending mutations.
```

Required directed traces:

- new empty client bootstraps while writes continue;
- snapshot spans multiple chunks/pages;
- response loss and duplicate chunk delivery;
- snapshot replacement during an abandoned bootstrap;
- crash before and after local snapshot install;
- client cursor older than watermark;
- stale client has pending edits already accepted before compaction;
- stale client has pending edits never accepted before compaction;
- actor high-water survives log deletion;
- tombstones prevent late resurrection after compaction;
- checksum or chunk corruption refuses installation without damaging local data.

The gate must prove a stable logical snapshot protocol. Physical SQLite file
backup and restore are out of scope.

### Gate 3: Exact schema epochs and incarnation cutover

Claim:

```txt
One exact schema identity owns each incarnation; incompatible clients pause,
and epoch import carries complete current intent without rewriting transport
history or resurrecting terminal identities.
```

Required directed traces:

- two builds with different logical schemas cannot connect to one incarnation,
  including additive field, table, enum, and nullability changes;
- schema-epoch mismatch pauses sync while local writes continue;
- transition freezes one canonical head, builds one resumable preparing
  baseline, activates atomically, and rolls back cleanly on lease expiry;
- the global target baseline excludes the initiating replica's private pending
  overlay;
- after activation, that private overlay enters through ordinary import and
  equal canonical content becomes a no-op;
- one identity map carries rows and tombstones consistently; zero-to-one
  transforms pass while one-to-many and many-to-one transforms fail preflight;
- a stale replica skips several epochs without resurrecting any carried
  tombstone;
- opening a physical copy routes through the import door and mints a new
  actor; no trace may present a reused actor identity to the server.

## Harness shape

```txt
Pure deterministic model
  no I/O, wall clock, or random choices of its own

Seeded schedule generator
  produces replayable concrete event traces and fault boundaries

Real SQLite client engine
  closes and reopens files for crash simulation

Real SQLite server engine
  implements transactions independently from the reference fold

Lockstep comparison
  after every event compare canonical logical state, visible rows, outbox,
  cursor, tombstones, unknown values, actor high-waters, and snapshot generation
```

The harness should minimize a failing seeded trace into the smallest directed
counterexample. HTTP and WebSocket plumbing are not the semantic proof; a
Playwright layer verifies OPFS durability, cross-worker reactivity, and browser
resource behavior after the deterministic model passes.

## Verification matrix

| Surface | Evidence |
| --- | --- |
| Local-only permanence | Browser reload and native reopen with no auth or server |
| Local atomicity | Crash boundaries around app row plus outbox commit |
| Server atomicity | Mutation log, fold, sequence, and actor high-water commit together |
| Convergence | Seeded three-client schedules plus fault-free drain |
| Conflict semantics | Directed same-cell and different-cell traces |
| Terminal deletion | Late patch and stale snapshot traces |
| Compaction | New and years-stale bootstrap after log prefix deletion |
| Schema evolution | Old/new client lifecycle with restart and promotion |
| Import | Per-cell choices become ordinary mutations; source remains intact |
| Clone safety | New actor identity; original and clone can write independently |
| Runtime parity | Same conformance suite through Bun and Durable Object adapters |
| Browser scale | OPFS SQLite benchmarks at 100K and 1M representative rows |
| Yjs laziness | Metadata bootstrap does not open every body document |

Performance reports must include database bytes, peak JavaScript memory, open
time, representative indexed queries, write latency, snapshot install time, and
reactive invalidation cost. Set budgets after collecting baseline distributions;
do not choose a winner from one warm-cache timing.

## Rejected alternatives

### Yjs tables for all metadata

Yjs remains excellent for collaborative bodies. Using it for hundreds of
thousands of queryable metadata rows couples ordinary local queries and startup
to an in-memory CRDT representation and retains merge history where the product
only wants current scalar state.

### TinyBase MergeableStore or custom HLC cells

HLC-based LWW is useful when replicas merge without a central sequencer. This
product has one accepted server order. Per-cell HLC metadata would remain in
local persistence and snapshots, complicate typed SQLite storage, and introduce
future-clock handling without improving causally observed writes.

### Turso/libSQL file replication

An embedded-replica engine may remain useful as a SQLite runtime or reference,
but Epicenter needs a browser-capable logical protocol, explicit mutation
semantics, self-hosted and Durable Object backends, terminal row identity, and
separate Yjs bodies. Copying or remotely following database pages does not own
those product boundaries.

### PowerSync, Electric, or query-subscription sync

These systems are optimized around server database integration, query shapes,
or partial local replicas. Epicenter has chosen a complete personal metadata
replica and a schema-blind per-app authority. Adopting partial replication would
add a product dimension rather than remove one.

### Zero-style application mutation framework

A rich application-aware mutation/query layer can provide optimistic behavior
and server functions. Epicenter's server deliberately does not know app schemas
or run app-specific query logic. The useful inspiration is deterministic
mutation replay, not the server-aware application model.

### Permanent conflict review

Reviewing routine background collisions requires detecting concurrency,
retaining overwritten values, synchronizing resolution state, and deciding when
conflicts expire. Explicit database merges already have two complete snapshots
and a user expecting reconciliation, so that is the only surface that earns the
editor.

## Implementation waves

### Wave 0: Reconcile and falsify the documents

- [ ] Review the three Proposed ADRs against existing accepted ADRs.
- [ ] Find every statement that still assumes Yjs owns record metadata.
- [ ] Run an independent collapse pass over the table-owner inventory and wire
  operation set.
- [x] Refuse cross-version logical-schema compatibility in the first wave;
  every synchronized table or field change creates a new exact epoch.
- [ ] Keep the ADRs Proposed and this spec Draft.

### Wave 1: Gate 1 reference and SQLite engines

- [x] Rewrite the hardened gate model around terminal ids, `patchRow`,
  `deleteRow`, actor sequence, and no selective rejection.
- [x] Implement both candidate client representations.
- [x] Generate and minimize adversarial schedules.
- [x] Measure code and storage differences.
- [x] Select the smallest representation that passes: typed tables without a
  canonical client shadow.

### Wave 2: Gate 2 snapshot and compaction

- [x] Define immutable logical snapshot manifest and chunk encoding.
- [x] Implement current-head snapshot publication and log-prefix deletion.
- [x] Prove new and stale bootstrap under failure.
- [x] Prove actor idempotency and tombstones survive compaction.

### Wave 3: Gate 3 schema epochs

- [x] Implement exact schema identity negotiation.
- [x] Implement the leased freeze/prepare/activate/abort transition model.
- [x] Prove canonical-baseline transformation and per-replica pending-intent
  import remain separate.
- [x] Prove zero-to-one identity mapping carries rows and tombstones through
  skipped epochs without resurrection.

### Wave 4: Shared production core

- [x] Extract protocol schemas, deterministic fold, and conformance tests.
- [x] Define the narrow storage transaction boundary from proven operations.
- [x] Implement browser SQLite, Bun SQLite, and Durable Object SQLite adapters.
- [x] Keep hosted auth/billing outside the shared server library.

Wave 4 evidence is in `demos/local-first-sync/gates/GATE4-EVIDENCE.md`. The
shared suite runs through all three adapter API shapes over real SQLite. It does
not replace later OPFS and workerd lifecycle smoke tests, so the broader runtime
parity success criterion remains open.

### Wave 5: Workspace API clean break

Foundation checkpoint (2026-07-11):
`demos/local-first-sync/gates/GATE5-EVIDENCE.md` records the passing typed
SQLite schema/runtime and reactive adapter evidence. The clean-break checklist
stays open. Production callers cannot delete the Yjs record root until the two
SQLite lifecycle doors exist, so implementation pulls the first Wave 6 item
forward before returning to the Wave 5 consumer migration and deletion steps.

- [ ] Make `field.*` plus `nullable` the only persisted storage vocabulary.
- [ ] Move scalar collaborative bodies to declared plain-text or rich-text docs.
- [ ] Replace Yjs table/KV record persistence with typed SQLite application
  tables and reactive query invalidation.
- [ ] Stop importing the old record path, verify, then delete it and its fixtures.

### Wave 6: Lifecycle and import review

- [ ] Implement the two open doors (`openLocalWorkspace`, `openReplica`) at boot.
- [ ] Implement the logical import planner with source retention through
  acceptance and destination-head revalidation at apply.
- [ ] Build the schema-driven plan summary and bulk-preference surface; grow a
  per-cell editor only when review volume earns it.
- [ ] Implement physical-copy adoption (import under a new actor) and the
  epoch-upgrade flow (`planEpochUpgrade`), including server-side freeze and
  preparing/active incarnation fencing.

### Wave 7: Accept decisions and delete the spec

- [ ] Reconcile provisional ADR numbers at merge.
- [ ] Supersede or scope conflicting accepted ADRs explicitly.
- [ ] Flip the new ADRs to Accepted when production behavior lands.
- [ ] Move current protocol facts into `docs/reference/` and shared vocabulary
  into `docs/CONTEXT.md`.
- [ ] Add the completed spec to `docs/spec-history.md` and delete this file.

## ADR reconciliation

Before implementation acceptance, review at least:

- ADR-0005: child docs stay schema-bound.
- ADR-0035: the coordination box remains app-blind, but its record authority is
  no longer a Yjs anchor for metadata.
- ADR-0079: cross-device remains two planes, but the record plane becomes logical
  SQLite mutation sync while Yjs remains the body plane.
- ADR-0088: sign-in remains an enhancement; local-only storage changes from bare
  Yjs persistence to application SQLite plus local child docs.
- ADR-0092: principal identity remains the partition.
- ADR-0094 and ADR-0096: one connect boot decision and environment-injected
  persistence should survive, but their concrete storage attachments change.
- ADR-0106 and ADR-0107: closed child-doc layouts and plain `Y.Text` remain.
- ADR-0110: edit timing remains owned by the value owner; the SQLite outbox must
  not introduce a global debounce tier.

The 2026-07-11 review swept the full ADR index and adds:

- Must be superseded by the accepted versions of 0119/0120/0121: ADR-0006
  (per-row `_v` version tuple), ADR-0077 (parsed-row memoization written
  against YKeyValueLww internals), ADR-0093 (KV metadata over the Yjs kv
  namespace).
- Re-anchor in each app's SQLite wave (decision survives, storage clause
  changes): ADR-0055 (conversations table), ADR-0102 (vocab entries),
  ADR-0025 (agent transcripts), ADR-0031 (names YKeyValueLww as the row
  store), ADR-0087 (the "Yjs wire contract" splits into SQLite metadata plus
  Yjs bodies). ADR-0074 (secret vault, its own encrypted Yjs LWW-KV doc) may
  remain a separate plane; flag for consistency only.
- Not affected: ADR-0026/0029/0065/0101 (Matter's markdown-to-SQLite
  projection is a different storage stack: disk as truth, disposable mirror).
- Numbering collisions to resolve before acceptance: 0092, 0079, and 0101
  each name two files.

Do not edit accepted ADRs to disguise the change. A new accepted ADR must
supersede or explicitly scope the old decision.

## Developer API target

The 2026-07-11 review made the developer API a first-class design target;
pass 3 corrected it against the second review's blockers. The selected shape
is type-checked in `demos/local-first-sync/api-prototype/` and detailed in
`demos/local-first-sync/REVIEW-2026-07-11.md` (pass 3 addendum):

- `defineWorkspace({ id, name, epoch, tables, kv, migrations })`; the local
  storage revision is derived as `1 + migrations.length`;
  `defineTable(columns, { indexes, docs })`; `defineKv(schema, default)`.
  A KV schema must not admit `null`: the wire encodes clear as
  `value: null`, so a nullable KV value would collide with cleared. Absence
  belongs to the default factory or the value's own shape.
- Opening is TWO doors, not one option: `openLocalWorkspace(definition,
  { storage })` (no actor, cursor, or outbox exist) and
  `openReplica(definition, { storage, sync })`. `openWorkspace({ sync? })`
  dies: it hid a permanent durable-identity choice inside an optional field.
  Promotion is `openReplica` + `planImport(local)`, never a reopen flag;
  `connect(connection | null)` does not survive either.
- Table writes are wire-honest and asynchronous: `put` (write every cell
  declared by this exact schema; the local image of
  patchRow-all-declared-cells),
  `patch` (named cells of a live row; null when absent or deleted), `remove`
  (terminal). `create` and `upsert` die with `set`: globally exclusive
  creation is not a promise a distributed patchRow can keep (the fold
  create-merges on unknown ids), and the protocol has no row-replacement
  operation. Local double-submit guards use stable ids or an asynchronous
  `has()` preflight; they are UX guards, never distributed uniqueness
  guarantees. Every write, single-verb or `transact(fn)`, is exactly one
  atomic local commit. For a replica, that same commit includes the outbox row
  and actor-sequence allocation. The transaction callback is a synchronous,
  write-only batch builder. It cannot read because the authoritative SQLite
  connection may live across a worker or native-service boundary. The returned
  promise resolves only after the committed delta has been published.
- Authoritative reads are asynchronous: `get` /
  `list({ where, orderBy, limit })` / `has` / `count`, plus one SELECT-only
  `sql(query, params, schema)` escape hatch with declared result validation and
  conservative `observeSql(tables, run)` invalidation. Under the quarantine
  decision, `sql` over application tables and `list` see one row population;
  `sql` stays an escape hatch because the query itself is untyped and
  uninvalidated, not because it reads a different dataset. No Drizzle and no
  bespoke query builder: the deleted 2026 Drizzle layer died as a second
  consumer-less schema derivation, and field.* must remain canonical, so
  Drizzle could only return as exactly that second derivation.
- UI helpers expose synchronous query-scoped projections after an explicit
  `whenReady` promise. They hydrate once, buffer committed deltas that race the
  initial snapshot, and never become a second durable database or update
  optimistically.
- Boundary doors: `planImport(source)` on any open workspace and
  `planEpochUpgrade(definition, { storage, sync })` for a superseded-epoch
  replica. Both return the same reviewable ImportPlan.
- Child docs: declared as `docs: { body: 'richText' | 'plainText' }` beside
  the table; opened via one lifecycle owner returning a disposable handle.

## Open questions

These questions invite evidence, not speculative framework growth.

1. **Can the direct typed-table client pass Gate 1 without a canonical shadow?**
   - Recommendation: require a minimal counterexample before adding the shadow.

2. **Where do terminal tombstones and nonconforming rows live locally?**
   - Recommendation: choose the smallest representation that keeps app queries
     typed and app code unaware of internal sync rows.

3. **Are new tables and fields new schema epochs?**
   - DECIDED (2026-07-11 correction pass): yes. One incarnation has one exact
     logical schema identity. This deliberately refuses invisible cross-version
     synchronization and deletes unknown-field, unknown-row, and promotion
     machinery. Representation-only SQLite changes remain within the epoch.

4. **Does `(actorId, actorSequence)` completely replace mutation UUID?**
   - DECIDED (2026-07-11 review): yes. The UUID is deleted from the protocol;
     the deletion traces are in the review memo's metadata matrix. Gate 1
     exercises retry and duplicate delivery. Physical copy, clone, and restore
     remain Gate 3 import/identity traces and are not claimed as Gate 1 evidence.

5. **How many actor high-water entries may one database retain?**
   - Recommendation: impose a product-level active-replica limit and explicit
     revocation before normalizing hypothetical millions of actors.

6. **How are snapshot generations retired during concurrent bootstrap?**
   - DECIDED (2026-07-11 Gate 2): one immutable published generation is
     addressable. Publication replaces it atomically; requests for the abandoned
     generation receive `snapshot-replaced` and restart from the current
     manifest. No separately durable build generation is required.

7. **What exact checksum belongs on snapshot manifests?**
   - DECIDED (2026-07-11 review): SHA-256 on the manifest and on each chunk.
     FNV-style digests keep silent corruption classes.

8. **How does reactive query invalidation observe SQLite changes?**
   - Recommendation: the application transaction reports touched tables/rows;
     do not poll or build a second in-memory database.

9. **Which current scalar bodies must move to Yjs immediately?**
   - Recommendation: Honeycrisp is the reference; move Whispering transcripts,
     Todo bodies, and Wiki bodies when their apps enter the SQLite wave.

10. **When does app-specific cloud work earn a durable jobs table?**
    - Recommendation: defer it. Preserve an ordinary named service-actor write
      boundary, but do not build Queues or a self-hosted scheduler in the first
      synchronization implementation.

11. **What happens to a child Yjs document after its parent row is deleted?**
    - Recommendation: deletion immediately makes the document unreachable from
      the app, but physical Yjs update reclamation is a separate garbage-
      collection decision. Do not make record deletion synchronously erase body
      history until stale-device and restore semantics prove that safe.

12. **How does a typed client hold a newly created row whose first patch is
    incomplete or invalid for its required fields?**
    - DECIDED (2026-07-11 Gate 1): by fold totality plus QUARANTINE. Typed
      application tables contain conforming rows for the exact epoch. The fold
      materializes a nonconforming row as one complete internal quarantine row;
      a completing patch promotes it atomically. `sql` and `list` therefore see
      the same typed row population. The rejected permissive-read alternative
      would make raw SQL counts and typed reads silently disagree. Gate 1 proves
      partial create, pending replay, completion promotion, crash, and delete;
      Gate 2 covers snapshot reclassification; Gate 3 proves exact schema
      identity and epoch import.

13. **Which structural limits prevent unbounded rows, fields, JSON values, and
    terminal tombstones?**
    - Recommendation: define bounded identifiers, cells per mutation, encoded
      mutation bytes, rows per account, active actors, and snapshot bytes. Limits
      pause the database before acceptance; they do not selectively remove one
      operation from an accepted mutation.
    - Platform floor (verified 2026-07-11): Durable Object SQLite caps any
      row/BLOB at 2 MB and statements at 100 KB, so encoded-mutation and
      snapshot-chunk byte limits are platform-required, enforced at write
      time on every engine.

## Success criteria

- [ ] The three Proposed ADRs survive an independent clean-break review.
- [ ] Every settled product invariant is represented in an ADR or this spec.
- [x] Gate 1 passes without earning a canonical shadow; evidence is in
  `demos/local-first-sync/gates/GATE1-EVIDENCE.md`.
- [x] Gate 2 proves permanent log-prefix deletion with stale pending clients;
  evidence is in `demos/local-first-sync/gates/GATE2-EVIDENCE.md`.
- [x] Gate 3 proves exact schema fencing and explicit epoch import; evidence is
  in `demos/local-first-sync/gates/GATE3-EVIDENCE.md`.
- [ ] The same protocol and fold conformance suite passes through browser, Bun,
  and Durable Object SQLite adapters.
- [ ] Local-only apps operate without actor identity, outbox, auth, or server.
- [ ] Explicit imports, endpoint moves, restores, and epoch upgrades use one
  logical import planner.
- [ ] Metadata bootstrap does not eagerly open Yjs bodies.
- [ ] Browser scale reports include 100K and 1M representative rows.
- [ ] Accepted ADR conflicts are superseded or scoped explicitly.
- [ ] Production docs teach one record path and one body path.
- [ ] The completed spec is deleted after its durable decisions and reference
  facts reach their proper homes.

## References

- `demos/local-first-sync/REVIEW-2026-07-11.md`: cold-start architecture
  review (developer API selection, metadata matrix, ADR sweep, Gate 1
  handoff) whose decisive findings are folded into this spec.
- `demos/local-first-sync/api-prototype/`: type-checked disposable prototype
  of the selected developer API.
- `demos/local-first-sync/DECISION-MEMO.md`: existing research and comparison.
- `demos/local-first-sync/gates/DESIGN.md`: earlier three-gate design to revise.
- `demos/local-first-sync/gates/protocol.ts`: earlier protocol skeleton.
- `packages/field/src/builders.ts`: persisted field authoring vocabulary.
- `packages/field/src/field.ts`: recognized field kinds and SQLite affinities.
- `packages/workspace/src/document/define-table.ts`: current table schema boundary.
- `packages/workspace/src/document/table.ts`: current table API and child-doc declarations.
- `apps/honeycrisp/src/lib/workspace/index.ts`: metadata plus rich-text child-doc reference shape.
- `apps/whispering/src/lib/workspace/definition.ts`: current scalar transcript and KV shapes.
- `apps/todos/todos.ts`: current scalar todo body.
- `apps/wiki/src/lib/workspace/schema.ts`: current raw persisted TypeBox escape cases.
- `docs/adr/README.md`: ADR lifecycle and numbering rules.
