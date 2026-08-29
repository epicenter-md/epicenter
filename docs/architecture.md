# Epicenter architecture

Epicenter is a local-first personal data platform. An application holds a
complete replica of its own data and reads it synchronously; a hosted or
self-hosted authority keeps a person's devices converged while they sleep.

This page is the five-minute map. Durable decisions live in
[`docs/adr`](adr/README.md). Shared vocabulary lives in
[`docs/CONTEXT.md`](CONTEXT.md). Package-owned current behavior belongs in
package READMEs and code. For how this replaced the previous stack, verb by
verb, see
[`the store and what it replaced`](the-store-and-what-it-replaced.md).

## One runtime

A desktop SPA in a WebView, over a store the client owns (ADR-0227). The Bun
host serves bundles and brokers credentials. It owns no application data and
constructs no database (ADR-0226).

Serving that same bundle over HTTP is not a second runtime, because there is no
platform seam left to differ: every build opens its own store. What ADR-0227
refused was a hosted surface that reached a host-owned replica instead.

## The stack

```text
+---------------------------------------------------------------------------+
| APPS                                                                      |
|                                                                           |
| honeycrisp   whispering   vocab   skills   epicenter   sync-lab           |
| api          self-host    landing  matter  local-books  local-mail        |
+---------------------------------------------------------------------------+
                                     |
                                     v
+---------------------------------------------------------------------------+
| SURFACE                                                                   |
|                                                                           |
| @epicenter/ui        @epicenter/app-shell     @epicenter/svelte         |
| @epicenter/chat      @epicenter/blobs         @epicenter/skills           |
+---------------------------------------------------------------------------+
                                     |
                                     v
+---------------------------------------------------------------------------+
| CORE                                                                      |
|                                                                           |
| @epicenter/data      the store and its definition, opener, sync, and SQL surfaces |
| @epicenter/field     release-local field declarations                     |
| @epicenter/sqlite    one engine seam over bun:sqlite and sqlite-wasm      |
| @epicenter/sync      route contracts a browser can import                 |
| @epicenter/server    the shared Hono library both deployables consume     |
+---------------------------------------------------------------------------+
```

`@epicenter/data` has one definition entry point and five runtime entry points:
`.` for the opened data surface, `./definition` for `defineData` and
`parseData`, `./bun` and `./browser` for the two openers, `./sync` for the
transport, and `./projection` for the SQL follower. The openers are separate
because one imports `bun:sqlite` and the other a WASM build, and neither belongs
in a barrel the other has to load.

`@epicenter/server` is AGPL and the core packages above it are MIT. Moving code
across that line is a relicensing act; see
[`licensing strategy`](licensing/licensing-strategy.md).

## An application has one scalar document

One scalar `Y.Doc` per application is persisted under the application log name
`app` (ADR-0257). Its current top-level roots are the bare named root `kv` and
one `tables:<name>` root for each declared table.

```text
Y.Doc "app"
 |- get("kv")               one value: this application's settings
 |- get("tables:notes")
 |   |- <rowId>             a nested Y.Type; holding it IS existing
 |   |   |- title           a field is an attribute on the row
 |   |   `- folderId
 |   `- <rowId> ...
 `- get("tables:folders")
```

A row is an attribute on its table root rather than a root of its own. That is
not a style choice: `Item.write` scans `doc.share` linearly, so one root per row
makes encoding quadratic, measured at 5,417 ms against 13 ms at 20,000 rows.
Deletion removes the row's attribute outright and the whole subtree goes with
it, which leaves one deleted map key rather than a permanent corpse.

## Prose is a plane beside the row, not a field in it

Each row owns one independent Yjs document at its derived address,
`{dataId}/{tableName}/{rowId}` (ADR-0248). The application names roots
inside it and Epicenter never looks inside one. Opening is a load, awaited,
and the handle that comes back is fully hydrated:

```ts
const { data: handle } = await data.tables.notes.openDocument(noteId);
const body = handle?.get('body'); // a Y.Type an editor binds to directly
handle?.[Symbol.dispose]();
```

Roots are minted by name on first use, which is safe in an independent
document: a top-level root is addressed by its name, so two devices
first-opening one note converge with both writes retained. Deleting the row
durably retires the document address in the same atomic step, so a late write
cannot resurrect it. Lists and previews read scalar fields and never hydrate
rich documents.

## What granularity an edit has

| edit | merge |
| --- | --- |
| two devices, different fields of one row | both survive |
| two devices, one scalar field | last write wins |
| two devices, one array or object field | last write wins on the WHOLE value |
| two devices, prose in a row's document | per character |

The third row is a decision, not a gap (ADR-0228). A field is one value, which
is one sentence of semantics instead of a per-field CRDT type system. The cost
is that a set several devices append to concurrently loses an addition, and the
answer is that such a collection wants to be a table, where each element is its
own row and nothing collides.

## Data definitions never migrate user data

A data definition is a release-local view over durable JSON (ADR-0255). A
release may add a field, remove one, or change validation. Rows that no longer
conform stay exactly as written and surface as nonconforming for that release.
Nothing copies a database, runs an upcaster, or reinterprets an old write.

Prevention is not available and asking for it is the wrong axis. A declaration is
release-local and rows arrive from NEWER releases, so no discipline in this
release stops a future one retyping a field. What exists instead is the material
to heal: `list()` returns `{ rows, nonconforming }`, each failure carries its
`address`, machine-readable `issues`, the `conforming` survivors and the
unmodified `raw`, a composed SQL projection stores nonconforming rows raw so
SQL can still show them, and repair is an ordinary `update` because a patch
validates only the values it supplies.

```text
durable JSON stays unchanged
        |
        +-- old release's declaration -> one interpretation
        `-- new release's declaration -> typed rows plus nonconforming diagnostics
```

## Reads are synchronous

Opening a store is the only asynchronous operation in an application. It is real
I/O: a file or an IndexedDB read, and the replay of a durable log. Everything
after it is a property access on a document already in memory.

```ts
const { data, error } = await openLocal(honeycrispDefinition);
if (error !== null) throw error;

const listed = data.tables.notes.list();          // { rows, nonconforming }
data.tables.notes.update(noteId, { title: 'x' }); // a transaction
data.tables.notes.subscribe((rowIds) => { ... }); // the ids a commit touched
```

`subscribe` names the rows a commit touched (ADR-0221), so a view refreshes
what moved rather than everything. SQL, when an application wants it, is a
follower it composes over this surface, rebuilt from the live document at the
next read (ADR-0241). The package shipped one and nothing composed it, so it
was deleted (ADR-0269): a person who wants to read their data outside the app
reads the export, which is Markdown files (ADR-0268).

## Where the durable facts live

The store keeps exactly the ledgers a crash cannot reconstruct: the update
log, the outbox, the cursor, and the document identity (ADR-0241). In the
browser, which is the runtime an application opens (ADR-0269), they are small
IndexedDB relations: `updates`, `outbox`, `tombstones`, `meta` (ADR-0223,
ADR-0238). There is no worker and no OPFS, and nothing derived is ever
restored, only rebuilt.

History lives outside the CRDT (ADR-0214). The document runs with garbage
collection on, which is what collapses a field edited five thousand times to two
structs.

## The authority owns availability, not meaning

One Durable Object per principal and application, named
`principals/<id>/stores/<ns>`, keeping a snapshot and a tail (ADR-0220,
ADR-0225). It appends opaque bytes and reads nothing about their meaning.

Being signed in is the whole of the sharing model. The route stamps the
principal from the bearer and addresses one Durable Object by it, so every
device on one account converges without anything being paired or invited.

The host supplies only `dial`, a function that makes a socket. The library owns
the cursor, attach and detach, reconnect on close and on `needsResync`, and the
unacknowledged-submission watchdog (ADR-0222).

Blobs are a separate plane and were never CRDT-backed. They are content
addressed bytes logged against the server, with local ones queued until they
are uploaded.

## Two deployables, one library

`packages/server` is the shared Hono library. `apps/api` is the hosted personal
cloud and `apps/self-host` is the self-hosted single-partition instance
reference, which is community-supported rather than Epicenter-operated. They
differ by principal resolver: an instance resolves every valid bearer to the
literal `instance` principal (ADR-0075, amended by ADR-0092). Billing is
hosted-only and lives in `apps/api/worker/billing/`.

## What is broken right now

ADR-0227 was executed as a clean break, so the applications that had not moved
are broken on purpose and their data on the old stack is gone: `apps/whispering`,
`apps/vocab`, `apps/skills`, `apps/epicenter`, `packages/chat`,
`packages/skills`, and `packages/app-shell`'s agent chat. Green:
`packages/data`, `packages/field`, `packages/sync`, `packages/sqlite`,
`packages/svelte-utils`, `apps/api`, `apps/self-host`, `apps/honeycrisp`, and
`apps/sync-lab`.
