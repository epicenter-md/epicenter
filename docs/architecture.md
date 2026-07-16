# Epicenter architecture

Epicenter is a local-first workspace platform. Apps define stable workspace
families, clients keep complete local data, and a hosted or self-hosted star
keeps devices synchronized while they sleep.

The workspace model is the center of the architecture:

> A workspace runtime owns a complete schema-opaque record map and lazily
> opened collaborative documents. Release-local definitions validate and
> project that data without migrating it.

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
`@epicenter/field` supplies the release-local projection vocabulary. The record
protocol orders schema-opaque JSON mutations; Yjs sync carries independently
addressed documents. Middleware turns those capabilities into reactive state,
filesystems, agent tools, and other app-shaped surfaces.

## A workspace composes two storage planes

The workspace is the stable app-defined identity and access-policy boundary. A
runtime binds it to one authority and owns a complete canonical record replica
plus a private catalog of declared Yjs rooms.

```text
workspace
|-- canonical record map
|   `-- (table key, row id) -> schema-opaque JSON object
`-- document catalog
    `-- lazily opened Yjs rooms selected by declared domain parameters
```

There is no user-data schema migration or records-database succession. A new
release may change its lens immediately. Nonconforming rows remain stored and
visible to repair code.

### Records are queryable product facts

A canonical record is an identified JSON object under a permanent table storage
key. It has explicit create, patch, and delete lifecycles. Field names are exact
permanent storage keys. The platform never renames, aliases, defaults, or heals
them implicitly.

Every synchronized device keeps a complete SQLite replica of the canonical
map. The server orders record commands and stores current state, receipts,
temporary deletion markers, and snapshots. It does not synchronize a device's
SQLite file. Local indexes, pages, cursors, outboxes, and SQL views are runtime
state.

### Table definitions are release-local lenses

`defineTable` names a permanent table key and uses `field.*` to validate present
values. It is not a storage schema. Typed `get` and `scan` return honest lens
errors for nonconforming rows, while repair code can scan raw invalid rows and
patch them with ordinary bounded writes.

Connection-local SQLite TEMP VIEWs project valid fields for read-only SQL.
Wrong or missing values become `NULL` in the projection. The views are rebuilt
when a connection opens with a different release-local lens; no materialized
projection or lens-derived index is synchronized.

### Documents are for merge-sensitive content

Every document declaration is top-level and parameterized by domain values when
it needs cardinality. A record relationship is ordinary application
composition:

```ts
documents: {
  instructions: document.text({ params: { skillId: field.string() } }),
  preferences: document.keyValue({ entries: { theme: field.string() } }),
}
```

The runtime derives private authority and storage identity from the declaration
and validated parameters. Public code never supplies a GUID, authority ID,
storage key, provider, or manual synchronization command. Opening awaits local
hydration, then the runtime attaches remote synchronization. Releasing the last
lease unloads live state without deleting persisted content.

## Definitions travel; runtimes connect them

The shared workspace definition is pure. It names release-local table lenses
and document declarations without opening storage or a network connection.

```text
defineWorkspace({ id, tables, documents })
        |
        | pure app contract
        v
runtime.open(definition)             Browser, Bun, or desktop runtime
```

One runtime may open several imported workspace definitions. Ordinary
TypeScript composes the returned handles. Opens and failures remain independent;
there is no surface registry, cross-workspace transaction, or all-or-nothing
application boot.

Runtime openers supply the resources that cannot travel with the definition:
browser storage, a record authority connection, Yjs collaboration, daemon
persistence, materializers, auth, and platform APIs. App-facing code should
enter through the workspace definition instead of rebuilding addresses or
storage topology itself.

## The records path

Record writes use three mechanical commands:

```text
createRow(table, rowId, JSON object)
patchRow(table, rowId, set keys, unset keys)
deleteRow(table, rowId)
```

The authority orders accepted commands and folds them into current state. Each
device applies the same ordered changes to its complete local SQLite replica.
The log is transport intent, not permanent product history. Applications retain
typed table helpers and read-only SQL without making physical SQLite files the
wire format.

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

Document edits follow their own Yjs path. The workspace composes these paths but
does not pretend records and documents share one conflict model or transaction.

## Lens evolution never migrates user data

Definitions are views over durable JSON. A release may add a required field,
remove a field, or change validation. Rows that no longer conform remain
preserved as invalid data. The runtime does not copy a database, execute an
upcaster, add fallback keys, or reinterpret old writes.

When product semantics require conversion, the application owns a normal,
explicit repair loop. It may recognize an old TypeBox shape, compute the new
value, and issue bounded typed patches. Mixed releases may disagree until the
repair converges; that is honest application behavior rather than a platform
migration protocol.

```text
canonical JSON stays unchanged
        |
        +-- old release lens -> one interpretation
        `-- new release lens -> valid rows plus explicit invalid rows
```

## The star owns availability, not application meaning

A star is the runnable deployment that holds a person's synchronized data. The
hosted Cloud app and the self-hosted instance use the same shared server library
but resolve principals differently.

The records authority owns ordering, current rows, receipts, deletion markers,
and snapshots. It remains schema-blind: application releases own field
validation and explicit repair code. Yjs rooms carry collaborative document
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
truth. Use this architecture to judge conversions, delete legacy branches, and
prevent the root-Y.Doc topology from leaking back into the selected vocabulary.
