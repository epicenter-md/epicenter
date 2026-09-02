# 0215. An application is one document, and a row owns a nested container

- **Status:** Superseded
- **Date:** 2026-08-07
- **Superseded by:** [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md)
  at the index/document split. The nested row container is replaced by an
  independently loaded Yjs document addressed by the row's coordinates.
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
- **Relates:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) restores this record's shape after ADR-0248 superseded it. This record stays superseded; ADR-0295 carries the decision.
  (the store), [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (the lens and the application surface),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (local persistence),
  [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md)
  (which addresses are safe to create at).
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  at the index/document split. Withdrawn: the separate per-row `Y.Doc`, the
  `<table>/<rowId>` document-name grammar, and the startup argument that
  justified the split. What survives, unchanged, is that a row's document is
  inherent rather than declared, that Epicenter never reads inside it, one root
  per table with rows nested beneath, `!presence`, and the reserved `!` prefix.
- **Amends:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md)
  at one clause: `using document = await tables.notes.document.open(row.id)`
  becomes `db.notes.document(row.id)`, synchronous and not disposable. Its
  substance is *restored* rather than withdrawn: the application names its own
  roots inside and chooses its own format, exactly as `document.get('editor')`
  and `document.get('comments')` always described.
- **Amends:** [ADR-0135](0135-row-documents-have-application-owned-roots.md) at
  the asynchrony rule only (`:106`, "`open(rowId)` is asynchronous because the
  returned handle is ready rather than half-hydrated"). Its refusal to expose a
  raw `Y.Doc` survives and is satisfied more completely here, because there is
  no second `Doc` to expose.
- **Does not settle the authority.** An earlier draft of this record also
  specified a Durable Object holding an append-only byte log with no Yjs, and
  superseded ADR-0146's bound on that basis. Both are withdrawn as unproven; see
  *The authority is not settled* below.
- **Amended by:** [ADR-0219](0219-a-deleted-row-is-removed-and-the-presence-flag-is-retired.md)
  at one clause, its listing of `!presence` as part of the surviving grammar.
- **Amended by:** [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md)
  at that one section, which is now settled. Read *The authority is not settled*
  below as the history of four withdrawn attempts, not as an open question.

## Context

ADR-0212 split a row's prose into its own `Y.Doc` because ADR-0146 bounds a
document at `stateBytes = 1_048_576` and one document per application measured
3.04 MB. The split then forced everything downstream: documents became many,
lazy and addressed, so opening became a load, so `open()` became asynchronous
(ADR-0135:106), so a socket was per open document (ADR-0145).

The bound exists to protect **authority hydration** (ADR-0146:69, "worst-case
authority hydration near 90 ms and tens of megabytes of transient"). It has
never protected a client, which already holds the whole thing.

This record collapses the client side of that chain. It deliberately does not
resolve the authority side, because the argument that would have justified doing
so turned out to be unsound.

## Decision

**An application is one Yjs document. A row owns a nested container inside it,
reached synchronously.**

### One document per application

One `Y.Doc` per application, `gc: true`, one root per table, rows nested as
attributes (ADR-0212, unchanged; the quadratic `findRootTypeKey` measurement is
why, and it reproduces: 14.8 ms at 1,000 rows, 344 ms at 5,000, 5,346 ms at
20,000, against 14.9 ms nested. `evidence/bench/row-model.ts`).

There is no `index` document, because there is no second kind to distinguish it
from.

### A row's document is a nested container the application owns

One reserved attribute per row (`!doc`) holds a nested type whose attributes are
roots the application names and types:

```ts
const document = db.notes.document(note.id);   // synchronous, or undefined
document?.get('editor', 'text');
document?.get('comments', 'array');
document?.get('meta');
```

`get(root, typeName)` mirrors `Y.Doc.get(key, name)` deliberately. A nested
`Y.Type` has no such method of its own, so this is a small handle over the
container's attributes, creating on miss. Epicenter allocates the container,
syncs it, collects it with the row, and learns none of the names or formats
inside.

**The container is allocated with the row, never on first access.** Lazy
allocation is a write at a well-known address, which is the failure ADR-0216
describes: two devices first-opening one note would each mint a container and
one entire subtree would be discarded.

**And so are the roots inside it, which this record originally missed.** The
argument above stops at the container, but `get(name)` creates on miss too, and
a created nested type is addressed by the operation that made it. So two devices
first-opening one note each minted a type at `editor` and map LWW discarded one
along with everything typed into it. Measured, and pinned with a control in
`evidence/invariants.test.ts`.

A caller names the roots when it creates the row, and they are allocated in the
same transaction:

```ts
db.notes.create({ title: 'Groceries' }, { document: ['editor'] });
db.notes.document(id).get('editor');   // always there, exactly one creator
```

**Why this was worth doing although it is rare.** The window is narrow: once per
root, at the very start of its life, and it closes permanently the moment any
device creates that root and syncs. Reaching it needs a note that exists on two
devices which neither has opened, opened on both while partitioned. In an app
that touches a note's document only when a person opens it, that is uncommon; in
one whose list view reads the document to render a preview, it is routine, and
the API should not depend on which kind of app is holding it.

What decided it is not the frequency but the failure mode: a person's writing
disappears, converged, with no error anywhere and nothing to retry. This corpus
has repeatedly chosen to make such a failure unreachable rather than documented,
most directly in ADR-0216, which deleted the chosen-id door so the hazard "stops
being something callers must avoid and becomes something they cannot express".
This is the same move, one level further down.

**What Epicenter learns by doing it: the NAMES, and nothing else.** Not the
format, not the contents, not the meaning. A type's name is inert in
`@y/y@14.0.0-rc.24` and does not choose behaviour, so the application still
picks its own format by how it uses the type. The promise that Epicenter never
reads inside a row's document is untouched.

**`document()` returns `RowDocument | undefined`, not a `Result`.** An absent row
is a fact rather than a failure, which is the same answer `get` gives it, and
nothing else about the call can fail because Epicenter never interprets what is
inside.

### Binding an editor to the row itself is refused, on evidence

Measured against `@y/prosemirror@2.0.0-6` and `@y/y@14.0.0-rc.24`, binding
ProseMirror to a row that holds `title` and `tags`:

| | the row's fields afterwards | reading it back |
| --- | --- | --- |
| bound to a nested container | `title: 'Groceries'`, `tags: ['food']` | `'buy milk'` |
| bound to the row, plain schema | survive | **throws** `Position -1 outside of fragment` |
| bound to the row, schema with `doc` attrs | **`title: 'PM OWNS THIS'`** | n/a |

The second failure is the serious one: a ProseMirror schema whose `doc` node
declares attributes, which is ordinary rather than exotic, silently overwrites
the row's real fields with its schema defaults, and that overwrite synchronises
to every device. The mechanism is `pmToFragment` applying `nodeToDelta(node)`,
which calls `d.setAttrs(n.attrs)` (`sync-utils.js:435-437`) onto whatever type it
is handed.

This corrects ADR-0212, which inferred from source reading that an editor would
clobber the row's fields. The truer statement is that a row's fields and a PM
document node's attributes occupy one namespace and corrupt each other in both
directions: the plain-schema case loses no data and still cannot be read back.

CodeMirror needs strictly less: positional insert and delete, change
observation, and remote edits arriving as `{retain, insert}` deltas, which is
what a `ChangeSet` is built from. No Yjs 14 binding is published
(`@y/codemirror` is a `0.0.0-0` placeholder, `y-codemirror.next@0.3.5` targets
Yjs 13), so that is a small hand-rolled binding rather than a dependency.

**A type's name does not choose its behaviour.** An earlier draft of this record
claimed, as "verified", that `doc.get('editor')` silently discards inserts while
`doc.get('editor', 'text')` does not. That is false, and the probe behind it
changed two variables and never called `applyDelta`. In rc.24 the name is an
inert label. The reason `get` takes a `typeName` is unchanged and sufficient on
its own: choosing a format is the application's business, not Epicenter's
(ADR-0130, ADR-0135). Pinned in `evidence/invariants.test.ts`, so if a later rc
makes names load-bearing the assumption fails loudly.

### The surface is synchronous

An application is one in-memory document, and `SqliteDatabase` is synchronous by
contract because every supported embedded engine provides a synchronous
transaction callback. The browser, the one runtime that would force asynchrony,
is deferred (ADR-0214). So every verb except opening the file returns its value
directly, and a test asserts none of them returns a promise.

**This reverses ADR-0135:106, and the reason must be recorded so nobody
re-derives the bug that closed it.** Synchronous opening was abandoned because it
returned a half-hydrated handle: an editor bound before IndexedDB replayed would
"merge keystrokes into an unhydrated doc at the wrong position relative to the
loaded content" (opensidian's own markup), and Honeycrisp issue #1590 was an
empty pre-hydration render clobbering a row's real title and word count by
last-writer-wins. That hazard was a property of **per-document lazy loading**,
not of synchrony. With one document replayed in full before `bind` returns, no
handle can be half-hydrated.

What it buys back is measurable in caller code: going asynchronous had turned
Honeycrisp's `NoteBodyPane` from one `fromDisposableCache(...)` line into a
`$derived.by` holding a promise, a hand-rolled generation counter, an `$effect`
disposing through `.then()`, and an `{#await}` block, and nobody rebuilt the
reactive adapter for that shape.

A device with an empty local store can still accept typing before its first
sync. That merges as ordinary concurrent editing, so it is a first-paint product
gate rather than a correctness bug.

### The ceiling is stated in items, because that is what it depends on

Hydrating from stored bytes. `bun 1.3.1`, darwin/arm64, JavaScriptCore, one OS
process per case, corpus read from disk, baseline taken after a forced GC.
Regenerate with `evidence/bench/memory.ts`.

| shape | rows | encoded | items | rss | heap | open |
| --- | --- | --- | --- | --- | --- | --- |
| notes with bodies | 986 (the real vault) | 3 MB | 7,888 | 24 MB | 0 MB | 10 ms |
| notes with bodies | 5,000 | 14 MB | 40,000 | 83 MB | 46 MB | 34 ms |
| notes with bodies | 10,000 | 28 MB | 80,000 | 142 MB | 91 MB | 58 ms |
| recordings | 5,000 | 2 MB | 55,000 | 72 MB | 26 MB | 32 ms |
| recordings | 10,000 | 4 MB | 110,000 | 118 MB | 28 MB | 57 ms |
| recordings | 25,000 | 10 MB | 275,000 | 263 MB | 155 MB | 124 ms |

**Memory tracks struct count, not bytes.** 10 MB of recordings costs 263 MB
resident, because every field is a Yjs `Item` and an item costs whatever the
engine charges for a small object regardless of how few bytes it encodes to. At
scale that settles near **1 KB of rss per item**, so:

```txt
resident ~= items x 1 KB          items ~= rows x (1 + fields + containers)
```

A recording is 11 items and a note with a body is 8, which is why the
application with no prose at all reaches the wall first.

**Quote the ceiling in items: roughly 100,000 items is roughly 100 MB
resident.** That is about 11,000 recordings or 16,000 notes with bodies. Items
are a property of the data and reproduce anywhere; bytes-per-item is a property
of the engine, and a Tauri WebView is JavaScriptCore on macOS and Linux but V8
on Windows, so the second half of that multiplication has to be re-measured per
platform rather than assumed from this table.

**These figures replace an earlier set that was too low, not too high.** A prior
draft reported 48 MB for the 10,000-note case now measured at 142 MB rss and
91 MB heap; an independent reviewer's 182 MB was nearer the truth. The error was
method, not arithmetic: several shapes were measured in one process, so the
allocator's high-water mark was attributed to the first case and roughly nothing
to the rest. `rss` and `heap` are both reported here because they disagree by
1.5x to 2x, and hiding that disagreement is what made the earlier number
impossible to falsify.

Past the ceiling the fix is not splitting prose back out, which removes about 2
items of 8 per note. The fix is not hydrating the whole document, because
ADR-0214's projection already holds the queryable copy and the `Y.Doc` is needed
only for merging. Not built, and the real vault sits at 7,888 items.

## The authority is not settled

An earlier draft specified one Durable Object per application partition holding
`(seq, bytes)` with no Yjs at all, and superseded ADR-0146's bound on the
argument that "nothing hydrates on the authority, so there is nothing to
protect." That argument is a non sequitur, and adversarial review broke the
design on four counts, three of them proven in real `workerd`:

- **An oversized update vanishes silently.** DO SQLite caps a value at
  2,097,152 bytes while the WebSocket accepts 32 MiB, and `workerd` swallows the
  throw in `webSocketMessage` without closing the socket. With no ack on the
  update path the client never retries. A 50,000-row import is 9.16 MB in one
  update. The 2 MiB wall is a SQLite limit and has nothing to do with hydration.
- **A client-posted baseline is unverifiable.** The draft claimed the claim was
  "checkable by comparing seq numbers"; 13 bytes of an empty document passes that
  check and destroys the partition.
- **A poison pill is durable.** Six bytes of garbage cannot be rejected by an
  authority that by construction cannot decode, and every device then throws on
  every connect, forever.
- **Cold start becomes O(entire history)** rather than O(state), measured at
  478 ms and 7 MB for 1,000 notes with 200 edits each.

Each is one of three things the current authority does and the draft removed:
**validate**, **bound**, and **compact**. None of them exists because of
hydration cost, so refuting hydration cost refutes none of them.

What is known and worth keeping for whoever settles this:

- The authority can answer a state vector without building an object graph:
  `Y.diffUpdateV2(stored, vector)` produces the byte-identical minimal diff at
  roughly a third less memory and twice the speed of hydrating a `Y.Doc`.
- y-sweet and PartyKit both **hold a live document** and persist one
  overwritten snapshot. Neither appends a log and neither merges, which is why
  neither has a compaction problem.
- `Y.mergeUpdatesV2` on a 14 MB document allocated 159 MB, so whatever compacts
  should probably not be the Durable Object.
- The 128 MB figure often quoted for a DO is the **ActorCache** limit, which is
  the storage cache and not a ceiling on allocation. Do not cite it for this.

## Consequences

- **Deleted:** the document-name grammar; asynchronous `document.open`, its
  disposable handle, its refcount, its per-document persistence listener, and
  the "never replace the type behind a handle" hazard.
- **All prose synchronises whether or not it is opened.** ADR-0212 called
  prefetching every body "a policy, not a mechanism"; it is now the mechanism,
  and the open question about a prefetch policy is answered by having none.
- **An application writing into its own container persists on its own.** Those
  bytes reach storage through the update listener rather than through a store
  verb, and they carry no projection work, because Epicenter never looks inside
  a document so nothing it holds is ever projected.
- **Prose still does not reach the markdown folder.** ADR-0207's hole is
  re-accepted for the same reason: Epicenter never learns which root inside a
  container holds writing.
- **ADR-0146's bound stands** until the authority is settled, since the argument
  for removing it was withdrawn.
