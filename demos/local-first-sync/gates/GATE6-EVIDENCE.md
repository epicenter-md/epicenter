# Gate 6 evidence: initial server-authoritative replica integration

Date: 2026-07-11

> Checkpoint vocabulary note: this file records the implemented
> `databaseIncarnationId` lifecycle on that date. The target protocol calls the
> coordination universe a records database and adds workspace-family selection
> in Wave 2. The implemented checkpoint does not prove schema succession. Its
> two opener functions are implementation seams from this checkpoint, not the
> settled public API; the active spec targets `workspace.connect(...)`.

## Result

The initial database-identity path works through real SQLite, the workspace
service boundary, HTTP, and both server deployment adapters. This checkpoint
proves the synchronized lifecycle door. It does not complete database movement
or records-schema succession.

The workspace now has two explicit durable lifecycle doors:

```ts
openStandaloneWorkspace(definition, { storage, ...runtimeOptions });
openWorkspaceReplica(definition, { storage, sync, ...runtimeOptions });
```

`openStandaloneWorkspace` creates a database with application state and no
actor, cursor, or outbox. `openWorkspaceReplica` creates or reopens a complete
local SQLite replica of one server-authoritative database incarnation. A SQLite
file cannot cross between those modes. The application metadata records its
mode permanently and refuses the wrong opener.

This is still a clean break. There is no `openWorkspace({ sync? })`, promotion
flag, dormant local-only outbox, or compatibility bridge between the two files.
Moving data between those database boundaries belongs to the logical import
flow that remains to be built.

## System shape

```txt
browser page                         Bun or native caller
typed async workspace API            typed async workspace API
          |                                     |
          | exact worker protocol               | in-process service
          v                                     v
app-owned module Worker              SQLite-owning runtime
SQLite WASM + OPFS                    Bun SQLite file
          |                                     |
          +---------- replica runtime ----------+
                     actor + outbox + cursor
                              |
                    authenticated JSON/HTTP
                              |
              +---------------+----------------+
              |                                |
              v                                v
 Epicenter Cloud Worker              self-hosted Bun server
 authenticated principal             authenticated principal
              |                                |
              v                                v
 Records Durable Object              partitioned Bun SQLite
 schema-blind authority               schema-blind authority
              |                                |
              +---- server acceptance order ---+
```

The client owns typed application DDL and local queries. The authority owns the
canonical logical fold, server sequence, actor high-water marks, mutation tail,
and snapshot generation. The server never imports an app definition and never
runs app-specific SQL.

Authentication selects the principal outside the record-sync request. The URL
selects the workspace. The request envelope then fences protocol major, schema
identity, and database incarnation. A client cannot choose another principal by
placing identity fields in JSON.

## SQLite at rest

A standalone database contains the application tables described in Gate 5. A
replica uses those same typed tables and adds small internal synchronization
tables:

```txt
application tables
  one typed SQLite column per declared field

__epicenter_meta
  storage_revision
  workspace_id
  schema_identity
  database_kind = replica

__epicenter_replica                         one singleton row
  actor_id                                  durable device writer identity
  next_actor_sequence                       next mutation number to allocate
  applied_server_sequence                   pull cursor installed in projection
  database_incarnation_id                   server-minted database identity
  protocol_major                            outbox encoding fence
  sync_storage_version                      local sync-table format

__epicenter_replica_outbox
  actor_sequence PRIMARY KEY
  operations_json                           exact pending logical operations

__epicenter_replica_snapshot
  manifest_json                             verified staging manifest

__epicenter_replica_snapshot_chunks
  chunk_index PRIMARY KEY
  chunk_json                                verified resumable staging chunk
```

Actor id is stored once. Outbox rows do not repeat it. Schema identity is also
stored once by `__epicenter_meta`; replica metadata does not create a second
owner. `applied_server_sequence` is the pull cursor: every server mutation at or
below that sequence has been durably folded into the local projection.

The authority stores a different physical model:

```txt
record_sync_meta
  storage version, protocol major, schema identity, database incarnation
  server sequence, compaction watermark, snapshot generation

record_sync_actor_high_water
  actor_id -> largest contiguous accepted actor sequence

record_sync_mutation_log
  server_sequence, actor_id, actor_sequence, operations_json

record_sync_canonical_rows
  table_name, row_id, cells_json, deleted

record_sync_snapshot_manifest
record_sync_snapshot_chunks
```

These are independent SQLite files. Clients synchronize logical mutations and
snapshots, never database pages, WAL files, or application-specific tables.

## Local write and convergence invariants

One application transaction produces at most one outbox mutation:

```txt
BEGIN local SQLite
  apply typed table writes
  collect canonical createRow/updateRow/deleteRow operations
  read durable actor_id and next_actor_sequence
  append one outbox row
  advance next_actor_sequence
COMMIT
publish reactive invalidation
```

The application SQL, outbox append, and actor-sequence allocation share the
same outer SQLite transaction. If journaling fails or actor sequence space is
exhausted, the application write rolls back. The UI never sees a successful
local write that sync cannot identify later.

Synchronization preserves these facts:

- actor sequences are positive, contiguous, and never reused;
- a lost push acknowledgement retries the same actor sequence and operations;
- push success does not prune the outbox;
- only the exact mutation echoed through server order, or a verified snapshot
  actor high-water that proves containment, prunes pending work;
- a pull page must start at the requested cursor and contain contiguous server
  sequences;
- applying remote operations, pruning exact echoes, replaying pending intent,
  and advancing the cursor happens in one SQLite transaction;
- deletion is physical absence: a stale update to a deleted row folds to an
  accepted no-op instead of resurrecting it, including after snapshot
  replacement, and a replica's own optimistic pending creations are retracted
  before an accepted page folds so createRow echoes land on absent
  identities;
- a duplicate createRow refused by the authority (create-conflict) is a fatal
  replica invariant violation: the replica pauses for rebootstrap instead of
  repairing itself;
- rows that do not satisfy the local schema stay in quarantine and can promote
  when later cells complete them;
- malformed protocol data and contradictory identity metadata pause sync
  without rewriting the outbox.

The snapshot high-water check is deliberately stronger than checksum
verification. The replica first proves that its outbox is one contiguous suffix
ending immediately before `next_actor_sequence`. The manifest may prune only a
prefix within the actor sequences that this replica actually allocated. A
validly hashed manifest cannot claim future local intent or regress below work
the replica already knows the authority accepted.

## Offline reopen

An existing replica opens from its local SQLite identity without contacting the
authority. Reads, queries, and writes remain available while signed in but
offline. New writes continue the same durable actor sequence and enter the same
outbox.

The first synchronization attempt verifies the stored database incarnation
against the authority before pushing or pulling. A different account database,
reset authority, or replaced incarnation pauses sync. It does not silently
rebind the file, mint a replacement actor, or discard pending edits.

A brand-new replica is different. It has no database incarnation to preserve,
so its first open must reach the authority, receive the server-minted
incarnation, and atomically create its local actor binding. Local-only creation
uses `openStandaloneWorkspace` instead.

## Snapshot restart and installation

Snapshot chunks change no visible application state while downloading. The
replica stores the manifest and each verified chunk in staging tables. If a
download stops, the next attempt reuses chunks whose generation, index,
checksum, and content hash still match the current manifest. A replaced
generation clears the old staging set. Corrupt staging bytes are disposable and
are fetched again; they cannot become typed application state.

Installation has one commit boundary:

```txt
BEGIN local SQLite
  replace canonical visible rows from snapshot (live rows only)
  validate this actor's accepted high-water against local sequence facts
  prune only contained outbox rows
  set applied_server_sequence = snapshot_sequence
  replay the remaining pending outbox over the snapshot
  clear staging rows
COMMIT
publish reactive invalidation
```

A crash before this transaction leaves the previous visible database intact. A
crash after it leaves the snapshot, cursor, pruned outbox, and replayed pending
intent committed together. A stale required snapshot is a protocol error rather
than a retry loop.

## Checkpoint naming, not the target public API

The checkpoint names are `openStandaloneWorkspace` and
`openWorkspaceReplica`. They mirror the returned domain nouns:
`StandaloneWorkspace` is its own authority, while `WorkspaceReplica` is a local
copy of a server-authoritative workspace database.

Within this checkpoint, `local` is not used as the opposite of `replica` because every replica
is also physically local and must work offline. `openWorkspaceReplica` keeps
`WorkspaceReplica` intact as the noun. These lower-level names do not require
the final application API to expose two openers; the active spec owns that
public composition decision.

## Verification

The focused integration suite passed:

```sh
bun test packages/record-sync/src \
  packages/workspace/src/sqlite \
  packages/server/src/records \
  packages/server/src/routes/records.test.ts
bun run --cwd packages/workspace typecheck
bun run --cwd packages/server typecheck
bun run --cwd examples/sqlite-workspace-browser typecheck
bun run --cwd examples/sqlite-workspace-browser smoke
```

Result: 114 tests passed with 383 assertions. The workspace, server, and browser
example typechecks passed. The Vite production build and Playwright replica
smoke passed.

That suite covers:

- one record-authority conformance suite over Bun SQLite, browser SQLite OO1,
  and Durable Object SQLite adapters;
- durable actor identity, atomic outbox writes, lost acknowledgements, exact
  echo pruning, same-cell ordering, different-cell composition, quarantine,
  terminal deletion, corrupt pages, actor exhaustion, offline reopen, and
  snapshot high-water refusal;
- automatic Bun replica convergence through the public workspace lifecycle;
- exact HTTP request routing and runtime response validation;
- authenticated principal and workspace partitioning in the Hono routes;
- durable Bun authority reopen and Durable Object restart behavior;
- shared admission ceilings and automatic byte-bounded production compaction.

The production browser smoke builds the real Vite Worker bundle, opens two
independent OPFS replica workers, starts a real Hono Records server backed by Bun
SQLite, and verifies convergence over HTTP. The Durable Object test runs its
adapter against real SQLite through the Durable Object storage contract. A
deployed workerd smoke remains a separate runtime-parity check; the test does
not pretend its local Durable Object harness is a Cloudflare deployment.

## What this checkpoint does not complete

This initial replica integration slice does not prove workspace-family
selection, the adjacent migration API and runner, source-row validation,
successor candidate staging, or conditional activation. Wave 2 must implement
client-built immutable successor candidates, exact manifest and chunk
idempotency, candidateId-only activation, and permanent old-database fencing.
Ordinary writes must atomically recheck family-current and writable before
folding and advancing the database head.

Do not infer a generic import planner, conflict-review product, or second public
opener family from this checkpoint. Physical-copy adoption and other database
movement are separate app-owned boundaries. Schema succession adds no source
freeze/unfreeze, transition lease, server-executed transform,
device-participation state, or private-overlay reconciliation.

Wave 4 consumer migration and deletion also remain: production apps still need
to stop importing the Yjs table and KV record path before that implementation
can be removed.

Wave 6 is the acceptance and documentation closeout. Reconcile provisional ADR
numbers, supersede conflicting accepted decisions explicitly, accept the new
ADRs only after production behavior lands, move durable protocol facts into
reference documentation, record the completed spec in history, and delete the
spent spec.
