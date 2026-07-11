# Server-authoritative SQLite synchronization

**Date**: 2026-07-11
**Status**: Draft
**Owner**: Epicenter

## One Sentence

Each Epicenter app keeps a complete local SQLite metadata replica, synchronizes
atomic fields through a schema-blind server-ordered mutation log, and
synchronizes mergeable bodies as lazy Yjs documents.

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
- The logical database key is `(principalId, appId)`.
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

- Import, restore-as-copy, local-to-account migration, and endpoint movement use
  one logical database merge engine.
- The merge engine compares compatible source and destination snapshots by
  table, row, and cell.
- Users may apply a bulk preference and review only differing cells.
- Merge output is ordinary mutations, not a second write protocol.
- Application row identity is portable. Replica actor identity, cursors, and
  outboxes are not.

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
```

The costs are explicit:

- A long-offline same-cell assignment may overwrite a change made later by human
  wall-clock time on another device.
- A complete metadata replica consumes local storage on every synchronized
  device.
- Server-side app search, indexing, automation, and AI require separate derived
  workers or services.
- Restoring a deleted record creates a new identity.
- Copying a physical SQLite file into another active replica requires an
  import-as-new-replica flow.

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
  unknown additive-field preservation
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

Merge editor
  owns explicit source/destination comparison and user choices
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

The minimal candidate shape is:

```ts
type Mutation = {
	protocolMajor: number;
	appId: string;
	databaseGeneration: string;
	actorId: string;
	actorSequence: number;
	operations: Operation[];
};
```

`(actorId, actorSequence)` is the candidate idempotency key. A separate mutation
UUID is refused unless a falsification trace proves the composite insufficient.

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
  visible, typed, locally queryable state

__epicenter_state
  one replica's actor identity, next sequence, cursor, database generation,
  app schema version, and protocol major

__epicenter_outbox
  one immutable row per pending atomic mutation

unknown additive-field storage
  values the current app schema cannot project yet

Yjs update storage
  separate persistence for opened child docs
```

The first gate must determine whether unknown values and terminal tombstones can
live in reserved internal columns on application rows or earn separate tables.
It must also determine whether application tables can be the only physical
materialization or whether a schema-blind canonical shadow is unavoidable.

The target starts with no canonical shadow. A proof may earn one by presenting a
minimal trace where accepted current state cannot be recovered after outbox
pruning, snapshot installation, or crash.

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

### How are unknown fields stored?

An old client must preserve additive fields it cannot project into typed columns.
The preferred candidate is a reserved JSON sidecar associated with a known row.
On upgrade, one transaction validates the stored value, writes the typed column,
and removes the sidecar key.

Unknown tables are a separate decision. The recommended refusal is that adding a
new synchronized table is an app-schema major change that pauses older clients;
only additive fields within known tables use the sidecar path. Gate 3 must either
validate this refusal or demonstrate a smaller safe representation.

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

The merge engine accepts two logical snapshot readers and one mutation writer:

```ts
type LogicalSnapshotReader = {
	readTables(): AsyncIterable<LogicalRow>;
	readDocument(ref: DocumentRef): Promise<Uint8Array | undefined>;
};

type MergeDestination = {
	commit(operations: Operation[]): Promise<void>;
};
```

The exact API is not settled. The ownership is: compare logical data, collect
choices, emit ordinary writes. It does not copy SQLite pages or sync metadata.

### Replica restore and clone

```txt
Restore lost replica:
  original no longer writes
  physical backup may preserve actor identity and outbox

Clone while original may write:
  open through import-as-new-replica
  preserve app rows and child docs
  discard old actor identity, cursor, and outbox identity
  mint/register a new actor
  emit logical import mutations
```

The product does not support two live files with one actor identity.

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

Large snapshots must be consistently pageable while new writes continue. The
candidate is immutable fixed-size chunks with a generation id, sequence, count,
and cryptographic checksum. A new snapshot is built beside the old generation,
published atomically, then the old generation is deleted after no bootstrap
request can reference it or after clients can restart against the new generation.

Gate 2 must determine whether one published generation plus an unpublished build
generation is enough. It must not keep arbitrary historical snapshots merely to
avoid designing restart semantics.

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

Four version axes stay separate:

```txt
App schema version
  typed local tables and field promotion

Client sync-storage version
  __epicenter_* local DDL

Server sync-storage version
  generic canonical/log/snapshot DDL

Wire protocol major
  mutation and snapshot encoding
```

Cloudflare Durable Object class migrations are deployment declarations, not a
substitute for SQL schema migrations inside each object.

### App schema rules

- Additive fields within known tables are compatible.
- Old clients preserve unknown additive fields without emitting them.
- Adding a non-null field requires a deterministic local default or migration.
- Renaming, removing, narrowing, or changing the storage kind of a field is a
  breaking app-schema migration.
- Adding a synchronized table is provisionally a breaking app-schema major.
- An incompatible client pauses remote sync but continues local work.
- Upgrade promotion from unknown sidecar to typed column is transactional and
  removes the sidecar copy exactly once.

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
- full drain convergence across at least three replicas.

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

### Gate 3: Additive schema preservation

Claim:

```txt
An old client cannot erase an additive field it does not understand, and an
upgraded client promotes the value into its typed column exactly once.
```

Required directed traces:

- new client writes a field unknown to old client;
- old client pulls, restarts, edits another field, pushes, and exports;
- old client installs a snapshot containing unknown fields;
- upgraded client promotes valid unknown values transactionally;
- invalid promoted value pauses or reports migration without erasing the sidecar;
- explicit `null` clears an unknown field;
- schema-major mismatch pauses sync while local writes continue;
- proposed unknown-table refusal is verified through app-schema major behavior.

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
- [ ] Decide the unknown-table compatibility refusal.
- [ ] Keep the ADRs Proposed and this spec Draft.

### Wave 1: Gate 1 reference and SQLite engines

- [ ] Rewrite the hardened gate model around terminal ids, `patchRow`,
  `deleteRow`, actor sequence, and no selective rejection.
- [ ] Implement both candidate client representations.
- [ ] Generate and minimize adversarial schedules.
- [ ] Measure code and storage differences.
- [ ] Select the smallest representation that passes.

### Wave 2: Gate 2 snapshot and compaction

- [ ] Define immutable logical snapshot manifest and chunk encoding.
- [ ] Implement current-head snapshot publication and log-prefix deletion.
- [ ] Prove new and stale bootstrap under failure.
- [ ] Prove actor idempotency and tombstones survive compaction.

### Wave 3: Gate 3 schema evolution

- [ ] Implement additive unknown-field preservation.
- [ ] Implement transactional promotion.
- [ ] Prove old-client restart, patch, export, snapshot, and upgrade.
- [ ] Prove app-schema major pause behavior.

### Wave 4: Shared production core

- [ ] Extract protocol schemas, deterministic fold, and conformance tests.
- [ ] Define the narrow storage transaction boundary from proven operations.
- [ ] Implement browser SQLite, Bun SQLite, and Durable Object SQLite adapters.
- [ ] Keep hosted auth/billing outside the shared server library.

### Wave 5: Workspace API clean break

- [ ] Make `field.*` plus `nullable` the only persisted storage vocabulary.
- [ ] Move scalar collaborative bodies to declared plain-text or rich-text docs.
- [ ] Replace Yjs table/KV record persistence with typed SQLite application
  tables and reactive query invalidation.
- [ ] Stop importing the old record path, verify, then delete it and its fixtures.

### Wave 6: Lifecycle and merge editor

- [ ] Implement local-only and synchronized database selection at boot.
- [ ] Implement logical import with source retention through acceptance.
- [ ] Build the schema-driven table, row, and cell diff surface.
- [ ] Implement import-as-new-replica and restore-lost-replica workflows.

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

Do not edit accepted ADRs to disguise the change. A new accepted ADR must
supersede or explicitly scope the old decision.

## Open questions

These questions invite evidence, not speculative framework growth.

1. **Can the direct typed-table client pass Gate 1 without a canonical shadow?**
   - Recommendation: require a minimal counterexample before adding the shadow.

2. **Where do terminal tombstones and unknown fields live locally?**
   - Recommendation: choose the smallest representation that keeps app queries
     typed and app code unaware of internal sync rows.

3. **Are new tables app-schema major changes?**
   - Recommendation: yes. Preserve additive unknown fields, but pause clients
     that do not know an entire synchronized table.

4. **Does `(actorId, actorSequence)` completely replace mutation UUID?**
   - Recommendation: yes unless clone, restore, compaction, or service-worker
     traces demonstrate a separate invariant.

5. **How many actor high-water entries may one database retain?**
   - Recommendation: impose a product-level active-replica limit and explicit
     revocation before normalizing hypothetical millions of actors.

6. **How are snapshot generations retired during concurrent bootstrap?**
   - Recommendation: permit one published and one building generation; clients
     restart against the published generation after replacement.

7. **What exact checksum belongs on snapshot manifests?**
   - Recommendation: use a standard cryptographic digest for corruption
     detection rather than FNV-style proof-only checksums.

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
    - Recommendation: treat honest clients as responsible for complete valid
      creates, but include malformed, partial, and newer-schema creates in Gate 1
      and Gate 3. If typed application tables cannot preserve them without a
      second generic representation, either earn that representation or tighten
      the operation contract. Do not hide repair in ordinary reads.

13. **Which structural limits prevent unbounded rows, fields, JSON values, and
    terminal tombstones?**
    - Recommendation: define bounded identifiers, cells per mutation, encoded
      mutation bytes, rows per account, active actors, and snapshot bytes. Limits
      pause the database before acceptance; they do not selectively remove one
      operation from an accepted mutation.

## Success criteria

- [ ] The three Proposed ADRs survive an independent clean-break review.
- [ ] Every settled product invariant is represented in an ADR or this spec.
- [ ] Gate 1 passes or produces a minimal trace that earns a canonical shadow.
- [ ] Gate 2 proves permanent log-prefix deletion with stale pending clients.
- [ ] Gate 3 proves additive unknown-field preservation and promotion.
- [ ] The same protocol and fold conformance suite passes through browser, Bun,
  and Durable Object SQLite adapters.
- [ ] Local-only apps operate without actor identity, outbox, auth, or server.
- [ ] Explicit imports and endpoint moves use one logical merge engine.
- [ ] Metadata bootstrap does not eagerly open Yjs bodies.
- [ ] Browser scale reports include 100K and 1M representative rows.
- [ ] Accepted ADR conflicts are superseded or scoped explicitly.
- [ ] Production docs teach one record path and one body path.
- [ ] The completed spec is deleted after its durable decisions and reference
  facts reach their proper homes.

## References

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
