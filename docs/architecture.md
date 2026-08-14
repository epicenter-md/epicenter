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
| @epicenter/ui        @epicenter/app-shell     @epicenter/svelte-utils     |
| @epicenter/chat      @epicenter/blobs         @epicenter/skills           |
+---------------------------------------------------------------------------+
                                     |
                                     v
+---------------------------------------------------------------------------+
| CORE                                                                      |
|                                                                           |
| @epicenter/data      the store, and the transport that carries it         |
| @epicenter/workspace      the workspace declaration vocabulary                  |
| @epicenter/field     release-local field declarations                     |
| @epicenter/sqlite    one engine seam over bun:sqlite and sqlite-wasm      |
| @epicenter/sync      route contracts a browser can import                 |
| @epicenter/server    the shared Hono library both deployables consume     |
+---------------------------------------------------------------------------+
```

`@epicenter/data` has exactly four entry points: `.` for the store, `./bun` and
`./browser` for the two openers, and `./sync` for the transport. The openers are
separate because one imports `bun:sqlite` and the other a WASM build, and
neither belongs in a barrel the other has to load.

`@epicenter/server` is AGPL and the core packages above it are MIT. Moving code
across that line is a relicensing act; see
[`licensing strategy`](licensing/licensing-strategy.md).

## An application is one document

One `Y.Doc` per application (ADR-0215). Its top-level roots say what kind of
thing they are: `tables:<name>` for each declared table, `kv` for settings, and
nothing else.

```text
Y.Doc
 |- kv                      one value: this application's settings
 |- tables:notes
 |   |- <rowId>             a nested Y.Type; holding it IS existing
 |   |   |- title           a field is an attribute on the row
 |   |   |- folderId
 |   |   `- !doc            a container, allocated WITH the row
 |   |       `- body        an application-named root an editor binds to
 |   `- <rowId> ...
 `- tables:folders
```

A row is an attribute on its table root rather than a root of its own. That is
not a style choice: `Item.write` scans `doc.share` linearly, so one root per row
makes encoding quadratic, measured at 5,417 ms against 13 ms at 20,000 rows.
Deletion removes the row's attribute outright and the whole subtree goes with
it, which leaves one deleted map key rather than a permanent corpse.

## Prose is a plane beside the row, not a field in it

A row's `!doc` container holds roots the application names, and Epicenter never
looks inside one. An editor binds to a root directly:

```ts
const body = db.notes.document(noteId)?.get('body');
```

Root names are declared when the row is created,
`db.notes.create({ ... }, { document: ['body'] })`, and that is what makes them
safe. Reaching for a root lazily is a write at a well-known address, so two
devices first-opening one note would each mint their own and map LWW would
discard one along with everything written into it. Allocating at creation leaves
exactly one creator, and minted row ids make that moment unraceable.

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

## Workspace evolution never migrates user data

A workspace declaration is a release-local view over durable JSON (ADR-0125, ADR-0213). A release
may add a field, remove one, or change validation. Rows that no longer conform
stay exactly as written and surface as nonconforming for that release. Nothing
copies a database, runs an upcaster, or reinterprets an old write.

Prevention is not available and asking for it is the wrong axis. A declaration is
release-local and rows arrive from NEWER releases, so no discipline in this
release stops a future one retyping a field. What exists instead is the material
to heal: `list()` returns `{ rows, nonconforming }`, each failure carries its
`address`, machine-readable `issues`, the `conforming` survivors and the
unmodified `raw`, nonconforming rows stay in the SQL projection so `db.query`
still finds them, and repair is an ordinary `update` because a patch validates
only the values it supplies.

```text
durable JSON stays unchanged
        |
        +-- old release's declaration -> one interpretation
        `-- new release's declaration -> typed rows plus nonconforming diagnostics
```

## Reads are synchronous

Opening a store is the only asynchronous operation in an application. It is real
I/O: a file or an IndexedDB read, a WASM compile, and the replay of a durable
log. Everything after it is a property access on a document already in memory.

```ts
const { data: db, error } = await openDevice(honeycrispWorkspace);
if (error !== null) throw error;

const listed = db.tables.notes.list();          // { rows, nonconforming }
db.tables.notes.update(noteId, { title: 'x' }); // a transaction
db.tables.notes.subscribe((rowIds) => { ... }); // the ids a commit touched
db.query`select count(*) from notes`;           // this app's own projection only
```

`subscribe` fires after the projection commits and names the rows that changed
(ADR-0221), so a view refreshes what moved rather than everything.

## One SQLite file

The same file is the update log and the query projection. In the browser that is
an in-memory sqlite-wasm database on the main thread plus three small IndexedDB
relations: `_updates`, `_outbox`, `_cursor` (ADR-0223). There is no worker and
no OPFS. The projection is never restored, only rebuilt, which is what removed
the reason for both.

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
`packages/data`, `workspace`, `sync`, `sqlite`, `svelte-utils`, `apps/api`,
`apps/self-host`, `apps/honeycrisp`, `apps/sync-lab`.
