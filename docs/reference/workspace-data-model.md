# Workspace data model

A canonical workspace owns one complete schema-opaque map of JSON records and a
set of independently addressed lazy Yjs documents. An application definition is
a release-local lens over those resources. It validates typed reads, admits
typed writes, and installs connection-local SQL views, but it never migrates or
rewrites canonical user data.

```text
workspace
|-- canonical record map
|   `-- (table key, row id) -> JSON object
|       complete device replica
|       server-ordered create, patch, delete
|       private SQLite materialization
|-- release-local table lenses
|   |-- typed validation and projection
|   `-- connection-local read-only SQL views
`-- top-level Yjs documents
    |-- optional typed domain parameters
    `-- lazy, revocable leases
```

An app may open and compose several workspaces through one runtime. Each handle
keeps its own record and document authority; composition does not create a
cross-workspace transaction.

## Records preserve honest JSON

The canonical record store maps a permanent table key and runtime-allocated row
ID to a JSON object. It does not store the current application schema, a schema
hash, a row version, migration state, or generated historical definitions.

```text
("notes", "note_123") -> {
  "title": "Trip planning",
  "pinned": true,
  "futureKey": "preserved for another release"
}
```

The synchronization wire has three commands:

- `createRow` creates one complete JSON object and conflicts with an existing
  live row.
- `patchRow` replaces supplied keys and preserves omitted keys. Patching an
  absent row is an accepted no-op.
- `deleteRow` removes a live row. Deleting an absent row is an accepted no-op.

The server orders accepted patches. Devices keep complete local replicas so
point reads and bounded scans do not require hydrating an entire CRDT into
JavaScript memory. SQLite is runtime-owned storage for that canonical map, not
the portable user-data contract.

## Definitions are release-local lenses

`defineTable({ fields, optional })` describes how one release interprets JSON
under one table key. Field names are exact permanent storage keys. A field
validates one present value; the table lens decides whether the key is required
or optional.

A lens may change freely between releases. Existing rows may then be
nonconforming, and that is honest. Reads never fill defaults, follow aliases,
rename keys, or mutate stored data. `get()` returns a typed row or null inside
`Result`, or a nonconforming-record error. `scan()` returns typed rows alongside
diagnostics and raw canonical payloads that application repair code can inspect.

Typed creates admit only the current shape. Typed patches preserve unknown keys.
For an optional field, patching `undefined` means unset and removes the key;
canonical JSON never stores `undefined`. `null` remains an ordinary value when
the field accepts it.

There is no records migration framework. A developer who wants to repair old or
nonconforming data writes ordinary bounded application code:

```text
scan one page
  -> identify a known old shape
  -> patch the exact canonical keys
  -> persist the application cursor
  -> repeat safely
```

That work may be interrupted, retried, or omitted. Different releases may
disagree about conformance without forking or replacing the canonical store.

## SQL is a disposable view

Each SQLite connection installs one explicit-column `TEMP VIEW` per table lens.
The view projects the current release's field names from canonical JSON and is
read-only. It stores no rows, reflects canonical commits immediately, and
disappears when the connection closes.

Changing a lens therefore requires no projector, polling loop, materialized
table, index catalog, or rebuild. Opening a new connection creates the current
views, so stale columns do not survive an application reload. Full `field.*`
validation remains in the typed JavaScript path; SQL only supplies a convenient
storage-shaped query surface.

## Documents are top-level parameterized resources

Documents are declared once at workspace top level:

```ts
defineWorkspace({
  id: "skills",
  tables: { skills },
  documents: {
    instructions: document.text({
      params: { skillId: field.string() },
    }),
    preferences: document.keyValue({
      entries: { theme: field.select(["light", "dark"]) },
    }),
  },
});
```

Parameters express the domain relationship without coupling document ownership
to a table declaration. A caller opens `instructions` with `{ skillId }`; the
runtime derives the room identity from its authority binding, workspace,
declaration, format, and canonical parameters. Application code never supplies
a GUID or authority identity.

Every document opens lazily as a revocable lease. Releasing the final lease may
unload live Yjs state, but it does not delete persisted or synchronized updates.
The runtime keeps its room catalog private so it can reopen, synchronize, or
export known rooms without exposing an arbitrary string room registry.

The current runtime persists and reconstructs those room manifests. A
user-facing ownership-export orchestrator that packages the logical record
snapshot, document manifest, and document updates is intentionally deferred. It
is not a release gate for replacing the old workspace runtime. When added, it
must follow the inert ownership-export contract in ADR-0122 rather than expose
live replica files or public room identities.

`document.keyValue` is a document shape, not a separate workspace KV plane.
Entries validate present values and return `undefined` when absent. Application
code owns release-local fallback values.

Records and documents do not share a transaction or cascade. A document may
take a record ID as a parameter, but deleting the record neither unloads nor
deletes that document. Cleanup is an explicit document/runtime operation only
when a product earns permanent deletion semantics.

## Placement rule

The required conflict boundary chooses the storage primitive:

1. Use records for identified, queryable facts where server-ordered replacement
   of a complete key preserves acceptable intent.
2. Use a document when concurrent edits inside a value must merge, such as text,
   rich structure, or independent key-value entries.
3. Keep device-local, secret, or privacy-sensitive settings outside the
   synchronized workspace unless the product explicitly defines another owner.

Size alone does not choose the plane. Records already work offline, and a large
record collection remains bounded in JavaScript memory. Documents earn their
Yjs history and lifecycle cost through merge semantics, not merely because a
value is called content.

If two values must change atomically, they must share one authority. Ordinary
application composition cannot turn records and documents, or two workspaces,
into one transaction.

## Current transition

The canonical model is exported from `@epicenter/workspace/sqlite`. New
definitions use `runtime.open(definition)`, release-local tables, top-level
parameterized documents, and read-only SQL.

The root `@epicenter/workspace` API is still active for apps not yet migrated.
It stores tables and KV in a root Y.Doc and exposes definition-owned
`create/connect/mount`, `defineKv`, `.docs`, and `_v`. Preserve those consumers
until each app moves, but do not treat that compatibility lane as the canonical
SQLite architecture or add its concepts to new SQLite definitions.
