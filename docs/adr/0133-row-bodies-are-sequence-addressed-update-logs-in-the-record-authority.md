# 0133. Row bodies are sequence-addressed update logs in the record authority

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md), [ADR-0135](0135-row-bodies-have-one-content-root.md), [ADR-0136](0136-replica-bootstrap-uses-a-disposable-anchored-live-scan.md)

## Context

ADR-0130 makes a collaborative body row-owned with no public identity. The
authority must accept body updates and row deletion under one liveness rule and
one transaction. Independent Yjs rooms cannot provide that boundary. The
remaining question is how confirmed body outcomes are retained and replicated
without turning the authority into a Yjs document runtime.

## Decision

The record authority stores each accepted row-body update as opaque bytes under
the one authority sequence assigned to its applied `RowIntent`. When fields and
body both apply, the fields' current postimage and body update share one
composite row outcome at that sequence. This sequence-addressed body tail is
confirmed transport, not a fourth mutation command and not the replica's
canonical body representation.

The authority treats update bytes as opaque. It does not inspect Yjs roots,
choose document layouts, or decide editor schema. The fixed supported layout is
a client API contract owned by ADR-0135; update encoding compatibility belongs
to the workspace protocol major.

RowIntent folding owns body liveness:

- A successful `create` may install its initial fields and body update in one
  transaction. A create collision no-ops as a whole, so body bytes cannot merge
  into another row lifetime.
- `update` on an absent row no-ops as a whole. On a live row, a valid body
  component appends even when an unrelated field component no-ops under the
  scalar capacity rule.
- `delete` removes the row and all authoritative body state in one transaction.
  Late updates for the absent address remain deterministic no-ops.

A create with an initial body is one intent, so there is no scalar-before-body
command order and no separate offline parking state. Every ordinary row is
body-capable, but an empty body persists no update; absence is the merge identity.

Body updates use their authority sequence, never a per-row positional index.
Compaction may reindex a physical list, while the global sequence remains the
stable replication cursor already owned by state paging.

The authority stores each body's compacted baseline with the authority sequence
through which it is complete, plus every retained body outcome above that
sequence. The retention floor is the greatest authority sequence below which
ordinary outcomes may be removed. Body compaction may fold outcomes only through
that floor, so every outcome above the floor remains available to catch-up.

An injected codec merges a baseline and its retained tail for compaction and
bootstrap; ordinary authority folding remains append-only and byte-opaque. The
sync core stays CRDT-library-free. Merge and application are idempotent: a
baseline or update installed twice hydrates to the same Yjs state. ADR-0136
scans the complete baseline-plus-tail composite and then replays outcomes after
its anchor; overlap is safe because Yjs updates are idempotent.

State pages emit one composite row outcome per applied RowIntent. It may carry
the latest scalar row image, the incremental body update, or both. Delete is a
separate outcome. This is not a return to authorship commands: the field value
is a confirmed postimage, and the body component comes from the retained
incremental tail.

## Consequences

- Row fields and body share one authority, order, liveness rule, and delete
  transaction even though their confirmed transport shapes differ.
- Body updates concurrent with deletion cannot survive the deletion fold.
- Replicas store one confirmed merged body baseline plus at most one sealed and
  one open body component; they do not retain the authority tail locally.
- Interior collaborative merge remains earned while ordinary fields and KV stay
  plain JSON under authority order.
- The authority owns merge-aware compaction through an injected codec. Without
  compaction, a hot body's retained tail and baseline-scan work grow without
  bound.
- Per-room Yjs transports, catalogs, and persistence for row-owned bodies are
  replacement targets.

## Considered alternatives

- **Keep `bodyAppend` as a wire command.** Rejected because the update is a
  component of `RowIntent`; the authority tail does not define authorship.
- **Independent Yjs rooms keyed by row id.** Rejected because row deletion and
  body acceptance would remain split across authorities.
- **Per-row positional update indexes.** Rejected because compaction can reuse
  an index for different bytes and make replicas diverge.
- **Hydrate Yjs inside ordinary authority folding.** Rejected because only
  compaction needs merge awareness; admission, storage, paging, and deletion
  can stay byte-opaque.
- **Unbounded update tails.** Rejected because a hot collaborative body would
  grow authority storage and baseline-scan work forever.
