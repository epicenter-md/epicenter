# 0125. Records schemas are immutable; evolution creates a successor database

- **Status:** Superseded
- **Date:** 2026-07-12
- **Superseded by:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)
- **Supersedes:** [ADR-0006](0006-schema-evolution-keeps-the-version-tuple-and-refuses-repair-apis.md)
- **Relates:** [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md), [ADR-0122](0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md), [ADR-0124](0124-workspace-kv-keeps-one-logical-identity-outside-the-record-database.md)

## Context

Per-row `_v` and migrate-on-read let several logical schemas coexist inside one
table. The server-authoritative SQLite design instead gives every synchronized
device a complete typed replica and fences incompatible schemas at connection
time. Keeping both models would preserve row-version routing, newer-writer read
states, patch translation, and historical executable table definitions after
the database boundary already provides a simpler place to change schemas.

## Decision

A workspace family selects one current records database. Each records database
has one immutable logical schema, identified by a canonical structural hash of
its synchronized tables and fields. Workspace identity, KV, child documents,
indexes, and physical storage do not enter that hash. Applications
do not author an epoch, revision, or incarnation. A stored meaning change must
be visible in the schema, for example by renaming
`temperatureFahrenheit` to `temperatureCelsius`; two schemas with the same
canonical structure are compatible by definition.

Schema declarations have value semantics. `defineTable`, `defineKv`, document
capabilities, and `defineWorkspace` consume mutable authoring objects and return
framework-owned immutable definitions. The descriptor, compiled validators,
runtime tables, KV declarations, and document formats cannot diverge after
definition. Mutating an object previously passed to a `define*` function does
not change the definition.

Historical records schemas are generated, committed artifacts. Importing those
artifacts and authoring adjacent semantic transforms is the only supported and
documented application workflow. The generated TypeScript must resolve its
constructor, so that constructor is exported from the explicit
`@epicenter/workspace/sqlite/generated` subpath and omitted from the ordinary
SQLite barrel. This is an ownership and friction boundary, not a security or
type-soundness boundary: deliberate code can import the subpath, edit generated
output, use casts, or supply a generic row type that disagrees with the
descriptor. The immutable source-snapshot capability, migration runner,
candidate protocol, and activation machinery remain runtime internals, not
application-facing succession tools. The workspace lifecycle detects a
recognized old schema and owns the one succession path.

A synchronized logical schema change is an explicit, user-approved boundary.
The migration screen tells the user to open the devices they care about, wait
until each reports `Synced`, stop editing, and approve the update. That assertion
belongs to the user. The authority does not enumerate devices or actors, prove
that every replica participated, or store device-participation state.
Choosing not to update closes that workspace in the current application. The
new binary does not offer an old-schema read-only compatibility mode.

After approval, one current client reads a canonical logical snapshot of source
database A at server sequence H and transforms it into a fresh successor B. The
records transform maps each source table statically to at most one same-named
target table, then maps one source row to the same target row identity or omits
it. It does not split rows, merge rows, route between tables, derive identities
from mutable cells, translate old patches, or replay mutation history.
The snapshot and transform contain records only. A records transform cannot
open a lazy child document, read an external Yjs room, migrate document bytes,
or move authority between SQLite records and Yjs documents.

The source remains normally writable while B is prepared. The authority
activates B only if the workspace family still selects A and A is still exactly
at H. Successful activation atomically selects B and permanently fences A. If
any ordinary write advanced A, activation fails without changing the family;
the client discards the stale candidate and retries from the new canonical head.
The conditional activation is the whole concurrency protocol.

Ordinary writes and activation serialize through the same authority transaction
boundary. A write atomically requires that the family still selects its request
database and that the database is writable, then folds the mutation, advances
the database head, and commits. A write that commits first advances A beyond H,
so activation is stale. Activation that commits first makes A non-current, so
the old-database write is rejected.

A local-only workspace follows the same logical rule without a server head, but
the lifecycle performs the update automatically because no other device can
contribute forgotten work. One runtime takes a short local exclusive cutover,
builds and verifies a fresh database, atomically selects it in local metadata,
and retains the source for logical export. A crash before selection leaves the
source current on reopen. It does not persist cross-device source-locking state
or rewrite mixed-version rows in place.

The server stores plaintext canonical cells but remains schema-blind. It owns A's
canonical head, temporary candidate storage, upload completeness and integrity,
and one atomic compare-and-swap of `(current database id, source head)`. It does
not load or execute application migration code or validate app-specific source
or target rows. The trusted application client validates every source row
against its historical source descriptor before invoking a typed transform and
validates every emitted row against the target descriptor before upload. A
nonconforming or quarantined source row blocks succession; it is never silently
discarded. A remains unchanged and available for diagnosis and logical export.
The ordinary user surface reports the blocker count and unchanged-source
outcome. Table names, row ids, and validation reasons appear only in bounded
technical details or a diagnostic export. Version one has no generic repair
editor.

A candidate may be larger than one request, so temporary staging is retained as
one generic immutable logical-baseline upload object. Its server-owned manifest
binds the candidate id, source database A, source head H, target records schema
hash, ordered chunk identities and content digests, row and byte totals, expiry,
and state (`open` or `sealed`). The manifest digest is
SHA-256 over the UTF-8 bytes of canonical JSON for the immutable manifest body,
excluding the digest itself; object keys use the protocol's fixed canonical
order and chunk entries sort by index. Duplicate chunk indexes and duplicate
`(table, rowId)` identities are rejected across the complete candidate.

Candidate creation and chunk upload are idempotent by exact content. Reusing a
candidate id with the identical manifest is a replay; a different manifest is a
conflict. Reusing a chunk index with identical bytes is a replay; different
bytes are a conflict. Resealing a sealed candidate succeeds. Sealing verifies
all declared chunks, canonical digests, counts, duplicate-row absence, and
generic wire limits. Activation accepts only `candidateId`, loads the sealed
manifest, and derives A, H, the target hash, and the candidate's successor
binding from that server-owned state. It revalidates the binding inside the
activation transaction. Retrying a committed activation returns
`already-activated`; a
genuinely stale candidate changes no family or source state.

Staging has bounded candidate, chunk, row, byte, and lifetime quotas. The
authority owns expiry and cleanup. Expiry, sealing, activation, and cleanup
serialize against candidate and family state: cleanup cannot delete a candidate
that wins activation, activation cannot revive an expired candidate, and an
activation receipt survives cleanup of staged bytes. Candidates require no
exclusive owner and never affect A before activation. Concurrent clients may
stage candidates; at most one can win the conditional activation.

Activation permanently fences synchronization against the superseded database.
An old offline replica may contain writes the user did not synchronize before
approval. The runtime retains that local database and can read it to produce a
logical export, but the current application does not open it as an old-schema
workspace. Version one provides no automatic merge or generic in-product
re-import into B. The runtime never deletes the retained source automatically.
Recovery tooling operates on logical exports, never on live SQLite files. A
generic SQLite editor would expose physical tables, indexes, replica state,
outboxes, and adapter details that are not portable records state, so it is not
part of the product. A later app-owned recovery service may consume a logical
export only when a concrete workflow earns it.

Historical schemas are inert canonical descriptors, not executable old
`defineTable` calls coupled to the current builder API. Migrations are a
separate declarative linear chain of adjacent schema steps, not a member of
`defineWorkspace`. The workspace lifecycle invokes the runtime, which composes
the unique source-to-current path in memory during one migration attempt and
one database cutover; it does not activate intermediate databases. Branches,
shortcuts, cycles, and multiple paths are refused. The first system has no
automatic migration-prefix retirement: hosted
authority data cannot prove non-use across independent self-hosted instances.
Removing an old step is a later release-policy decision with deployment-specific
evidence, not sync-engine behavior. Forgotten local bytes remain export-only and
do not create an automatic reconciliation obligation.

Conditional activation does not change the transformation problem: a workspace
family may skip several application releases while still selecting an older
supported schema. Adjacent steps keep authored history linear and are composed
client-side into one candidate. A direct-to-current registry would make each new
schema re-author every supported historical path.

The application declaration API is
`defineRecordsMigration({ from, to, transform, discard })` and
`defineRecordsMigrations(steps)`. The scoped name is deliberate: the workspace
package also contains physical storage evolution and child-document formats,
and this API owns neither. Historical exports use source-history labels such as
`recordsSchemaV1`; `recordsSchemaHash`, not the label, is compatibility identity.
For each adjacent step, a same-named table with a canonically identical
descriptor copies automatically. A changed same-named table requires a
transform. A source-only table requires explicit `discard`; a target-only table
begins empty. A transform receives `{ id, cells }`, may return target cells or
`null`, and the runtime preserves the source id. The transform cannot author a
replacement id, route between tables, split, merge, aggregate, or produce more
than one output row. Complex remodeling inside the records plane belongs to a
separate app-owned successor build or logical export/import boundary. Moving
data between records and child documents changes the authoritative storage
plane and belongs to an explicit app-owned maintenance operation. Neither
boundary is designed here.

`defineRecordsMigration` rejects equal source and target hashes. A no-op is not
an adjacent schema migration and is invalid before chain construction.

Transforms should be synchronous, pure, and deterministic so retries are easy
to reason about. This is trusted application guidance, not an enforceable
sandbox invariant. The runtime enforces descriptor continuity, source and
target validation, same-table routing, zero-or-one output, and id preservation;
it cannot prevent arbitrary TypeScript from observing time, randomness, the
network, or the filesystem.

## Consequences

- Record rows no longer carry `_v`; read-time migration, newer-writer buckets,
  and mixed-version tables leave the records path.
- The product asks the user to synchronize the devices they care about before
  approval. The server deliberately does not prove that assertion.
- Migration is a client-run import with server conditional activation, not a
  server-executed application migration or an in-place SQLite rewrite.
- Several clients may stage candidates concurrently. Conditional activation
  admits at most one candidate from the still-current source head; no migration
  lease or coordinator election is required.
- A source write during preparation is safe: it advances A beyond H, makes
  activation fail, and forces a fresh snapshot and transform.
- Local-only succession is automatic. Synchronized succession requires
  approval because activation permanently excludes forgotten old-schema work.
- Declining a synchronized update closes that workspace in the current binary;
  it does not create a historical compatibility mode.
- Candidate creation, chunk upload, sealing, and activation have explicit
  replay/conflict behavior; a lost activation response never turns success into
  a false stale result.
- Nonconforming or quarantined source rows block succession. `discard` and
  `return null` are authored migration semantics, never an implicit repair path.
- Blocking identities are technical diagnostics. The default user surface
  reports counts and confirms that the source was not changed.
- There is no post-activation private-overlay import, three-way comparison,
  deletion-intent recovery, row-resurrection policy, or migration-time device
  participation state.
- Local indexes and internal SQLite layouts may migrate in place because they do
  not change the logical synchronized schema.
- Child-document formats have independent compatibility identity and addressing
  under ADR-0126. Adding or changing a child document does not trigger
  records-database succession; a format change creates a separately addressed
  document and uses explicit per-document conversion when content must carry
  forward. Child addresses never include the runtime records database id.
- Migration steps remain in new binaries in the first system. A later release
  may remove a prefix only under a separately approved deployment-support
  policy; sync does not infer global non-use.
- Version one retains the superseded canonical server database but provides no
  server-export UI or automatic deletion policy. Measured storage cost may earn
  cleanup later; local logical export is the first recovery surface.
- The portable recovery surface is a logical export. Epicenter provides no
  generic SQLite editor, old-schema application mode, automatic merge, or
  generic re-import.

## Considered alternatives

- **Keep per-row `_v` beside database succession.** Rejected because it keeps two
  schema-evolution systems and their failure states.
- **Run application migrations on the server.** Rejected because the shared
  hosted and self-hosted authority would need every app's schemas, code, release
  lifecycle, and sandbox.
- **Let old and new schemas synchronize concurrently.** Rejected because it
  requires bidirectional patch translation or a permanent cross-schema
  forwarder.
- **Prove every device participated before activation.** Rejected because it
  turns actor and node identity into a distributed migration state machine. The
  user owns the narrower assertion that important devices show `Synced` before
  approval; conditional activation protects canonical writes during preparation.
- **Let an offline device contribute old-schema edits after activation.**
  Rejected because it requires private-overlay transformation, three-way
  reconciliation, deletion-intent preservation, and row-resurrection policy.
  The migration screen states the loss before approval; old bytes remain
  readable and exportable.
- **Lock A while B uploads.** Rejected because comparing A's head with H at
  activation protects canonical writes without a source-locking lifecycle.
- **Open the old database read-only in the current application.** Rejected
  because it would require historical app queries, rendering, disabled-write
  states, and indefinite compatibility behavior. Declining the update closes
  the workspace; retained old state remains available for logical export.
- **Provide a generic SQLite recovery editor.** Rejected because SQLite files
  contain runtime representation and replica state, not the portable records
  contract. Future shared recovery tooling may inspect logical exports without
  writing live databases.
- **Expose source snapshots, migration execution, and candidate upload as an
  application toolkit.** Rejected because applications own schema meaning, not
  succession lifecycle or protocol state. The runtime owns the operation after
  applications register generated history and adjacent transforms.
- **Require one-request candidate creation.** Rejected because database size
  would become a request-size and transaction-duration limit. Immutable staged
  chunks retain atomic visibility without creating device coordination state.
- **Use an authored epoch or revision beside the structural hash.** Rejected
  because invisible meaning changes should become visible schema changes, not a
  counter developers must remember to bump.
- **Copy SQLite files or WAL pages.** Rejected because physical files contain
  runtime indexes, storage revisions, actor identity, cursors, and private
  outboxes that do not belong to the logical database.
- **Include child-document formats in the records schema hash.** Rejected because
  child Yjs rooms evolve and synchronize independently of SQLite record rows;
  coupling them makes unrelated document changes force succession of the whole
  database.
