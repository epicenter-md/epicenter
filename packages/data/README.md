# @epicenter/data

The Epicenter store: one Yjs document per application, a synchronous surface
over it, and the transport that carries it between a person's devices. MIT.

Four entry points, and no more:

| Import | What it gives you |
| --- | --- |
| `@epicenter/data` | the store surface, plus the workspace vocabulary re-exported from `@epicenter/workspace` |
| `@epicenter/data/bun` | `open(workspace, { root })`, and `openMemory(workspace)` for tests |
| `@epicenter/data/browser` | `openDevice(workspace)`, and `openAccount(workspace, { principalId })` |
| `@epicenter/data/sync` | `createSyncConnection`, and the authority half a server runs |

A Bun opener imports `bun:sqlite` and a browser opener imports a WASM build, so
neither belongs in a barrel the other has to load. That is the whole reason the
openers live at their own entry points rather than on `@epicenter/data`.

## Opening is the only asynchronous thing

```ts
import { openAccount } from '@epicenter/data/browser';

const { data: app, error } = await openAccount(honeycrispWorkspace, {
	principalId,
});
if (error !== null) return handle(error);

const listed = app.tables.notes.list();          // no await
app.tables.notes.update(id, { title: 'Draft' }); // no await
```

A workspace names the store it opens (ADR-0229), so there is one call and one
name: the namespace is the document, the file, the folder and the authority
address. Nothing takes a path or a database name. In a browser the durable
address is derived from that namespace and the document named below rather
than supplied (ADR-0233), so a declaration still cannot open a store it does
not name. The runtime that comes back holds exactly this one definition for
its whole life (ADR-0240); a newer declaration reads the same durable data by
closing it and opening the next one.

In a browser the caller also names which durable document it means and whose it
is (ADR-0233). An application keeps one device document that never joins
workspace sync, and one retained replica per account:

```text
epicenter/<namespace>/device
epicenter/<namespace>/account/<principal id>
```

That address is the IndexedDB database name, so a workspace discard,
supersession, or rebuild can reach exactly one account's replica and never the
device document or another account's. An account replica cannot be opened
without an account: the argument is a union with nowhere to omit one, and an
empty id is refused with `StoreError.Unaddressable` rather than addressed.

Opening replays a durable log into one `Y.Doc`. After that every read is a
property access on a document already in memory, so nothing below returns a
promise.

Opening one address twice in a process is refused with
`StoreError.AlreadyOpen`. Two opens would be two `Y.Doc`s of one document that
cannot see each other's writes, so they would converge through storage under
last-writer-wins and quietly lose one side's work. The device document and
each account's replica are different documents, so any number of them may be
open at once.

## The surface

Each table the workspace declares is a key on `app.tables`. The file itself sits
under `app.store`, so a table can be named anything a person names it:

```ts
app.tables.notes.defaults                        // what a read supplies for unwritten keys
app.tables.notes.create(fields, options?)        // Result<Row>, at a minted 24-character id
app.tables.notes.get(id)                         // Result<Row | undefined, NonconformingRow>
app.tables.notes.update(id, patch)               // Result<void>; merges; refuses an absent address
app.tables.notes.delete(id)                      // boolean: was there a row to take?
app.tables.notes.ids()                           // string[], sorted
app.tables.notes.list()                          // { rows, nonconforming }
app.tables.notes.document(id)                    // RowDocument | undefined
app.tables.notes.subscribe(listener)             // returns its own unsubscribe
```

Settings live on `app.kv`, which has `get()`, `update(patch)`, `subscribe`, and
`defaults`. There is no id and no `create`, because there is exactly one and it
always exists.

SQL, when an application wants it, is a follower it composes over this
surface: `createSqliteProjection` from `@epicenter/data/projection` hydrates
from `list()`, follows commits through `store.onCommitted`, and rebuilds
whole at the next `query`, so SQL can never serve rows the live document has
moved past (ADR-0241).

`app.store` carries the document itself: `pressure()` (how much of it is dead
weight), `onCommitted` (anything committed, whoever wrote it),
`persistence` (whether accepted work has reached durable storage, ADR-0238),
and `sync`, the value that tells the two store kinds apart (ADR-0239):
`undefined` on a device document, and `{ get, subscribe }` over
`{ document }` on an account replica. They live under one key rather than
beside the tables so that no table name is reserved: `kv` is the only one a
workspace refuses, and that is because KV projects as a SQL relation of that
name.
The delivery machinery underneath sync (the outbox, cursors,
acknowledgements) is internal; only the transport drives it.

### Reading

`list()` returns the rows this release could read and the ones it could not,
side by side, as a plain object:

```ts
const { rows, nonconforming } = app.tables.notes.list();
```

It is not a `Result`, because nothing in it can fail: reads come from a
document already in memory. A disposed store throws `StoreUnusableError`
instead of dressing that up as a read outcome (ADR-0237). The old shape
returned a `Result` here, and `.data?.rows ?? []` quietly rendered an
operational failure as "you have never written one of these"; the throw makes
that unwritable. Storage falling behind is not a read outcome either: the
store keeps serving the live document and reports through
`store.persistence` (ADR-0238). Discarding `nonconforming` is still the trap
it always was: rows a person wrote are simply missing from the screen with
nothing to explain why.

A point read's one error is a live row this declaration cannot fully read, as plain
diagnostic data: `{ id, raw, conforming, issues }`, no `name` and no
`message`, because there is nothing else in the arm to tell it apart from.
Recover with `??` and never with a destructuring default. An `Err` sets `data`
to `null`, and `= fallback` fires only on `undefined`:

```ts
const { data, error } = app.tables.notes.get(id);
const note = data ?? { ...app.tables.notes.defaults, ...error?.conforming };
```

### Reacting

`subscribe` fires once per commit, carrying the row ids that commit touched
(ADR-0221). It fires for a local write, for prose typed into a row's document,
and for bytes that arrived from another device alike, and it fires after every
`onCommitted` listener has run, so a composed follower (like the SQL
projection) is already marked dirty by the time a subscriber reads through
it.

Registration is synchronous, does no I/O, and never fires initially, so a
caller that subscribes and then reads has already seen everything. There is no
generation counter to keep and no `refresh()` to remember:

```ts
function read() { /* the read above */ }
read();
const stop = app.tables.notes.subscribe(read);
```

`app.kv.subscribe` takes a listener with no arguments. KV is one value at a
name-addressed root, so there are no ids to carry.

## The shape of the data

One `Y.Doc` per application. Its top-level roots are `tables:<name>` for each
declared table and `kv` for settings, and nothing else, so dumping `doc.share`
reads as a description of the application.

```txt
Y.Doc
├── tables:notes
│   ├── <rowId>        a nested Y.Type: the row
│   │   ├── title      an attribute: a field
│   │   ├── folderId
│   │   └── !doc       the reserved container this row's prose lives in
│   └── <rowId>
├── tables:folders
└── kv
```

**A row is an attribute on its table root, not a root of its own.** That is a
measured decision: `Item.write` calls `findRootTypeKey`, a linear scan of
`doc.share`, so one root per row makes encoding quadratic in rows, at 5,417 ms
for 20,000 rows against 13 ms nested. Deletion takes the row's attribute off the
root, and the whole subtree goes with it.

Row ids are always minted, never chosen. A row is a nested container addressed
by the operation that created it, so two devices creating one chosen id produce
two containers and map LWW discards one **with every field in it**. Anything an
application wants to name by hand goes in `kv`, where independent minting
converges (ADR-0216).

### Prose

A row's document container is allocated when the row is created, never lazily
on first access, and the application names the roots inside it at that moment:

```ts
app.tables.notes.create(fields, { document: ['body'] });

const body = app.tables.notes.document(id)?.get('body'); // a live Y.Type
```

`get(name)` creates on miss, and a created nested type is addressed by the
operation that made it, so two devices first-opening one note would each mint a
root at that key and lose one along with everything typed into it. Naming it at
`create` leaves exactly one creator.

What comes back is a `Y.Type` an editor binds to directly. Nothing to open,
await, dispose, or poll. Epicenter allocates the container with the row,
collects it with the row, picks no format, and never looks inside.

## What merges with what

Not uniform, and worth knowing exactly, because it decides how a field should be
shaped.

| Where | Granularity |
| --- | --- |
| two fields of one row | independent, both survive |
| one scalar field | last write wins, converged |
| one array or object field | last write wins on the WHOLE value |
| a row document | per character |
| the SQL projection | a cache derived from the CRDT |

A row is an attribute map and a write sets only the attributes handed to it, so
two devices editing different fields of one row offline both keep their edit.
That is also what makes an old release safe to write with: it cannot clobber a
field it does not know.

**An array or object field is one value, and replacing it wholesale is kept on
purpose** (ADR-0228). The alternative is a per-field CRDT type system, and every
entry in it is a second merge semantics an author has to learn and two releases
can disagree about. The price is bounded and nameable: a collection several
devices append to concurrently will lose an addition. The escape hatch needs no
new machinery, because the store already has a per-element merge primitive.
**A collection several devices write independently wants to be a table**, where
each element is its own row, nothing collides, and deletion is a real operation
rather than an array splice that races.

## The workspace declaration

A workspace is one application's complete declaration of its durable data
domain: pure JSON, arktype expression strings, defaults declared inline
(ADR-0213, ADR-0240). It creates no storage and no lifecycle, and it never
migrates user data (ADR-0125). It is still release-local in one honest sense:
a newer release ships a newer declaration and reads the same durable data
through it.

```ts
const notes = defineTable({
	title: 'string',
	folderId: 'string|null = null',
	createdAt: 'string.date.iso',
});

export const notesWorkspace = defineWorkspace({
	namespace: 'com.example.notes',
	kv: defineKv({ theme: "'light'|'dark' = 'light'" }),
	tables: { notes },
});
```

`defineTable` and `defineKv` are validation identities: the returned value is
the argument, and arktype's compile error lands on the ingredient the app
wrote, which is also what lets `RowOf<typeof notes>` name a row type without
`as const`.

Each `tables` property name is that table's durable name forever: it is what a
row address carries, what the projection's relation is called, and what
`SELECT * FROM notes` names. There is no second key to keep in step, and no
rename, because a different property name is a different address and therefore
different data.

Three rules bite immediately:

1. **There are no optional fields.** A field has to be one type through the CRDT
   attribute, the projection column, and the row alike, and "absent" is not a
   SQL type. Write `'string|null = null'`, never `'field?'`. The default is
   applied at read time and never stored.
2. **A declaration cannot express an array default.** `'string[] = []'` throws, and
   arktype is right to refuse it: a literal default would hand every row the
   SAME array. Write `'string[]|null = null'` and materialise a fresh array at
   the point of use.
3. **No transforming fields.** `'string.date.iso'`, not `'string.date.parse'`: a
   parsing form would hand back a `Date` that cannot round-trip, so
   `update(id, { when: row.when })` would break.

### Nonconforming is a view, not damage

A row this release cannot read is reported, never dropped and never silently
repaired. Prevention is impossible in principle, because a declaration is
release-local and rows arrive from the future: a release that has not shipped
yet can retype a field, and no default you declare today prevents that.

What is possible is healing, and the primitives already exist:

```ts
for (const issue of app.tables.notes.list().nonconforming) {
	issue.id          // the structural row id
	issue.issues      // [{ field: 'n', message: 'n must be a number (was a string)' }]
	issue.conforming  // what survived
	issue.raw         // the stored truth, unmodified
}

app.tables.notes.update(issue.id, { n: 7 }); // an ordinary write repairs it
```

A patch validates only the values it supplies, so it can fix the offending key
even though the whole payload does not currently pass. A composed SQL
projection stores nonconforming rows with their raw values, so SQL can show
them; `list().nonconforming` is the only thing that knows they failed.

Whether an application shows a person the broken row, has an agent propose a
fix, or ignores it until someone cares is a product decision this layer does not
make. Dropping it silently is the one option the store went out of its way to
prevent.

## Where it stores

The `Y.Doc` is the truth while the client is open; everything else follows it
(ADR-0238). The store keeps exactly the ledgers a crash cannot reconstruct:
the update log, the outbox, the cursor, and the document identity, each
written in the same atomic act that incurs it (ADR-0241). They live behind a
per-store persistence controller: every accepted edit queues its durable work
and one coalesced flush commits the whole queue atomically. Everything
derived from the document (SQL, search, exports) is a follower composed
outside the store.

On Bun the durable facts are `store.sqlite3` in the application's directory,
beside `history.sqlite3` for what collapse superseded, and a flush is a
synchronous transaction, so a successful write is durable when the verb
returns. In the browser they live directly in IndexedDB, three object stores
(`updates`, `outbox`, `meta`) written one atomic transaction per flush.

There is no worker and no OPFS. The reasoning is in the module comment titled
"Why there is no worker" at the top of `packages/data/src/store/browser.ts`, and
it is worth reading before proposing one: opening rebuilds every projected
table unconditionally, so a restored file bought nothing, and what actually
has to survive is a handful of small facts that IndexedDB holds fine.

Persistence failing never fails a verb and never poisons the store. The debt
is observable instead:

```ts
db.store.persistence.get(); // 'saved' | 'pending' | 'blocked'
db.store.persistence.subscribe(listener);
await db.store.persistence.flush();
```

`blocked` means the latest flush failed and a restart would lose the retained
work; a later edit or an explicit `flush()` retries. Nothing is lost while
the client stays open: the `Y.Doc` still holds the work, and on a replica the
outbox still owes it to the authority once it lands durably. Sync sends only
durable work, so an edit is never offered to the authority merely because it
is visible in memory.

## Sync

A host supplies one thing, `dial`, and the library owns everything done with a
socket (ADR-0222):

```ts
import { createSyncConnection } from '@epicenter/data/sync';

const connection = createSyncConnection({
	store,
	dial: ({ cursor, opened, received, closed }) => { /* make a socket */ },
});
```

The cursor, attach and detach, reconnect on close, reconnect when the client is
stuck behind a gap, and a watchdog for a submission nobody answers all live
here, because every one of them is correctness rather than transport. A fuzz
proved that omitting the resync reconnect wedges a device permanently. The
store announces its own durable local work to the transport internally, so
nothing has to remember to nudge it.

The authority is one Cloudflare Durable Object per (principal, namespace), named
`principals/<principalId>/stores/<namespace>`, keeping a snapshot plus the
entries after it (ADR-0220, ADR-0225). It reads nothing and holds opaque bytes.
`packages/server/src/store-sync/` is the mount; `@epicenter/data/sync` is where
every merge rule actually lives, so what is deployed and what the transport's
tests drive are the same object.

**Being signed in on two devices is the entire sharing model.** Nothing is
paired, invited, or approved, and there is no identifier a client can supply
that reaches another partition.

## What is not here

Blobs. They are content-addressed, write-once bytes logged against the server,
they were never part of the row plane, and `packages/blobs` has no
`@epicenter/*` import at all. The row layer only ever stored an opaque id. The
asymmetry to know is that an un-uploaded blob exists on exactly one machine, so
the blob plane does not have the row plane's guarantees.
