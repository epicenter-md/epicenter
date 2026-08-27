# @epicenter/data

The Epicenter store: one scalar Yjs document per application, independently
loaded row documents for rich content, a synchronous surface over the scalar
state, and the transport that carries it between a person's devices. MIT.

The package has one definition entrypoint and four runtime entrypoints:

| Import | What it gives you |
| --- | --- |
| `@epicenter/data` | the opened data surface |
| `@epicenter/data/definition` | `defineData`, `parseData`, and the field descriptor vocabulary |
| `@epicenter/data/browser` | `openDevice(definition)`, and `openAccount(definition, { baseURL, principalId })` |
| `@epicenter/data/sync` | `createSyncConnection`, and the authority half a server runs |
| `@epicenter/data/artifact` | `renderRow(...)` and `renderWorkspace(data, definition)` out, `readArtifact(files, definition)` back in: the folder a person keeps |
| `@epicenter/data/memory` | `openMemory(definition)` and `createMemoryRecord()`, test support |

The browser opener is the only one a person's data lands in. A memory opener
imports `bun:sqlite` and the browser opener imports a WASM build, so neither
belongs in a barrel the other has to load. That is the whole reason the openers
live at their own entry points rather than on `@epicenter/data`.

## Opening is the only asynchronous thing

```ts
import { openAccount } from '@epicenter/data/browser';

const { data, error } = await openAccount(honeycrispDefinition, {
	baseURL,
	principalId,
});
if (error !== null) return handle(error);

await using opened = data;
opened.definition; // the immutable declaration that opened this data

const listed = opened.tables.notes.list();          // no await
opened.tables.notes.update(id, { title: 'Draft' }); // no await
```

An inert data definition names the store it opens (ADR-0229), so there is one call and one
name: the definition id is the document, the file, the folder and the authority
address. Nothing takes a path or a database name. In a browser the durable
address is derived from that definition id and the document named below rather
than supplied (ADR-0261), so a declaration still cannot open a store it does
not name. The runtime that comes back holds exactly this one definition for
its whole life (ADR-0240); a newer declaration reads the same durable data by
closing it and opening the next one.

In a browser the caller also names which durable document it means and whose it
is (ADR-0261). An application keeps one device document that never joins
account sync, and one retained replica per account:

```text
epicenter/<definitionId>/device
epicenter/<definitionId>/account/<base URL>/<principal id>
```

That address is the IndexedDB database name, so a data discard or
supersession can reach exactly one account's replica and never the
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

Each table the definition declares is a key on `data.tables`. The physical file
and CRDT capability that `data` owns sits under `data.store`, so a table can be
named anything a person names it:

```ts
data.tables.notes.create(fields)                 // Row, at a minted 24-character id
data.tables.notes.get(id)                         // Result<Row | undefined, NonconformingRow>
data.tables.notes.update(id, patch)               // void; merges; refuses an absent address
data.tables.notes.delete(id)                      // boolean: was there a row to take?
data.tables.notes.ids()                           // string[], sorted
data.tables.notes.list()                          // { rows, nonconforming }
data.tables.notes.openDocument(id)               // RowDocument | undefined
data.tables.notes.subscribe(listener)             // returns its own unsubscribe
```

Settings live on `data.kv`, which has `get()`, `update(patch)`, and `subscribe`.
There is no id and no `create`, because there is exactly one and it always exists.
Missing fields remain nonconforming. Applications compose initialization and
recovery values explicitly from `error.conforming`.

Row document lifecycle is owned by the table that owns the row.
`data.transact(() => { ... })` groups direct table and KV operations into one
accepted and durable transaction.

SQL, when an application wants it, is a follower it composes over this
surface: hydrate from `list()`, follow commits through `store.onCommitted`,
and rebuild whole at the next read, so an index can never serve rows the live
document has moved past (ADR-0241). The package shipped one such follower and
no application ever composed it, so it was deleted; a person who wants to look
at their data outside the app reads the export (ADR-0268), which is files.

`data.store` carries the document itself: `pressure()` (how much of it is dead
weight), `onCommitted` (anything committed, whoever wrote it),
`persistence` (whether accepted work has reached durable storage, ADR-0238),
and `sync`, the value that tells the two store kinds apart (ADR-0239):
`undefined` on a device document, and `{ get, subscribe }` over
`{ document }` on an account replica. They live under one key rather than
beside the tables so that no table name is reserved: `kv` is the only one a
definition refuses, so a follower may project KV as a relation of that name
without colliding with a table.
The delivery machinery underneath sync (the outbox, cursors,
acknowledgements) is internal; only the transport drives it.

### Reading

`list()` returns the rows this release could read and the ones it could not,
side by side, as a plain object:

```ts
const { rows, nonconforming } = data.tables.notes.list();
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
const { data: noteData, error } = data.tables.notes.get(id);
const note = noteData ?? { ...applicationRecovery, ...error?.conforming };
```

### Reacting

`subscribe` fires once per commit, carrying the row ids that commit touched
(ADR-0221). It fires for a local write, for prose typed into a row's document,
and for bytes that arrived from another device alike, and it fires after every
`onCommitted` listener has run, so a composed follower is already marked
dirty by the time a subscriber reads through it.

Registration is synchronous, does no I/O, and never fires initially, so a
caller that subscribes and then reads has already seen everything. There is no
generation counter to keep and no `refresh()` to remember:

```ts
function read() { /* the read above */ }
read();
const stop = data.tables.notes.subscribe(read);
```

`data.kv.subscribe` takes a listener with no arguments. KV is one value at a
name-addressed root, so there are no ids to carry.

## The shape of the data

One scalar `Y.Doc` per application is persisted under the application log name
`app`. Its current top-level roots are the bare named root `kv` and one
`tables:<name>` root for each declared table. This is the physical storage
grammar; it is not a promise that an older or unknown writer could not have
left another root behind. The current model mints no other root kind, so
dumping `doc.share` reads as a description of the application's current scalar
state.

```txt
Y.Doc "app"
├── get("kv")
│   ├── <field>        one KV attribute
│   └── ...
├── get("tables:notes")
│   ├── <rowId>        a nested Y.Type: the row
│   │   ├── title      an attribute: a field
│   │   └── folderId
│   └── <rowId>
└── get("tables:folders")
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

A row's rich content lives in an independent Yjs document at its derived
address (ADR-0248), not in a nested `!doc` container on the row. The application
names roots inside that independent document when it first opens them:

```ts
const { data: handle } = await data.tables.notes.openDocument(id);

const body = handle?.get('body'); // a live Y.Type
handle?.[Symbol.dispose]();
```

Because the row document is independently name-addressed, two devices
first-opening the same named root converge with both writes retained. What
comes back is a hydrated handle whose `get(name)` returns a `Y.Type` an editor
binds to directly. Epicenter picks no rich-content format and never looks
inside.

## What merges with what

Not uniform, and worth knowing exactly, because it decides how a field should be
shaped.

| Where | Granularity |
| --- | --- |
| two fields of one row | independent, both survive |
| one scalar field | last write wins, converged |
| one array or object field | last write wins on the WHOLE value |
| a row document | per character |
| any composed index | a cache derived from the CRDT |

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

## The data definition

A data definition is one application's complete declaration of its durable data
domain: closed JSON field descriptors, with no storage or lifecycle
(ADR-0213, ADR-0240). It never migrates user data (ADR-0125). A newer release
ships a newer definition and reads the same durable data through it.

```ts
import { defineData, field } from '@epicenter/data/definition';

export const notesDefinition = defineData({
	id: 'com.example.notes',
	kv: { theme: field.select(['light', 'dark']) },
	tables: {
		notes: {
			title: field.string(),
			folderId: field.nullable(field.string()),
			createdAt: field.instant(),
		},
	},
});
```

Each `tables` property name is that table's durable name forever: it is what a
row address carries, what the export names its folder, and what a composed
SQL follower calls its relation. There is no second key to keep in step, and no
rename, because a different property name is a different address and therefore
different data.

Three rules bite immediately:

1. **There are no optional fields.** A field has to be one type through the CRDT
   attribute, the exported frontmatter value, and the row alike.
   `field.nullable(inner)`
   accepts stored JSON `null`, but a missing field remains nonconforming.
2. **Definitions do not own defaults.** Initialization and recovery values live
   in application code. `parseData` rejects a descriptor carrying `default`.
3. **No transforming fields.** Date, instant, and datetime descriptors preserve
   their string representation, so values round-trip through storage and SQL.

### Nonconforming is a view, not damage

A row this release cannot read is reported, never dropped and never silently
repaired. Prevention is impossible in principle, because a declaration is
release-local and rows arrive from the future: a release that has not shipped
yet can retype a field, and no default you declare today prevents that.

What is possible is healing, and the primitives already exist:

```ts
for (const issue of data.tables.notes.list().nonconforming) {
	issue.id          // the structural row id
	issue.issues      // [{ field: 'n', message: 'n must be a number (was a string)' }]
	issue.conforming  // what survived
	issue.raw         // the stored truth, unmodified
}

data.tables.notes.update(issue.id, { n: 7 }); // an ordinary write repairs it
```

A patch validates only the values it supplies, so it can fix the offending key
even though the whole payload does not currently pass. `stored()` and the
export read the raw values regardless, so a broken row is never invisible;
`list().nonconforming` is the only thing that knows they failed.

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

In the browser the durable facts live directly in IndexedDB, four object
stores (`updates`, `outbox`, `tombstones`, `meta`) written one atomic
transaction per flush. Over a synchronous SQLite (a Durable Object's storage,
or a memory record in a test) a flush is one transaction, so a successful
write is durable when the verb returns.

There is no worker and no OPFS. The reasoning is in the module comment titled
"Why there is no worker" at the top of `packages/data/src/store/browser.ts`, and
it is worth reading before proposing one: opening rebuilds every projected
table unconditionally, so a restored file bought nothing, and what actually
has to survive is a handful of small facts that IndexedDB holds fine.

Persistence failing never fails a verb and never poisons the store. The debt
is observable instead:

```ts
data.store.persistence.get(); // 'saved' | 'pending' | 'blocked'
data.store.persistence.subscribe(listener);
await data.store.persistence.flush();
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

The authority is one Cloudflare Durable Object per (principal, definitionId), named
`principals/<principalId>/stores/<definitionId>`, keeping a snapshot plus the
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
