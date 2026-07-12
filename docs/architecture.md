# Epicenter architecture

Epicenter is a local-first workspace platform. Apps define stable workspace
families, clients keep complete local data, and a hosted or self-hosted star
keeps devices synchronized while they sleep.

The workspace model is the center of the architecture:

> A workspace owns queryable records, stable synchronized preferences, and
> collaborative documents attached to record identities. Each plane has one
> distinct lifecycle and synchronization model.

This page is the five-minute map. See the
[workspace data model](reference/workspace-data-model.md) for the placement rule
and [`docs/adr`](adr/README.md) for the decisions behind it.

## The stack

Apps compose middleware and core packages. Dependencies point downward; product
policy stays in the app that can name it.

```text
+----------------------------------------------------------------------------+
| APPS                                                                       |
|                                                                            |
| opensidian   whispering   tab-manager   vocab                              |
| honeycrisp   self-host    api           landing                            |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| MIDDLEWARE                                                                 |
|                                                                            |
| @epicenter/svelte      @epicenter/filesystem                               |
| @epicenter/skills      @epicenter/workspace/agent                          |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| CORE                                                                       |
|                                                                            |
| @epicenter/workspace   @epicenter/record-sync   @epicenter/sync            |
| @epicenter/field       @epicenter/constants     @epicenter/ui              |
+----------------------------------------------------------------------------+
```

`@epicenter/workspace` owns the app-facing data contract and runtime handles.
`@epicenter/field` supplies the persisted cell vocabulary. The record protocol
orders logical record mutations; Yjs sync carries KV and child-document
updates. Middleware turns those capabilities into reactive state, filesystems,
agent tools, and other app-shaped surfaces.

## A workspace family composes three storage planes

The workspace family is the stable app-defined identity and access-policy
boundary. It owns the selection of one current records database, one stable KV
namespace, and a namespace of child documents.

```text
workspace family
|-- current records database
|   `-- tables
|       `-- records
|           |-- stable row id
|           `-- named atomic cells
|-- synchronized KV
`-- child-document namespace
    `-- format-addressed Yjs documents reached through records
```

A records schema change replaces the selected records database. It does not
replace the workspace family, reset preferences, or rename child documents.

### Records are queryable product facts

A record is one identified row in a typed table. It has a stable row ID, named
atomic cells, and explicit create, update, and delete lifecycles. The records
database is the complete queryable collection of those tables under one
immutable logical schema.

Every synchronized device materializes the records database in local SQLite.
The authority stores the same logical records, mutations, snapshots, and
canonical head. It does not synchronize a device's SQLite file. Local indexes,
pages, triggers, cursors, and outboxes are runtime state rather than part of the
records schema.

### KV is for bounded synchronized preferences

Workspace KV stores declared preferences such as theme, language, or collapsed
UI state. It has one stable logical identity across records-database changes.
Missing or invalid values read as defaults; a new meaning normally gets a new
dot-namespaced key.

KV has no row lifecycle and does not participate in records snapshots,
migrations, imports, or schema hashes. A value that must commit atomically with
a record belongs in that record. Device-local and privacy-sensitive settings
belong in device storage.

### Child documents are for merge-sensitive content

A table may declare child-document slots for its records. Each opened child is
a separate lazy Yjs document with an Epicenter-owned format capability, such as
plain text, canonical rich text, or validated keyed records.

The record gives the document its product relationship and row identity, but
the document bytes do not live in the record. Its address includes the
workspace, table, row ID, document name, and document format hash. Document
format identity is independent of the records schema hash.

## Definitions travel; runtimes connect them

The shared workspace definition is pure. It names the family, tables, KV
preferences, actions, and child-document declarations without opening storage
or a network connection.

```text
defineWorkspace({ id, name, tables, kv, actions })
        |
        | pure app contract
        v
connect(...)                         browser or local runtime
mount(...)                           daemon runtime
```

`defineTable` declares fields and optional child documents. A field becomes one
atomic SQLite cell and one record-wire value. `defineKv` declares a preference
schema and a fresh default factory. Both use the same closed `field.*`
vocabulary, but they do not share a storage plane.

Runtime openers supply the resources that cannot travel with the definition:
browser storage, a record authority connection, Yjs collaboration, daemon
persistence, materializers, auth, and platform APIs. App-facing code should
enter through the workspace definition instead of rebuilding addresses or
storage topology itself.

## The records path

Record writes use three semantic operations:

```text
createRow(table, rowId, complete cells)
updateRow(table, rowId, changed cells)
deleteRow(table, rowId)
```

The authority orders accepted mutations and advances the database head. Each
device applies the same ordered stream to its complete local SQLite replica.
Applications retain typed table helpers and direct SQL queryability without
making physical SQLite files the wire format.

```text
app action / UI event
        |
        v
typed table operation
        |
        +----------------------+
        | local SQLite commit  |
        | local observation    |
        +----------------------+
        |
        v
record authority
        |
        v
ordered mutations to other replicas
```

Child-document edits follow their own Yjs path. KV edits use the eager KV Yjs
document. The workspace composes these paths but does not pretend they have one
conflict model.

## Schema evolution creates a successor

One records database has one immutable logical schema, identified by a
canonical hash of record tables and fields. A stored meaning change must be
visible in that schema.

After user approval, a trusted client reads a canonical logical snapshot,
validates its records against the historical descriptor, and builds a complete
successor database. The authority activates that successor only if the family
still selects the source database and its canonical head has not changed.

```text
source database A at head H
        |
        | validate + transform records
        v
candidate database B
        |
        | activate only if A is still current at H
        v
workspace family selects B; A is fenced
```

`defineRecordsMigration` owns this records-only transformation. It never opens
child documents or migrates KV. Child-document format conversion is explicit
and per-document. Moving authority between records and documents is an
app-owned maintenance operation rather than a universal migration feature.

## The star owns availability, not application meaning

A star is the runnable deployment that holds a person's synchronized data. The
hosted Cloud app and the self-hosted instance use the same shared server library
but resolve principals differently.

The records authority owns ordering, canonical heads, candidate storage, and
conditional activation. It remains schema-blind: trusted application clients
own field validation and migration code. Yjs rooms carry KV and child-document
updates. The blob store holds large binaries by reference.

This separation keeps the privacy question concrete. Epicenter can run the
star, or the user can run it. In either topology, apps keep their schema meaning
and product policy at the client boundary.

## Current transition

The SQLite records implementation lives under `packages/workspace/src/sqlite`
while the older public workspace path still stores record tables and KV in one
root Y.Doc. The older path is implementation history, not the target ownership
model described here.

During the transition, use the code and accepted ADRs as current implementation
truth. Use this architecture and the proposed records ADRs to judge the final
API, delete legacy branches, and prevent the root-Y.Doc topology from leaking
back into the product vocabulary.
