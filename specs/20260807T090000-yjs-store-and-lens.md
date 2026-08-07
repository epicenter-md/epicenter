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

## Deletion costs 21 bytes, and clearing is not optional

Measured over 1,000 rows:

```txt
1,000 live rows                            2888.2 KB
setting a tombstone flag only              2908.5 KB   <- LARGER
clearing content, then flagging              86.4 KB   <- 97% reclaimed
```

A dead row then costs a flat 21 to 23 bytes, from one thousand to one hundred
thousand of them.

## Open

- **The `content` sentinel** sits beside the arktype object rather than inside
  it, because a Yjs document is not a value to validate. That is the last
  unsettled shape in the lens.
- **Prefetch policy for prose.** The index syncs always; a body syncs when
  opened. Going offline with unopened notes needs a prefetch rule. Prefetching
  everything is 2.7 MB.
- **`doc.share` grows monotonically.** Bounded in practice at 21 bytes a dead
  row; not bounded if an application ever writes rows at machine rate. The
  address should be able to carry a generation. No generation mechanism is built.
- **`@y/prosemirror` binding was never run.** Source reading shows it calls
  `setAttr` and `deleteAttr` on the type it binds to, which is why the prose
  document is separate. The containment was verified structurally, but the real
  binding has not been exercised.
- **Nothing here is built.** Every figure is a measurement against the real
  vault or the installed `@y/y@14.0.0-rc.24`, not against shipped Epicenter code.
