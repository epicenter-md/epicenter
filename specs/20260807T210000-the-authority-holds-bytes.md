# The authority holds bytes, and the merge moves to the client

- **Status:** Draft
- **Date:** 2026-08-07
- **Settles nothing yet.** This is the working record for the sync authority,
  which [ADR-0215](../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  deliberately leaves open after an earlier version of it asserted a design that
  adversarial review broke. Promote to an ADR only after the two unproven pieces
  below are proven in `workerd`.
- **Relates:** [ADR-0215](../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (an application is one document),
  [ADR-0216](../docs/adr/0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md)
  (which addresses are safe to create at),
  [ADR-0214](../docs/adr/0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (local persistence).

## Why four designs failed before this one

Every rejected authority design failed at the same joint, and it is worth
stating once so the fifth is not the same shape in new clothes:

```txt
A log must be compacted.
  Compaction must prove the replacement covers what it replaces.
    Proof requires semantics the authority was defined not to have.
```

The four attempts, and how each died:

| attempt | how it died |
| --- | --- |
| delete the bound, validation and compaction | oversized updates vanish silently; one poison message bricks the partition |
| client posts a baseline, DO checks a seq | 13 bytes of an empty document passes and destroys the partition |
| verify the baseline by state-vector domination | **a state vector cannot express deletion**, so a lagging device's baseline resurrects every delete |
| accept a baseline only from a client at the log head | untested, and it was patch number four on the same wound |

The fourth entry is the tell. When each fix addresses a different symptom and
fails for a different reason, the shape is wrong rather than the details.

## The refusal

```txt
Product sentence:
  A recording made offline on one device shows up on the other with no ceremony,
  and nothing a person wrote is ever silently lost.

Candidate refusal:
  The authority's log is bounded. It is never compacted, and grows for the life
  of the application.

Deletion prize:
  compaction; baselines; coverage proofs; state-vector domination; cursor-at-head
  rules; delete-set accumulation and comparison; the question of which party may
  replace another party's history; and the authority's need to understand Yjs.

User loss:
  About 4 MB of server storage per year, and a new device replays the log rather
  than a snapshot.

Decision:
  Refuse it. The measured cost is 41 MB over a decade against 10 GB of Durable
  Object SQLite, and the deletion removes the one requirement that broke four
  designs. No party ever has to verify another party's claim about history.
```

## The finding that makes it affordable

Refusing compaction is only affordable because of a variable that is not on the
authority at all. Measured over the real vault's shape, 986 notes with 2.8 KB
bodies, seven simulated days of 20 field edits and 2,000 characters typed:

| send policy | entries | per day | per year | 10 years |
| --- | --- | --- | --- | --- |
| per transaction | 14,141 | 354 KB | 126.2 MB | **1,261.7 MB** |
| coalesce 10 | 1,415 | 39 KB | 13.8 MB | 137.9 MB |
| per second (~40) | 355 | 11 KB | 4.1 MB | **40.8 MB** |
| coalesce 100 | 143 | 6 KB | 2.1 MB | 21.4 MB |

`evidence/bench/never-compact.ts`. The seed, the vault itself, is 2.8 MB paid
once.

**The 30x is the whole answer, and it is a client-side choice.** Sending one
update per transaction is what made compaction feel mandatory. Coalescing on the
idle timer an editor debounces on anyway makes the log a rounding error.

And the merge that was impossible to verify becomes trivially correct once it
moves: **a client may merge its own unsent updates, and needs no proof from
anybody, because it indisputably owns them.** Every failed design was trying to
let one party rewrite another party's history. Ownership makes verification
unnecessary rather than cheap.

## Four mechanisms, four distinct jobs

None of these patches another. That is the test they had to pass.

| mechanism | job | why it is sound |
| --- | --- | --- |
| **coalesce** on an idle timer | cut log growth 30x | the client merges only its own unsent bytes |
| **chunk** to the storage cap | fit records into DO SQLite | pure framing, opaque, no semantics |
| **ack** carrying the assigned seq | make failure visible | the client holds an update as unsent until confirmed |
| **validate and discard** | reject a poison message | one Yjs call, result thrown away, 0 heap |

### Chunking, not bounding

An earlier version of this memo bounded the coalesce buffer by size. That was a
band-aid twice over, and the measurements say so:

- **It does not fix the real failure.** A single paste is 4.77 MB in **one
  transaction**. There is nothing for a coalescing bound to split.
- **It guards a case that does not occur.** 14,000 coalesced field edits, a week
  fully offline, come to 99 KB. That is 20,000x under the 2,097,152-byte cap.

The fix is framing at the storage boundary: store `(seq, chunk, bytes)` and
concatenate on read. Verified, with the control that matters, that a lone chunk
is **not** independently valid, so reassembly is doing real work: 4.77 MB splits
into 3 chunks each within the cap and rebuilds to 5,000,000 characters with an
unrelated marker attribute intact.

### The one Yjs call the authority makes

The honest claim is not "the authority never decodes". It is:

> The authority makes exactly one Yjs call, as a validity check, and throws the
> answer away.

On the final chunk it reassembles and calls `encodeStateVectorFromUpdateV2`,
keeping only whether it threw. Measured: rejects garbage and truncated updates,
**0 MB heap**, 19 ms on a 28 MB input. That is what closes the poison pill, and
it is a small enough amount of knowledge to defend.

## Facts worth keeping whatever design wins

These cost real time to find and will be re-derived wrongly if they live only in
a commit message. The first two are pinned in `evidence/invariants.test.ts`.

- **A state vector cannot express deletion.** A delete does not advance the
  clock: two documents, one of which has deleted a row, can have byte-identical
  state vectors. Any protocol reasoning about "has this peer caught up" from
  state vectors alone is wrong about deletes.
- **An update whose dependencies are missing is buffered silently**, with no
  error, no event, and no public API to detect it, and the document emits no
  `updateV2`. This is why the local log persists received bytes rather than
  emitted ones.
- **A clientID is minted per `Y.Doc` instance**, so it accumulates per app
  launch: 500 sessions is 500 clients and a 4,472-byte state vector. Bounded and
  worth knowing; a stable per-device clientID would remove it.
- **A DO's often-quoted 128 MB is the ActorCache limit**, the storage cache, not
  a ceiling on allocation. Do not cite it for memory arguments.
- **Hydrating a `Y.Doc` costs ~90 MB of heap for a 10,000-note application**, and
  is re-paid on every hibernation wake. That is the cost of the alternative
  design where the authority holds the document, which is what y-sweet and
  PartyKit both do.

## Unproven, and the order to prove it

Nothing below has run in `workerd`. The adversarial pass proved the *failures*
there; only the *fixes* have been measured, and only in Bun.

1. **The ack**, which is mechanical but unwritten. It is what makes a refused
   update visible instead of vanishing.
2. **The exact 2,097,152 boundary**, tested at the boundary rather than at a
   comfortable 3 MB.
3. **Sustained operation through one DO instance**, thousands of messages, not
   one message through a fresh isolate. A single-shot measurement in a fresh
   isolate is the flattering case and is exactly the error that produced this
   branch's wrong memory numbers.

Real Cloudflare deployment is needed only for genuine hibernation eviction,
which local `wrangler dev` cannot trigger honestly.

## A note on method

Three experiments on this branch passed for hollow reasons before being caught:
a forged baseline rejected because the harness gave it a different clientID, a
cursor rule that "worked" in a simulation where nothing was ever delivered, and
a memory table that measured several shapes in one process so the allocator's
high-water mark landed on the first case.

Each was noticed only because a number looked odd, not because the assertion
failed. So every experiment here now carries **a control that must fail** if the
test is not live, and the controls are reported alongside the results.
