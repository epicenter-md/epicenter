# Gate 5 evidence: typed SQLite workspace foundation

Date: 2026-07-11

> Checkpoint note: implementation examples below record the API and vocabulary
> tested on this date. The current target is the active server-authoritative
> SQLite sync spec. In particular, records identity now excludes documents,
> workspace identity, KV, indexes, and authored epoch lineage; schema succession
> uses records databases and structural `recordsSchemaHash`.

## Result

The typed SQLite foundation and browser-standalone lifecycle pass. The full
workspace clean break remains open because production apps still need the
replica lifecycle before they can stop opening Yjs-backed record roots.

The new `@epicenter/workspace/sqlite` boundary proves:

- `field.*` plus explicit `nullable(...)` compiles to typed SQLite columns;
- canonical records identity is stable across declaration order, changes with
  synchronized tables and fields, and excludes documents, workspace identity,
  KV, indexes, and authored epoch lineage;
- `create`, `patch`, physical `remove`, representation migrations, and
  post-commit invalidation operate over ordinary SQLite;
- a replica-supplied coordinator can commit application SQL and canonical
  record-sync operations in one outer transaction;
- logical snapshots use the record-sync `SnapshotRow` shape for every live row,
  including rows the typed client classifies as quarantined; deletion is
  physical absence.

The next checkpoint also proves the process boundary required by browser and
native SQLite owners:

- the public workspace client is asynchronous while the SQLite service remains
  synchronous internally;
- one write-only client batch becomes one database transaction;
- committed row and removal deltas publish before the mutation promise
  resolves;
- service requests serialize, so an observer-triggered write cannot overtake
  the commit currently being published;
- Svelte helpers hydrate one query-scoped cache, buffer pre-hydration deltas,
  and never update optimistically.
- `openStandaloneWorkspace` verifies the service's standalone/replica mode,
  workspace id,
  and exact records schema hash before exposing a typed client;
- the Bun adapter owns a real file-backed SQLite connection and preserves typed
  rows across close and reopen.
- an app-owned module Worker owns SQLite WASM and the OPFS connection while the
  page receives only the typed async workspace API;
- a versioned, exact, runtime-validated worker protocol rejects malformed or
  semantically mismatched messages;
- disposal rejects new requests, drains admitted work, delivers its committed
  delta, then closes the worker and database;
- BroadcastChannel invalidations make committed rows visible across independent
  page workers, coalesce while refresh is in flight, and retry transient refresh
  failures rather than silently leaving a page stale;
- the Vite production build emits the SQLite WASM and OPFS proxy assets and runs
  under the required COOP and COEP headers.

The old Yjs table/KV path and its callers remain until
`openWorkspaceReplica` supplies the server-authoritative lifecycle and apps
migrate to the new workspace API.

The browser ownership boundary is:

```txt
page 1                              page 2
typed async workspace API          typed async workspace API
          | validated protocol               | validated protocol
          v                                  v
app module Worker 1                app module Worker 2
SQLite WASM connection             SQLite WASM connection
          |                                  |
          +------ BroadcastChannel ----------+
                         |
                         v
                 one OPFS SQLite file
```

## Physical storage

For a table declared as:

```ts
defineTable(
	{
		id: field.string(),
		title: field.string(),
		pinned: field.boolean(),
		rating: nullable(field.number()),
		tags: field.tags(),
	},
	{ indexes: [['pinned']] },
);
```

SQLite stores one physical column per field:

```txt
notes
  id       TEXT PRIMARY KEY NOT NULL
  title    TEXT NOT NULL
  pinned   INTEGER NOT NULL
  rating   REAL
  tags     TEXT NOT NULL      JSON array codec

__epicenter_meta
  storage_revision
  workspace_id
  records_schema_hash
  database_kind       standalone or replica, permanent for this file

```

There is no serialized row blob and no per-row `_v`. The records schema hash
identifies synchronized tables and fields; physical migration progress belongs
to `storage_revision`.

## Mutation ownership

```txt
application transact
  -> typed table SQL
  -> canonical createRow/updateRow/deleteRow operations
  -> replica coordinator
       BEGIN SQLite
         apply application SQL
         allocate actor sequence
         append one outbox mutation
       COMMIT
  -> publish changed row ids and KV keys
```

Across a worker or native service boundary, the public shape is:

```txt
UI projection after whenReady
  <- committed delta <- async workspace service <- synchronous SQLite

await table.get/list/create/patch/remove
await workspace.transact(writeOnlyBatch)
workspace.kv.get/set   synchronous, root-document preference plane
```

Transactional reads are deliberately absent from the public batch callback.
Preserving them would require either blocking the UI thread or pretending a
client-side cache is authoritative.

The standalone coordinator owns only the SQLite transaction. A replica coordinator
can add actor and outbox work before the same commit returns. Observer failures
go to an injected error sink after commit; they cannot turn durable success into
an apparent write failure or prevent later observers from running.

KV is not on the record wire at all: declared keys live in the eager root
Yjs document (ADR-0124), so no table in this file stores preferences.

## Adversarial corrections

The first implementation was not accepted until a fresh-context review found
and corrected these failures:

- same-revision schema drift could open without an identity check;
- a null-admitting JSON schema could bypass `nullable(...)`;
- the discarded epoch-only prototype could be stamped current without
  transforming data;
- the application runtime owned an inner transaction that a replica could not
  extend atomically;
- observer exceptions escaped after commit;
- caught nested transactions could commit their inner writes;
- KV initially invented a second operation family, then rode the record wire
  as a reserved table, and finally left the record plane for the root
  document (ADR-0124).
- async projections initially subscribed after requesting their snapshots;
- a disposed service could still accept queued or future writes;
- the in-process service retained caller-owned request objects by reference;
- the pre-readiness KV binding type hid its real `undefined` state (obsolete
  once KV became synchronous on the root document);
- schema names could collide with inherited JavaScript record properties.
- disposal could reject a mutation after it had committed and suppress its
  delta;
- a schema-valid reply of the wrong semantic type could leave one request
  pending forever;
- a transient cross-worker refresh failure could permanently drop an
  invalidation;
- browser initialization could leak an already-opened SQLite resource when a
  later resource failed to initialize.

Focused regression tests now cover each corrected invariant.

## Verification

Commands:

```sh
bun test packages/workspace/src/sqlite
bun run --cwd packages/workspace typecheck
bun run --cwd examples/sqlite-workspace-browser typecheck
bun run --cwd examples/sqlite-workspace-browser smoke
bun test packages/svelte-utils/src/from-table.svelte.test.ts \
  packages/svelte-utils/src/from-kv.svelte.test.ts
bun run --cwd packages/svelte-utils typecheck
bun run --cwd apps/wiki typecheck
bun run --cwd apps/reddit typecheck
bun run --cwd apps/whispering typecheck
bun run check:licenses
```

Result at the browser-standalone lifecycle checkpoint: 59 focused SQLite tests
passed with 180 assertions. Workspace and browser example typechecks passed.
The production browser smoke built the real Vite worker bundle, opened two page
workers against one OPFS file, verified sequential and concurrent cross-worker
writes, closed one owner without disrupting the other, reopened persisted data,
and rejected a mismatched workspace definition.

The smoke uses SQLite's standard `opfs` VFS with `busy_timeout = 5000`. In the
exact `@sqlite.org/sqlite-wasm` 3.53.0-build1 build and concurrent schedule used
for this gate, `opfs-wl` lost one branch while standard `opfs` passed repeatedly.
This is a scoped compatibility decision, not a claim that standard `opfs` is
universally superior. The gate keeps explicit contention handling and can
re-evaluate `opfs-wl` when the upstream package changes.

## Required next step

Implement the Wave 2 family and records-database protocol around the proven
replica lifecycle. Reuse the validated service protocol and the rule that the
worker or native service imports the workspace definition itself. The UI sends
no executable schema; its opening handshake verifies mode, workspace id, and
exact records records schema hash. Schema succession must follow the candidate and
conditional-activation contract in the active spec, not the discarded epoch or
database succession prototypes.

Then migrate app definitions and actions, move only proven collaborative bodies
to declared Yjs docs, stop every old record import, and delete the Yjs table/KV
implementation.
