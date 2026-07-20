# One Epicenter clean break

**Date**: 2026-07-19
**Status**: Draft
**Owner**: Epicenter workspace, server, desktop, and portability boundaries
**Branch**: `codex/epicenter-architecture-freeze`
**Supersedes**: `20260717T120000-workspace-root-cleanup.md`,
`20260717T212450-two-plane-row-document-runtime.md`, and
`20260719T180000-app-owned-workspace-lenses-clean-break.md`

## One Sentence

A principal owns one portable Epicenter of current rows, typed key-values, lazy
row documents, and immutable blobs; trusted applications interpret it through
release-local lenses, and devices edit durable local replicas that converge
through the principal's server.

## Decision Owners

- [ADR-0160](../docs/adr/0160-one-principal-owns-exactly-one-epicenter.md): one principal, one Epicenter.
- [ADR-0161](../docs/adr/0161-each-local-owner-persists-one-sqlite-database-and-one-blob-directory.md): selected-owner local layout.
- [ADR-0162](../docs/adr/0162-portability-is-a-frozen-editable-projection-of-one-selected-owner.md): portable-v1 artifact format.
- [ADR-0163](../docs/adr/0163-read-only-sql-exposes-only-the-schema-opaque-rows-relation.md): protected local SQL relation.
- [ADR-0164](../docs/adr/0164-accepted-membership-gates-immutable-s3-blobs.md): accepted blob authority.
- [ADR-0165](../docs/adr/0165-export-captures-the-complete-durable-state-of-one-selected-owner.md): selected-owner export completeness.
- [ADR-0166](../docs/adr/0166-import-initializes-an-empty-owner-or-explicitly-replaces-the-whole-owner.md): empty initialization and whole-owner replacement.
- [ADR-0167](../docs/adr/0167-row-documents-persist-as-one-compact-baseline-plus-a-bounded-tail.md): bounded Yjs persistence.
- [ADR-0168](../docs/adr/0168-a-row-document-update-leaves-its-owner-only-after-persistence-commits.md): durability-gated publication.
- [ADR-0169](../docs/adr/0169-scalar-convergence-retains-one-bounded-deletion-and-retry-horizon.md): bounded scalar deletion and retry horizon.
- [ADR-0170](../docs/adr/0170-scalar-settlement-is-a-lower-bound-result.md): scalar-only Result settlement.
- [ADR-0171](../docs/adr/0171-tables-mutate-rows-through-create-update-and-delete.md): row mutation vocabulary.
- [ADR-0172](../docs/adr/0172-applications-interpret-the-selected-epicenter-through-identity-free-lenses.md): identity-free application lenses.
- [ADR-0173](../docs/adr/0173-remote-blob-transfer-is-explicit-create-only-and-one-shot.md): explicit one-shot remote blob transfer.
- [ADR-0174](../docs/adr/0174-applications-own-row-and-blob-aggregate-deletion.md): application-owned row-and-blob aggregate deletion.
- [ADR-0175](../docs/adr/0175-one-epicenter-durable-object-owns-one-principals-accepted-state.md): one surviving hosted owner actor.
- [ADR-0176](../docs/adr/0176-the-hosted-product-lives-in-apps-hosted-and-deploys-as-epicenter.md): hosted deployable and Worker names.
- [ADR-0177](../docs/adr/0177-the-generic-room-actor-is-withdrawn.md): generic Room withdrawal after its clients leave.
- [ADR-0178](../docs/adr/0178-live-remote-home-control-is-deferred-until-it-has-a-shipped-workflow.md): unshipped AttachRelay withdrawal.
- [ADR-0179](../docs/adr/0179-owner-data-routes-are-id-free-and-specific-to-each-synchronization-plane.md): final owner-data routes.
- [ADR-0180](../docs/adr/0180-home-conversations-belong-to-the-selected-epicenter.md): selected-owner Home conversation data.
- [ADR-0181](../docs/adr/0181-owner-selection-is-the-boot-and-storage-decision.md): boot-time owner selection.
- [ADR-0182](../docs/adr/0182-background-scalar-synchronization-owns-retries-and-reactive-status.md): background scalar retry and status ownership.
- [ADR-0144](../docs/adr/0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md): retained independent synchronization planes.
- [ADR-0146](../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): retained Yjs 14 V2 and compound bound.

## How to read this spec

Read first:

```txt
One Sentence
Recognition Criteria
Current State
Target Shape
Execution Spine
Verification
```

Read when changing architecture:

```txt
Product Vocabulary
Public API
Scalar Synchronization
SQL Contract
Row Documents
Blobs
Portable Artifact
Hard Constraints and Refusals
ADR Dependency Ledger
```

This is the implementation spine for the explicitly accepted destination. The
ADRs own the durable decisions. This spec owns dependency order, proof gates,
and deletion. It does not authorize a compatibility layer or a second product
mode.

## Recognition Criteria

- One authenticated principal or explicit local selection resolves one
  Epicenter. No `WorkspaceId`, workspace catalog, picker, directory, route
  parameter, authority dimension, or app-declared workspace inventory remains.
- Hosted accepted state lives in `EpicenterDurableObject` through the
  `EPICENTERS` namespace. Authority is a protocol role, not a public aggregate
  or account noun.
- Generic Room and AttachRelay actors, bindings, routes, clients, and runtime
  composition are absent. Durable collaboration uses row documents; live
  remote Home control is deferred until it has a complete shipped workflow.
- One selected local owner persists `epicenter.sqlite3` plus `blobs/`; account
  roots are keyed by opaque `AccountKey`; no `account.json` or device-global
  blob directory remains.
- Applications pass identity-free release-local lenses. Several lenses can
  interpret one selected owner concurrently without opening storage twice.
- Table mutations are exactly `create`, sparse absolute `update`, and `delete`.
  Live creation always mints a fresh row ID.
- Read-only SQL exposes only
  `rows(table_key, row_id, fields_json)`, performs no full-dataset refresh, and
  never performs hidden synchronization.
- Scalar conflict resolution remains authority acceptance order. Pull
  checkpoints are lower bounds, not exact historical snapshots.
- Scalar deletion markers and exact-retry state are bounded. A replica below
  the retention floor cannot upload until it exports or discards local salvage
  and reinitializes.
- `sync.settle()` returns `Result<void, SyncSettleError>`, covers only scalar
  state through one captured lower bound, and exposes `retrying` only through
  reactive status.
- Each row document persists as one compact Yjs 14 V2 baseline plus a bounded
  V2 tail. Local persistence commits before publication; authority persistence
  commits before broadcast.
- Remote blob truth is private authority membership, never object presence,
  row citations, `uploadedAt`, or application schema. Upload is one create-only
  PUT with signed `If-None-Match: *`, followed by confirmation.
- Blob purge revokes authority membership first, then attempts physical delete
  synchronously. Retry and sweep remove inaccessible residue.
- Portable v1 is a freshly projected editable directory containing one public
  SQLite schema plus ordinary blob files. A ZIP is transport only.
- Local export contains exactly that local owner's durable state. Server export
  contains exactly server-accepted state. Neither coordinates all devices.
- Import only initializes an empty owner or explicitly replaces a whole owner
  generation after complete staging and rollback export. There is no merge or
  writeback.

## Current State

The branch already proves several useful kernels, but they are arranged around
the old Workspace noun.

### Local runtime

`packages/workspace/src/sqlite/` has schema-opaque scalar owners, typed caller
views, owner-side SQLite row-document logs, browser Worker ownership, desktop
transport, and automatic scalar synchronization. It still keys owners, paths,
leases, API values, and transports by `WorkspaceId`. The selected owner is
therefore a map of workspaces rather than one Epicenter.

The previous app-lens clean break moved lens validation into calling JavaScript
and completed the schema-opaque browser and desktop transports. Preserve that
work. Delete only the ID-owned plurality and the stale `Workspace` nouns.

### SQL

The current public relation is `records`. Synchronized queries materialize the
complete visible overlay before running SQL. That proves query semantics but
violates the target performance contract. The replacement must make setup cost
independent of total owner size and expose only `rows`.

### Server authority

`packages/server/src/workspace-authority/` already composes one Durable Object
per principal and one authority SQLite database, but scalar and document tables
still carry `workspace_id`. Routes still address
`/api/workspaces/:workspaceId/...`. Current scalar receipts are permanent and
old replicas automatically acquire current state even after their deletion
history disappeared.

### Row documents

The Yjs 14 V2 provider, compound byte/struct bound, owner-side SQLite log,
liveness-gated append, real `gc: true` compaction, state-vector repair, and
commit-before-server-broadcast are valuable and survive. Two gaps remain:

1. The client network listener may send before the asynchronous local append
   completes.
2. A legal V2 candidate may exceed Durable Object SQLite's 2,000,000-byte row
   limit even though its resulting canonical state is at most 1 MiB.

### Blobs

The S3 client already uses SigV4 over ordinary fetch and signs
`If-None-Match: *`, so it has the right shape for a narrow conformance seam.
Current server correctness still treats bucket presence as truth and has no
confirm step or accepted inventory. Local desktop blobs still live in one
device-global `<AppData>/blobs` directory.

Whispering already owns recording row and audio consistency through one domain
namespace. Local recording completion is independent of explicit remote
upload, `RecordingId` differs from `BlobId`, and `uploadedAt` is historical UI
evidence only. Preserve those aggregate lessons while replacing remote
acceptance truth.

### Portability

`LogicalWorkspaceCopy` and Device Add coordinate logical rows and documents but
are not a supported public artifact. They omit a frozen SQLite schema, complete
blob package, format version, integrity validation, editable return path, and
whole-owner generation replacement.

## Target Shape

### Ownership

```txt
Deployment
  Principal
    Epicenter
      rows
      typed KV
      lazy row documents
      immutable blobs

Selected local owner
  private SQLite + private blobs + optional replica state

Trusted application
  identity-free release-local lens over selected owner
```

Hosted auth resolves the principal. Self-host resolves valid bearers to the
literal `instance` principal. Local mode selects an independent local owner.
Projects, folders, notebooks, recording collections, and other divisions are
application rows.

### Local layout

```txt
<AppData>/
  epicenters/
    local/
      epicenter.sqlite3
      blobs/
    accounts/
      <AccountKey>/
        epicenter.sqlite3
        blobs/
```

Yjs document bytes always live in SQLite. Media and attachments always live in
the owner blob backend. The boundary is semantic, not a byte threshold.

### Server authority

```txt
principal authority SQLite
  owner generation and scalar head/floor
  current scalar rows and typed KV
  bounded changed-address and deletion feed
  bounded exact-retry receipts
  compact document baselines + bounded V2 tails
  blob upload grants + accepted blob membership

S3-compatible object store
  immutable owner-relative bytes only
```

The authority contains no application lenses, media bytes, filenames, blob
digests, citations, refcounts, permanent row tombstones, permanent replica
registry, or artifact lineage.

## Product Vocabulary

| Noun | Exact meaning |
| --- | --- |
| Deployment | One reachable hosted or self-hosted Epicenter installation. |
| Principal | The authenticated partition key. Self-host uses `instance`. |
| Owner | The selected local Epicenter or one principal's server Epicenter. |
| Epicenter | One owner's rows, typed KV, row documents, and immutable blobs. |
| Replica | One private local durable view and its bounded sync state. |
| Lens | An identity-free release-local typed interpretation in trusted app code. |
| Row | One generated ID under a permanent table key with schema-opaque scalar fields. |
| Row document | One latent Yjs 14 document whose lifetime is owned by a row. |
| Blob | Immutable owner-scoped bytes addressed by opaque `BlobId`. |
| Portable artifact | A detached frozen public SQLite projection plus ordinary blob files. |
| Authority | Internal server coordination that orders scalars, persists documents, and accepts blobs. |

`Workspace`, `WorkspaceId`, workspace store, workspace authority, provider app,
and installed-app workspace inventory leave the target vocabulary.

## Public API

The selected owner is already fixed when an application opens its lens:

```ts
const lens = defineEpicenter({
  tables: { notes },
  kv: settings,
});

using epicenter = await runtime.open(lens);

const note = await epicenter.tables.notes.create({ title: 'Hello' });
const updated = await epicenter.tables.notes.update(note.id, {
  title: 'Hello again',
});

using document = await epicenter.tables.notes.document.open(note.id);

const titles = await epicenter.sql(
  `SELECT row_id, json_extract(fields_json, '$.title') AS title
   FROM rows
   WHERE table_key = ?`,
  ['notes'],
  resultSchema,
);

const settlement = await epicenter.sync?.settle();
await epicenter.tables.notes.delete(note.id);
```

`create` validates complete declared fields and returns the locally visible row
with a generated ID. `update` validates only supplied values and applies
absolute sparse assignments; `undefined` unsets an optional key. `delete` ends
the scalar and latent document lifetime, but never infers blob ownership.

The ideal product composition binds the selected owner's blob capabilities once
beside tables, KV, SQL, and optional sync. It does not construct per-call
dependency bags. Keep the MIT structured-state layer independent of the AGPL
blob implementation: the AGPL application or host composition may expose the
cohesive product handle without moving blob policy into `@epicenter/workspace`.

A local-only owner exposes `sync: null`. It does not fabricate a successful
remote settlement implementation.

## Scalar Synchronization

- Scalar changes resolve by server acceptance order. Different-field changes
  compose; later accepted same-field assignment wins.
- Local writes are durable and immediately visible without waiting for network.
- One compactable open mutation generation and one sealed exact-retry image are
  sufficient. The replacement wire uses bounded mutation identity and base
  sequence, not permanent replica enrollment and round identity.
- Push acceptance is atomic for one batch. Remote installation is row-atomic,
  not batch-atomic. Cross-row remote atomicity is not promised.
- Pull pages changed addresses toward a fixed head and joins them to current
  postimages. A scalar row newer than the head may arrive early, so the pull
  checkpoint is a lower bound, never an exact historical snapshot.
- The authority retains a bounded changed-address/deletion feed and bounded
  exact-retry receipts. Replicas cannot pin the retention floor.
- A mutation whose pinned accepted base predates the floor is refused before
  folding. The replica offers selected-owner salvage export, then reinitializes
  or explicitly discards local state.
- Generated row IDs are never intentionally reused. No permanent tombstone or
  eternal identity registry remains.

`sync.settle()` captures its scalar admission cut synchronously. It succeeds
only after mutations through that cut are accepted and authority state is
installed through the resulting lower bound. Later work cannot extend the cut.
It never means global quiescence, exact snapshot, document settlement, blob
settlement, or all-device settlement.

## SQL Contract

```sql
rows(
  table_key   TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  fields_json TEXT NOT NULL
)
```

The relation presents current locally visible ordinary rows, including durable
optimistic scalar work. It excludes KV and every private relation. SQL is
read-only and sees one stable local SQLite transaction. It performs no network
work and may observe mixed remote acceptance times across rows.

The executor permits `SELECT` and `WITH`, bound parameters, scalar JSON
functions, CTEs, joins, grouping, and aggregation. It rejects writes, DDL,
`ATTACH`, private relations, mutating or private-layout pragmas, and virtual
table opens. The platform installs no lens-shaped TEMP views. The result schema
stays in the caller realm.

The private representation is evidence-dominated. It may be durable optimistic
rows with dirty shadows, an incrementally maintained visible relation, or
another design, but one query must perform zero whole-owner refresh writes or
full-dataset copies.

## Row Documents

- One lazy Yjs 14 document belongs to each live ordinary row.
- Persistence and wire use only pinned `@y/y` V2 encodings.
- Durable state is one compact baseline plus a bounded incremental tail. The
  tail is a write buffer, not history.
- Real compaction hydrates a fresh `gc: true` document and re-encodes it.
  `mergeUpdatesV2` alone is not compaction.
- The canonical server bound remains 1,048,576 encoded bytes and 131,072
  structs. Local durability and export remain available after server fullness.
- A legal candidate too large for one Durable Object SQLite row is written as
  the already-computed legal canonical baseline, not split into a new chunk
  protocol.
- Every local outbound update-bearing frame waits for its persistence cut.
  Every server broadcast waits for authority commit.
- State-vector exchange repairs missed broadcasts and old peers after
  compaction. GC preserves CRDT identity ranges but not deleted payload history.
- Row deletion removes local and server document state through the scalar row
  lifecycle. Documents do not own blob slots.
- Documents expose local `whenDurable()` and reactive connection state. They do
  not expose remote settlement, durable receiver acknowledgments, or dormant
  discovery.

## Blobs

### Local

Each owner has an internally enumerable canonical blob backend. Applications
address immutable bytes only by opaque `BlobId`; there is no public list.
Remote transfer is explicit and one-shot. Local recording completion never
waits for or schedules remote upload.

### Server

```txt
owner_state(active_generation)
blob_upload_grants(generation, blob_id, confirm_until)
accepted_blobs(generation, blob_id)
```

`begin` writes a grant before issuing a short presigned create-only PUT. The URL
signs `If-None-Match: *`. `confirm` requires the live grant, performs HEAD,
enforces the maximum, and atomically moves the ID into accepted membership.
Reads and export require accepted membership.

Physical keys derive from `(owner, generation, BlobId)`. Replacement may stage
the same logical BlobId under a new generation without overwriting live bytes,
then make the new membership authoritative through one active-generation flip.

Purge removes grant and accepted membership first, then attempts object delete
synchronously. It still attempts the derived-key delete on an idempotent retry
after membership is absent. A stale PUT can create only inaccessible residue;
the private sweep removes objects outside accepted membership and unexpired
grants. Authority maintenance also prunes expired grant rows. A short GET URL
already issued may remain usable until expiry if physical deletion is
interrupted.

Live correctness stores no size, type, digest, filename, citation, row owner,
refcount, or deletion tombstone. HEAD supplies size and type. Artifact export
computes its own digest.

The required object-store subset is SigV4 `PutObject` with signed
`If-None-Match: *`, `HeadObject`, `GetObject`, `DeleteObject`, and private
`ListObjectsV2`. Hosted and self-host use this same S3-compatible seam. V1
refuses multipart/resumable upload and blobs over 5 GiB.

Whispering's recording aggregate remains the only complete recording deletion
path: remote audio, local audio, then row. Raw row deletion cannot stand in for
aggregate cleanup. `uploadedAt` remains historical app evidence, never accepted
membership.

## Portable Artifact

### Envelope

```txt
My Epicenter.epicenter/
  epicenter.sqlite3
  blobs/
    <BlobId>
```

The directory is canonical. A ZIP is only transport encoding and must reject
path traversal, duplicate entries, and decompression limit violations.

Portable v1 uses SQLite `application_id` and `user_version`. Its public logical
schema is:

```sql
rows(
  table_key TEXT NOT NULL,
  row_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  PRIMARY KEY (table_key, row_id)
);

kv(
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

documents(
  table_key TEXT NOT NULL,
  row_id TEXT NOT NULL,
  state_v2 BLOB NOT NULL,
  PRIMARY KEY (table_key, row_id)
);

blob_manifest(
  blob_id TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  content_type TEXT,
  sha256 TEXT NOT NULL
);
```

Blob file paths derive exactly as `blobs/<BlobId>`. The manifest and directory
must be a bijection. SHA-256 is lowercase hex over the artifact bytes. The
format ships with a version-pinned reference reader and Yjs editor.

### Export cuts

- Local export includes the selected local owner's durable rows, KV, documents,
  unreferenced blobs, never-uploaded blobs, and device-only document edits.
- Server export includes exactly accepted scalar, document, and blob state. It
  excludes local overlays, upload grants, orphans, never-uploaded blobs, and
  device-only document edits.
- Export publishes nothing until every selected-owner entry validates. Missing
  accepted bytes fail loudly.
- Export coordinates no other device and does not settle documents or blobs.

### Editing and import

Artifacts are formally editable with ordinary SQLite tools, pinned Yjs tooling,
and manifest-aware blob replacement. Import validates version, schema, JSON,
addresses, Yjs bytes, manifest bijection, sizes, and digests completely in
staging.

Default import initializes only an empty owner. Explicit whole-owner replacement
first emits a rollback artifact, stages the candidate, atomically activates a
new owner generation, and forces every old replica through salvage export and
reinitialization. Import never merges, writes back, stays linked, preserves sync
lineage, or silently replaces a nonempty owner.

## Hard Constraints and Refusals

| Refusal | Concrete user loss | Complexity deleted |
| --- | --- | --- |
| No platform workspaces | One principal cannot keep several isolated platform stores. | IDs, catalogs, routes, directories, authority dimensions, pickers, app ownership. |
| No cross-row remote atomicity | A peer may observe rows from one accepted batch at different times. | Commit history, snapshot sessions, exact checkpoint promotion, transaction wire. |
| Bounded offline horizon | An indefinitely offline device may need manual salvage and reset. | Permanent tombstones, eternal replica registry and receipts, unbounded deletion feed. |
| Scalar-only settlement | Callers cannot prove every document or blob reached every device. | Document acknowledgments, dormant discovery, blob outboxes, all-device barriers. |
| One-shot blobs up to 5 GiB | Failed large uploads restart; larger blobs are refused. | Multipart IDs, parts, ETags, URL renewal, completion, abort, resume persistence, provider matrix. |
| Selected-owner export | One artifact may omit valuable state held only by another device. | Online device census, forced flush, distributed export coordination. |
| No import merge | Edited artifacts cannot patch a live nonempty owner. | Generic row conflict, Yjs import merge, blob reconciliation, partial rollback. |
| No automatic blob sync | Remote availability is an explicit product operation. | Retry queues, transfer ledgers, automatic download, retention tombstones. |
| No lens TEMP views | SQL callers write JSON extraction and CTEs themselves. | View registration, connection identity, collision and cleanup lifecycle. |
| No blob reachability graph | Deleting a blob can break application references. | Schema inspection, refcounts, citations registry, dormant-document scans. |

Also refused: partial replication, query subscriptions, permission-aware
fanout, scalar history, per-field causal clocks, event sourcing, SQLite
WAL/page/session replication, reactive SQL automation, all-device discovery,
automatic sign-in merge, compatibility aliases, and hidden fallback readers.

## ADR Dependency Ledger

### Proposed successors

- ADR-0160 replaces principal-owned workspace plurality in ADR-0145 and amends
  ADR-0152 so Home remains a storage-free shell while conversations follow the
  selected owner.
- ADR-0161 replaces connection/workspace boot layout in ADR-0094 and ADR-0151,
  and narrows ADR-0159's file owner to one selected Epicenter.
- ADR-0162 replaces ADR-0122's logical-copy portability with the frozen public
  artifact.
- ADR-0163 replaces proposed ADR-0157 and the `records` relation.
- ADR-0164 replaces ADR-0091 and ADR-0154 with private accepted membership and
  public address-only access.
- ADR-0165, ADR-0166, and ADR-0169 collectively replace proposed ADR-0147's
  export, import, and stale-recovery contract.
- ADR-0166 also replaces ADR-0143's Device Add model with empty initialization
  or whole-owner replacement.
- ADR-0167 and ADR-0168 amend ADR-0144, ADR-0146, and ADR-0159 without replacing
  their independent planes, Yjs 14 V2, owner-side SQLite, liveness, or GC.
- ADR-0169 replaces ADR-0141 and ADR-0142's permanent identity and indefinite
  automatic rebuilding.
- ADR-0170 replaces ADR-0140's settlement outcome family.
- ADR-0171 freezes `create`, `update`, and `delete`.
- ADR-0172 replaces proposed ADR-0156 and proposed ADR-0158 with identity-free
  lenses and no installed-app store inventory. It amends ADR-0130's definition
  identity; ADR-0132, ADR-0135, ADR-0160, ADR-0169, and ADR-0171 own the other
  retained or replaced invariants.
- ADR-0173 replaces ADR-0089 and ADR-0149 with explicit create-only one-shot
  transfer over the conforming S3 subset.
- ADR-0174 makes application aggregates, not platform reachability, own
  row-and-blob deletion workflows.

### Decisions retained

Retain ADR-0066's per-concern portability, ADR-0090's blob confidentiality
boundary, ADR-0092's principal partition, ADR-0120's presence semantics,
ADR-0121's authority-order scalar conflicts, ADR-0125's non-migrating lenses,
ADR-0132's typed KV product surface, ADR-0135's application-owned Yjs roots,
ADR-0137's eventual physical allowance, ADR-0144's two synchronization planes,
ADR-0146's Yjs 14 V2 and compound bound, ADR-0148's opaque BlobId, ADR-0150's
Whispering plaintext choice, ADR-0153's trusted static apps, and ADR-0159's
owner-side document durability and liveness transaction.

Accepted predecessors remain current behavior until their replacement waves
land. At that production flip, mark them Superseded and promote the implemented
successors from Proposed to Accepted. Abandoned Proposed ADRs 0145, 0147, 0156,
0157, and 0158 are superseded immediately.

## Evidence-Dominated Implementation Hypotheses

These choices may change under measurement without weakening a product promise:

1. Visible scalar storage may use optimistic rows plus dirty-address shadows or
   another incremental representation. Prototype crash/rebase transitions and
   benchmark before choosing.
2. A bounded scalar mutation can use
   `{ mutationId, baseSequence, digest, intents }`; prove exact retry, base
   pinning under compaction, and receipt pruning before freezing the wire.
3. Baseline/tail count and byte compaction thresholds are implementation values.
4. The protected SQL relation may be a private table, view, or isolated
   connection if it passes the same access and zero-refresh proofs.
5. Authority export may hold a SQLite read transaction, copy to staging, or
   retry an owner generation. It must never publish a mixed or partial cut.
6. Whole-owner local activation may use directory rename or a host-specific
   atomic pointer. Failure injection decides the mechanism.
7. The AGPL artifact owner should be a shared package such as
   `packages/artifact`; do not place whole-artifact orchestration in MIT
   `packages/workspace`.

## Execution Spine

Each wave follows build, stop importing, prove, remove. A rollback point is the
last complete commit before stop-importing. Do not retain old and new product
modes after a wave's proof gate.

The repository work lands as a stack over one clean integration branch. Each
actor or ownership boundary remains a standalone PR, while the integration
branch absorbs them in dependency order before one final merge into the active
SQLite architecture branch.

### Wave A: remove the unshipped AttachRelay family

Build:

- Record the supersession of ADR-0115 and preserve ordinary synchronized Home
  conversation history.

Stop importing:

- Remove AttachRelay from hosted and self-hosted composition, Worker exports,
  bindings, device grants, host discovery, desktop scripts, and package barrels.
- Leave the implementation files on disk for the rollback checkpoint.

Prove:

- Hosted, self-hosted, scalar, and row-document paths pass without AttachRelay.
- No shipped UI or desktop composition imports the host or client adapter.

Remove:

- Delete the AttachRelay server family, desktop proof adapters, tests, smoke
  script, unfinished discovery spec, and obsolete WebSocket composition code.
- Append a new Cloudflare migration that deletes the class. Never rewrite its
  historical creation migration.

### Wave B: retire every generic Room producer and actor

Build:

- Move any surviving product behavior to row-owned Yjs 14 documents.

Stop importing:

- Remove or migrate the legacy Yjs 13 workspace producers, including Tab
  Manager and Opensidian mounts, before changing the server route.
- Stop hosted and self-hosted deployments from mounting `/api/rooms/:roomId`.

Prove:

- Every remaining product document opens through its table key and row ID.
- Hosted and self-hosted document smokes pass with no generic Room route.

Remove:

- Delete the Room actor, both backends, registry, update logs, route, bindings,
  migrations, package exports, dependencies, tests, and documentation.
- Append a new Cloudflare migration that deletes the class. Never allocate the
  Room and Epicenter class migration tags on parallel branches.

### Wave 0: establish proof harnesses

Build:

- Add a scalar storage model/prototype for dirty shadows, remote rebase,
  acceptance, deletion, acquisition, and crash/reopen transitions.
- Add SQL setup benchmarks at 1k, 10k, and 100k rows.
- Add an S3 conformance harness for signed create-only PUT, HEAD, GET, delete,
  and paginated listing.
- Add portable-v1 malformed fixtures and an independent reference reader.
- Add Yjs persistence-publication and Durable Object row-wall regression tests.

Stop importing:

- None. These are evidence harnesses, not production modes.

Prove:

- Select the scalar private representation with crash and benchmark evidence.
- Prove R2 and the supported self-host S3 target satisfy the narrow object seam.
- Prove old Yjs peers converge after hydrated GC compaction.

Remove:

- Discard losing prototypes. Keep only conformance and regression harnesses.

### Wave 1: build the ID-free selected-owner runtime

Build:

- Add the identity-free Epicenter lens and one selected raw owner under
  `packages/workspace/src/sqlite/`.
- Make browser, Bun, and desktop compositions select `local` or one opaque
  `AccountKey` before opening lenses.
- Bind cohesive table, KV, SQL, document, sync, and host-owned blob capabilities
  once at construction without per-call dependency bags.
- Install the owner layout under `epicenters/` and bind browser storage to the
  same semantic owner model.

Stop importing:

- Move application call sites from `WorkspaceLens.id`, `Workspace`, and
  per-workspace owner factories to the selected Epicenter API.
- Stop reading installed-app workspace declarations and desktop allowlists.

Prove:

- Two distinct lenses concurrently interpret one owner without duplicate
  storage or lifecycle displacement.
- Local and two account owners remain disjoint across restart and selection.
- Offline known-account open remains usable; logout does not redirect writes to
  local.
- No plaintext account identity or `account.json` appears under AppData.

Remove:

- `WorkspaceLens.id`, `WorkspaceOwnerFactory(workspaceId)`, per-workspace maps,
  paths, leases, desktop allowlists, `BUILT_IN_WORKSPACE_IDS`, `account.json`, and
  installed-app workspace metadata.

Primary paths: `packages/workspace/src/sqlite/{workspace-lens,runtime,bun-runtime,browser-runtime,browser-runtime-worker,desktop-owner,desktop-runtime,account-runtime,local-workspace-storage}.ts`
and `apps/epicenter/src/{main,server,workspace-owner}.ts`.

### Wave 2: replace the SQL relation

Build:

- Implement `rows` directly over the chosen incremental visible-state
  representation.
- Add structural read-only authorization and keep result validation in the
  caller realm.

Stop importing:

- Rewrite every SQL caller and fixture from `records` to `rows`.

Prove:

- Filtering, CTEs, joins, grouping, aggregation, and scalar JSON work.
- Writes, DDL, `ATTACH`, private tables, unsafe pragmas, and virtual opens fail.
- Query setup performs zero full-dataset copies or refresh writes at all
  benchmark sizes.

Remove:

- `installRecordsRelation`, the TEMP `records` table, pre-query overlay refresh,
  `records` aliases, and unused lens-view helpers.

Primary path: `packages/workspace/src/sqlite/canonical-store.ts` and all runtime
SQL transports/tests.

### Wave 3: collapse server ownership to one Epicenter

Build:

- Remove `workspace_id` from authority schema and operations.
- Rename the surviving Cloudflare actor to `EpicenterDurableObject`, bind it as
  `EPICENTERS`, and keep authority as a descriptive protocol role.
- Collapse scalar routes to `/api/rows/{push,pull,acquire}` and row-document
  sockets to `/api/tables/:tableKey/rows/:rowId/document`.
- Keep hosted/self-host differences at principal resolution and injected
  storage only.

Stop importing:

- Move clients, constants, hosted storage service, self-host, and tests off
  `/api/workspaces/:workspaceId/...`.

Prove:

- Hosted principals remain isolated; self-host `instance` sees one Epicenter.
- Scalar and document conformance passes without a caller-selectable second
  authority.
- Whole-owner delete closes document connections and removes authority state.
- Only `EpicenterDurableObject` remains in the hosted actor inventory.

Remove:

- Workspace route patterns, parameters, schema columns, compound keys,
  factories, storage observations, and account workspace enumeration.

Primary paths: `packages/server/src/{workspace-authority,records,document-hub,routes,db}`,
`apps/api/worker/storage/`, and `apps/self-host/`.

### Wave 4: make document durability explicit and bounded

Build:

- Refine `sqlite-document-log.ts` and server document storage into explicit
  baseline and tail state.
- Add count/byte compaction, canonical-baseline fallback near the DO row wall,
  and one persistence/publication coordinator across runtime and connection.

Stop importing:

- Route every Yjs 14 row-document owner through the baseline/tail store and
  durability gate.

Prove:

- Baseline plus tail reopens to identical content and state vector.
- Count and byte compaction preserve state; old peers repair after deleted
  payload GC.
- Failed local append emits no update-bearing frame and successors cannot
  leapfrog it.
- Failed authority append broadcasts nothing.
- A legal candidate above the tail-row budget stores the baseline fallback.

Remove:

- Tail-as-history assertions, legacy Yjs 13 room/provider paths after their last
  consumers move, `y-indexeddb`, its patch, and obsolete persistence listeners.

Focused proof: `bun test packages/sync/src/document-v3 packages/server/src/document-hub packages/server/src/workspace-authority/document-store.test.ts packages/workspace/src/document-provider`.

### Wave 5: add accepted blob authority

Build:

- Add grants and accepted membership to the principal authority contract and
  both Cloudflare/Bun implementations.
- Extend the S3 seam with metadata HEAD and confirmation-aware coordination.
- Add begin, confirm, accepted-gated GET, membership-first purge, expiry, and
  private orphan sweep.
- Scope grants, accepted membership, and physical keys by owner generation;
  prune expired grant rows as well as their orphan objects.
- Move local blob backends into selected-owner roots and expose private export
  enumeration without widening the public BlobStore.

Stop importing:

- Change client upload to ticket, one PUT, confirm. Stop treating object
  presence or `uploadedAt` as remote truth.

Prove:

- Concurrent begin on one ID, begin after acceptance, duplicate begin,
  confirm-after-expiry, confirm/purge races, stale PUT after purge, lost
  responses, missing accepted bytes, and idempotent delete retry all fail
  closed.
- Expired grant rows and their objects are both pruned.
- Signed `If-None-Match: *` prevents overwrite on every supported provider.
- Public enumeration remains absent.
- Whispering upload stays explicit and recording deletion owns remote bytes,
  local bytes, then row.

Remove:

- Bucket-only acceptance, citation inventory, device-global blobs, content-hash
  assumptions, any automatic transfer queue, and stale marker-as-truth tests.

Primary paths: `packages/server/src/{s3-blob-store,workspace-authority,routes/blobs}.ts`,
`packages/server/src/records/`, `packages/client/src/index.ts`,
`packages/blobs/src/`, `packages/constants/src/api-routes.ts`, hosted account
deletion, and Whispering recording tests.

### Wave 6: build portable v1 in an AGPL artifact owner

Build:

- Add `packages/artifact` as AGPL with the public SQLite schema, directory/ZIP
  codec, version pin, reference reader, validation, staging, and blob manifest.
- Inject logical structured-state and owner-blob readers rather than copying
  AGPL blob policy into MIT `packages/workspace`.

Stop importing:

- Route every new export/import implementation through the one codec and
  validator.

Prove:

- Exact round trip for rows, KV, documents, and blobs.
- Direct row/KV edits, pinned Yjs edits, and manifest-aware blob replacement
  import successfully.
- Invalid version, schema, JSON, Yjs state, duplicate addresses, missing/extra
  files, size mismatch, digest mismatch, ZIP traversal, and decompression limits
  leave destination staging unpublished.
- `bun run check:licenses` keeps the MIT closure clean.

Remove:

- Ad hoc logical-copy encoders, private SQLite copying, and any second artifact
  schema.

### Wave 7: wire selected-owner export and generation replacement

Build:

- Give the local owner one export barrier shared by scalar/KV commits, document
  appends, blob finalization, and blob purge. Hold it until the SQLite snapshot
  and independent staged blob copies are secured.
- Server export snapshots accepted scalar/document/blob inventory and streams
  every accepted object into staging.
- Empty initialization atomically installs a staged artifact.
- Whole-owner replacement first writes rollback export, stages scalar,
  document, and generation-keyed blob state fully, atomically flips the active
  owner generation, closes old-generation document sockets, and later sweeps
  inactive physical state.

Stop importing:

- Move recovery, CLI, desktop, hosted, and self-host flows off
  `LogicalWorkspaceCopy`, Device Add, and app-specific export structures.

Prove:

- Local export includes dormant durable documents, unreferenced and
  never-uploaded blobs, and device-only edits.
- Native recording finalization, local blob purge, scalar commit, and document
  append concurrent with local export produce one valid cut or a clean retry,
  never a mixed SQLite/blob artifact.
- Server export excludes pending blobs, orphans, never-uploaded blobs, local
  scalar overlays, and device-only documents.
- Concurrent upload, purge, or owner replacement yields one valid artifact or a
  clean failure, never silent omission.
- Default import into nonempty owner is no-op failure. Failure injection at
  every staging/copy/activation boundary preserves the current owner.
- Replacement stages artifact BlobIds already present in the old generation
  without overwrite or collision.
- Old-generation replicas cannot upload or resurrect prior rows. Document
  handshakes and frames carry the generation, old sockets close at activation,
  and delayed old-generation frames cannot merge into the new documents.
- Rollback artifact restores exact pre-replacement state.

Remove:

- `LogicalWorkspaceCopy`, `LogicalWorkspaceExport`, Device Add/merge/delete
  migration intents, missing-document omission semantics, lineage continuation,
  and import modes that partially accept or repair.

Primary obsolete center: `packages/workspace/src/sqlite/canonical-addition.ts`.

### Wave 8: bound scalar history and replace settlement

Build:

- Replace permanent replica rounds with bounded mutation identity/base semantics
  in `packages/row-sync` and the authority.
- Advance and compact the retention floor, deletion markers, and retry receipts.
- Stop below-floor upload before folding and route recovery to selected-owner
  export plus owner reinitialization.
- Replace the settlement union with `Result<void, SyncSettleError>` through
  supervisor, Worker protocol, runtime adapters, and public exports.

Stop importing:

- Move callers off `captureRecovery`, `startFresh`, outcome/reason unions,
  enrollment IDs, and permanent round vocabulary.

Prove:

- Base at floor accepts; base below floor returns recovery without mutation.
- Stale mutations cannot recreate rows after deletion marker compaction.
- Exact retry inside the horizon returns the original receipt; digest mismatch
  halts; pruned retry enters recovery.
- Identity, deletion, and retry storage remain bounded as floor advances.
- Continuous later work cannot extend an older settlement cut.
- `retrying` remains status; each actionable condition returns its exact Err;
  corruption and programming defects reject.

Remove:

- Permanent replica/tombstone/receipt tables, enrollment and round fields,
  below-floor automatic acquisition, `WorkspaceSyncSettlement`, pending and
  recovery reason unions, public `lineage-mismatch`, `captureRecovery`, and
  `startFresh`.

### Wave 9: flip applications and delete the old family

Build:

- Move every production app, script, example, CLI, desktop host, hosted API, and
  self-host path to the one-Epicenter surface.
- Rename `apps/api` to `apps/hosted` and its Worker to `epicenter` without
  changing the installed `api.epicenter.so` origin.
- Update current package READMEs and `docs/CONTEXT.md` to the implemented nouns.
- Preserve application aggregate services, especially Whispering recording
  row/blob construction and deletion.

Stop importing:

- Prove no production import reaches the Workspace-ID runtime, old room family,
  old blob truth, or logical-copy family.

Prove:

- Run all focused suites, app smokes, provider conformance, artifact fixtures,
  reset/recovery scenarios, browser ownership tests, and host deletion tests.
- Run independent collapse, clean-break, fresh-context, and post-implementation
  reviews.
- Promote implemented ADRs to Accepted and mark accepted predecessors
  Superseded in the same review unit.

Remove:

- Every old API alias, fallback reader, old route, old physical schema, stale
  test fixture, obsolete skill instruction, and superseded implementation spec.
- Delete this spec after its durable outcomes are harvested; done is absence.

## Verification

Focused commands evolve with the implementation, but the final gate includes:

```sh
bun test packages/row-sync
bun test packages/workspace/src/sqlite
bun test packages/workspace/src/document-provider
bun test packages/sync/src/document-v3
bun test packages/server/src/workspace-authority
bun test packages/server/src/document-hub
bun test packages/server/src/routes/blobs.test.ts
bun test packages/client/src/index.test.ts
bun test packages/blobs/src
bun test apps/epicenter/src
bun test apps/whispering/src/lib/whispering/recordings.test.ts
bun run check:licenses
bun run check:doc-hygiene
bun run check:doc-paths
bun run check:api-paths
bun run typecheck
```

Deletion audits must reduce the target concepts to zero in the new runtime,
server, desktop host, API, and self-host paths:

```sh
rg -n 'WorkspaceId|WorkspaceLens|workspace_id|/api/workspaces|LogicalWorkspaceCopy|captureRecovery|startFresh|WorkspaceSyncSettlement' packages/workspace/src/sqlite packages/server/src apps/epicenter/src apps/api/worker apps/self-host

rg -n 'FROM records|TEMP records|installRecordsRelation' packages apps

rg -n 'bucket.*only|uploadedAt.*proof|content-addressed' packages/server packages/client packages/blobs apps/whispering

rg -n 'AttachRelay|ATTACH_RELAY|/attach|ROOM_ROUTE|/api/rooms|createBunRooms|createDurableObjectRooms|mountRoomsApp' packages apps scripts
```

Historical ADRs and git history may still contain old words. The production and
current-document surfaces may not.

## Reopen Signals

- A measured product requires several isolation or lifecycle domains beneath
  one principal and cannot model them as rows.
- A real distributed workflow requires exact cross-row checkpoint visibility.
- Supported recordings repeatedly exceed 5 GiB or restart cost causes measured
  user failure sufficient to earn multipart as transport-only behavior.
- A product requires proof that every durable document/blob reached every
  device and accepts the acknowledgement/discovery machinery.
- Scalar identity or retry storage still grows without a bound after the new
  floor compaction.
- SQL callers demonstrate load-bearing table-valued JSON traversal or session
  TEMP view lifecycle that CTEs cannot express.
- Artifact v1 cannot represent a new platform primitive without ambiguity.
- One principal authority approaches its structured storage or throughput wall
  under observed human workloads.

Each signal reopens only its named decision. None silently restores Workspace
plurality, all-device coordination, merge, or compatibility branches.
