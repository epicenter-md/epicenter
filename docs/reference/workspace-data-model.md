# Workspace data model

A workspace owns queryable records, stable synchronized preferences, and
collaborative documents attached to record identities. Each plane has one
distinct lifecycle and synchronization model.

That sentence is the target architecture. It is also the rule for deciding
where new data belongs.

```text
workspace
|-- active records epoch
|   `-- records database
|       `-- record tables
|           `-- records
|               |-- stable row id
|               `-- named atomic cells
|-- synchronized KV
`-- child-document namespace
    `-- documents addressed through table + row id + document name + format
```

An app may compose several workspaces. Each workspace keeps one stable identity
while its three storage planes evolve independently.

## Records are identified rows of atomic cells

A record is one identified row in a typed table. It consists of a stable row ID
and named atomic cells, and it has an explicit create, update, and delete
lifecycle.

```text
notes table
`-- note record
    |-- id: "note_123"
    |-- title: "Trip planning"
    |-- pinned: true
    `-- updatedAt: "2026-07-12T18:30:00Z"
```

A cell is atomic because assigning it replaces its complete value. Concurrent
assignments to different cells compose; concurrent assignments to the same cell
resolve by server acceptance order. A value that needs character-level or
structural merging is not a cell; it belongs in a child document.

A table is the typed collection that organizes records. The records database is
the complete queryable collection of those tables under one immutable records
schema. The name describes the logical product data, not its physical storage:

```text
logical records database
|-- authority: canonical rows, mutations, snapshots, and head
`-- each device: local SQLite materialization
```

SQLite pages, indexes, triggers, cursors, outboxes, and mutation history do not
define the logical records database. A local SQLite layout may change without
changing the records schema.

Use records for product facts that need identity, queries, relationships,
explicit creation or deletion, or atomic updates alongside other fields. A
record can be primary product data, not merely metadata.

## KV is the stable preference plane

Workspace KV is a bounded set of synchronized preferences. Its identity is
independent of the active records epoch.

```text
editor.theme
sidebar.collapsed
transcription.language
```

KV has no row identity or record lifecycle. Missing or invalid values read as
fresh defaults, and a semantic change normally uses a new dot-namespaced key.
KV does not participate in records snapshots, imports, schema hashes, or
records-epoch replacement.

Use KV for bounded settings and preferences that do not need to change
atomically with a record. A value that must commit with a record belongs in
that record. Device-local or privacy-sensitive settings belong in device
storage, not workspace KV.

## Child documents hold merge-sensitive content

A table may declare child-document slots for its records. A child document is a
separate, lazy Yjs document with a format capability such as plain text, an XML
fragment, or validated keyed records.

```text
note record
|-- records database: title, pinned, updatedAt
`-- child document: body
```

The record supplies the product relationship and part of the address, but it
does not contain the document bytes. The workspace derives a document address
from the workspace, table, a collision-resistant digest of the full row ID,
document name, and format identity. The digest accepts application IDs without
turning the room-address grammar into a record-schema restriction. Opening the
document owns its persistence, synchronization, caching, readiness, and
disposal.

Not every table declares documents, and a declared document remains unopened
until a caller needs it. Child-document formats have compatibility identities
independent of the records schema. Adding a document or changing its format
does not replace records or start a new records epoch.

Fields and documents use separate declaration namespaces. A field and a child
document may both be named `body`: callers still distinguish `row.body` from
`table.docs.body`. Matching names do not make the two planes consistent or
choose an authority. Table and document names participate in persistent room
addresses, so renaming either creates new document identities and requires an
explicit conversion when content must carry forward. Capability-owned internal
Yjs root names are isolated from both public maps.

Use a child document when independent edits inside one value must survive and
converge. Do not put a large JSON object in one cell and expect its members to
merge; an atomic JSON cell is still replaced as a whole.

## The planes compose without sharing lifecycles

The workspace is the stable owner that composes the three planes:

| Plane | Unit | Best for | Evolution |
| --- | --- | --- | --- |
| Records epoch | Identified record | Queryable product facts and metadata | Ordinary mutations; disruptive replacement starts a new epoch |
| Synchronized KV | Declared key | Bounded preferences with defaults | Keep the stable KV identity; use a new key for a new meaning |
| Child documents | Format-addressed Yjs document | Merge-sensitive bodies and collections | Convert one document explicitly into a new format-addressed document |

The separation is intentional. A universal migration system would need to scan
lazy documents, coordinate different authorities, support cross-plane
transactions, and reconcile dual writers. Epicenter refuses that abstraction.
Moving data between records and child documents is an explicit app-owned
authority transfer that chooses one authoritative plane after cutover.

The current table path opens the declared target. A converter uses
`historicalDocument(...)` to name one retained source and
`workspace.documents.open(reference, rowId)` to open it through the same
workspace runtime. Both handles are typed by their format capabilities. This is
not a registry or scan: the application must know the old coordinates and the
row ID. Format hashing prevents incompatible bytes from mixing; by itself it
does not copy content, acknowledge target durability, atomically switch
authority, or stop old clients editing the old room. Opening both handles is a
copy and initialization seam, not a completed authority transfer.

## Schema identity follows the owned data

The records schema hash includes record tables and fields only. Workspace
identity, KV declarations, child documents, local indexes, and physical SQLite
storage do not enter it.

This gives each compatibility boundary one owner:

```text
record tables + fields  -> records schema hash
child-document content  -> document format hash
KV preferences          -> stable workspace KV identity
physical SQLite layout  -> runtime storage version
```

Ordinary record changes use ordinary mutations. A synchronized schema change,
restore, or wholesale rewrite installs a complete logical snapshot as a new
records epoch. The workspace, its KV preferences, and its child-document
addresses remain stable.

## Placement rule

The merge unit chooses the storage plane. Store a value in records when
server-ordered replacement of the whole cell preserves acceptable intent. Use a
child document when independent edits inside one value must survive and
converge.

Size does not choose the storage plane. Offline availability does not choose it:
records already support offline work. The required conflict boundary does.

Ask these questions in order:

1. Does this value need an identified create, update, and delete lifecycle, or
   direct queries and relationships? Put it in a record.
2. Does it need concurrent edits to merge inside the value? Put it in a child
   document declared by the relevant table.
3. Is it a bounded synchronized preference with a sensible default? Put it in
   workspace KV.
4. Is it local to one device, secret, or privacy-sensitive? Keep it outside the
   synchronized workspace.

A database-style spreadsheet can remain records when each logical cell is an
acceptable replacement boundary. A workbook with concurrent structural edits,
range operations, and collaborative undo may instead earn a dedicated document
format. The product label "spreadsheet" does not decide the model; its required
concurrent operations do.

The hard boundary is atomicity. If two values must change atomically, they must
share an authority. Convenience alone is not a reason to cross storage planes.

## Current transition

The SQLite records path implements this target model under
`packages/workspace/src/sqlite`. The older public workspace path still stores
tables and KV in a root Y.Doc while the records-authority work lands. Treat that
implementation as migration context, not as the target definition of a
workspace.

This page collects the shared product model from the records-authority design.
The ADRs retain the detailed protocol and evolution rationale.
