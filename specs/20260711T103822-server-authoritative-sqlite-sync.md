# Server-authoritative SQLite synchronization

**Date**: 2026-07-11
**Status**: In Progress
**Owner**: Epicenter

## One Sentence

A synchronized workspace update rebuilds the current records database under a
new immutable records schema after explicit approval; a trusted application
client prepares a complete successor from canonical database A at head H, and
the schema-blind authority activates it only if A is still current and
unchanged. A local-only workspace performs the same replacement automatically.

## How to read this spec

Read first:

- Current state
- Target model
- Schema succession
- Developer API target
- Implementation waves

Read when implementing sync:

- Ordinary synchronization
- Logical snapshots and compaction
- Storage owners
- Verification matrix

Read when reviewing scope:

- Refusals
- Open approval points
- ADR reconciliation

## Overview

Epicenter is replacing Yjs tables as the general record-metadata store with
ordinary local SQLite tables and a small logical mutation protocol. Every app
continues to work without an account or server. Signing in adds a plaintext,
schema-blind authority that orders mutations and keeps a compact canonical
snapshot. Synchronized KV stays in one permanent eager Yjs document, and
collaborative bodies stay in separate lazy Yjs documents.

The server does not mirror SQLite files and does not run application migrations.
Physical SQLite layouts are runtime state. Logical rows and snapshots are the
portable contract.

## Durable decisions

This spec implements and tests the following ADR decisions. Their individual
files own current acceptance status:

- [ADR-0119](../docs/adr/0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md): complete metadata replicas use server-ordered logical mutations.
- [ADR-0120](../docs/adr/0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md): record fields are atomic cells; collaborative bodies are Yjs documents.
- [ADR-0121](../docs/adr/0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md): background sync is automatic; explicit database-boundary movement is reviewable.
- [ADR-0122](../docs/adr/0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md): logical snapshots are portable; SQLite files are runtime state.
- [ADR-0123](../docs/adr/0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md): bounded metadata uses records; merge-sensitive state uses lazy child docs.
- [ADR-0124](../docs/adr/0124-workspace-kv-keeps-one-logical-identity-outside-the-record-database.md): workspace KV keeps one logical identity outside records databases.
- [ADR-0125](../docs/adr/0125-record-schemas-are-immutable-evolution-creates-a-successor-database.md): record schemas are immutable; evolution creates a successor database.
- [ADR-0126](../docs/adr/0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md): child documents use format capabilities and evolve outside records databases.
- [ADR-0127](../docs/adr/0127-chat-streams-live-turns-in-client-state-and-stores-finished-messages-as-records.md): chat streams live turns in client state and stores finished messages as records.
- [ADR-0129](../docs/adr/0129-matter-is-markdown-authoritative-application-records-follow-developer-owned-schemas.md): Matter remains Markdown-authoritative; this spec owns only developer-shaped application records.

ADR numbers allocated on this branch remain provisional until merge.

## Current state

The repository is between the old and target models.

### Production workspace path

- Yjs tables still own production record metadata.
- Per-row `_v` and migrate-on-read still exist in the document-table path.
- Child Yjs documents already own some large or collaborative bodies.
- `workspace.kv` exists as a Yjs LWW key-value surface.

### SQLite branch

`packages/workspace/src/sqlite/` already contains substantial target machinery:

- typed SQLite tables and field validation;
- local transactions and reactive invalidation;
- logical `createRow`, `updateRow`, and `deleteRow` operations;
- a durable replica outbox, actor sequence, pull cursor, and snapshot install;
- schema identity negotiation and database-authority binding.

The first definition wave deleted app-authored `epoch`,
`rootDocumentIncarnation`, and mixed migration arrays, added inert historical
descriptors, and derived `<id>.kv`. Its document, index, and generic
`schemaHash` surfaces were reopened by the pre-Wave-2 greenfield review. The
terminal definition instead uses one `{ fields, documents }` table shape, a
closed document-capability catalog, and a records-only `recordsSchemaHash`.
Internal replica and authority code still uses
`databaseIncarnationId` vocabulary; the Wave 2 rename to records `database`
state is pending.

### Falsification gates

`demos/local-first-sync/gates/` proves useful mechanics against independent
in-memory and SQLite implementations:

- Gate 1: pending and accepted writes stay visible through retries and crashes.
- Gate 2: a snapshot can replace a mutation-log prefix permanently.
- Gate 3: replace the rejected late-overlay and device-participation proofs with
  head-bound candidate upload, conditional activation, stale-head retry, and
  permanent supersession.
- Gate 4: the protocol runs through Browser, Bun, and Durable Object adapter shapes.
- Gate 5 and Gate 6: typed workspace and lifecycle integration evidence.

The old Gate 3 implementation was deleted because it proved rejected transition
models. Its replacement remains a pre-Wave-2 proof gate.

## Target model

```txt
Workspace family
  stable workspace id
  permanent synchronized KV: <workspaceId>.kv
  independently format-addressed child documents
  current records database id
          |
          v
Records database
  server-minted database id
  one immutable records schema hash
  logical tables, rows, and cells
  actor/cursor/outbox coordination universe
```

Each device materializes the current records database in its own SQLite file.
The hosted or self-hosted authority materializes the same logical rows in its
own SQLite storage. No physical file, page, WAL, index, cursor, or outbox moves
between them.

### Data planes

```txt
workspace.kv
  bounded synchronized preferences
  eager YKeyValueLww document
  stable logical identity across record schema changes

workspace.tables
  bounded queryable metadata
  complete local SQLite replica
  server-ordered atomic cell replacement

table documents
  merge-sensitive or large collaborative bodies
  separate lazy Yjs documents with independent format hashes

blobs
  large opaque bytes
  addressed outside records and Yjs documents
```

There is no generic root document. KV earns one eager document; child bodies earn
separate lazy documents; records earn SQLite.

### Source authority boundary

This spec applies to developer-shaped application sources. Their TypeScript
definitions generate mandatory portable descriptors, and their logical records
materialize into complete local SQLite databases.

Matter is a separate source kind. User-authored Markdown remains authoritative;
an optional folder-level `matter.json` describes a lens, and any SQLite mirror
is a disposable read-only query projection. The two source kinds share the
closed `field.*` vocabulary, not an authority model. There is no bidirectional
Markdown and SQLite materialization, generic source registry, cross-source
reference, or cross-source transaction in this work.

### Trust model

The authority stores plaintext cells. This preserves the current trusted-server
decision and self-hosting privacy model. Plaintext permits future server-side
features but does not require them. The first authority remains deliberately
small and implements no app-specific search, migration, AI, or query layer.

## Product contract

### Local-only operation

- Every app opens and remains useful without sign-in.
- Local reads and queries never require a server.
- A local write commits to application SQLite before the UI reports success.
- A local-only database has no dormant actor, cursor, or synchronization outbox.
- A recognized local-only schema change updates automatically through a fresh
  successor database. Failure leaves the retained source selected on reopen.

### Synchronized operation

- One principal owns each synchronized workspace family.
- Every synchronized device keeps a complete metadata replica.
- A client may remain offline indefinitely and keep local work while its records
  schema remains current. Before a schema cutover, the user chooses which
  devices matter, synchronizes them, stops editing, and approves the update.
  Forgotten old-schema work remains local/exportable but does not rejoin
  automatically.
- Server acceptance order resolves concurrent assignments to the same cell.
- Concurrent assignments to different cells compose.
- WebSockets are wake-up hints; cursor-based pull carries durable state.
- The transport log is compactable and promises no permanent history.

### Agent interaction

An agent may inspect the portable records descriptor and query or export the
complete local SQLite materialization without the original application. Writes
do not target the SQLite file or transport outbox directly. The agent submits a
portable proposal containing `createRow`, `updateRow`, and `deleteRow` changes;
a trusted application surface reviews it and, after approval, commits through
the same local transaction and outbox as a human edit.

The first proposal contract is records-only. One proposal cannot span records,
KV, child documents, or blobs, and it cannot invoke application code. Expected
old values may reject a stale proposal at approval time. The observed server
sequence is diagnostic context, not a second compare-and-swap condition.
App-specific executable actions remain separately approved tools around the
opened source; they are not portable workspace data.

### Row lifecycle

The record wire has three operations:

```ts
type Operation =
	| {
			kind: 'createRow';
			table: string;
			rowId: string;
			cells: Record<string, JsonValue>;
	  }
	| {
			kind: 'updateRow';
			table: string;
			rowId: string;
			cells: Record<string, JsonValue>;
	  }
	| { kind: 'deleteRow'; table: string; rowId: string };
```

- `createRow` creates one absent identity with complete initial cells.
- `updateRow` replaces named cells of a live row and is a no-op when absent.
- `deleteRow` physically removes a live row and is a no-op when absent.
- Creating an already-live identity is a replica invariant violation.
- A purged row id has one lifetime and is never intentionally reused.
- Reversible trash is ordinary live app data such as `deletedAt`; purge is the
  only action that emits `deleteRow`.

Deletion knowledge lives nowhere. Explicit creation and one-lifetime row ids
prevent a delayed update from resurrecting a purged row.

## Ordinary synchronization

### Local write

One local SQLite transaction:

```txt
validate current-schema input
apply change to typed application table or quarantine
append one mutation to durable outbox
commit
notify reactive queries after commit
```

A mutation is atomic across all of its row operations. The outbox uses
`(actorId, actorSequence)` for identity and ordering; there is no mutation UUID.

### Size admission

The same byte admission runs before standalone commits, replica outbox commits,
authority folds, pull parsing, and snapshot installation. Limits count UTF-8
bytes, not JavaScript characters:

| Value | Limit |
| --- | ---: |
| One logical cell | 256 KiB |
| One canonical snapshot row | 508 KiB |
| One encoded mutation | 512 KiB |
| One encoded push | 768 KiB |
| One records HTTP request | 1 MiB |
| One encoded snapshot chunk | 512 KiB |

For a string cell, the cell limit counts the raw UTF-8 string. For other JSON
cells, it counts their JSON encoding. `field.string({ maxBytes })` may set a
smaller authored raw-string limit; that constraint enters the canonical records
descriptor and schema hash. A declared `maxBytes` cannot exceed the universal
cell ceiling.

The row ceiling reserves 4 KiB below the snapshot chunk ceiling for generation,
index, checksum, and JSON framing. The authority checks the complete folded row,
not only the cells named by the current patch, so separately accepted updates
cannot accumulate an unsnapshotable row. A concurrent patch that would cross
the row ceiling is a terminal admission conflict: the replica stops retrying and
preserves its outbox for application-owned resolution. Standalone transactions
validate their complete logical operation set before commit. A value or
transaction accepted while signed out therefore remains encodable after
sign-in.

### Push

Every ordinary write uses the same serialization boundary as database
activation. The authority performs one transaction:

```txt
require family.currentDatabaseId == request.databaseId
require the selected database is writable
verify records schema hash, protocol major, and actor sequence
fold every operation into canonical rows in one transaction
advance the database head with one monotonically increasing server sequence
record actor high-water and uncompacted mutation tail
commit or reject the whole mutation
```

This transaction serializes with activation:

```txt
write first
  -> A.head advances
  -> activation is stale

activation first
  -> A becomes non-current
  -> old-database write is rejected
```

The server understands database, table, row, field, JSON value, actor, mutation,
and sequence. It does not understand app schemas or run app queries.

### Pull

The replica pulls accepted mutations after its cursor, applies them to typed
tables or quarantine, removes its own echoed outbox entries, reapplies any
remaining pending overlay, and advances the cursor in one local transaction.

Authentication, protocol mismatch, records-schema mismatch, sequence gaps, corruption,
and account-wide limits pause synchronization. The server never drops one
operation and accepts the rest of its mutation.

## Logical snapshots and compaction

A logical snapshot contains:

```txt
records schema hash
live table / row / cell state
server sequence
actor high-water marks
chunk manifest and integrity checks
```

It excludes:

```txt
SQLite pages, WAL, and indexes
local storage revisions
replica actor identity and cursor
private outbox
deleted rows and mutation history
workspace KV
child-document updates
```

The server may replace an accepted mutation prefix with one current checkpoint
and delete that prefix permanently. A stale replica installs the checkpoint,
prunes outbox entries covered by its actor high-water, reapplies the remaining
outbox, and continues after the snapshot sequence.

The checkpoint sequence, live rows, and actor high-water marks come from the
same server transaction. Reading rows at one head and high-waters at a later
head could prune an outbox mutation whose effect is absent from the snapshot.
Ordinary pull pages prune by exact accepted echoes only; actor high-water
containment is safe only after installing the matching checkpoint.

Snapshots are sync transport state, not user-visible backup or version history.
A product that needs history models and retains it separately.

## Schema succession

### Identity axes

Only five version or identity axes remain:

```txt
Records schema hash
  canonical logical record tables and fields
  selects whether a binary may synchronize with a records database

Document format hash
  canonical Yjs roots and accepted stored content for one closed capability
  prevents incompatible binaries from joining one child-document room

Records database id
  server-minted coordination universe
  binds actors, cursors, outboxes, snapshots, and mutations

Runtime storage version
  private SQLite DDL for Browser, Bun, or Durable Object storage

Wire protocol major
  mutation, snapshot, and transition encoding
```

Applications do not author an epoch, schema revision, record incarnation, KV
incarnation, or ordered migration counter.

### Structural meaning

The records schema hash is sufficient only if meaning changes are structurally visible.
For example:

```ts
// Wrong: same field, new unstated meaning
temperature: field.number(); // Fahrenheit became Celsius

// Right: the schema names the meaning
temperatureCelsius: field.number();
```

Changing a table, field name, field kind, nullability, enum, reference, or stored
meaning creates a different records schema hash. Adding or changing a child
document or local index does not.

Workspace identity, KV, child documents, indexes, and physical storage do not
enter the records schema hash. Each document capability derives its own format
hash from its canonical descriptor. Its address combines workspace, table, a
collision-resistant digest of the full row ID, document name, and format hash;
runtime `databaseId` never enters that address.
A format change therefore opens a new room. Capability-specific application
code may convert one document into that room while retaining the old room; this
does not succeed the SQLite records database.

### Canonical schema descriptor

The hash is computed over a canonical descriptor, and the descriptor is
designed first. A canonical JSON string is not a hash; the definition exposes
both.

```txt
recordsDescriptor
  format: "epicenter.record-schema/1"   (hashed with the rest)
  tables, sorted by name
    fields, sorted by name
      normalized at-rest JSON schema

recordsSchemaHash
  sha256:<lowercase hex> over the UTF-8 bytes of the canonical JSON
```

Included: table names, column names, normalized persisted schemas (kind,
nullability wrapper, enum members in authored order, validation constraints,
`x-ref` reference targets, and `field.json` schemas).

Excluded, with the reason each is excluded:

- `workspaceId`: family routing already binds every database to its workspace
  at three independent seams (local metadata `workspace_id`, the service
  handshake, authority route binding). Including it conflates "same logical
  schema" with "same workspace".
- Workspace display `name`: cosmetic; a rename must be free.
- KV keys, schemas, and defaults: KV survives records succession (ADR-0124).
- Child-document declarations and format hashes: Yjs rooms have independent
  compatibility identity and lifecycle (ADR-0126).
- Local indexes: rebuildable runtime query state.
- Annotation keywords `title`, `description`, `default`, and `examples` are
  stripped from every column schema root (and nullable branches) before
  canonicalization. They are editor and UI hints; editing a description or
  default must not create a successor database. Because `field.json` spreads
  its payload onto the column root, the payload's root-level annotations are
  stripped too; annotations nested deeper inside a `field.json` payload remain
  identity (stated cost of refusing recursive schema surgery). Everything else
  in the normalized at-rest schema is identity, including string-length and
  numeric constraints, because it changes accepted logical state.
- Authored epoch lineage: deleted. There is no migration-ancestry component in
  identity; succession is a database-level transition, not a lineage proof.

Array order inside a schema (for example enum member order) stays significant:
canonicalization sorts object keys only. Reordering enum members is an identity
change; this is stated cost in exchange for zero normalization machinery beyond
key sorting and annotation stripping.

There are no production SQLite-path databases yet, so the identity change from
the transitional canonical-JSON-with-workspaceId-and-epochs value is a clean
break with no compatibility bridge, dual token, or fallback reader.

### Evolution ownership by storage plane

The cohesion rule is:

> Same plane and same authority may earn a framework migration API. Moving
> between planes changes authority and remains an explicit application
> operation.

Epicenter separates three operations:

1. **Records-schema succession** is first-class, typed, and database-wide. The
   trusted client transforms canonical records database A at head H into
   complete successor B, and the authority conditionally activates B. A
   records transform reads records only. It never opens a lazy child document,
   reads an external Yjs room, or migrates document bytes.
2. **Child-document format conversion** is explicit and per document. A format
   change creates a separately format-addressed room. Capability-specific
   application code may name one old endpoint with `historicalDocument(...)`,
   open it through `workspace.documents.open(reference, rowId)`, and initialize
   the new declared room. Old room bytes remain retained. Version one has no
   generic document migration registry, cross-format graph, or workspace-wide
   scan that discovers and opens every lazy document.
3. **Cross-plane authority transfer** moves data between records and child
   documents through an explicit app-owned maintenance or successor operation.
   The app may use ordinary typed readers and writers, but it must choose
   exactly one authoritative plane after cutover. Version one provides no
   generic or atomic cross-plane migration, permanent dual write, automatic
   rollback, generic reconciliation, or server-executed application conversion.
   Source bytes remain retained until separate explicit cleanup, but they stop
   being authoritative after cutover.

Examples:

```txt
text -> richText
  per-document format conversion

richText -> text
  potentially lossy per-document projection

counter document -> SQLite cell
  app-owned authority transfer

SQLite cell -> counter document
  app-owned idempotent initialization, then authority transfer

Yjs keyed collection -> SQLite table
  app-owned successor builder, not a records migration
```

This boundary does not design document conversion, cross-plane transfer, or an
app-owned successor-builder API. It records ownership, retained old bytes, and
the refusal of a universal migration system.

The asymmetric decision is explicit:

```txt
Product sentence:
  Epicenter gives each storage plane one honest evolution path while
  applications may explicitly transfer authority between planes.

Refused promise:
  Epicenter generically discovers, coordinates, atomically migrates, and
  reconciles arbitrary data across records and Yjs documents.

Deletion prize:
  No universal migration registry, cross-plane transaction protocol, document
  enumeration, dual writers, generic rollback, cross-format graph, or
  server-executed application conversion.

User/developer loss:
  Cross-plane transfers require an explicit application maintenance operation
  and cannot claim atomicity across SQLite and Yjs.
```

### Trigger

The server does not decide that an application should migrate. A current binary
connects with its derived target records schema hash. If the workspace family's
selected database has a different hash and the binary registers that source descriptor,
the client may begin succession. An unrecognized source remains readable and
exportable but cannot synchronize with the target binary.

### Transition flow

```txt
ACTIVE source database at schema A
  -> user synchronizes important devices, stops editing, and approves
  -> client reads canonical snapshot of A at server sequence H
  -> client transforms H and uploads immutable candidate B bound to (A, H)
  -> authority seals B after manifest completeness and integrity checks
  -> activate(candidateId)
       if family.current == A and A.head == H:
         atomically select B and permanently supersede A
       otherwise:
         change nothing; let staging clean up B and retry from the new current head
```

The user, not the authority, owns the assertion that important devices have
synchronized. The migration UI must show the instruction and current device's
ordinary `Synced` state, but schema cutover creates no device-participation
state.
`actorId` and `actorSequence` remain ordinary retry-safe synchronization state
and do not enter migration requests.

The current binary treats a recognized old synchronized schema as a workspace
compatibility boundary. It explains that the user must synchronize the devices
whose changes matter, stop editing, and approve the update. Choosing `Not now`
closes only that workspace. The current application does not open the retained
old database as a read-only historical mode. During preparation the workspace
is unavailable for editing in that client. A source-head race restarts from a
fresh snapshot; repeated races surface the instruction to stop editing rather
than a merge or conflict workflow.

The server never executes app migration code. It publishes a canonical snapshot
at H, accepts immutable candidate chunks, verifies upload integrity and declared
completeness, and performs conditional activation. A continues accepting
ordinary writes while candidates upload. Any accepted write advances A beyond
H and safely invalidates those candidates.

Temporary staging is required for databases that exceed one request. A
candidate is a generic immutable logical-baseline upload with this server-owned
state:

```txt
candidate id
source database id
source head
target records-schema hash
immutable manifest digest
ordered chunk identities and content digests
row and byte counts
expiry
state: open | sealed
```

The manifest digest is SHA-256 over the UTF-8 bytes of canonical JSON for the
immutable manifest body, excluding the digest field itself. The protocol fixes
the manifest fields and canonical ordering; chunk entries sort by index. The
authority rejects duplicate chunk indexes and duplicate `(table, rowId)`
identities across the complete candidate. Sealing verifies that every declared
chunk exists, digests and counts match, row identities are unique, and values
satisfy generic wire limits.

Idempotency is exact:

```txt
same candidate id + identical manifest -> replay
same candidate id + different manifest -> conflict
same chunk index + identical bytes -> replay
same chunk index + different bytes -> conflict
reseal sealed candidate -> success
retry committed activation -> already-activated
genuinely stale candidate -> change nothing
```

Activation accepts only `candidateId`. Inside the activation transaction, the
authority loads the sealed manifest and derives source database A, source head
H, target records-schema hash, and the candidate's successor binding from
server-owned state. It
revalidates that binding, candidate state and expiry, family selection, and A's
head before selecting B and fencing A.

Staging has bounded candidate, chunk, row, byte, and lifetime quotas. The
authority owns cleanup. Expiry, sealing, activation, and cleanup serialize on
candidate and family state: cleanup cannot delete a winning candidate,
activation cannot revive an expired candidate, and an activation receipt
survives deletion of staged bytes. A sealed candidate is invisible until
activation and safe to garbage-collect if abandoned or stale.

The schema-blind authority verifies transport completeness and integrity. The
trusted application client validates every canonical source row against the
historical source descriptor before invoking typed transforms, then validates
every emitted row against the target descriptor before upload. Any
nonconforming or quarantined source row blocks succession. It is never silently
discarded; A remains unchanged and available for diagnosis and logical export.
The ordinary UI reports the blocker count and confirms that nothing changed.
Raw table names, row ids, and validation reasons appear only in bounded
technical details or a diagnostic export. This system has no generic repair
editor.

Candidates require no exclusive owner. Several clients may prepare from the
same H; the first successful activation changes the family selection, so every
other activation fails its compare-and-swap without special race state.

| Invariant | Owner |
| --- | --- |
| Which devices matter and whether they show `Synced` | User, informed by ordinary device UI |
| Stop-editing instruction and explicit approval | Migration UI |
| Canonical source snapshot and its head H | Records authority |
| Source and target schema validation, semantic completeness, and trusted transform execution | Migration client |
| Candidate binding, upload completeness, chunk integrity, and cleanup | Records authority staging |
| Current/writable write admission, fold, and head advance | Records-database authority transaction |
| Candidate binding revalidation and `(family.current == A && A.head == H)` | Workspace-family authority transaction |
| Atomic selection and permanent supersession | Workspace-family authority transaction |
| Actor id, actor sequence, cursor, and outbox retry semantics | Ordinary sync protocol, outside migration |
| Forgotten old bytes, retention, and logical export | Local storage owner |

The conditional update changes only the records database selection. Permanent
KV and independently addressed Yjs child documents continue syncing normally.

A local-only workspace uses the same logical transform without server
coordination or user approval:

```txt
current local database at schema A
  -> lifecycle recognizes the source and starts automatically
  -> take one short process-local exclusive cutover
  -> create fresh local database at schema B
  -> transform the logical source snapshot directly to B
  -> verify the complete target
  -> atomically select the target in local runtime metadata
  -> retain the source for logical export until explicit cleanup
```

This is still database succession, not an eager rewrite of mixed-version rows.
The source-head compare-and-swap is coordination needed only when a server may
accept concurrent writes. A failed or crashed local attempt leaves A selected
and writable on reopen; the partial candidate is safe to discard and retry.

### Records migration contract

The `Records` qualifier is deliberate. `@epicenter/workspace` spans records,
physical storage, KV, and child-document formats, so generic
`defineMigration`/`defineMigrations` names would imply a universal abstraction
that does not exist.

Records migrations are not behavior on `defineWorkspace`. A release exports a
separate declarative linear chain of adjacent steps and registers it with the
workspace lifecycle. Application code does not invoke a row runner, construct a
source snapshot, upload a candidate, or activate a database. Every step binds
one generated inert source descriptor to one target descriptor. The runtime
finds and composes the unique path from the family authority's selected source
hash to the current workspace hash during one migration attempt. It does not
create or activate intermediate databases. Branches, shortcuts, cycles, and
multiple paths are invalid.

The adjacent chain survives the optimistic cutover collapse because workspace
families may skip releases. Each schema edge is authored once and composed
client-side into the final candidate; a direct-to-current registry would grow a
new transform for every supported historical source on every release.

Every step uses
`defineRecordsMigration({ from, to, transform, discard })`. The runtime derives
a total disposition for every source table:

```txt
same name + canonically identical table descriptor
  -> copy automatically

same name + changed descriptor
  -> transform required

source-only table
  -> explicit discard required

target-only table
  -> begins empty

transform returns null
  -> omit that source row

runtime preserves source row id
  -> transform may read id but cannot author a replacement
```

Canonical descriptor equality, not TypeScript assignability or an authored
`'copy'` token, is the authority for automatic copying. `discard` acknowledges
that a source-only table intentionally does not enter the successor; it never
means silent handling of a nonconforming row. A transform receives `{ id,
cells }` and returns exact target cells or `null`. The runtime carries the source
row id. A records transform cannot open a child document or external Yjs room.
Equal source and target hashes are rejected by `defineRecordsMigration`; a
no-op is not an adjacent schema step.

The generic path refuses, at compile time where the type system can carry it:

- one-to-many splits (arrays are not a legal return);
- many-to-one merges;
- authored or cell-derived row ids;
- table routing or renaming, unknown target tables, and incomplete target rows;
- unregistered source shapes;
- mutation-history replay;
- old-patch translation;
- server-executed application code.

Transforms should be synchronous, pure, and deterministic so retries are easy
to reason about. This is trusted application guidance, not a runtime invariant:
arbitrary TypeScript is not sandboxed, so the runtime cannot prevent time,
randomness, network, or filesystem access. It does enforce descriptor
continuity, source and target row validation, same-table routing, zero-or-one
output, and id preservation.

Historical modules are generated, committed artifacts. They store the canonical
descriptor as truth, derive its hash, and never call old `defineTable` builders.
Importing generated endpoints is the sole supported and documented application
workflow. Generated TypeScript resolves its constructor through
`@epicenter/workspace/sqlite/generated`; the ordinary SQLite barrel does not
export it. The explicit subpath creates ownership friction, not a security or
type-soundness boundary. Deliberate code can still import the constructor, edit
generated output, cast values, or supply a generic that disagrees with the
descriptor. Source-code history labels use `recordsSchemaV1`, `recordsSchemaV2`,
and so on. These labels are not compatibility identity; `recordsSchemaHash` is
authoritative. The first system does not automatically retire chain prefixes
because hosted authority data cannot prove non-use across independent
self-hosted instances. Any later removal is release policy with explicit
deployment-support evidence, not a sync-engine inference.

The generic migration path deliberately refuses table routing, renames, splits,
merges, aggregation, and id changes. A remodel that needs those operations uses
a separate app-owned successor build or logical export/import boundary. That
escape hatch may reuse the logical snapshot and candidate activation seams, but
its API and recovery UX are outside this wave.

### Forgotten work after activation

There is no private-work migration phase. The user approved from canonical head
H after synchronizing the devices they cared about. A forgotten old replica may
retain and read its old local database only to produce a logical export. The
current application does not display it as an old-schema workspace. The
authority permanently rejects writes to the superseded database, and version
one never transforms, compares, merges, or generically re-imports its old-schema
overlay. Recovery beyond logical export is app-owned and outside schema
succession. A generic recovery tool, if later earned, reads logical exports; it
does not edit live SQLite files.

## Physical storage migrations

Physical migrations are private to a runtime:

- add or rebuild a local query index;
- change outbox or checkpoint tables;
- change JSON encoding;
- alter Durable Object or Bun adapter storage.

They migrate in place under a runtime-owned storage version because they do not
change logical synchronized state. Cloudflare class migrations are deployment
metadata, not a substitute for SQL storage migrations inside an object.

Application definitions do not carry generic `apply(tx)` representation
migrations or index declarations in the target API. Runtime internals own
internal DDL and protocol indexes. Application query indexes remain absent until
a measured local query earns an adapter-owned physical tuning surface.

## Storage owners

```txt
App schema
  current tables and fields, KV declarations, document capabilities

Explicit records migration bundle
  adjacent inert descriptors and same-table row transforms

Document capability
  canonical format descriptor and derived format hash
  typed Yjs attachment over fixed internal roots

Workspace runtime
  standalone versus replica boot
  asks storage to open the selected local records database
  permanent eager KV document
  child-doc openers, readiness, wipe, and disposal

Local workspace storage capability
  one environment-owned physical root
  family catalog and current/retained database selection
  one file per local logical records database
  derived paths/names, typed DDL, internal indexes, and storage revisions

Sync engine
  mutation identity, outbox, cursor, fold, snapshots, convergence

Database authority
  canonical plaintext rows, sequence, dedupe, snapshots
  staged candidates, conditional activation, atomic current-database selection

Yjs provider
  KV and child-document updates, persistence, and synchronization
```

### Cloud and self-host symmetry

Both deployments use the same logical authority contract:

```txt
Epicenter Cloud
  one principal/workspace Durable Object or equivalent partition
  private SQLite containing family metadata and logical database generations

Self-host
  Bun SQLite authority behind the same transaction boundary
```

One physical server SQLite database may contain several logical records
databases partitioned by `database_id`. A schema successor does not require
moving data between Durable Objects or uploading a SQLite file.

Minimal authority indexes are protocol implementation details:

```sql
PRIMARY KEY (database_id, table_name, row_id)
UNIQUE (database_id, actor_id, actor_sequence)
INDEX (database_id, server_sequence)
```

Application search and vector indexes remain local and rebuildable until a real
server-side consumer earns a declaration surface.

Authoritative SQLite is opened, never attached. `attachBunSqliteMaterializer`
names the old Yjs-to-SQLite projection and is deleted after its remaining Tab
Manager consumer moves to authoritative records. A browser or host constructs
one storage capability, for example `createOpfsWorkspaceStorage()` or
`createBunWorkspaceStorage({ root })`; applications never concatenate workspace,
principal, schema, or database identifiers into a file path.

## Developer API target

The public API should expose app concepts only. This is the target for review,
not a claim about the current implementation.

Every `define*` call has value semantics. It snapshots the declaration into
framework-owned immutable state; later mutation of caller-owned schema maps,
table maps, KV maps, document maps, or schema objects cannot change the
definition. Generated historical modules are the only supported application
workflow for historical endpoints. Low-level source scans, row runners,
candidate upload, and activation remain internal to the workspace lifecycle.

### Define the current schema

```ts
import { field } from '@epicenter/field';
import {
	document,
	defineKv,
	defineRecordsMigration,
	defineRecordsMigrations,
	defineTable,
	defineWorkspace,
	nullable,
} from '@epicenter/workspace';
import { recordsSchemaV1 } from './history/records-schema-v1';
import { recordsSchemaV2 } from './history/records-schema-v2';

const notes = defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
		updatedAt: field.instant(),
		archivedAt: nullable(field.instant()),
		pinned: field.boolean(),
	},
	documents: {
		body: document.xmlFragment,
	},
});

export const notesWorkspace = defineWorkspace({
	id: 'notes',
	tables: { notes },
	kv: {
		'theme.mode': defineKv(
			field.select(['light', 'dark', 'system']),
			() => 'system',
		),
	},
});

export const notesMigrations = defineRecordsMigrations([
	defineRecordsMigration({
		from: recordsSchemaV1,
		to: recordsSchemaV2,

		transform: {
			notes: ({ cells }) => ({
				...cells,
				archivedAt: null,
			}),
		},

		discard: ['drafts'],
	}),

	defineRecordsMigration({
		from: recordsSchemaV2,
		to: notesWorkspace,

		transform: {
			notes: ({ cells }) => ({
				...cells,
				pinned: false,
			}),
		},
	}),
]);
```

What one realistic call site teaches:

- `id` is the workspace family's durable namespace: it keys local persistence,
  sync routing, the KV document, and child-doc guids. `name` is an optional
  display label (mount labels, sign-in copy) and defaults to `id`; renaming it
  is free.
- A table's `id` column is declared so branded row types flow through the
  schema, but generation is framework-owned: `create()` mints the id, imports
  and sync preserve it, and no caller ever supplies one.
- `documents` assigns Epicenter-owned format capabilities to separately
  addressed per-row Yjs documents. `body` is an app-authored name, not a
  built-in. A capability owns its canonical descriptor, derived format hash,
  and typed `attach(ydoc)` implementation; no string switch or arbitrary raw
  attach function enters the schema. Fields and documents are separate
  namespaces, so `row.body` and `table.docs.body` may coexist. Matching names do
  not imply synchronization or shared authority. Table and document names are
  persistent room-address segments; renaming either creates new document
  identities. The table declaration does not promise a record patch after a
  document edit; an application that needs such a projection owns its observer,
  coalescing policy, and record writer.
- `defineWorkspace` describes only the current workspace. The records migration
  bundle is a separate declaration registered with the lifecycle; application
  code does not execute it. Each adjacent step names only changed-table
  transforms and explicit source-only `discard` entries. Descriptor-identical
  tables copy automatically, target-only tables begin empty, and the runtime
  composes the unique chain without activating intermediate databases.
- `defineKv(schema, () => default)` keys live outside the records database and
  survive schema succession; missing or invalid values read as fresh defaults.

The transform may read `{ id, cells }` but returns cells only. It cannot author
an id, switch target tables, or return several rows. The runtime reattaches the
preserved source row id; returning `null` omits it. Applications with no
historical synchronized family omit the separate records migration bundle
entirely. The current `recordsSchemaHash` is derived from canonical record
tables and fields only. KV and child documents are excluded because each has an
independent identity and lifecycle.

### Connect once

```ts
const storage = createOpfsWorkspaceStorage();

const workspace = await notesWorkspace.connect({ storage });

const synchronizedWorkspace = await notesWorkspace.connect({
	storage,
	connection,
});
```

The environment constructs storage once. It supplies a root capability, never a
workspace-specific path or OPFS name. The runtime derives family and database
locations from opaque identities and opens a local-only or synchronized
database based on whether a connection is present. Promotion opens the account
database and performs logical import; it never mutates an existing replica
identity.

### Use records, KV, and child docs

```ts
const note = await workspace.tables.notes.create({
	title: 'Migration notes',
	archivedAt: null,
});

workspace.kv.set('theme.mode', 'dark');

using body = await workspace.tables.notes.docs.body.open(note.id);
body.asXmlFragment();
```

The application never sees `recordsSchemaHash`, `databaseId`, actor identity,
cursor, outbox, snapshot generation, candidate id, or source head during normal
use.

### API removals

The clean break removes these definition concepts:

```txt
epoch
rootDocumentIncarnation
databaseIncarnationId as an app-authored noun
per-row _v in records tables
variadic live table versions
migrate-on-read
app-authored representation migrations array
public repair / drain / epochs APIs
required workspace display name
table `.docs(...)` builder and raw attach-function declarations
symbolic `'plainText' | 'richText'` layout union
per-document `{ layout, touch }` objects
logical table index declarations
caller-authored SQLite paths and OPFS names
the noun "record" in everyday CRUD (developers see workspace, tables, rows, kv,
  and docs); `recordsSchemaHash`, historical records schemas, and migration
  compatibility vocabulary keep the precise noun because they exclude KV,
  child documents, indexes, physical SQLite layout, and workspace identity
```

The census found zero production callers of the SQLite-path `epoch`,
`rootDocumentIncarnation`, and `migrations` surface (tests only), so these are
deletions, not migrations. `EpochMigration.mapIdentity` and `transformCells`
have no caller anywhere and are deleted with it.

Internal protocol code may use `databaseId`, `recordsSchemaHash`,
`documentFormatHash`, `storageVersion`, and
`protocolMajor`; they name real runtime invariants and do not enter app schemas.

`@epicenter/chat` migrates conversations and finished messages into SQLite
record tables
([ADR-0127](../docs/adr/0127-chat-streams-live-turns-in-client-state-and-stores-finished-messages-as-records.md)).
The live turn stays in client state; each finished message is one bounded atomic
record value validated by a runtime schema.
`document.keyed(...)` remains available for bounded merge-sensitive collections,
but it is not a second message-table system.

## Refusals

```txt
No SQLite file, WAL, or page replication
No partial metadata replicas or query subscriptions
No peer-to-peer record merge
No device-clock or HLC conflict authority
No per-cell conflict metadata or background conflict inbox
No permanent transport mutation history
No tombstones or used-id registry
No record upsert
No per-field merge-policy language
No arbitrary persisted-schema language beside field.*
No server-side app schema, migration code, search, or AI in the first system
No cross-version synchronization
No patch translation or outbox rewriting
No generic splits, merges, or reference remapper
No generic child-document migration hidden inside record succession
No universal migration registry across records and Yjs documents
No document enumeration or workspace-wide lazy-document scan
No application-facing source scanner, row runner, candidate uploader, or activator
No supported hand-authored historical descriptor/generic pairing in application code
No live mutable definition after a `define*` call returns
No no-op records migration step
No permanent cross-plane dual write, generic rollback, or reconciliation
No atomic transaction across SQLite records and Yjs documents
No agent proposal spanning records, KV, child documents, or blobs
No executable action encoded in the portable records descriptor
No server-executed application conversion
No app-authored epoch, revision, or incarnation
No physical restore that preserves replica actor identity
No KV rows or KV migration in the records plane
No old-schema compatibility mode in the current application
No generic SQLite recovery editor or live-database repair UI
No automatic merge or generic re-import of forgotten old-schema work
```

These are deletion decisions, not missing placeholders. A future product may
earn one back only with a concrete consumer and a new decision.

## Implementation waves

Build backward from the product promise, not forward from the existing public
plumbing:

1. Close the declaration boundary. Definitions have value semantics,
   historical endpoints are generated artifacts, no-op steps are invalid, and
   lifecycle machinery is not an application API.
2. Establish an honest source. The storage owner can identify and repeatedly
   scan the exact immutable `A@H` in canonical order without materializing it.
3. Establish an honest destination. The lifecycle owner stages, seals, and
   verifies a complete immutable candidate without reusing sync-compaction
   manifests.
4. Serialize cutover. Current-database write admission, head-conditional
   activation, and permanent fencing make the authority transition exact.
5. Add the product lifecycle. Local-only succession runs automatically;
   synchronized succession asks for approval; blockers and logical recovery
   export remain bounded technical surfaces.
6. Convert applications only after the new path is complete, then delete every
   superseded compatibility and storage path.

This order is a dependency rule. A later slice must not force an earlier owner
boundary to remain public or mutable.

### Wave 0: Build the records definition foundation

- [x] Remove app-authored `rootDocumentIncarnation`; derive `<workspaceId>.kv`.
- [x] Replace `epoch` and authored epoch lineage with a canonical records
  descriptor and derived hash (annotation-stripped, workspaceId-free,
  format-versioned).
- [x] Separate runtime storage migrations from app schema definitions.
- [x] Add inert historical schema descriptors and the generated-module renderer
  (`renderHistoricalSchemaModule`).
- [x] Replace the invalidated `defineWorkspace.imports` prototype with a
  separate linear adjacent records migration bundle and same-table-only
  transforms.
- [x] Make split, merge, table-routing, and id-changing migration results
  unrepresentable in the replacement type tests.
- [x] Make workspace `name` optional display metadata.
- [x] Replace `(fields, options)` with one
  `defineTable({ fields, documents? })` shape.
- [x] Keep field and document declarations as independent namespaces; prove a
  same-named cell and child document remain separately typed and addressable.
- [x] Add the closed branded `document` capability catalog with plain text,
  an XML-fragment-backed rich-text candidate, and validated keyed records.
- [x] Give each document capability a canonical descriptor, derived format hash,
  and typed `attach(ydoc)` implementation.
- [x] Exclude documents from `recordsDescriptor` and `recordsSchemaHash`.
- [x] Put document format identity at the child-document admission/address seam
  and prove it fences incompatible Yjs rooms.
- [x] Hash the complete row ID into a fixed-size room segment so valid record
  IDs do not inherit the room-address grammar.
- [x] Add one nominal historical-document reference and explicit typed opener
  without adding a registry, scan, or conversion runner.
- [x] Remove application indexes from logical table definitions.
- [x] Rename generic `schemaDescriptor` / `schemaHash` vocabulary to
  `recordsDescriptor` / `recordsSchemaHash` across the SQLite path.
- [x] Give every definition factory value semantics: snapshot caller-owned
  schema and declaration inputs, freeze framework-owned outputs, and prove
  later caller mutation cannot change runtime behavior or identity.
- [x] Make generated historical modules the only supported application workflow
  for old endpoints; expose the constructor only through the explicit
  generated-artifact subpath and omit it from the ordinary SQLite barrel.
- [x] Reject equal source and target hashes in `defineRecordsMigration`.
- [ ] Update real app definitions as API proof, starting with Honeycrisp.
  (Deferred to the app-by-app records migration: no production app is on the
  SQLite path yet, so the Wave 1 proof is Honeycrisp-shaped definition tests.)

### Wave 1: Settle schema succession decisions and evidence

- [x] Record stable `workspace.kv` identity in ADR-0124.
- [x] Propose immutable-schema succession in ADR-0125.
- [x] Settle the collapsed records migration API:
  `defineRecordsMigration({ from, to, transform, discard })` and
  `defineRecordsMigrations(steps)`.
- [x] Scope the planned API names to records and separate records succession,
  per-document format conversion, and cross-plane authority transfer.
- [x] Record retained old document bytes and refuse a universal or atomic
  migration system across SQLite records and Yjs documents.
- [x] Settle implicit descriptor-equal copy, explicit source-only discard,
  target-only empty tables, `null` row omission, and runtime-preserved ids.
- [x] Refuse table routing, renames, splits, merges, aggregation, and id changes
  from the generic path.
- [x] Require historical source-row validation and block succession on any
  nonconforming or quarantined row.
- [x] Specify atomic ordinary-write versus activation serialization.
- [x] Specify candidateId-only activation, immutable manifest binding,
  canonical digests, exact idempotency, quotas, expiry, and cleanup ownership.
- [x] Reconcile CONTEXT, ADRs, this active spec, gate evidence, historical
  labeling, and the implementation handoff around one target model.
- [ ] Re-run Gate 3 against structural records schema hashes, client-run
  adjacent migration chains, and the final candidate protocol. This is Wave 2
  proof work, not evidence supplied by this documentation wave.

### Wave 2: Build database succession

- [x] Stop exporting source-snapshot, row-runner, candidate-upload, and
  activation plumbing as application API. The workspace lifecycle owns
  execution after an app registers generated history and adjacent transforms.
- [ ] Introduce environment-owned workspace storage capabilities. Browser and
  host callers provide at most one root; no app supplies a per-workspace path,
  OPFS name, schema suffix, or database suffix.
- [ ] Store one local logical database per adapter-derived file and let the local
  family catalog select current, candidate, and retained database ids.
- [ ] Rename authority and replica `incarnation` state to records `database` state.
- [ ] Implement family `current_database_id` selection.
- [ ] Publish canonical source snapshots with an exact server head H.
- [x] Implement and prove the bounded-memory adjacent records-migration runner.
  Keep it internal to lifecycle orchestration and do not reuse compaction
  snapshot manifests as successor candidates.
- [ ] Implement immutable candidate manifests, idempotent chunk upload, upload
  completeness/integrity sealing, and safe abandoned-candidate cleanup.
- [ ] Make every ordinary write atomically require family-current and writable,
  fold its mutation, advance the selected database head, and commit.
- [ ] Implement `activate(candidateId)` by deriving and revalidating A, H,
  target hash, and successor binding from the sealed server-owned manifest; the
  authority never stores or runs application transforms.
- [ ] Enforce candidate replay/conflict rules, TTL and aggregate quotas, and
  serialization between expiry, sealing, cleanup, and activation.
- [ ] Validate every source row before transform and every output row before
  upload; surface nonconforming source rows as a blocking diagnostic.
- [ ] Prove concurrent candidates race only at the family-selection and
  source-head compare-and-swap.
- [ ] Fence superseded databases from further synchronization.
- [ ] Make local-only succession automatic and synchronized succession
  approval-gated through the workspace lifecycle.
- [ ] Preserve forgotten old local databases for logical export only. Provide
  no current-app compatibility viewer, generic SQLite editor, automatic merge,
  or generic re-import path.

### Wave 3: Prove ordinary synchronization

- [ ] Re-run pending-write, duplicate-delivery, crash, and rebootstrap traces.
- [ ] Re-run snapshot compaction and stale-outbox containment traces.
- [ ] Verify Browser, Bun, and Durable Object adapters against one fold suite.
- [ ] Verify local application indexes rebuild from a logical snapshot.

### Wave 4: Stop importing the old records path

- [ ] Move production app record metadata to typed SQLite.
- [ ] Move `@epicenter/chat` conversations and finished messages to SQLite
  record tables. Replace the synchronous keyed store with asynchronous atomic
  turn persistence, add explicit turn/step ordering, make conversation deletion
  remove its message rows transactionally, keep the live turn in client state,
  and remove the keyed message child document.
- [ ] Convert retained keyed chat rooms through an app-owned one-time import
  before authority cutover. This cross-plane conversion is not a records
  migration; retain old rooms for export and make old binaries fail closed.
- [ ] Move merge-sensitive scalar bodies to declared child docs where earned.
- [ ] Keep synchronized preferences on `workspace.kv`.
- [ ] Stop importing Yjs table persistence and per-row `_v` from migrated apps.
- [ ] Stop exporting raw `attachPlainText`, `attachRichText`, and
  `attachRecords`; migrated apps enter through document capabilities.
- [ ] Replace Tab Manager's Yjs-to-SQLite materializer and FTS dependency with
  authoritative records queries before removing the old projection.
- [ ] Keep the old code on disk but unused for one verification wave.

### Wave 5: Verify

- [ ] Run targeted workspace tests, package typechecks, and app smoke tests.
- [ ] Run document hygiene and stale-name sweeps.
- [ ] Prove no app definition exposes old schema-evolution nouns.
- [ ] Review the public API with fresh context before deletion.

### Wave 6: Remove the old path

- [ ] Delete per-row `_v`, migrate-on-read, and mixed-version table machinery.
- [ ] Delete `.docs(...)`, raw document-layout functions, string-layout adapters,
  and their normalization tests.
- [ ] Delete `attachBunSqliteMaterializer`, `attachMountSqlite`, old SQLite mirror
  readers, and caller-authored mirror-path helpers after their imports stop.
- [ ] Delete unused epoch/root-incarnation adapters, fixtures, and docs.
- [ ] Supersede ADR-0006 when the replacement behavior lands.
- [ ] Flip the remaining Proposed ADRs in 0119 through 0126 to Accepted as
  their production facts land. ADRs 0123 and 0126 already own the settled
  storage-plane and document-capability decisions.
- [ ] Accept ADR-0127 and mark ADR-0055 superseded after every chat surface uses
  record-backed messages.
- [ ] Move current protocol facts into `docs/reference/`.
- [ ] Add this spec to `docs/spec-history.md` and delete it.

## Verification matrix

| Property | Evidence required |
| --- | --- |
| Pending intent remains visible | Directed retry, crash, pull, and snapshot schedules |
| Same mutation is accepted once | Actor-sequence duplicate and response-loss tests |
| Deleted rows do not resurrect | Delayed update/delete and compaction traces |
| Snapshot replaces old log safely | Stale actor high-water and remaining-outbox tests |
| Partial successor never activates | Missing chunk, digest/count mismatch, failed seal, and abandoned-candidate cleanup tests |
| Source writes cannot be lost during migration | Force both serialization orders: write-first advances A and makes activation stale; activation-first makes A non-current and rejects the write |
| Candidate retries are idempotent | Identical candidate/chunk replay, conflicting manifest/chunk refusal, reseal success, already-activated receipt, and stale no-op tests |
| Candidate cleanup is bounded and serialized | TTL and aggregate quota tests plus expiry/seal/activation/cleanup race traces |
| Invalid source rows never disappear | Historical validation blocks the whole succession, reports row identities, and leaves A unchanged |
| Migration race has one winner | Concurrent sealed candidates from A/H; one conditional activation succeeds |
| Device participation is not protocol state | Migration requests and authority tables contain no device-participation fields |
| Forgotten local work has the stated loss | Superseded local database can produce a logical export; the current app cannot open it, merge it, or generically re-import it |
| Old records schema cannot keep syncing | Records-schema mismatch and superseded-database fencing test |
| Document implementation refactor is compatible | Same descriptor yields the same format hash and address |
| Incompatible document formats never share a room | Different descriptors yield different format-addressed guids |
| Document changes do not succeed records | Add/change/remove document leaves `recordsSchemaHash` unchanged |
| Storage paths stay adapter-owned | No app call site supplies an OPFS name, file path, or database suffix |
| Files are not portable identity | Physical-copy import mints a new actor test |
| Chat persistence is honest | User row commits before inference; one completed assistant turn commits atomically; live token deltas never enter records |
| Chat conversion changes authority once | Every retained keyed room validates into target rows before cutover; old clients fail closed and old rooms remain exportable |
| Chat deletion has one owner | One records transaction deletes a conversation's message rows and then its conversation row |
| Runtime parity holds | Same fold and transition suite through Browser, Bun, and DO SQLite |

## ADR reconciliation

- ADR-0006 is proposed for supersession by ADR-0125 after the replacement lands.
- ADR-0126 proposes superseding ADR-0005's builder/function shape while keeping
  its workspace-owned opener and closed-palette decision. ADR-0106 and ADR-0107
  keep one body format and plain-text storage semantics.
- ADR-0127 proposes superseding ADR-0055's keyed child-document storage while
  keeping one canonical `@epicenter/chat` owner and synchronized transcripts.
- ADR-0035 remains the deployment topology, but record metadata stops using the
  Yjs anchor path.
- ADR-0068 remains the privacy posture: hosted is trusted plaintext; self-host
  changes custody.
- ADR-0088 remains the product promise: sign-in enhances a local app.
- ADR-0092 remains the principal partition.
- ADR-0093 is reaffirmed: synchronized preferences stay in workspace KV.
- ADR-0094 and ADR-0096 keep one connection decision and environment-owned
  persistence, while their storage implementation changes.
- ADR-0077 and app-specific Yjs-table decisions need explicit supersession or
  scoping when their production consumers migrate.

Accepted ADRs must not be silently rewritten. Each real contradiction gets a
superseding or amending ADR when implementation makes the new fact true.

## Decision register and proof points

These decisions are settled unless their listed falsifier appears. Items that
request a prototype are implementation proof, not unresolved product approval.

1. **Records migration API ownership and shape** (direction resolved 2026-07-12)
   - Decision: delete `defineWorkspace.imports`. Define a separate declarative
     linear adjacent chain registered with the workspace lifecycle using
     `defineRecordsMigration({ from, to, transform, discard })` and
     `defineRecordsMigrations(steps)`. Descriptor-identical same-named tables copy
     automatically; changed same-named tables require a transform; source-only
     tables require `discard`; target-only tables begin empty. The runtime owns
     ids and composes one path to current during one lifecycle-owned cutover;
     synchronized cutover requires approval and local-only cutover is automatic.
   - Keep generated inert descriptors as the sole authored truth and derive
     their hashes. Use `recordsSchemaV1` source-history labels; hashes remain
     authoritative. Refuse table routing, renames, splits, merges, aggregation,
     and id changes.

2. **Structural records identity**
   - Current recommendation: no authored revision. Stored record meaning changes
     must alter a table, field, kind, enum, or reference. Document capabilities
     have their own derived format identity.
   - Falsifier: a real semantic change that cannot be made structurally visible.

3. **Document format addressing**
   - Current recommendation: include the full document format hash in the
     workspace-derived child-document address. This automatically fences stale
     binaries and makes format evolution independent of records succession.
   - Alternatives to challenge: a room-level immutable format marker, or a
     manual document-name change. Neither may silently permit incompatible
     writers in one Yjs room.

4. **Records migration surface proof**
   - The adjacent-chain API and bounded runner tests prove chain linearity,
     derived
     source-table totality, same-table routing, exact target cells, implicit
     descriptor-equal copy, explicit discard, runtime-owned ids, row omission,
     and descriptor-derived hashes.

5. **Superseded-source retention on the server** (resolved 2026-07-12)
   - Decision: version one retains the superseded canonical database but defers
     server-side export UI and automatic deletion. Local logical export remains
     the stated recovery surface. Measured storage cost may earn a separate
     cleanup policy later.

6. **Forgotten old-schema work** (resolved 2026-07-12)
   - Decision: the runtime retains it for logical export and it never rejoins
     automatically. Version one exposes logical export only. A later app-owned
     recovery service may consume that export when a concrete workflow earns
     it; this is not schema succession or a framework conflict-review product.

7. **Database authority topology**
   - Current recommendation: one principal/workspace authority with several
     logical databases partitioned by `database_id`, not one Durable Object per
     generation.
   - Falsifier: measured per-workspace storage or transaction limits that require
     physical generation separation.

8. **Canonical rich-text contract** (resolved 2026-07-12)
   - Decision: expose the honest `document.xmlFragment` capability until
     Epicenter owns a persisted node and mark vocabulary. Editor UI and its
     higher-level rich-text schema remain app-owned.

9. **Definition and succession ownership** (resolved 2026-07-12)
   - Decision: `define*` calls produce framework-owned immutable values.
     Historical endpoints are generated artifacts. Applications register the
     current definition and adjacent semantic transforms; the workspace
     lifecycle owns source snapshots, row execution, candidates, and
     activation. Equal-hash steps are invalid at `defineRecordsMigration`.

10. **Succession user contract** (resolved 2026-07-12)
    - Decision: local-only succession runs automatically. Synchronized
      succession requires approval because activation can exclude forgotten
      device work permanently. `Not now` closes the workspace in the current
      binary. Blocking counts are user-facing; row identities and validation
      reasons are technical details. Forgotten old local state is retained for
      logical export, not opened as an old-schema compatibility mode. Version
      one has no generic SQLite editor, repair UI, merge, or re-import path.

11. **Chat transcript storage** (direction resolved 2026-07-12)
    - Decision: keep the live turn in client state and store conversations and
      finished messages as complete-replica SQLite rows. The transcript port is
      asynchronous; the user message commits before inference and every
      completed assistant turn commits atomically. Explicit turn and step fields
      own causal ordering. Conversation deletion owns transactional cleanup of
      message rows.
    - Existing keyed Yjs rooms move through one app-owned cross-plane import,
      not records succession. Complete transcript replication is the accepted
      price for direct local query, search, retention, and export.
    - Falsifier: measured transcript volume makes a complete per-device replica
      untenable. Reopen chat retention or storage topology with that evidence;
      do not infer that mutable Yjs rooms are the replacement.

## Success criteria

- [ ] App definitions contain no epoch, root incarnation, or row-version API.
- [ ] Every definition is a framework-owned immutable value; mutating authored
  inputs after `define*` returns changes neither identity nor runtime behavior.
- [ ] Application migrations import committed generated historical endpoints;
  the renderer uses the generated-artifact subpath and the ordinary SQLite
  barrel does not export the historical constructor.
- [ ] Records migration definitions use only
  `defineRecordsMigration({ from, to, transform, discard })` and
  `defineRecordsMigrations(steps)` with implicit descriptor-equal copy.
- [ ] Records transforms cannot open child documents or external Yjs rooms;
  document conversion and cross-plane transfer remain explicit app operations.
- [x] A narrow historical-document reference lets explicit converter code
  address both the retained old room and the new declared room. It introduces
  no generic registry, scan, authority cutover, or conversion runner.
- [ ] Each records database accepts exactly one canonical records schema hash.
- [ ] The server stages and conditionally activates but never runs app migration
  code.
- [ ] Every source row validates against its historical descriptor before a
  transform runs; nonconforming rows block succession without changing A.
- [ ] Succession execution plumbing is internal; applications register current
  schema and adjacent transforms but never construct source scans, invoke row
  runners, upload candidates, or activate databases.
- [ ] Schema succession activates one complete target atomically.
- [ ] Activation succeeds only when the family still selects source A and A is
  still exactly at the snapshot head H.
- [ ] Ordinary writes recheck currentness and writability in the same
  transaction that folds and advances the database head.
- [ ] Candidate creation, chunks, sealing, activation retries, expiry, and
  cleanup follow the specified replay/conflict and serialization rules.
- [ ] Records succession authority state contains no device-participation or
  source-locking lifecycle.
- [ ] The runtime retains forgotten old-schema work for logical export, but it
  cannot automatically synchronize into the successor.
- [ ] Local-only succession is automatic; synchronized succession requires
  approval, and declining closes only that workspace.
- [ ] Recovery exports logical records. The current application does not open
  retained old schemas, and no generic SQLite editor or repair UI exists.
- [ ] Logical snapshots are the only portable records format.
- [ ] Browser, Bun, and Durable Object adapters pass one conformance suite.
- [ ] App call sites never author SQLite file paths, OPFS names, schema suffixes,
  or database-generation suffixes.
- [ ] Incompatible child-document formats cannot enter one Yjs room, and adding
  a document does not create a successor records database.
- [ ] Production apps use typed SQLite records, permanent KV, and lazy child docs.
- [ ] Chat persists conversations and finished messages as SQLite records; live
  turns remain client state and no chat transcript uses a keyed child document.
- [ ] The old Yjs records and migrate-on-read paths are unimported, verified, and deleted.
- [ ] Durable decisions are accepted, current facts are in reference docs, and this spec is deleted.

## References

- `docs/adr/0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md`
- `docs/adr/0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md`
- `docs/adr/0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md`
- `docs/adr/0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md`
- `docs/adr/0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md`
- `docs/adr/0124-workspace-kv-keeps-one-logical-identity-outside-the-record-database.md`
- `docs/adr/0125-record-schemas-are-immutable-evolution-creates-a-successor-database.md`
- `docs/adr/0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md`
- `docs/adr/0127-chat-streams-live-turns-in-client-state-and-stores-finished-messages-as-records.md`
- `demos/local-first-sync/gates/GATE1-EVIDENCE.md`
- `demos/local-first-sync/gates/GATE2-EVIDENCE.md`
- `demos/local-first-sync/gates/GATE3-EVIDENCE.md`
- `demos/local-first-sync/gates/GATE4-EVIDENCE.md`
- `demos/local-first-sync/gates/GATE5-EVIDENCE.md`
- `demos/local-first-sync/gates/GATE6-EVIDENCE.md`
- `packages/workspace/src/sqlite/definition.ts`
- `packages/workspace/src/sqlite/database.ts`
- `packages/workspace/src/sqlite/replica.ts`
