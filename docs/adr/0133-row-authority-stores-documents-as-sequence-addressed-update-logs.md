# 0133. The row authority stores documents as sequence-addressed update logs

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), [ADR-0136](0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)

## Context

ADR-0130 makes a collaborative document row-owned with no public identity. The
authority must accept document updates and row deletion under one liveness rule
and one transaction. Independent Yjs rooms cannot provide that boundary. The
remaining question is how confirmed document outcomes are retained and
replicated without turning the authority into a Yjs document runtime.

## Decision

The row authority stores each accepted row-document update as opaque bytes under
the one authority sequence assigned to its applied `RowIntent`. When fields and
document both apply, the fields' current postimage and document update share one
composite row outcome at that sequence. This sequence-addressed document tail is
confirmed transport, not a fourth mutation command and not the replica's
canonical document representation.

The authority treats update layout as opaque. It validates the update's
protocol-level byte bound and uses an injected Yjs codec to compute whether the
merged compact document remains within the canonical maximum, but it does not
inspect roots, choose document layouts, or decide editor schema.
Application-owned root composition is a client API contract owned by ADR-0135;
update encoding compatibility and the encoded canonical document maximum belong
to the one active workspace protocol major.

RowIntent folding owns document liveness:

- A successful `create` may install its initial fields and document update in one
  transaction. A create collision no-ops as a whole, so document bytes cannot
  merge into another row lifetime.
- `update` on an absent row no-ops as a whole. On a live row, a valid document
  component within the merged document bound appends even when an unrelated
  field component no-ops under the scalar capacity rule.
- `delete` removes the row and all authoritative document state in one
  transaction. Late updates for the absent address remain deterministic no-ops.

A create with an initial document is one intent, so there is no
scalar-before-document command order and no separate offline parking state.
Every ordinary row is document-capable, but an empty document persists no
update; absence is the merge identity.

Document updates use their authority sequence, never a per-row positional index.
Compaction may reindex a physical list, while the global sequence remains the
stable replication cursor already owned by state paging.

The authority stores each document's compacted baseline with the authority
sequence through which it is complete, plus every retained document outcome above that
sequence. The retention floor is the greatest authority sequence below which
ordinary outcomes may be removed. Document compaction may fold outcomes only
through that floor, so every outcome above the floor remains available to
catch-up.

For every document-bearing fold, the injected codec hydrates the current
baseline and tail with the candidate update into a fresh `gc: true` Yjs
document and encodes its compact full state. If that state exceeds ADR-0131's
canonical document maximum, the document component deterministically no-ops.
Otherwise ordinary authority storage appends the original update bytes at the
RowIntent's sequence.

The same codec periodically replaces a baseline and the tail below the
retention floor with a compact full-state baseline. The sync core remains
independent of root layout and editor schema while the injected codec owns the
minimum merge-aware admission and compaction operations. Merge and application
are idempotent: a baseline or update installed twice hydrates to the same Yjs
state. ADR-0136 scans the complete baseline-plus-tail composite and then replays
outcomes after its anchor; overlap is safe because Yjs updates are idempotent.

Row documents are bounded interactive content, not storage for media or large
files. Garbage collection can remove deleted structs from the compacted state,
but it cannot shrink live content. Files and media use the filesystem or blob
plane. The protocol does not add chunks, upload sessions, or multiple fragments
to make an oversized document admissible.

State pages emit one composite row outcome per applied RowIntent. It may carry
the latest scalar row image, the incremental document update, or both. Delete
is a separate outcome. This is not a return to authorship commands: the field value
is a confirmed postimage, and the document component comes from the retained
incremental tail.

## Consequences

- Row fields and document share one authority, order, liveness rule, and delete
  transaction even though their confirmed transport shapes differ.
- Document updates concurrent with deletion cannot survive the deletion fold.
- Replicas store one confirmed merged document baseline plus at most one sealed
  and one open document component; they do not retain the authority tail locally.
- Interior collaborative merge remains earned while ordinary fields and KV stay
  plain JSON under authority order.
- The authority owns merge-aware admission and compaction through an injected
  codec. Admission prevents concurrent valid updates from producing an
  unsendable canonical document; compaction bounds a hot document's retained
  tail and baseline-scan work.
- The encoded document maximum is a product contract. Increasing it is a
  deliberate protocol and deployment decision, not an automatic chunking path.
- Per-room Yjs transports, catalogs, and persistence for row-owned documents are
  replacement targets.

## Considered alternatives

- **Keep `bodyAppend` as a wire command.** Rejected because the update is a
  component of `RowIntent`; the authority tail does not define authorship.
- **Independent Yjs rooms keyed by row id.** Rejected because row deletion and
  document acceptance would remain split across authorities.
- **Per-row positional update indexes.** Rejected because compaction can reuse
  an index for different bytes and make replicas diverge.
- **Keep ordinary authority folding entirely byte-opaque.** Rejected because
  client admission cannot bound the result of merging concurrent offline
  documents.
- **Unbounded update tails.** Rejected because a hot collaborative document would
  grow authority storage and baseline-scan work forever.
