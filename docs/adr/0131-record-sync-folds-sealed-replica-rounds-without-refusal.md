# 0131. Record sync folds sealed replica rounds without refusal

- **Status:** Proposed
- **Date:** 2026-07-16
- **Relates:** [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md), [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md)

## Context

ADR-0119's wire lets the authority refuse commands after a replica has already
admitted them locally (`create-conflict`, `row-too-large`), so the client
carries recovery machinery whose only job is surviving that refusal: a durable
quarantine table, dependent-intent partitioning, actor rotation, a full local
wipe with rebootstrap, per-command actor sequences with contiguity checks, and
an authority-side stored batch JSON (up to 768 KiB per actor) plus a six-field
receipt so retries can be answered exactly. ADR-0121 already resolves same-key
conflicts by server acceptance order without asking anyone. A prototype
falsification pass (139 executable trace checks and three independent audits;
see the git history of `packages/workspace/__prototypes__/sqlite-sync-decision/`
and `specs/20260716T173049-fold-never-refuse-sync-architecture.md`) showed the
same doctrine can absorb capacity and identity conflicts, and found that
today's pull-install replay already writes over-cap optimistic rows unchecked.

## Decision

A replica submits intent as sealed rounds and the authority never refuses an
admitted round. Wire protocol major 5 carries this model; the pieces below are
one decision because each is unsound without the others.

**Fold rules.** Every command in an accepted round is ordered and folds into
current state as an application or a deterministic no-op: a command whose
folded row would exceed the row cap folds to a no-op; `createRow` on a live
row folds to a no-op (first create wins); `patchRow` and `deleteRow` on an
absent row remain accepted no-ops. The client mirrors these rules when it
replays pending intent over installed state, and may surface a local
"this edit did not apply" diagnostic.

**Dead identities.** A deleted row id is dead forever as a client-runtime
invariant: the public `create` allocates runtime UUIDs and accepts no
caller-supplied id anywhere, and a replica drops pending intent for a row the
authority reports deleted. The authority polices order, not identity; it keeps
no used-identity registry, and absence folding late updates to no-ops is its
entire guarantee.

**The exchange.** `sync({ token, sealedRound? })` answers with ordered
current-state pages from the caller's checkpoint plus a new token. A sealed
round is `(replicaId, round, requestDigest, commands[])`; order within a round
is array order; the authority folds a round exactly once and stores one
`(replicaId, acceptedRound, requestDigest)` triple per replica. A retry whose
digest matches refolds nothing and pages regenerate from current state. The
terminal verdicts are exactly: a digest mismatch on the accepted round, and a
round number that is neither `acceptedRound` nor `acceptedRound + 1` (a late
round from an old fork is undecidable with one stored digest, so it is
terminal). Fork recovery is fresh replica identity plus resubmitted pending
intent; everything folds. The token packages
`(replicaId, acceptedRound, checkpoint)`; both sides still hold those facts,
and the server-minted checkpoint is the only part a client cannot fabricate.
The sealed round leaves disk only when its exchange completes (accepted and
paged to head); until then the client replays it over each installed page so
its own writes never visibly regress. Rounds are accepted before stale-client
snapshot bootstrap, always.

## Consequences

- Deleted outright: the client quarantine table, dependent-intent
  partitioning, actor rotation, the `requires_bootstrap` wipe, per-command
  actor sequences and contiguity checks, per-command accepted-sequence stamps
  (one per-round bit replaces them), and the authority's stored batch JSON and
  receipt (the replica triple replaces them).
- The round replay is idempotent only because of the fold rules
  (first-create-wins makes replayed `createRow` a no-op instead of a
  conflict), and one stored digest is sufficient only because stale rounds are
  terminal. Adopting the exchange without the fold rules, or narrowing the
  terminal rule back to digest-mismatch-only, reintroduces proven
  counter-traces.
- Durable rejected-intent evidence disappears. A capacity or duplicate-create
  loser evaporates exactly like a same-key conflict loser (ADR-0121 doctrine).
  The replay-time diagnostic is heuristic and in-memory; if durable evidence
  is ever wanted it is a small optional client-side table written when a
  sealed command re-folds to a no-op at retirement, never authority machinery.
- The client-side mirror of the capacity rule closes an existing hole: today's
  `replayOutbox` writes folded rows with no admissibility check, so local
  optimistic state can already exceed the cap.
- Row tombstones, the compaction floor, snapshot manifest/chunks, and staged
  snapshot install survive unchanged. ADR-0122's checkpoint "actor high-water
  marks" become replica round marks.
- Protocol major 5 is a clean break: mixed-version peers refuse each other at
  the envelope, exactly as today.

## Considered alternatives

- **Refuse-and-quarantine (status quo).** Its only value fold rules cannot
  replace is durable rejected-intent evidence; it costs quarantine, rotation,
  rebootstrap, receipts, and stored batches.
- **Digest mismatch as the only terminal verdict.** Falsified: one stored
  digest cannot judge a late older round from a fork.
- **Per-command accepted-sequence stamps retained.** Unnecessary once folds
  are idempotent; a sealed round retires whole at exchange completion.
- **Per-replica server diffs or server shadow state.** Grows authority state
  beyond the three-value replica record to save client bytes the ordered
  stream plus snapshot floor already bounds.
- **Authority-assigned row incarnation fencing.** Nothing is left to fence
  once ids are dead forever and creates mint their own UUIDs.
