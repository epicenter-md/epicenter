# 0213. Two replicas compare a multiset digest, because a cursor cannot say whether they agree

- **Status:** Proposed
- **Date:** 2026-08-06
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0212 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0212](0212-epicenter-replicates-cells-and-a-cells-version-carries-no-identity.md),
  which decides the cell store this verifies and owns the repair pass a mismatch
  schedules. That record converges without this one; this one detects that it
  failed to.
  [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md),
  which owns the authority lifetime. The lifetime and the digest answer different
  questions and neither substitutes for the other.

## Context

ADR-0212 replaces ordered patch intents with a store of cells, and gives the
authority a cursor: one counter, assigned when stored state changes, which a
replica pages on to receive deltas. A cursor is a fine courier. It was then asked
to be a detector as well, and it cannot be one.

**Three attempts, three failures, one cause.** A restore is the case that matters:
an authority rebuilt from an older snapshot holds less than its replicas do, and
nothing in the protocol notices.

1. There was no signal at all, so the authority gained a `lifetime` column and
   returned it on every response.
2. The lifetime lives *inside* the file being restored, so a restore carries the
   old lifetime back with it. Measured with the column in place: a replica still
   receives 0 cells over 50 rounds and disagrees on 100 of 350 addresses. A
   cursor regression was added as the signal instead.
3. The cursor an authority is shown is the replica's **read** cursor, and a
   restore destroys what a replica **wrote**. Clearing `dirty` by merging a push
   answer is a separate commit from advancing the read cursor, so a replica can
   push forty cells, have them accepted, and still present a cursor that predates
   them. Measured with no clock skew and no concurrency: the authority never
   re-mints, forty cells survive on exactly one device with nothing dirty, both
   sides report the same lifetime and a consistent cursor, and a new device
   bootstraps to a truncated store.

Each patch added a *proxy* for the missing information. None added the
information. Whether two stores hold the same thing is not derivable from a
counter that describes delivery, in any of its forms, and the third failure is
the proof: the counter is not even a complete record of what one side delivered.

## Decision

**Both sides maintain an incremental multiset digest over what they hold, and
comparing its root is how they learn they disagree.**

```sql
CREATE TABLE _replica_digest (
	bucket INTEGER PRIMARY KEY CHECK (bucket BETWEEN 0 AND 4095),
	sum BLOB NOT NULL CHECK (length(sum) = 8)
) STRICT;
```

The authority's is identical. Both metadata singletons carry a `digest_format`.

### A multiset sum, folded in the application

The sum is addition modulo 2^64 over per-entry hashes, not XOR: XOR cancels
identical pairs, so two genuinely different states can agree. Addition is exact,
order-independent, and inverted by subtraction, which is what makes it
incremental. Every write adds its new entry and subtracts the one it replaced.

**The fold happens in the application, never in SQL.** SQLite raises on 64-bit
integer overflow, and an earlier attempt to keep a running sum in a column
promoted it to REAL and silently destroyed the digest.

### The sum is stored as eight bytes, not as an integer

A bucket sum is uniform over 2^64, and every SQLite driver in this family returns
`INTEGER` as a double unless a per-connection flag is set. A sum read back is
therefore a different number from the one written, which makes the stored sum a
function of **write order** rather than of the multiset: two sides holding
identical cells then compare unequal. Measured, the digest degenerates into
"repair always", firing on 89% of rounds against 13% with exact arithmetic.

A per-connection flag is the weaker fix, because one connection opened without it
corrupts the file. Eight bytes read as bytes has no such door.

### An entry hashes the address, the version, and the value

Hashing only the version would make the verifier trust `version_hash`, which is
the pairing the merge already trusts. The one corruption ADR-0212's schema is
shaped to prevent, a value that no longer matches its own hash, would then be
invisible to the verifier *and* unrepairable by the merge: both sides read clean,
both refuse each other, forever.

### A body has an entry, keyed on its generation

A body carries no version, so without an entry a body divergence is undetectable:
the cell roots agree, the cursor sees nothing, and a device that bootstraps
afterwards gets an empty document while another holds the prose. Measured over
4000 randomized traces, three end at quiescence with divergent body text and
identical cell roots. The body entry takes that to zero, for 48 extra repair
passes out of 42,641.

### A bucket is not an address range

A cell's bucket is the first 12 bits of a hash of its address, so buckets are
stable across releases and evenly filled. That deliberately makes a bucket
useless as a repair unit: its members are scattered across the whole address
space, and enumerating one would cost a full scan plus a hash per cell, about 1.3
seconds at ADR-0212's own fixture.

So a mismatch is **not** localized into a resumable cursor. It schedules the
ordinary full-range repair pass, which already resumes by address, and the bucket
set only says that one is owed.

### A comparison has a precondition

A replica compares roots only when it owes nothing and has applied the page
through `next_cursor`, and only against a root the authority read in the same
transaction as that page. Without the precondition the comparison is not wrong so
much as useless: measured, a replica making one ordinary local write per round
schedules a full repair on **500 rounds out of 500**, with zero divergence.

### A drop subtracts, in the same transaction

ADR-0212's R2 deletes a row's older cells when a presence cell is written. That
delete returns what it removed and subtracts each entry in the same transaction,
or the first deletion in the store guarantees a permanent false mismatch.

The same rule generalizes: a digest bucket and the write it describes are one
transaction. Otherwise the digest becomes the thing ADR-0212 refuses elsewhere, a
durable marker that decides what to send and is wrong in a way that perpetuates
itself.

### The bucket count and the entry encoding are a cross-release contract

Both metadata singletons carry a `digest_format`, compared before the roots. A
peer on another format is **incomparable**, not divergent. Measured: a release
that changed only the bucket count would report 496 buckets differing on
identical state, while the root itself survives the change.

## Consequences

- **It costs 72 KB of disk per side, 144 KB for the pair**, and **+63% on a local
  write** that already pays ADR-0212's row-local floor (+77% at the minimum, on a
  run whose control arm is 2%). Hashing the value rather than the version alone
  accounts for 8 points of that. Against a store with neither the floor nor the
  digest, a local write costs **+112%**.
- **That is the price of knowing.** ADR-0212's repair pass is a correct repair
  that, without this, nothing can ever trigger: the record can say "full
  reconciliation always converges" and be unable to say when to run it.
- **It answers in 8 bytes.** A settled round compares two roots and stops.
- **It does not localize.** A mismatch costs the full-range pass, which at
  ADR-0212's fixture is 2.6M cells and roughly 315 MB. The precondition above is
  what keeps that rare; without it, it is every round.
- **It is a range reconciliation primitive, and both sides now have one.**
  ADR-0212 refuses peer-to-peer sync because a cursor is server-assigned and has
  no meaning between peers. That refusal now costs only the courier, not the
  verifier.
- **The authority lifetime is not redundant with it.** The lifetime answers "am I
  talking to the same authority", cheaply, on every round. The digest answers "do
  we hold the same thing". Neither substitutes for the other, and the three
  failures above are what happens when one is asked to do the other's job.
- **A modelled digest is not a tested one.** The `INTEGER` defect above survived a
  full adversarial round because the verification of the day modelled the digest
  in JavaScript maps and never wrote a sum to SQLite. Any check of this mechanism
  must round-trip through the database.

## Considered alternatives

- **Derive detection from the cursor.** Three attempts, in Context. The root cause
  is that a delivery counter does not contain the information.
- **XOR rather than modular addition.** Identical pairs cancel, so two different
  states agree. Free to compute and wrong.
- **Store the sum as `INTEGER`.** Measured to make the stored sum a function of
  write order, so identical stores compare unequal and repair fires on 89% of
  rounds.
- **Hash only the version into an entry.** Cheaper per write by 8 points, and it
  makes the verifier trust exactly what it exists to verify.
- **Descend into differing buckets to localize a repair.** About 1.3 seconds per
  bucket at ADR-0212's fixture, because a bucket is a hash class rather than a
  range, and it cannot resume from an address the way the existing pass does.
  Storing a `bucket` column on every cell would fix the scan and costs disk that
  ADR-0212 refuses for a cursor column on the same grounds.
- **Compare unconditionally.** 500 false full repairs out of 500 rounds.
