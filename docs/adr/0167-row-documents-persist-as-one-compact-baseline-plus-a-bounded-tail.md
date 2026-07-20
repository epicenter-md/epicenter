# 0167. Row documents persist as one compact baseline plus a bounded tail

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md) and [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)
- **Relates:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md) and [ADR-0161](0161-each-local-owner-persists-one-sqlite-database-and-one-blob-directory.md)

## Context

Appending every Yjs update forever makes storage and hydration unbounded.
Replacing a complete document after every edit turns a small keystroke into a
full-state SQLite write. Binary `mergeUpdatesV2` removes duplicate encoding but
does not garbage-collect deleted content.

The authority must also admit a legal document diff that may exceed Cloudflare
Durable Object SQLite's 2,000,000-byte BLOB and row ceiling even when the
resulting canonical document remains inside Epicenter's 1 MiB state bound.

## Decision

Each durable row document has one optional compact Yjs 14 `updateV2` baseline
followed by an ordered tail of incremental `updateV2` values. Both the selected
local Epicenter SQLite and the server authority SQLite use this logical shape. A
row that has never acquired document content stores neither.

The tail is an operational durability buffer. It is not mutation history,
authorship history, an undo log, or a user-visible snapshot sequence. Tail count
and encoded bytes remain bounded independently of baseline size.

Appending an update rechecks row liveness and commits the update in the same
SQLite transaction. At a count or byte threshold, compaction reads one fixed
covered prefix, applies the baseline and that prefix to a fresh
`Y.Doc({ gc: true })`, encodes one complete state with
`encodeStateAsUpdateV2`, replaces the baseline, and deletes the covered tail in
one transaction. `mergeUpdatesV2` alone is never compaction.

The authority applies each candidate to committed state before mutation and
measures the canonical post-candidate encoding against the existing 1,048,576
byte and 131,072 struct bounds. Invalid or over-bound candidates leave committed
state unchanged.

No tail row may approach the Durable Object SQLite row ceiling. When a valid
candidate exceeds a conservative storage-row budget but its canonical state is
legal, the same transaction writes that state as the new baseline and clears
the covered tail instead of inserting the candidate as one oversized BLOB.

Compaction preserves Yjs client clocks, garbage-collected identity ranges, and
the deletion set. An old peer can still repair through a state-vector exchange.
Compaction discards deleted payload and therefore promises neither historical
reconstruction nor persisted undo. `Y.snapshot()` is not a persistence format.

## Consequences

- Ordinary durability writes only the incremental update. Hydration and storage
  remain bounded by one baseline and a short tail.
- Garbage collection can reduce deleted payload bytes, but it is not an epoch
  reset. Structurally dense documents can still reach the struct ceiling; the
  escape is moving valuable content to a freshly generated row.
- Local documents remain durable and exportable even when their canonical state
  cannot enter the server bound.
- A valid near-row-limit frame is canonicalized instead of gaining a private
  chunk protocol.

## Considered alternatives

- **Append every update forever.** Rejected because storage and replay grow
  without a bound.
- **Rewrite one baseline after every edit.** Rejected because every small edit
  writes the complete document.
- **Use `mergeUpdatesV2` as compaction.** Rejected because it does not
  garbage-collect deleted content.
- **Chunk oversized update rows.** Rejected because the already-computed legal
  canonical state fits and needs no second framing format.
- **Retain deleted payload for history.** Rejected because historical
  reconstruction is not a row-document promise.
