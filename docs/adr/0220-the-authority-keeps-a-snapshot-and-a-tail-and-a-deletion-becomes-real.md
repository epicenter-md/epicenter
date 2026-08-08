# 0220. The authority keeps a snapshot and a tail, and a deletion becomes real

- **Status:** Accepted
- **Date:** 2026-08-08
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0220 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md)
  at its central refusal. Withdrawn: that the log is never compacted, that no
  party ever verifies another party's claim, and the whole *generations* section.
  What survives, unchanged, is that the authority holds opaque bytes, that the
  merge belongs to the client, that catch-up and live relay are one path, and
  that there is no state vector in the transport.
- **Relates:** [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md)
  (the authority reads nothing, which this preserves),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (local persistence and history).
- Evidence: `packages/data/src/sync/transport.test.ts` (including a seeded
  convergence fuzz), `packages/data/evidence/retention.test.ts`,
  `packages/data/evidence/workerd/results.md`.

## Context

ADR-0217 refused compaction, because compaction must prove the replacement
covers what it replaces and that proof needs semantics the authority does not
have. Refusing it removed the requirement, and the price was quoted as storage:
about 4 MB a year against 10 GB.

That was not the price. An append-only log keeps the update that CREATED a row,
so deleting the row removes it from current state and removes nothing from the
log. Measured with a canary and a control: after a delete the text is still
recoverable from the authority's log, and **a device joining for the first time
downloads every note anyone has ever deleted** (`evidence/retention.test.ts`).
It then displays none of them, because the lens reads current state, so nothing
surfaces it.

The log also grew forever, so first sync grew forever, and the only escape from
the tombstone ceiling was a rebuild, which needed generations, a pointer,
compare-and-swap, freezing, migration and reconciliation.

## Decision

**The authority keeps one snapshot and the entries after it. Not a log.**

A replica offers its whole state as the snapshot for a position; everything the
snapshot covers is forgotten. Storage stops growing, first sync becomes state
plus a short tail, and a deletion becomes real, because a snapshot is current
state and carries no trace of what was deleted before it.

### The condition is checkable without semantics, and it is two halves

This is compaction, which four designs failed at, and it works here only because
the precondition can be checked by counting rather than by understanding.

- **The authority checks coverage.** The offered position must lie inside the
  log and ahead of the snapshot already held.
- **The hub checks provenance.** The offer must come from a connection the
  authority has *sent* everything through that position. That is the authority's
  own record of what it transmitted, **not a claim the replica makes about
  itself**, and it is the entire difference between this and the client-posted
  baseline that an earlier design died on. Thirteen bytes of an empty document
  offered by a connection that has been sent nothing is refused, and the test
  that pins it uses exactly that payload.

### It is coverage, not currency

The first implementation required `position === head` and was wrong. An entry
landing between the request and the offer moved the head, and a perfectly good
snapshot was refused; under ordinary traffic that happened constantly. A
snapshot at P is only ever used to forget entries at or before P, so being
current was never the requirement.

### The trigger has one number in it

A snapshot is taken when the tail outgrows the snapshot, which bounds both
storage and any returning replica's download at about twice the state, and
needs no interval to tune.

**It also needs a floor, and pretending otherwise cost a live run.** The ratio
is scale-free, so on a small document the next update outgrows the snapshot
immediately; against Cloudflare it snapshotted on nearly every message and
stalled around the two hundredth. Below the floor the whole log is trivial and
replacing it buys nothing.

### Re-delivery is ordinary, and a gap is recoverable

Two rules the first implementation got backwards, both found by a seeded fuzz
over random schedules rather than by any written scenario.

**An entry already applied is not an error.** Re-delivery is a property the
design leans on: a crash between committing bytes and advancing the cursor, a
reconnect carrying what was in flight, and a hibernating Durable Object waking
with a position behind what it truly sent all re-send deliberately. Treating
that as a gap made the recovery path report data loss.

**A gap must not be permanent.** The cursor refuses to move past one, which is
right, so every later entry is also a gap. Reporting an error and waiting for
someone to notice meant nobody did: the fuzz produced a replica wedged at
position 108, still being sent 118, 119 and 121, rejecting all of them while its
rows silently stopped updating. `status().needsResync` now says so, and the
repair is a reconnect, which is the catch-up any returning device already runs.

### One place a cursor may jump

A snapshot arrives as its own frame carrying its position, and adopting it moves
a replica's cursor there in one step. That is the only permitted jump: a gap
arriving as an ordinary entry is still refused, because a gap in the log is data
nobody will mention again. It is safe here for a reason unrelated to trust, in
that the snapshot covers every position at or before it.

Adopting **merges** rather than replaces. Identities are preserved, so a replica
arriving with unsent offline work keeps it and pushes it afterwards like any
other local write. Verified end to end: a replica 30 entries behind, whose tail
no longer exists, converges and keeps a note nobody had seen.

## Consequences

- **What ADR-0217 said about no party verifying another's claim is withdrawn.**
  The authority now verifies a precondition. It is a fact about what it sent
  rather than a claim about content, but the sentence is no longer true.
- **Generations are deleted, not deferred.** They answered "and then what" for a
  log that grew forever. It does not.
- **Server-side history is gone.** ADR-0214's `history.sqlite3` on each device
  is now the only full history. Relocated, not lost, and a deliberate loss of
  the ability to restore the authority to an arbitrary past point.
- **The previous snapshot is kept.** A poison entry is one row and repairable
  (ADR-0218); a bad snapshot replaces history and is not, so one spare is the
  only way back.
- **Tombstone memory is unchanged**, and remains a non-problem at realistic
  churn: about 14 deletions a day for a decade to reach 100 MB, with
  `store.pressure()` reporting the ratio so it is watched rather than argued
  about.
- **The retention window and the 90-day deletion promise are withdrawn as
  mechanisms.** Deleted data now disappears at the next snapshot, which is a
  function of write volume rather than of a policy.
- **Four bugs came from running this rather than from testing it.** Two from
  Cloudflare (a trigger that thrashed, a refusal that crossed wires) and two
  from a randomised schedule (re-delivery read as a gap, a gap that wedged a
  replica forever). Scenario tests find bugs someone already imagined; these
  were not among them, and the fuzz is kept for that reason.
- **What the fuzz covers, and what it cannot.** Three replicas, random creates,
  updates, deletes and prose, random disconnects and reconnects, snapshots
  firing throughout, compared against a model held outside the system so that
  every replica agreeing on the wrong answer still fails. It runs in one process
  over an in-order wire.
- **Still uncovered, and worth naming rather than implying.** Genuine
  hibernation eviction, which is production code in the Durable Object adapter
  that has never executed; a socket dying part way through a chunked snapshot;
  more than three replicas; a lens mismatch between devices; and a stall
  observed once against Cloudflare that has no cause and is not claimed fixed.
