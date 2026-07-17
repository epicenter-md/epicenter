# Epicenter architecture

Epicenter is a local-first workspace platform. Apps define stable workspace
families, clients keep complete local data, and a hosted or self-hosted star
keeps devices synchronized while they sleep.

The workspace model is the center of the architecture:

> A workspace runtime owns complete canonical rows, reserved workspace KV, and
> one latent collaborative document per ordinary row. Release-local definitions
> validate and project that data without migrating it.

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
| @epicenter/workspace   @epicenter/row-sync   @epicenter/sync            |
| @epicenter/field       @epicenter/constants     @epicenter/ui              |
+----------------------------------------------------------------------------+
```

`@epicenter/workspace` owns the app-facing data contract and runtime handles.
`@epicenter/field` supplies the release-local projection vocabulary. Row sync
orders schema-opaque fields and carries row-owned Yjs updates through one
authority. Middleware turns those capabilities into reactive state,
filesystems, agent tools, and other app-shaped surfaces.

## A workspace owns one row authority

The workspace is the stable app-defined identity and access-policy boundary. A
runtime binds it to one authority and owns a complete canonical replica.

```text
workspace
|-- ordinary rows
|   `-- (table key, row id) -> fields + latent row document
`-- reserved workspace KV row
```

There is no user-data schema migration or records-database succession. A new
release may change its lens immediately. Nonconforming rows remain stored and
visible to repair code. Row documents are not rooms or a second authority.

### Records are queryable product facts

A canonical record is an identified JSON object under a permanent table storage
key. Its whole mutation vocabulary is one `RowIntent`: create, update, and
delete (ADR-0131). Field names are exact permanent storage keys. The platform
never renames, aliases, defaults, or heals them implicitly.

Every synchronized device keeps a complete SQLite replica: confirmed authority
state plus its own compacted sealed and open RowIntents (ADR-0134). The server
folds sealed rounds in authority order and stores current rows, exact-retry
receipts, and a bounded ordered outcome tail; a replica below the retention
floor reacquires state through a disposable baseline scan (ADR-0136). It does
not synchronize a device's SQLite file. Local indexes, pages, cursors, and SQL
views are runtime state.

### Table definitions are release-local lenses

`defineTable` names a permanent table key and uses `field.*` to validate present
values. It is not a storage schema. Typed `get` and `scan` return honest lens
errors for nonconforming rows, while repair code can scan raw invalid rows and
patch them with ordinary bounded writes.

Connection-local SQLite TEMP VIEWs project valid fields for read-only SQL.
Wrong or missing values become `NULL` in the projection. The views are rebuilt
when a connection opens with a different release-local lens; no materialized
projection or lens-derived index is synchronized.

### Every ordinary row owns merge-sensitive content

Every ordinary row has one lazy document under the same identity, liveness, and
authority as its fields:

```ts
using document = await workspace.tables.notes.document.open(note.id);

const editor = document.get('editor');
const comments = document.get('comments');
```

The application owns root names and their interpretation. The platform owns
document identity, hydration, update capture, persistence, synchronization, and
revocation. Opening checks row liveness and awaits local hydration. Releasing
the final lease unloads live state without deleting the row. Deleting the row
ends both its fields and document lifetime.

## Definitions travel; runtimes connect them

The shared workspace definition is pure. It names release-local table and KV
lenses without opening storage or a network connection.

```text
defineWorkspace({ id, tables, kv })
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
browser storage, the row authority connection, daemon persistence,
materializers, auth, and platform APIs. An opened handle exposes typed
`tables`, typed `kv`, and `records.sql`. App-facing code should enter through
that handle instead of rebuilding addresses or storage topology itself.

## The records path

Fields and document changes use one row-lifecycle vocabulary:

```text
create  complete fields, optionally with an initial document update
update  field set/unset changes, a document update, or both
delete  end the row lifetime, including fields and document
```

These are `RowIntent` variants. The authority orders accepted intents and folds
them into current state. Fields follow authority order; document content uses
Yjs merge within the same row lifetime. Each device applies the same composite
outcomes to its complete local SQLite replica. The log is transport intent, not
permanent product history. Applications retain typed table helpers, row
documents, KV, and read-only SQL without making physical SQLite files the wire
format.

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
row authority
        |
        v
composite row outcomes to other replicas
```

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

The records authority owns ordering, current rows, exact-retry receipts, and a
bounded ordered outcome tail. It remains schema-blind: application releases own
field validation and explicit repair code. Row-owned collaborative document
updates travel inside RowIntents and composite outcomes on the same authority
(ADR-0133). The blob store holds large binaries by reference.

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
