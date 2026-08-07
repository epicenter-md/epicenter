# 0215. An application is one document, and the authority is a durable ordered byte log

- **Status:** Proposed
- **Date:** 2026-08-07
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0215 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  (the store), [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (the lens and the application surface),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (local persistence).
- **Supersedes:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md)
  at its bound only. Withdrawn: the compound per-document bound
  (`stateBytes = 1_048_576`, `stateStructs = 131_072`), the transfer ceiling
  derived from it, the client-side measure-and-suppress rule, and the terminal
  `too-large` outcome with its `sync_issue` column and `syncIssue()` reader. The
  Yjs-14-only rule and runtime-native V2 update logs survive and are the premise
  this record argues from.
- **Amends:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md)
  at the authority's job and the socket's granularity. Withdrawn: the authority
  as "trusted document joiner and compactor", and one socket per open row
  document. What survives is that one account authority owns the partition and
  that the principal is the partition (ADR-0092).
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  at the index/document split. Withdrawn: the separate per-row `Y.Doc`, the
  `<table>/<rowId>` document-name grammar, the claim that opening is a load, and
  the startup argument that justified the split. What survives, unchanged and
  now load-bearing for a different reason, is that a row's document is inherent
  rather than declared, that Epicenter never reads inside it, one root per table
  with rows nested beneath, `!presence`, and the reserved `!` prefix.
- **Amends:** [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)
  at publication. Withdrawn: the revision counter, `accepted_revision`, the
  publish/pull split, and the drain's settlement protocol. An unsent update is
  the obligation, and the socket is the drain.
- **Amends:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md)
  at one clause: `using document = await tables.notes.document.open(row.id)`
  becomes `db.notes.document(row.id)`, synchronous and not disposable. Its
  substance is *restored* rather than withdrawn: the application names its own
  roots inside and chooses its own format, exactly as `document.get('editor')`
  and `document.get('comments')` always described.

## Context

Every hard constraint in the row-document design descends from one sentence. The
authority hydrates a `Y.Doc` in order to join and compact it (ADR-0145). Because
it hydrates, it needs a memory bound, and ADR-0146:69 says so in as many words:
"worst-case authority hydration near 90 ms and tens of megabytes of transient".
The rest follows mechanically:

```txt
the authority hydrates a Y.Doc
  -> it needs a memory bound                          ADR-0146, stateBytes = 1 MB
    -> one document per application is 3.04 MB, over
      -> so prose must live in its own document        ADR-0212
        -> so documents are many, lazy, and addressed
          -> so opening is a load, so open() is async  ADR-0135, ADR-0130
            -> so a socket is per open document        ADR-0145
              -> so sockets are refused for HTTP pull
                -> so revisions, obligations, a supervisor, a polling cadence
```

Nothing in that chain is wrong given its first line. This record removes the
first line.

**The bound never protected a client.** It bounds what the authority will accept
and hydrate. A client already holds the whole thing.

## Decision

**An application is one Yjs document. The authority stores its bytes in order
and never decodes them.**

### One document per application

One `Y.Doc` per application, `gc: true`, one root per table, rows nested as
attributes (ADR-0212, unchanged, and the quadratic `findRootTypeKey` measurement
is why). Prose stops being a second document and becomes a nested type inside
the row.

There is no `index` document, because there is no second kind of document to
distinguish it from. The name was an artifact of the split.

### A row's document is a nested container the application owns

One reserved attribute per row holds a nested type whose attributes are roots
the application names and types:

```ts
const document = db.notes.document(note.id);   // synchronous
document.get('editor', 'text')                  // the app names the root and the format
document.get('comments', 'array')
document.get('meta')                            // a plain map, if that is what it wants
```

`get(root, typeName)` mirrors `Y.Doc.get(key, name)` deliberately, so it is a
shape a Yjs developer already knows. Epicenter allocates the container, syncs
it, collects it with the row, and learns none of the names or formats inside.

This is the second reason to prefer it over a single typed slot: Yjs 14 gives a
type its behaviour from its *name*, verified, `doc.get('editor')` silently
discards inserts while `doc.get('editor', 'text')` does not. A single slot would
force Epicenter to pick that name, which is precisely the format authority
ADR-0130 and ADR-0135 both refuse. Letting the application pass it means nobody
has to decide.

An earlier draft of this record called the accessor `prose` and gave it one
stream. Withdrawn: naming it for a format asserts what the content is, and
collapsing it to one stream removed the multi-root capability ADR-0130 already
granted.

### Binding an editor to the row itself is refused, on evidence

The nesting is not hygiene. Measured against `@y/prosemirror@2.0.0-6` and
`@y/y@14.0.0-rc.24`, binding ProseMirror to a row that holds `title` and `tags`:

| | the row's fields afterwards | reading it back |
| --- | --- | --- |
| bound to a nested type | `title: 'Groceries'`, `tags: ['food']` | `'buy milk'` |
| bound to the row, plain schema | survive | **throws** `Position -1 outside of fragment` |
| bound to the row, schema with `doc` attrs | **`title: 'PM OWNS THIS'`, `tags: 'pm-tags'`** | n/a |

Two independent failures, and the second is the serious one: a ProseMirror
schema whose `doc` node declares attributes, which is ordinary rather than
exotic, silently overwrites the row's real fields with its schema defaults, and
that overwrite synchronises to every device. The mechanism is that
`pmToFragment` applies `nodeToDelta(node)`, which calls `d.setAttrs(n.attrs)`
(`sync-utils.js:435-437`) and inserts children onto whatever type it is handed.

The third row also corrects this record's predecessor. ADR-0212 inferred from
source reading that an editor would clobber the row's fields. The truer
statement is that a row's fields and a PM document node's attributes occupy one
namespace, so they corrupt each other in both directions: the plain-schema case
loses no data and still cannot be read back.

CodeMirror needs strictly less. Verified on a nested `'text'` type: positional
insert and delete, change observation, and remote edits arriving as
`{retain, insert}` deltas, which is exactly what a CodeMirror `ChangeSet` is
built from. No Yjs 14 binding is published yet (`@y/codemirror` is a `0.0.0-0`
placeholder and `y-codemirror.next@0.3.5` targets Yjs 13), so this is a small
hand-rolled binding rather than a dependency.

### Opening is synchronous, because there is nothing left to load

`db.notes.document(id)` returns a live type from a document the store hydrated
before it handed back a binding. There is no per-row load, so there is no
half-hydrated handle, no `whenLoaded`, no disposal, and no refcount.

**This reverses ADR-0135:106 for a reason, and the reason must be recorded so
nobody re-derives the old bug.** Synchronous opening was abandoned because it
returned a half-hydrated handle: an editor bound before IndexedDB replayed would
"merge keystrokes into an unhydrated doc at the wrong position relative to the
loaded content" (opensidian's own markup), and Honeycrisp issue #1590 was an
empty pre-hydration render clobbering a row's real title and word count by
last-writer-wins. That hazard was a property of *per-document lazy loading*, not
of synchrony. With one document replayed in full before `bind` returns, no
handle can be half-hydrated.

What it buys back is real. Going async turned Honeycrisp's `NoteBodyPane` from
one `fromDisposableCache(...)` line into a `$derived.by` holding a promise, a
hand-rolled generation counter, an `$effect` disposing through `.then()`, and an
`{#await}` block. Nobody rebuilt the reactive adapter for the async shape.

A device with an empty local store can still accept typing before its first
sync. That merges as ordinary concurrent editing rather than corrupting
anything, so it is a first-paint product gate and not a correctness bug.

### The authority is a durable ordered byte log

One Durable Object per application partition. Its SQLite holds `(seq, bytes)`.
One hibernatable WebSocket per device. On connect a client sends its last seq
and receives everything after it; on write the DO appends, assigns the next seq,
and broadcasts to its other sockets.

Yjs updates are commutative and idempotent, so replaying bytes a client already
holds is free and no state vector is needed on the wire. The authority never
decodes an update, never merges, never compacts, and never reads `!presence`.
ADR-0212's "the authority stops needing to understand anything but bytes"
becomes literally true.

**Sockets are cheap now for the reason they were expensive before.** ADR-0145
refused a socket per open row document because the count scaled with open
documents, which bought hibernation-attachment addressing and fan-out
enumeration. With one document per application the count is one, and fan-out is
every socket attached to this DO.

Growth is bounded by a client-driven checkpoint: a client that has applied
through seq N may post a baseline covering it, and the DO truncates at or below
N. The DO still decodes nothing, because a baseline is bytes with a claim
attached, and the claim is checkable by comparing seq numbers.

### The bound is deleted, not raised

Nothing hydrates on the authority, so there is nothing to protect. Deleted with
it: `DOCUMENT_BOUND`, `measureDocumentState`, `exceedsDocumentBound`,
`DOCUMENT_MAX_TRANSFER_BYTES`, the client's measure-and-suppress rule, the
terminal `too-large` outcome, the `sync_issue` column, and `syncIssue()`.

### The real ceiling is client memory, and it is stated rather than discovered

Measured, hydrating from stored bytes on `@y/y@14.0.0-rc.24`:

| shape | live rows | encoded | resident | cold open |
| --- | --- | --- | --- | --- |
| notes with bodies | 986 (the real vault) | 2.8 MB | **4 MB** | 6 ms |
| notes with bodies | 10,000 | 28 MB | 48 MB | 38 ms |
| notes with bodies | 25,000 | 71 MB | 112 MB | 85 ms |
| recordings | 10,000 | 4 MB | 66 MB | 40 ms |
| recordings | 25,000 | 10 MB | 147 MB | 98 ms |
| recordings | 50,000 | 20 MB | 357 MB | 208 ms |

**Memory is driven by item count, not by bytes.** Every field is a Yjs `Item`
costing roughly 500 B of resident JavaScript however few bytes it encodes to, so
10 MB of recordings costs 147 MB resident. A recording carries about ten fields
and a note about three, which is why the app with no prose at all reaches the
wall first.

**The supported ceiling is 10,000 to 15,000 live rows per application.** Beyond
it the fix is not splitting prose back out, which takes 25,000 notes only from
112 MB to 68 MB and costs a second synchronisation mechanism. The fix is not
hydrating the whole document, because ADR-0214's projection already holds the
queryable copy and the `Y.Doc` is needed only for merging. Not built, and no
application is near this.

The authority is unaffected by any of it, because it holds bytes.

## Consequences

- **Deleted:** the compound bound and its whole measure-and-refuse family; the
  publication revision, `accepted_revision`, and the drain's settlement
  protocol; the document-name grammar; asynchronous `document.open`, its
  disposable handle, its refcount, and the "never replace the type behind a
  handle" hazard; authority-side liveness checks, joining, and compaction; the
  sync supervisor's polling cadence and backoff; the publish/pull split.
- **A deleted row's document is collected with it, and churn is free.** Measured
  over 1,000 notes carrying 2.8 KB bodies: 2,888 KB live becomes 91 KB after
  deleting every row, 96.9% reclaimed, at 93 B per dead row. A body that existed
  at all therefore costs 15 B of tombstone forever, and twenty edits per body
  changes none of it because `gc: true` has already collapsed the history.
  Replaying through a fresh document reclaims nothing further.
- **A per-dead-row figure in ADR-0212 needs reconciling.** That record states
  170 B with ADR-0206's 24-character ids; the same measurement here gives 78 B
  for a three-field row and 93 B with a body. The difference is field shape or
  measurement boundary, and whichever is reproducible should be the one written
  down.
- **Prose still does not reach the markdown folder.** ADR-0207's hole is
  re-accepted a second time and for the same reason: Epicenter never learns
  which root inside a row's container holds writing. An application that wants
  its writing on disk puts it in an ordinary field.
- **All prose synchronises whether or not it is opened.** ADR-0212 called
  prefetching every body "a policy, not a mechanism"; it is now the mechanism,
  and the open question about a prefetch policy is answered by having none.
- **One application's availability and growth are one unit.** A partition's DO
  is its blast radius, which is why the DO is per application rather than per
  principal.
- **A second OPFS owner remains impossible**, and the browser remains deferred
  (ADR-0214). Nothing here depends on the browser arriving, and the one-document
  shape ports to `sqlite-wasm` over OPFS exactly as the split one would have.
