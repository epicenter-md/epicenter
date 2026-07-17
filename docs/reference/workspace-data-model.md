# Workspace data model

A canonical workspace owns complete schema-opaque rows and one reserved KV row.
Every ordinary row contains JSON fields and one latent collaborative document.
An application definition is a release-local lens over those resources. It
validates typed reads, admits typed writes, and installs connection-local SQL
views, but it never migrates or rewrites canonical user data.

```text
workspace
|-- ordinary rows
|   `-- (table key, row id)
|       |-- schema-opaque JSON fields
|       `-- latent row-owned Yjs document
|-- reserved workspace KV row
|-- release-local table and KV lenses
`-- connection-local read-only SQL views
```

An app may open and compose several workspaces through one runtime. Each handle
keeps its own row authority; composition does not create a cross-workspace
transaction.

## Rows preserve honest ownership state

The canonical store maps a permanent table key and runtime-allocated row ID to
fields plus row-document state. It does not store the current application
schema, a schema hash, a row version, migration state, or generated historical
definitions.

```text
("notes", "note_123")
|-- fields: { "title": "Trip planning", "pinned": true }
`-- document: application-owned collaborative roots
```

The synchronization wire carries one `RowIntent` vocabulary:

- `create` starts a row lifetime with complete fields and may include an
  initial document update.
- `update` changes field keys, document state, or both. Field changes replace
  supplied keys, preserve omitted keys, and may unset optional keys.
- `delete` ends the row lifetime and removes its fields and document together.

The server folds sealed intent rounds in authority order. Fields use that order
for last-accepted-wins replacement. Document updates use Yjs merge inside the
same row lifecycle. Devices apply composite row outcomes to complete local
replicas, so point reads and bounded scans do not hydrate the entire workspace
into JavaScript memory. SQLite is runtime-owned storage for canonical state,
not the portable user-data contract.

## Definitions are release-local lenses

`defineTable({ fields, optional })` describes how one release interprets the
fields under one table key. Field names are exact permanent storage keys. A
field validates one present value; the table lens decides whether the key is
required or optional.

A lens may change freely between releases. Existing rows may then be
nonconforming, and that is honest. Reads never fill defaults, follow aliases,
rename keys, or mutate stored data. `get()` returns a typed row or `undefined`
inside `Result`, or a nonconforming-record error. `list()` returns typed rows
alongside diagnostics and raw canonical payloads that application repair code
can inspect.

Typed creates admit only the current shape. Typed updates preserve unknown
keys. For an optional field, updating with `undefined` means unset and removes
the key; canonical JSON never stores `undefined`. `null` remains an ordinary
value when the field accepts it.

There is no records migration framework. A developer who wants to repair old
or nonconforming data writes ordinary bounded application code:

```text
read one bounded page
  -> identify a known old shape
  -> update the exact canonical keys
  -> persist the application cursor
  -> repeat safely
```

That work may be interrupted, retried, or omitted. Different releases may
disagree about conformance without forking or replacing the canonical store.

## Every row has one document

Documents are not declared in a workspace definition. Every ordinary row has
the same latent capability:

```ts
using document = await workspace.tables.notes.document.open(note.id);

const editor = document.get('editor');
const comments = document.get('comments');
```

The row supplies identity, authority, and lifetime. The application owns root
names and how each root is interpreted. Epicenter owns document construction,
hydration, update capture, SQLite durability, synchronization, revocation, and
destruction. Public code never supplies a room ID, authority ID, storage key,
provider, document format declaration, or synchronization command.

`open(rowId)` checks that the row is live and returns a ready `RowDocument`
lease after local hydration. Persistence begins automatically for every local
update. `whenDurable()` is an optional barrier that waits for updates already
observed by the runtime to commit locally; it does not wait for remote
acceptance. Disposing the lease unloads live state after the final user without
deleting canonical content. Deleting the row revokes its handles and prevents
queued or later writes from recreating it.

An empty row document stores no bytes. The entire document remains bounded
interactive CRDT state. Large media belongs in the filesystem or blob plane and
may be referenced from row fields.

## Workspace KV is one reserved row

The workspace definition includes a release-local typed KV lens:

```ts
defineWorkspace({
  id: 'skills',
  tables: { skills },
  kv: {
    theme: field.select(['light', 'dark']),
  },
});
```

Every declared key is optional in canonical storage. `kv.get` returns a
conforming value, `undefined`, or a nonconforming error with the raw value.
`kv.set` validates and replaces one value; `kv.unset` removes one key. Reads do
not install defaults, repair values, or remove unknown keys. Different keys are
independent merge units, while nested JSON under one key replaces atomically.

KV is for workspace-owned singleton values without identity, lifecycle, or
query needs. Identified or queryable values belong in ordinary rows. The KV row
is immortal and has no document component.

## SQL is a disposable view

Each SQLite connection installs one explicit-column `TEMP VIEW` per table lens.
The view projects the current release's field names from canonical JSON and is
read-only. It stores no rows, reflects canonical commits immediately, and
disappears when the connection closes.

Changing a lens therefore requires no projector, polling loop, materialized
table, index catalog, or rebuild. Opening a new connection creates the current
views, so stale columns do not survive an application reload. Full `field.*`
validation remains in the typed JavaScript path; SQL only supplies a convenient
storage-shaped query surface through `workspace.records.sql`.

## Placement rule

Use an ordinary row for every mutable referenceable application value with its
own identity and lifecycle. Put authority-ordered queryable facts in its fields.
Put merge-sensitive interactive state, such as text or rich structure, in its
row document. Use workspace KV only for declared singleton values without
identity or query needs. Keep device-local, secret, or privacy-sensitive values
outside the synchronized workspace unless the product names another owner.

This is one ownership boundary, not separate record and document planes. If
fields and document state must start or end together, the row lifecycle already
provides that aggregate. If product correctness requires validation against
current authority state, use an application-specific authority operation
instead of strengthening the generic field conflict model.

Logical ownership export contains row fields, row-document state, and workspace
KV. It excludes replica receipts, pending intents, SQLite pages, TEMP views,
room manifests, and transport history.

## Current transition

The canonical model is exported from `@epicenter/workspace/sqlite`. New
definitions use `defineWorkspace({ id, tables, kv })`; opened handles expose
`tables`, `kv`, and `records.sql`.

The root `@epicenter/workspace` API is still active for apps not yet migrated.
It stores tables and KV in a root Y.Doc and exposes definition-owned
`create/connect/mount`, `defineKv`, `.docs`, and `_v`. Preserve those consumers
until each app moves, but do not treat that compatibility lane as the canonical
SQLite architecture or add its concepts to new SQLite definitions.
