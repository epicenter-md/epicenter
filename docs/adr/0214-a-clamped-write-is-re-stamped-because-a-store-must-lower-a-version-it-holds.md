# 0214. A clamped write is re-stamped, because a local-first store must be able to lower a version it holds

- **Status:** Proposed
- **Date:** 2026-08-06
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0213 land with this
  branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0212](0212-epicenter-replicates-cells-and-a-cells-version-carries-no-identity.md),
  which decides the cell store, the version scheme, the merge rules R1 and R2 this
  record's refusals arise from, and the local write rule this record is the
  exception to. That record owns the cells; this one owns what
  happens when the authority refuses one.
  [ADR-0213](0213-two-replicas-compare-a-multiset-digest-because-a-cursor-cannot-say-whether-they-agree.md),
  which owns detection. A clamp refusal on a presence cell no longer schedules the
  whole-store pass, because the digest schedules the identical pass one round later
  and only when something is actually wrong.

## Context

ADR-0212's local write rule stamps a write at
`max(now, the cell's own version, the row's presence version)`, so a device never
lowers a version it already holds. That is what makes a local edit land offline
and win against a stale remote one.

It is also what makes a badly-set clock unrecoverable without this record. The
authority refuses a write more than five minutes ahead of its clamp reference. A
device a day fast is refused, corrects its offset, and its next write is floored
**back up to `T+24h` by its own earlier local write**: measured, four attempts,
four refusals, no progress. The two ways out are to lower what the device holds
locally, which is what this record decides, or to not keep a local write until the
authority accepts it, which is write-through and costs the offline edit the whole
design exists for.

So a local-first store that stamps versions from a wall clock **must be able to
lower a version it already holds**, and every rule below follows from that: lowering
is the one operation exempt from the local write rule, the lowered cell must not
land under its own row's presence, and presence is a cell so R2 reaches it.

This record is about 195 lines of decision, and it is load-bearing rule by rule,
measured by removing each and watching what breaks across 20 independent
1200-trace seed blocks. Two came out clean: the coupling to the whole-store repair
pass, which is removed, and the floor's `local` term, which is inert on every
counter in 20 of 20 blocks and survives on a hand-built case instead. The full knob
table and the six priced refusals are in
[the memo](../../specs/20260805T190000-replicated-cell-store-memo.md).

## Decision

The authority answers with the winning version of everything it processed, and
the replica merges that answer exactly as it merges a pull. Clearing `dirty`
becomes a consequence of merging rather than a bookkeeping step, which is what
covers the case a conditional confirm misses: a push that *loses* the authority's
comparison would otherwise clear its flag while the authority holds a different
value, and a losing write takes no cursor, so the winner might never be
redelivered.

**A refusal is a merge input too, and there are two kinds.** A refused write
stores nothing,
takes no cursor, and therefore appears nowhere in a response that only reports
what was stored. Its `dirty` flag is never cleared and the round repeats forever
with no bound: a laptop resuming with its clock a day fast strands the cell for
about 24 hours, and one resuming with an RTC reading 2031 strands it for years.
Rewriting cannot repair it, because the local write rule never lowers
`version_ms`. So a **clamp** refusal names the address and the authority's own time, and the
replica re-stamps the refused cells of that row, and the row's body generation
with them, **in one transaction, at `(floor, rank)`**, where rank is each cell's
position in the row's own `(version_ms, version_seq)` ascending order, and which is the one
operation exempt from the local write rule above because it deliberately lowers
a version. The floor is

```txt
held  = the presence version the AUTHORITY holds for this row, returned with the
        refusal, or zero when it holds none
local = the presence version this replica holds for the row, or zero when it holds
        none OR when the row's presence cell is DIRTY, whether or not it is in
        this refusal. Zeroing only on the refused set assumes a row's dirty cells
        push together, which nothing decides: measured, a field refused in a round
        its own dirty presence was not sent in floors at the skewed version and
        the re-stamp lowers nothing, four rounds with no progress, which is the
        livelock this record exists to break
floor = (max(the authority's time,
             held.version_ms,
             local.version_ms),
         the millisecond came from a presence version
           ? that version's seq + 1 + rank
           : rank,
         and when the maximum TIES across terms the presence branch is taken,
         SEEDED FROM THE HIGHEST TIED PRESENCE VERSION'S SEQ, because `held` and
         `local` can tie on the millisecond and differ on the counter, and seeding
         from the lower one, like taking the non-presence branch, lands the
         re-stamp under a presence already above it where R1 discards it with
         nothing dirty)
```

**All three terms are load-bearing, and every clamped variant of `held` is
provably inert.** One asymmetry has to be said out loud: `local` binds on 0 of 4361
re-stamps, which is the same measured-inert standard that kills the two clamped
variants below. It survives anyway, on a hand-built case rather than on the fuzz,
so the fuzz is not what establishes it. Taking the floor from the authority alone loses the write
outright when the authority holds no presence for the row, because `held` is then
undefined and the re-stamped cell lands under the replica's own presence. Taking
it from the replica alone is the round-8 defect. Two rounds then tried to clamp
the forward reach of `held`, and both clamps are dead arithmetic:

- `min(held, A)` is inert by algebra. It is never greater than `A`, and `A` is
  already a term of the same maximum, so the expression collapses to
  `max(A, local)` and the refusal's held version can never raise anything. That
  collapse is round-8's replica-only floor with a flat authority time beside it,
  which is the pair of defects the formula exists to avoid.
- `min(held, A + the clamp width)` is inert by the clamp's own invariant, **while
  the authority's clock is monotonic**. The authority refuses any write above
  `A + the clamp width`, so a presence version it *holds* is at or below that bound
  and the `min` never binds. Measured, it is byte-identical to the unclamped floor on every counter of a
  1200-trace fuzz. Re-verified against the settled column-keyed schema: 40 of 41 counters identical
  and the `min` binds 0 times in 4361 re-stamps, so the claim is no longer inherited
  from an earlier key.

  The premise is load-bearing and is not free. Step the authority's clock back an
  hour (an NTP correction, a VM migration, a restore onto a host whose clock is
  behind, all reachable on the self-hosted deployable) and a presence it already
  holds sits permanently above `A + the clamp width`. Measured there, **every**
  member of the family livelocks: `local` is never clamped, R1 forces a field cell
  above its row's presence, and nothing the replica can write inside the clamp
  beats a held version the merge is monotone against. The 1200-trace fuzz cannot
  reach this state, because its authority clock only ever advances. The backward step is not a price of clamping: measured, the **decided** unclamped
floor is the worst-affected arm by 5.5x, 897,660 re-stamps
against 164,528 for either clamped variant. So **ADR-0212's** clamp reference ratchets on the highest `version_ms` the
authority holds, which cannot move past what the clamp already permitted and
restores the premise by construction. It restores the premise and **not convergence**: measured at 300
traces with a one-hour backward step, 14 traces still diverge and 4 replicas remain
dirty at quiescence, against 0 and 0 with a monotonic clock.

So the family has exactly two members, not three, and choosing between them is a
trade rather than a defect to fix. Measured over 1200 traces of 70 steps, four
replicas skewed -3 to +12 minutes, 4361 clamp re-stamps (`r20-e-fuzz.ts`):

| floor | presence re-stamped below the authority's own | then refused stale | destroyed by R2 | lost create/delete intents |
| --- | --- | --- | --- | --- |
| `max(A, local)`, and `min(held, A)` | 488 | 506 | 153 | 518 |
| `max(A, held, local)` (**decided**) | 0 | 18 | 5 | 518 |

Neither dominates. The decided floor removes 488 below-authority re-stamps and 488
of the 506 stale refusals that follow from them, and pays nothing measurable in
lost intents at 1200 traces, where both arms lose 518. The 4800-trace paired figure
below is the only evidence the cost exists at all, at about **3%**, for importing
another device's skew into a re-stamp applied to a device already known to have a
bad clock. That is the honest shape
of the choice. Only the first column is unambiguous: 0 against 418 to 524, disjoint in 20 of 20 seed blocks.
The other three are small counters that move by half their value between blocks,
so 1200 traces separates 488 from 0 and does not resolve 5 from 1. Across four disjoint
1200-trace blocks the intent difference runs +18, -7, +33, +22, one block with the
sign reversed and a block standard deviation near 17, so the +18 above is one
standard deviation of block noise. At 4800 traces the totals are **1994 against
2060, +66 or 3.3%**, paired z = 2.67 with a bootstrap 95% CI of 0.88% to 5.74%: the direction is probably real and
the magnitude at 1200 traces is not. No third formula recovers both: the clamp that would buy them
back is the one the invariant above makes inert.

**The floor is spent in the round that reads it.** The refusal carries the
authority's held presence at refusal time, and pushing the re-stamped cells on the
*next* round lets another replica move it in between, after which the re-stamped
presence is refused as stale and the user's create or delete is gone with nothing
dirty. Measured over the 4361 re-stamps of the decided run above: the re-push settles at an inner depth of 1,
the 32-round cap is never reached, and a device three days fast settles in one
inner round.

**The refusal names the authority's held presence, and the floor clears it.** A presence write
overwrites the row's presence cell in place, so when the presence cell is itself
refused the replica no longer holds the version it must clear, and an earlier
draft floored that branch at the authority's time flat. Measured: a clamped
`delete` lands below the authority's own `present`, the answer restores it, the
delete is gone from both sides with nothing dirty; a clamped `create` is worse,
because the stale answer fires R2 and drops the fields with it. So the refusal
names the authority's held presence version, and the floor clears it. It stays
inside the clamp because the authority accepted that version itself.

**The authority clamps a body's generation exactly as it clamps a cell's
version, and a clamp-refused body is re-stamped with its row.** A body carries the
generation copied from the presence cell that created it, so a clamped `create`
produces an equally skewed generation. Left unstated, the other branch chains into
permanent loss through this record's own rules: the authority refuses the skewed
generation and answers with a newer one, a newer returned generation resets the
body and both slots, and opening a body whose generation is not the row's current
presence version replaces it with an empty document. Measured, the prose is gone
from the device that typed it, the authority holds it under a generation no row
has, and the digest mismatches every round while the repair pass re-sends bytes
the authority refuses. A re-stamp that moves a row's presence also moves its body
generation, and it leaves `send_token` and both delivery slots alone, because the
row is the same incarnation rewritten rather than a new one.

**The counter is part of the floor, not decoration.** R1 compares
`(version_ms, version_seq)`, so flooring the millisecond alone still lands a
re-stamped cell under a presence cell whose own counter is above zero, which a
delete-then-create inside one millisecond produces by the local write rule and
which a previous re-stamp of presence produces by rank. Measured with the
millisecond floored and the counter not: the re-creation is gone from both sides,
nothing is dirty, the roots agree, and the call returned success.

**The floor is the fix, and a flat authority time is the defect it repairs.**
Re-stamping to authority time alone lands the cell *below* its own row's presence
cell, and the failure above follows: measured, the user's write vanishes from the device that typed it
and from the authority, with nothing dirty and the digest roots agreeing.  Dragging a clean presence cell into the
re-stamp set instead is worse: the authority refuses it as stale and R2 kills the
cell anyway. Rank rather than the
original counter: the re-stamp collapses a *range* of `version_ms` onto one time,
and a `version_seq` was only ever meaningful inside its own millisecond, so
preserving it lets a cell written at a later millisecond land below one written
earlier and be eaten by R2. Rank rather than address order too, which is what puts
a `create`'s presence cell first. The body's generation is the presence cell's
version, so a re-stamp that lowers presence and leaves the body behind makes a row
stale against itself: the projection blanks it, losing the prose the user typed seconds earlier from
every read of the live row. The open door does not fire there: it predicates on
older, and a body left behind by a lowered presence is newer than its row. Re-stamping a
field cell alone would land it below its own row's presence cell, which is exactly
what R1 refuses, so the debt would never clear.

**A clamp refusal on a presence cell does not schedule the whole-store pass.** An
earlier draft coupled the two, because a whole-store pass is the only repair the
schema can represent. ADR-0213's digest schedules the identical pass one round
later and only when something is actually wrong, where the coupling fired
unconditionally: measured, 3051 raises across 1200 traces landing as 1683
additional passes, 6839 to 8522, up 24.6%, each pass at 2.6M cells and roughly
336 MB at an 80-character body or 8.2 GB at 40 KB. With the coupling off and the
digest on, the same hazard converges.

Lowering a presence cell is still the one operation in the design that moves a
version down, and it retroactively un-refuses every pull R1 rejected while the cell
was high. Those pulls stored nothing and consumed their cursors, and a cell the
authority already holds at that exact version takes no new cursor, so nothing
redelivers them. That is the hazard the digest closes one round later, and it is
why the re-stamp needs no obligation of its own: a clamp re-stamp is an **event**
naming one row, discharged inline in the transaction that creates it.
An **R1** refusal must not be answered that way. R1 fires at the authority as well
as the replica, and re-stamping there would promote a previous incarnation's value
over the re-creation's own snapshot, which is exactly what R2 exists to prevent.
Measured: an offline edit at version 1500, a delete at 2000, a re-creation at
2100, and a re-stamp at the authority's clock leaves the row holding the offline
edit. So an R1 refusal is answered with **the presence cell**. The replica merges
it like any other cell, R2 then drops the refused write, and the debt clears
because the obligation was discharged rather than deferred.

## Consequences

- **A re-stamp can lose a user's field write, silently.** The floor's terms are the
  clamp reference and presence versions, and the refusal does not carry the version
  the authority holds for the refused cell itself. Re-taken on the settled column-keyed schema, **224 of 5422** re-stamped field cells
  land on or below a held version, 79 exactly on it and 145 below, and **193 are
  discarded as stale** with both sides agreeing and nothing dirty. A further 35 of
  the 79 win the hash instead of losing it, silently displacing the value the
  authority held. The rates did not move: 4.43% of clamp re-stamps against 4.44%
  before the rekey, and 3.56% of field cells against 3.56%. The counts did: an
  earlier draft carried 223 / 5331 / 66 / 157 / 190 / 34 from the pre-rekey harness
  and called them settled. A
  fourth floor term of the same shape as the second would close it. It is priced in
  the memo and not taken.
- **The floor's three terms are each load-bearing**, and one of them is not
  exercised by any fuzz. `local` binds once in 86,913 re-stamps, close enough to the
  measured-inert standard that kills the two clamped variants to invite the same
  verdict, and it survives on a hand-built case instead.
- **A backward step of the authority's own clock is this record's worst case**, and the Decision above prices it.
  The ratchet restores the clamp's invariant and not convergence.
