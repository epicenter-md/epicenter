# The Yjs store, the lens, and where history lives

- **Status:** In Progress
- **Date:** 2026-08-07
- **Settled as:** [ADR-0212](../docs/adr/0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md),
  [ADR-0213](../docs/adr/0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md),
  [ADR-0214](../docs/adr/0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md).
  Delete this file once all three are `Accepted` and built.

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

## Prose is its own document

| | prose in the row | prose as its own document |
| --- | --- | --- |
| bytes at startup | 3.04 MB | **0.31 MB** |
| total stored | 3.04 MB | **2.99 MB** |
| cold open | 7.2 ms | **2.3 ms** |
| open five notes | n/a | **0.18 ms** |
| per-document overhead | n/a | **27 B** |
| ADR-0146's 1 MB bound | **over** | index and every body under |

Smaller in total, ten times smaller at startup, and the only arrangement that
satisfies a bound ADR-0174 makes terminal. This is ADR-0130's "every ordinary row
inherently owns one lazy collaborative document", which was already `Accepted`.

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

A dead row then costs a flat **170 bytes**, measured with ADR-0206's
24-character minted ids and unchanged by compaction. So a hundred thousand
lifetime deletions cost 17 MB. Two earlier figures in these records, 21 to 23
bytes and then 68, were both wrong: they measured a root that had never held a
field. The 86.4 KB above already implied 86 bytes each.

## Corrected after five adversarial API reviews

Five things in the first draft of these records were wrong and are fixed:

| was | is | why |
| --- | --- | --- |
| one Yjs root per row | one root per **table**, rows nested | `findRootTypeKey` linearly scans `doc.share` (`utils/ID.js:79-87`), so root-per-row encoding is quadratic: **5,417 ms** at 20,000 rows against 13 ms nested |
| a dead row costs 21 to 23 B | **170 B** | measured the way deletion works, with ADR-0206's 24-character ids. 100,000 deletions is 17 MB, not 2.2 MB |
| a `kv` section | a table with a chosen row id | ADR-0206 already deleted this at `d5e53cca24`, +1303/-6422 |
| `content`, then `TEXT = '!text'` | **the lens says nothing about prose** | ADR-0130 already decides a row owns a document inherently and the table "does not opt in, declare roots, or choose a format". Deletes the sentinel and the prose/scalar type split. Cost: ADR-0207's hole reopens, so prose does not reach the folder |
| `note.set()`, `note.body.insert()` | `notes.set(id, ...)`, `await notes.prose(id, field)` | a stale handle can half-resurrect a row, and prose opening is a port round trip on two of three surfaces |

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

## Open

- **Prose does not reach the folder, and that is now chosen.** A row's document
  is inherent, so Epicenter never learns which root inside it holds writing. An
  application that wants its prose on disk puts it in an ordinary field instead.
- **Prefetch policy for prose.** The index syncs always; a body syncs when
  opened. Going offline with unopened notes needs a prefetch rule. Prefetching
  everything is 2.7 MB.
- **A table root grows monotonically**, and listing it touches every corpse:
  24.9 ms to list a thousand live rows among a hundred thousand. If a table ever
  gets slow, the fix is a second attribute naming only the live rows. The address
  should be able to carry a generation; no generation mechanism is built, and the
  rebuild it would enable is refused because a device that missed one has its
  offline edit destroyed.
- **`@y/prosemirror` binding was never run.** Source reading shows it calls
  `setAttr` and `deleteAttr` on the type it binds to, which is why the prose
  document is separate. The containment was verified structurally, but the real
  binding has not been exercised.
- **Nothing here is built.** Every figure is a measurement against the real
  vault or the installed `@y/y@14.0.0-rc.24`, not against shipped Epicenter code.
