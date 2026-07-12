# Gate 5 evidence: typed SQLite workspace foundation

Date: 2026-07-11

## Result

The typed SQLite foundation passes. The full workspace clean break remains
open because production apps still need the two SQLite lifecycle doors before
they can stop opening Yjs-backed record roots.

The new `@epicenter/workspace/sqlite` boundary proves:

- `field.*` plus explicit `nullable(...)` compiles to typed SQLite columns;
- canonical logical schema identity is stable across declaration order and
  changes when tables, columns, docs, KV, workspace identity, or authored epoch
  lineage changes;
- `put`, `patch`, terminal `remove`, KV writes, representation migrations, and
  post-commit invalidation operate over ordinary SQLite;
- a replica-supplied coordinator can commit application SQL and canonical
  record-sync operations in one outer transaction;
- logical snapshots use the record-sync `SnapshotRow` shape for live rows,
  tombstones, and KV rows in the reserved namespace.

This does not claim that Wave 5 is complete. The old Yjs table/KV path and its
callers remain until `openLocalWorkspace` and `openReplica` can supply real
browser and native SQLite lifecycles.

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
  schema_identity

__epicenter_kv
  key      TEXT PRIMARY KEY
  value    TEXT NOT NULL      canonical JSON value

__epicenter_tombstones
  table_name + row_id PRIMARY KEY
```

There is no serialized row blob and no per-row `_v`. Logical epoch identity
belongs to the complete workspace schema; physical migration progress belongs
to `storage_revision`.

## Mutation ownership

```txt
application transact
  -> typed table and KV SQL
  -> canonical patchRow/deleteRow operations
  -> replica coordinator
       BEGIN SQLite
         apply application SQL
         allocate actor sequence
         append one outbox mutation
       COMMIT
  -> publish changed row ids and KV keys
```

The local coordinator owns only the SQLite transaction. A replica coordinator
can add actor and outbox work before the same commit returns. Observer failures
go to an injected error sink after commit; they cannot turn durable success into
an apparent write failure or prevent later observers from running.

KV uses no third wire operation. A stored key is a row in
`__epicenter_kv`; set is `patchRow(..., { value })`, and clear is
`patchRow(..., { value: null })`.

## Adversarial corrections

The first implementation was not accepted until a fresh-context review found
and corrected these failures:

- same-revision schema drift could open without an identity check;
- a null-admitting JSON schema could bypass `nullable(...)`;
- epoch-only migrations could be stamped current without transforming data;
- the application runtime owned an inner transaction that a replica could not
  extend atomically;
- observer exceptions escaped after commit;
- caught nested transactions could commit their inner writes;
- KV initially invented a second operation family instead of using `patchRow`.

Focused regression tests now cover each corrected invariant.

## Verification

Commands:

```sh
bun test packages/workspace/src/sqlite
bun run --cwd packages/workspace typecheck
bun test packages/svelte-utils/src/from-table.svelte.test.ts \
  packages/svelte-utils/src/from-kv.svelte.test.ts
bun run --cwd packages/svelte-utils typecheck
bun run --cwd apps/wiki typecheck
bun run --cwd apps/reddit typecheck
bun run --cwd apps/whispering typecheck
bun run check:licenses
```

Result: 34 focused tests passed with 119 assertions. Workspace and affected app
typechecks passed. Whispering passed both browser and Tauri Svelte checks. The
MIT package graph remains clear of AGPL dependencies.

## Required next step

Pull the first Wave 6 item forward: implement `openLocalWorkspace` and
`openReplica` over real browser and native SQLite lifecycles. Then migrate app
definitions and actions, move only proven collaborative bodies to declared Yjs
docs, stop every old record import, and delete the Yjs table/KV implementation.
