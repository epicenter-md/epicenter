# The Yjs store, the lens, and where history lives

- **Status:** In Progress
- **Date:** 2026-08-07
- **Settled as:** [ADR-0212](../docs/adr/0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md),
  [ADR-0213](../docs/adr/0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md),
  [ADR-0214](../docs/adr/0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md),
  [ADR-0215](../docs/adr/0215-an-application-is-one-document-and-the-authority-is-a-durable-ordered-byte-log.md).
  Delete this file once all four are `Accepted` and built.

Replaces `specs/20260805T190000-replicated-cell-store-memo.md`, which explored a
hand-built per-field cell store. That store is not being built. The exploration
is recoverable from git; the measurements that survived are below.

## The vision this works backward from

**Epicenter is where everything you make lives, no matter which app you made it
in.**

Not "local-first personal data platform", which is what Tolaria, Hubble, Obsidian
and a dozen others also say. The distinguishing claim is that the work you do
inside other people's apps, the tagging and rating and organizing and writing,
lives with you rather than inside whichever app prompted it.

Three planes, and only one of them merges:

| plane | what it holds | how it converges |
| --- | --- | --- |
| **contributed** | notes, tags, ratings, playlists, saved queries, recordings' titles | Yjs. ADR-0212 |
| **received** | Gmail messages, Spotify tracks | not at all. rebuild from the provider (ADR-0192) |
| **captured** | audio, photos | not at all. write once, deliver bytes |

The contributed plane is the small one: 986 notes, 2.84 MB. The mirror is
gigabytes. Every hard sizing question in the previous memo was asked of the wrong
number.

## Why the cell store lost

Head to head against Yjs 14 on the real vault:

| | Yjs | hand-built cell store |
| --- | --- | --- |
| stored size | **3.02 MB** | 5.11 MB |
| sync manifest | **state vector, ~0 KB** | 201 KB |
| one field changed | **43 B** | 172 B |
| projection rebuild | **2 ms** | 4 ms |
| a field edited 5,000 times | **2 structs, 0.1 KB** | grows linearly |

The one thing Yjs cannot do is resolve a concurrent same-field write by recency;
the higher `clientID` wins. Verified by giving the low-`clientID` device a
20-operation head start and making it write last. That single property is what
roughly 2,100 lines of record were buying, and it was traded deliberately.

## Prose is a nested type, and the split it justified is gone

The table above justified splitting prose into its own document, and every entry
in it was true. It has been withdrawn anyway, because the bound in its last row
is what the split existed to satisfy, and ADR-0215 deletes the bound: nothing
hydrates on the authority, so there is nothing for a bound to protect.

Prose is now a nested container inside the row, holding roots the application
names and types. Measured, binding `@y/prosemirror@2.0.0-6` to a row that holds
`title` and `tags`:

| | the row's fields afterwards | reading it back |
| --- | --- | --- |
| bound to a nested type | `title: 'Groceries'`, `tags: ['food']` | `'buy milk'` |
| bound to the row, plain schema | survive | **throws** `Position -1 outside of fragment` |
| bound to the row, schema with `doc` attrs | **`title: 'PM OWNS THIS'`** | n/a |

So the nesting is load-bearing and the reason is sharper than ADR-0212 inferred
from source: a row's fields and a ProseMirror document node's attributes are one
namespace, and they corrupt each other in both directions.

## Refusals, and what each one deleted

| refused | deleted |
| --- | --- |
| recency on a concurrent same-field write | the version triple, the digest, the clock, the clamp, the re-stamp |
| history inside the CRDT | unbounded growth; `gc: true` collapses 5,000 edits to 2 structs |
| cross-device undo | the snapshot-in-place machinery |
| collecting tombstones | causal stability, a device roster, an eviction policy, a quiescence button |
| a rebase or epoch | measured at 1% reclaimed and total corruption for a device that missed it |
| a trash in the platform | retention windows and a two-stage lifecycle. Apps own it |
| property assignment as a write | an unreportable failure channel |
| replacing a content field's document | silent writes into a detached handle held by an editor |
| loose files for persistence | impossible anyway: a second OPFS owner is refused |
| field builder functions | a compile step and an identity-keyed cache, source of two live bugs |

## Clearing is not optional, and a dead row costs 170 bytes

Measured over 1,000 rows:

```txt
1,000 live rows                            2888.2 KB
setting a tombstone flag only              2908.5 KB   <- LARGER
clearing content, then flagging              86.4 KB   <- 97% reclaimed
```

A dead row then costs about **82 bytes** with ADR-0206's 24-character minted ids
and three fields, following `35 + len(rowId) + SUM(2 + len(fieldName))`. Flat in
row count and unchanged by value size, edit history, or compaction, but *not*
flat in row shape: every cleared field leaves a tombstone carrying its own name,
undeduplicated. A hundred thousand lifetime deletions cost about 8.2 MB.

Three earlier figures were wrong: 21 to 23 bytes, then 68, then 170. The first
two measured a root that had never held a field. The 170 reproduces only with
`gc: false`, which is also where the claim that compaction cannot reduce it came
from; one wrong flag produced both sentences.

## Corrected after five adversarial API reviews

Five things in the first draft of these records were wrong and are fixed:

| was | is | why |
| --- | --- | --- |
| one Yjs root per row | one root per **table**, rows nested | `findRootTypeKey` linearly scans `doc.share` (`utils/ID.js:79-87`), so root-per-row encoding is quadratic: **5,417 ms** at 20,000 rows against 13 ms nested |
| a dead row costs 21 to 23 B | **170 B** | measured the way deletion works, with ADR-0206's 24-character ids. 100,000 deletions is 17 MB, not 2.2 MB |
| a `kv` section | a table with a chosen row id | ADR-0206 already deleted this at `d5e53cca24`, +1303/-6422 |
| `content`, then `TEXT = '!text'` | **the lens says nothing about prose** | ADR-0130 already decides a row owns a document inherently and the table "does not opt in, declare roots, or choose a format". Deletes the sentinel and the prose/scalar type split. Cost: ADR-0207's hole reopens, so prose does not reach the folder |
| `note.set()`, `note.body.insert()` | `notes.update(id, ...)`, `db.notes.document(id)` | a stale handle can half-resurrect a row; and once an application is one document there is nothing left to load, so opening is synchronous again |

An earlier rejection of the nested layout was also wrong: it tested deletion as
`deleteAttr(rowId)` on the table root, which destroys a concurrent edit. Clearing
fields on the nested type and flagging `!presence` converges with the tombstone
held and the edit retained, exactly as roots do.

Also found in shipped code, unfixed: `patch` on an absent row returns
`Ok(undefined)` and silently swallows the write.

## Defaults, and why there is still no kv

arktype expresses a default inside the expression, so the lens stays JSON:
`"'light'|'dark' = 'light'"`. Measured: `{}` yields `light`, `{theme:'dark'}`
keeps `dark`, and `{theme:'purple'}` is still an error. **A default fills an
absent key; it does not rescue a present but invalid one.**

So there is one read verb and recovery is composed at the call site from two
pieces of data: `db.settings.defaults` (arktype yields them by validating `{}`)
and `error.conforming` (the fields that did pass). `data ?? defaults` is the
whole-object fallback; `{ ...defaults, ...(data ?? error.conforming) }` keeps the
good fields when a release narrows one. A `getOrDefault` verb was drafted and
withdrawn: it is that second line with the composition frozen. Use `??`, never a
destructuring default, because `Err` sets `data: null` and a destructuring
default fires only on `undefined`.

## Closed since the first draft

- **`@y/prosemirror` has now been run**, against the real installed
  `2.0.0-6` with its local patch. See the table above. The containment is
  verified rather than inferred, and binding to the row is refused on evidence.
- **Prefetch policy for prose** is answered by having none: one document means
  everything syncs, so prefetching stops being a policy and becomes the
  mechanism.
- **Who names the prose type** is answered by the application naming it, which
  is what `document.get('editor', 'text')` is for. Yjs 14 gives a type its
  behaviour from its name, verified, so a single typed slot would have forced
  Epicenter to choose a format it refuses to know about.

## Open

- **Prose does not reach the folder, and that is now chosen.** A row's document
  is inherent, so Epicenter never learns which root inside it holds writing. An
  application that wants its prose on disk puts it in an ordinary field instead.
- **A table root grows monotonically**, and listing it touches every corpse:
  24.9 ms to list a thousand live rows among a hundred thousand. If a table ever
  gets slow, the fix is a second attribute naming only the live rows. The address
  should be able to carry a generation; no generation mechanism is built, and the
  rebuild it would enable is refused because a device that missed one has its
  offline edit destroyed.
- **The client memory ceiling is 10,000 to 15,000 live rows per application**
  (ADR-0215). Past it the lever is not hydrating the whole document, because the
  projection already holds the queryable copy. Not built; no application is near
  it.
- **A per-dead-row figure needs reconciling.** ADR-0212 says 170 B; the same
  measurement gives 78 B for a three-field row and 93 B with a body.
- **The wire is not built.** The lens and the store are; the Durable Object, the
  socket, and the cutover of the old `packages/data` stack are not.
