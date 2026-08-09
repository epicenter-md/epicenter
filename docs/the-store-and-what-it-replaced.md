# The store, and what it replaced

What changed between the superseded data stack and the store, and why. Written
for someone about to migrate an application, so it is organised by the DECISION
each change came from rather than by API surface.

The old stack is gone (ADR-0227), so nothing here is a compatibility guide.
It is an explanation of intent.

---

## The one change everything else follows from

**An application is ONE Yjs document, replayed in full before any handle
exists, and the surface over it is synchronous.** (ADR-0215)

The old stack was many documents behind a process boundary: a replica owned by a
worker or a desktop host, reached over a message port or HTTP. Every read was a
round trip, so every read was `async`, so every consumer was `async`, so every
consumer needed cache invalidation and race protection.

Once the whole application is one document in memory, none of that is true. A
read is a property access. That single fact deletes more code than any other
decision here, and most of the entries below are consequences of it rather than
independent changes.

---

## Reads

| | old | new |
| --- | --- | --- |
| one row | `await table.get(id)` | `db.notes.get(id)` |
| all rows | `await table.scan()` | `db.notes.list()` |
| ids | (part of scan) | `db.notes.ids()` |
| SQL | a separate inspection surface | ``db.query`SELECT ...` `` |

`list()` returns `{ rows, nonconforming }`. A row the current Lens cannot read
is REPORTED, never dropped and never repaired (ADR-0125): you get the rows that
parsed and the failures beside them, and the failure carries `conforming` so a
caller can compose its own recovery.

```ts
const { data, error } = db.notes.get(id);
const note = data ?? { ...db.notes.defaults, ...error?.conforming };
```

Use `??`, never a destructuring default. An `Err` sets `data` to `null`, and
`= fallback` fires only on `undefined`.

---

## Reactivity, and why `fromTable` is gone

**Old:** a table had `subscribe`, but a subscription only said "something in
this table moved". To know what, you re-scanned. Because scans were async and
could overlap, every consumer grew a generation counter to discard the results
of races:

```ts
let refreshGeneration = 0;
async function refresh() {
  const generation = ++refreshGeneration;
  const { rows } = await honeycrisp.notes.scan();
  if (generation !== refreshGeneration) return;   // a newer refresh won
  ...
}
```

Every mutation had to remember to call `refresh()`, and forgetting was silent.

`packages/svelte-utils`'s `fromTable` existed to hide exactly this. It was a
Svelte adapter that owned the scan, the `whenReady` promise, the `refresh()`,
and the point-reads driven by an invalidation payload. It was good code solving
a problem that no longer exists.

**New:** `db.notes.subscribe(listener)` fires once per commit with the ROW IDS
that commit touched (ADR-0221), and fires for a local write, for prose typed
into a row's document, and for bytes that arrived from another device alike. It
fires AFTER the projection commits, so a listener sees `list()` and `db.query`
agree.

The whole consumer is now:

```ts
let rows = $state.raw<Note[]>([]);
let unreadable = $state.raw<NonconformingRowError[]>([]);

function read() {
  const { data, error } = db.notes.list();
  if (error !== null) { reportBackgroundError(error); return; }
  rows = data.rows;
  unreadable = data.nonconforming;   // not `?? []`, and not dropped
}
read();
const stop = db.notes.subscribe(read);
```

The two lines people are tempted to skip are the ones that matter. `list()`
returns a `Result`, so `.data?.rows ?? []` turns a storage failure into an empty
list, and an empty list renders as "you have never written one of these".
`nonconforming` is the same trap one level down: discard it and rows a person
wrote are simply missing from the screen with nothing to explain why.

No generations, no `refresh()` discipline, no adapter. `fromTable` was deleted
rather than ported because the fifteen lines above are the whole of what it did,
and a shared abstraction is worth designing when two applications on the store
want the same one.

`db.kv.subscribe(listener)` is the same idea for settings, with a void listener:
KV is one value at a name-addressed root, so there are no ids to carry.

---

## Writes

**Old:** promises that threw. **New:** synchronous, `Result`-returning.

```ts
const { data, error } = db.notes.update(id, { title: 'Shopping' });
if (error !== null) …
```

Two behaviour changes worth knowing:

- `patch` became `update`, and **an update to a row that does not exist is a
  failure**. The old verb returned `Ok(undefined)` and silently swallowed the
  write, which was a live bug.
- There is no optimistic cache to patch. The write commits, the subscription
  fires, the read re-runs. A UI that used to patch its own cache to feel fast
  now does nothing, because the write already happened in memory.

---

## Row ids

**Old:** an application could choose a row id (`create(rowId, fields)`).
**New:** ids are minted, always, 24 characters (ADR-0206).

This is a correctness decision, not ergonomics. A row is a nested container
addressed by the operation that created it, so two devices creating the same
chosen id produce two containers and map LWW discards one **with every field in
it**. A minted id makes that unreachable.

Consequences you will hit:

- Whispering's recipes had a `sourceId` "portable identity" purely because the
  old store allowed chosen ids. It is deleted; the minted row id IS the identity.
- **Anything an application wants to name goes in `kv`**, which lives at a
  name-addressed root where independent minting converges (ADR-0216).

---

## Settings

**Old:** one row at the chosen id `'settings'`.
**New:** the Lens's `kv` section.

Same reason as above, and it was a live data-loss shape rather than tidiness:
every device writes settings on its own boot path, so two devices both creating
the `'settings'` container lose one of them entirely.

```ts
const { data } = db.kv.get();      // every declared key, defaulted if unwritten
db.kv.update({ theme: 'dark' });   // merges; other keys untouched
```

---

## Prose and row documents

**Old:** `await table.openDocument(id)` returned a lease you had to dispose, and
the app polled it on an interval to pull remote changes.

**New:** `db.notes.document(id).get('body')` returns a live `Y.Type`. Nothing to
open, nothing to await, nothing to dispose, nothing to poll. Bind an editor to
it directly.

One rule: **name the roots at `create`.**

```ts
db.notes.create(fields, { document: ['body'] });
```

`document(id).get(name)` creates on miss, and a created nested type is addressed
by the operation that made it — so two devices first-opening one note would each
mint a root at that key and lose one. Naming it at `create` leaves exactly one
creator.

**Whether prose belongs in a document at all is a per-application decision.**
Honeycrisp's notes do (a person types them a character at a time, so per-
character merging is the point). Whispering's transcripts do NOT: they are
machine-produced, replaced wholesale, and rendered in a list.

---

## The Lens

**Old:** TypeBox, `defineTable({ fields: { title: field.string() } })`, with
defaults living outside in application code.

**New:** pure JSON, arktype expression strings, defaults declared inline
(ADR-0213).

```ts
export const lens = defineLens({
  namespace: 'so.epicenter.honeycrisp',
  kv: { theme: "'light'|'dark' = 'light'" },
  tables: { notes: { title: 'string', folderId: 'string|null = null' } },
});
```

Three things bite immediately:

1. **There are no optional fields.** A field must be one type through the CRDT
   attribute, the projection column and the row alike, and "absent" is not a SQL
   type. What would have been optional is `'T|null = null'`, applied at read
   time and never written.
2. **A Lens cannot express an array default, and arktype is RIGHT to refuse
   it.** `'string[] = []'` does not parse, and the tuple form
   `['string[]', '=', []]` is refused too, with "Non-primitive default must be
   specified as a function". That is not a gap: a literal default would hand
   every row the SAME array, and a caller that pushed to one would mutate the
   default for all of them. A function is how you say "a fresh one each time",
   and a Lens is pure JSON so it cannot carry one.

   So `'string[]|null = null'` is the principled answer rather than a
   workaround: `null` is a primitive, so it is expressible, and it forces the
   reader to materialise a fresh array at the point of use.
3. **No transforming fields.** `'string.date.iso'`, not `'string.date.parse'` —
   a parsing form would hand back a `Date` that cannot round-trip, so
   `update(id, { when: row.when })` would break.

Objects have no STRING expression, so `'{ status: ... }'` does not parse and
`'object|null'` validates nothing. Today that means flattening a
`{ status, completedAt, error }` shape into columns.

**That is a limitation of `parseLens`, not of arktype or of the projection, and
it is worth knowing before you flatten anything by hand.** Measured against the
installed arktype: a nested JSON literal (`{ transcription: { status: "'a'|'b'"
} }`) parses, accepts a good value and refuses a bad one, and it is still pure
JSON. And `projectValue` already `JSON.stringify`s any non-scalar into its
column, which is exactly how array fields work today and why they are queryable
with `json_each`. The only missing piece is `parseLens` recursing into a nested
field. Flattening is the shape available now, not the shape that is possible.

---

## Sync

**Old:** an HTTP `Exchange`, a `sync-supervisor`, and a connect loop each host
wrote for itself — including the reconnect rules, one of which (reconnect when
the client reports `needsResync`) is a CORRECTNESS requirement that a fuzz
proved wedges a device permanently when omitted.

**New:** the host writes a `dial` and nothing else (ADR-0222).

```ts
createSyncConnection({ store, dial: ({ cursor, opened, received, closed }) => { … } });
```

The library owns the cursor, attach/detach, reconnect on close, reconnect on
`needsResync`, and a watchdog for a submission nobody answers. The store
announces its own local work (`onLocalWork`), so **nothing calls `nudge`** —
forgetting to was the same class of silent wedge.

Server side: one Durable Object per (principal, application namespace),
addressed by a principal resolved from the bearer (ADR-0225). **Being signed in
on two devices is the entire sharing model** — nothing to pair, invite or
approve, and no identifier a client can supply that reaches another partition.

---

## Where the store runs

**Old:** a worker owned the replica and the page was its asynchronous client,
which is why every read in an application on that stack was awaited.

**New:** the store runs in the page over an in-memory SQLite, and three small
relations (`_updates`, `_outbox`, `_cursor`) live in IndexedDB (ADR-0223).

The measured fact behind it: a page cannot take a synchronous handle to durable
storage. That decides where the LOG lives, not where the store runs — the store
needs a synchronous HANDLE, not synchronous durability, because reads come from
the `Y.Doc` and SQLite is a write-behind log plus a query cache.

One property is genuinely weaker and is surfaced rather than hidden:
`store.durability()` is an ALARM, because IndexedDB is asynchronous so a refusal
arrives after the write returned `Ok`. Nothing is lost when it fires; what is
lost is the guarantee that a reload sees it.

---

## The host

**Old:** the desktop host owned a replica, and served applications wrote into it,
which is how Home's tools could read another application's rows.

**New:** a host serves bundles and brokers credentials, and owns no application
data (ADR-0226, widened by ADR-0227). Neither Bun entrypoint constructs a
database at all.

A reader that wants an application's rows becomes a replica of the same
authority that application uses, which is the shape every other reader already
has rather than a privileged local one.

---

## Blobs, which did NOT change

Worth stating because the host rule sounds like it should have.

`packages/blobs` has no `@epicenter/*` import at all: the row layer only ever
stored an opaque id, and the blob layer never knew a row existed. A blob is
content-addressed and write-once, so it cannot diverge, so it creates none of
the failure modes the host rule refuses.

Its durable home is the object store. The host holds local bytes, some uploaded
and some queued, and the row says which. **When one uploads is the
application's policy** — Epicenter supplies the verbs and has no opinion about
batching, Wi-Fi or retention.

The asymmetry to know: an un-uploaded blob exists on exactly one machine. The
blob plane does not have the row plane's guarantees.

---

## What granularity an edit actually has

Worth knowing exactly, because it decides how a field should be shaped and it
is not uniform. Measured, not assumed.

**A row is not replaced. A field is.** A row is an attribute map and `writeRow`
sets only the attributes handed to it, so two devices editing DIFFERENT fields
of one row offline both keep their edit:

```txt
phone:  update(id, { title: 'phone renamed it' })
laptop: update(id, { body:  'laptop rewrote the body' })
after sync -> title: 'phone renamed it', body: 'laptop rewrote the body'
```

That is the same property that makes an old release safe to write with: it
cannot clobber a field it does not know, because it never touches that
attribute.

**Inside one field there is no merging at all.** Two devices writing the same
field converge on one winner (last write wins by client id), and the other
value is gone. That is correct for a title and it is the whole story for every
scalar.

**An array or object field is ONE value, so it is replaced wholesale.** This is
the one that surprises people:

```txt
phone:  update(id, { tags: ['a', 'from-phone'] })
laptop: update(id, { tags: ['a', 'from-laptop'] })
after sync -> tags: ['a', 'from-phone']      // 'from-laptop' is gone
```

Both devices agree, nothing is corrupt, and one person's addition vanished. A
JSON value in an attribute is atomic; it is not a CRDT list. **So an array field
is right for a set one device owns and wrong for a set several devices append
to.** If concurrent appends must all survive, the collection wants to be rows in
a table, where each element is its own row and nothing collides.

**Per-character merging exists in exactly one place: a row document.**
`document(id).get('body')` is a live `Y.Type`, so two people typing in it merge
at the character. That is the whole reason prose lives there rather than in a
`string` field, and the reason a machine-produced transcript does not need to.

**The projection has different granularity, and it does not matter.** A local
commit upserts one row; an arrived update rebuilds every bound table. Both are
writes to a cache derived from the CRDT, so neither affects what merges with
what.

| where | granularity |
| --- | --- |
| two fields of one row | independent, both survive |
| one scalar field | last write wins, converged |
| one array or object field | last write wins on the WHOLE value |
| a row document | per character |
| the SQL projection | a cache; row upsert locally, full rebuild on arrival |

---

## How a row evolves

Two devices on two releases hold two Lenses over one namespace, and rows written
by either arrive at the other in any order. There is no migration step to
sequence, no schema version, and no compatibility classifier: ADR-0125 decided
that, and the behaviour below is that decision verified against the store rather
than restated.

**Fields are independent, and that is the load-bearing invariant.** A row is an
attribute map, a write sets only the attributes handed to it, and a read
interprets only the fields the Lens declares. Everything else follows.

| what changed | what the other release sees |
| --- | --- |
| a field was ADDED, with a default | old rows read, the default fills in |
| a field was ADDED, no default | **old rows go `Nonconforming`** |
| a row has a field this Lens never heard of | ignored on read, **preserved on write** |
| a field's TYPE changed | `Nonconforming`, with `conforming` carrying what survived |
| a field was REMOVED | the attribute lingers, unread, costing only `pressure()` |

The third row is the one that makes mixed-version fleets safe, and it is worth
stating as a property rather than a footnote: **an old release updating a row
does not clobber the fields it cannot see.** Verified — a v1 release editing a
`title` left a v2 `tags` array untouched.

The fourth row has an escape hatch that is easy to miss: a nonconforming row is
not a dead row. A patch validates only the values it supplies, so it can repair
the offending key even though the whole payload does not currently pass:

```ts
db.notes.update(id, { n: 7 });   // succeeds; the row conforms afterwards
```

**Order does not matter, by construction.** Because fields are independent and
defaults apply at read time, there is no interleaving of v1 and v2 writes that
produces a state neither can read. That is the whole reason there is no
migration chain to run in sequence.

### Nonconforming is a view, not damage

The instinct on first meeting a `Nonconforming` row is to prevent it: default
every field, require every field at `create`, make the schema watertight.

**That cannot work, and it is worth understanding why before designing around
it.** A Lens is release-local, and rows arrive from the future. A release that
has not shipped yet can retype a field and write it, and your release will not
be able to read the result — no default you declare today prevents that, because
the change is not yours. Verified: a v1 Lens reading a row a v3 Lens wrote is
`Nonconforming`, and nothing in v1 could have avoided it.

So prevention is impossible in principle, and a discipline aimed at it buys a
tax on every author for a guarantee it cannot deliver. What is possible is
HEALING, and the primitives for it already exist.

A failed read is not an absence. It carries everything an app, a person, or an
agent needs to act:

```ts
const { data } = db.notes.list();
for (const issue of data.nonconforming) {
  issue.address     // { namespace, tableName, rowId }
  issue.issues      // [{ field: 'n', message: 'n must be a number (was a string)' }]
  issue.conforming  // { id, title }              what survived
  issue.raw         // { title, n: 'seven' }      the stored truth, unmodified
}
```

`issues` names the field and says what is wrong with it in a sentence, which is
the whole input an agent or a repair screen needs. `raw` is never modified, so
nothing is lost while the row is unreadable. And repair is an ordinary write,
because a patch validates only the values it supplies:

```ts
db.notes.update(issue.address.rowId, { n: 7 });
```

Nonconforming rows are also still in the projection with their raw values, so
`db.query` can SHOW them. It cannot FIND them: the projection carries one column
per declared field and no conformance marker, and SQL cannot re-run arktype. The
typed read is the only thing that knows which rows failed, so a repair surface
identifies them with `list().nonconforming` and may then use SQL to display or
group them.

Two things the projection does NOT promise, worth knowing before building on it.
It stores what was WRITTEN, so a field nobody has written reads as its declared
default through `list()` and as `NULL` through `db.query`. And it is a cache: it
is rebuilt at `bind`, so it is current, but it is derived from the CRDT rather
than authoritative over it.

**So the answer here is to add nothing.** No schema version, no migration chain,
no repair API, no alias, no compatibility classifier — ADR-0125 refused all of
those, and the reason it could is that these five primitives (`nonconforming`,
`issues`, `conforming`, `raw`, and a validating patch) already make healing an
ordinary application concern. Whether an app shows a person the broken row, has
an agent propose a fix, or ignores it until someone cares is a product decision
this layer should not make.

What survives is a preference rather than a rule: **adding a field is cheaper
than retyping one**, because adding leaves every existing row readable and
retyping hands them all to a healer.

It is a preference and not a rule because retyping is a legitimate thing to do.
Sometimes a field was simply the wrong type, and living with the wrong one
forever to avoid a heal is the worse trade. Retype it, know that existing rows
go `Nonconforming` until something fixes them, and decide whether anything
needs to. Often nothing does: a row nobody looks at can stay unreadable
indefinitely without hurting anyone, and `raw` still holds it.

---

## A migration checklist

1. Rewrite the Lens: arktype strings, nullable-with-default, no optionals, no
   objects, defaults inline. Settings to `kv`.
2. Decide per field whether prose belongs in a row document or the row.
3. Replace `openEpicenter` with `openBrowserStore({ name })` + `store.bind(lens)`.
4. Replace `scan` + `refresh` + generations with `read()` + `subscribe(read)`.
5. Drop `await` from every read and every mutation; destructure `{ data, error }`.
6. Delete chosen-id machinery; move anything that needed a stable name to `kv`.
7. Replace document leases and polling with `document(id).get(root)`, naming
   roots at `create`.
8. Add a `dial` if the application syncs, and delete every `nudge`.
9. Decide what the application does with `list().nonconforming`. Showing it,
   healing it, and ignoring it are all legitimate; dropping it silently is the
   one option the store went out of its way to prevent.
