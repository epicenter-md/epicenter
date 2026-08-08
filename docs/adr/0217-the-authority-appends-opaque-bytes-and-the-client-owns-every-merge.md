# 0217. The authority appends opaque bytes, and the client owns every merge

- **Status:** Accepted
- **Date:** 2026-08-07
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0217 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (an application is one document, and the record that deliberately left the
  authority open),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (local persistence),
  [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  (the address carries a generation, and nothing increments it).
- **Amends:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  at one section, *The authority is not settled*, which is now settled here.
  Everything else in that record stands untouched. Supersedes nothing: the four
  designs that failed there were never accepted.
- Evidence: `packages/data/evidence/validation.test.ts`,
  `packages/data/evidence/workerd/results.md`,
  `packages/data/evidence/bench/never-compact.ts`,
  `packages/data/src/sync/transport.test.ts`.

## Context

Four authority designs were built and withdrawn, all failing at one joint:

```txt
A log must be compacted.
  Compaction must prove the replacement covers what it replaces.
    Proof requires semantics the authority was defined not to have.
```

Each fix addressed a different symptom and failed for a different reason, which
is the tell that the shape was wrong rather than the details.

## Decision

**The authority is an append-only log of opaque bytes. It never merges, never
compacts, and never holds a document. Every merge happens on a client, over
bytes that client authored.**

### Refusing compaction removes the requirement

The log grows for the life of the application. Measured over the real vault's
shape, coalescing on a roughly one-second idle timer costs about 4 MB a year
against 10 GB of Durable Object SQLite, and 41 MB over a decade
(`evidence/bench/never-compact.ts`).

The deletion is the point: compaction, baselines, coverage proofs, state-vector
domination, cursor-at-head rules, and the question of which party may replace
another party's history all go with it. No party ever verifies another party's
claim about the past.

### The merge moves to where it needs no proof

**A client may merge its own unsent updates, and needs no proof from anybody,
because it indisputably owns them.** Every failed design was trying to let one
party rewrite another party's history. Ownership makes verification unnecessary
rather than cheap.

This is also what makes refusing compaction affordable, and the 30x is entirely
a client-side choice: sending one update per transaction is what made compaction
feel mandatory.

### Four mechanisms, four distinct jobs

None patches another. That is the test they had to pass.

| mechanism | job |
| --- | --- |
| **coalesce** on an idle timer | cut log growth 30x, over bytes the client owns |
| **chunk** at the storage boundary | fit a value; pure framing, no semantics |
| **ack** carrying the assigned position | make a refusal visible |
| **filter** on the reassembled update | refuse what a decode can catch |

### There is no state vector in the transport

A replica's position is an integer index into the log. A state vector cannot
express deletion: a delete advances no clock, so two documents that disagree
about a key hold byte-identical state vectors (`evidence/invariants.test.ts`).
Any protocol reasoning about "has this peer caught up" from state vectors is
wrong about deletes, and that killed two of the four designs.

Catch-up is "everything after your cursor". A live relay is the same sentence
with a cursor one behind the head, so there is one delivery path rather than two
that can disagree.

### Every handover fails in the safe direction

`acknowledge` runs after the authority has confirmed, and `advance` runs after
bytes have committed. A crash re-offers or re-applies, which costs nothing
because an update is idempotent; the other order skips an entry, and a skipped
entry is invisible forever. No transactional coupling across the two systems is
needed, and none is built.

## The claim from the design memo that did not survive

The memo said the authority calls `encodeStateVectorFromUpdateV2`, keeps only
whether it threw, and that **"that is what closes the poison pill"**. Both halves
are wrong, and the correction is the substance of this record.

**It is the weakest available check.** An update truncated by ONE byte passes it
and throws on every device that applies it, which is the exact failure it was
chosen to prevent. Swept over every single-byte corruption and every tail
truncation of a real update:

| check | poison pills accepted, full update | on an increment |
| --- | --- | --- |
| `encodeStateVectorFromUpdateV2` | 108 | 103 |
| `diffUpdateV2` against an empty state vector | **44** | **4** |
| integrating into a throwaway `Y.Doc` | 0 | 3 |

**No check the authority can run closes the pill at all**, including holding a
document. Whether bytes throw depends on the structs the *receiver* already
holds, and the authority holds none by construction, so the receiver's predicate
is not available to it at any price. On the shape the transport actually carries
an increment, holding a document leaks 3 where the diff leaks 4, which is not a
difference worth a document for.

So the mechanism is a **filter, not a proof**, and what actually bounds the
damage is that **a partition has one writer principal**: the only party who can
author bytes that brick it is the party that owns it. The filter is still worth
being the best available one, because it costs one call and no document and it
turns an accidental truncation into a refusal a client can retry.

Neither check ever refuses bytes a receiver would have survived. That direction
would be unforgivable, and it is pinned.

## What the runtime said that no test could

- **The authority could not load.** Diffing against
  `Y.encodeStateVector(new Y.Doc())` at module scope mints a clientID through
  `crypto.getRandomValues`, and generating random values in global scope is a
  disallowed operation in a Worker. The constant is written out as
  `new Uint8Array([0])`, which also makes the central claim literally true.
- **The value cap is not where it is documented.** Bisected to the byte,
  identically in `wrangler dev` and in production, the engine stores 2,199,994
  and refuses 2,199,995. The 2,097,152 everyone quotes is Cloudflare's
  documented limit and sits 102,842 bytes under the wall. Chunking at the
  documented number is still right, for a different reason than stated.
- **A refusal is answered and the socket stays open**, which is the whole reason
  the ack exists: `workerd` swallows a throw in `webSocketMessage` without
  closing.

## When the log eventually fills: generations, designed and not built

The answer to "and then what" is not to compact it later under a different name.
It is to **supersede** it. A generation is immutable; if `<app>/1` approaches
10 GB, a client writes its complete state as seq 1 of `<app>/2` and devices move
there. Nothing is rewritten, so there is no coverage to verify.

It is **not ADR-0214's rebase**: seeding with `encodeStateAsUpdateV2` preserves
struct identities, so a device arriving with unsent work merges normally. It
self-heals, because every device on a fresh generation has a cursor of zero.
ADR-0212 already says the address carries a generation and nothing increments
it; this is what would.

**At 158 measured bytes an entry the ceiling is roughly 68 million entries, and
at the measured rate the trigger is millennia away.** A recovery path that never
executes is the one that fails when it finally does, so nothing is built. What
is instrumented instead is log size per application, which gives years of
warning. Three costs are recorded for whoever builds it: the redirect must
resolve before connecting or gen 1 can never be deleted; deleting gen 1 is a
time policy rather than a device roster; and a generation costs N snapshots
because each device pushes its full state on arrival.

## Consequences

- **Do not reintroduce compaction, baselines, or coverage proofs.** They are not
  missing; they were removed, and the requirement went with them.
- **The local log still collapses, and that is a different operation.** ADR-0214
  keeps the client's own file small by replaying its own bytes. It is why the
  outbox is a relation of its own rather than a cursor into `_updates`: that
  relation is renumbered from 1, so a position recorded against it would come to
  mean a different update.
- **ADR-0146's bound is no longer load-bearing for the authority**, which
  hydrates nothing. It is not withdrawn here, because the argument for removing
  it was withdrawn once already and nothing on this branch re-establishes it.
- **A remote update reaches the local log once.** The store persisted the bytes
  it emitted *and* the bytes it received, doubling the log invisibly; fixed with
  this work.
- **The throwaway `apps/sync-lab` is not a product surface.** It exists because
  two devices on one deployed URL is the only evidence that counts, and it
  should be deleted once the transport is carried by a real application.
- **Still unmeasured:** genuine hibernation eviction, authority heap under a
  large reassembly, and more than two replicas.
