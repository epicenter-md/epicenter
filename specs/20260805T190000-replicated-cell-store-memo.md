# Architecture memo: a replicated cell store

- **Status:** In Progress
- **Date:** 2026-08-05
- **Settled as:** [ADR-0212](../docs/adr/0212-epicenter-replicates-cells-and-a-cells-version-carries-no-identity.md) and [ADR-0213](../docs/adr/0213-two-replicas-compare-a-multiset-digest-because-a-cursor-cannot-say-whether-they-agree.md).
  This memo is the exploration behind that record and keeps the reversals and the
  Rejected table; the ADR is the decision, and carries the measurements that
  were taken after this memo settled. Delete this file once both are
  Accepted and its schemas are built.

Evaluates replacing ordered-patch replication with a generic replicated cell
store. Verdict first: **take the radical model, with three amendments**, one of
which is a product win rather than a simplification. Details in section 10.

## Open right now

Rewritten each round. History is below; this is the working copy.

### The scope question, which round 18 answered by measuring the record

ADR-0212 is 1389 lines. By section: the refusal, clamp and re-stamp machinery is
**247 lines**, the DDL and its comments 245, Consequences 237. The design that
actually makes per-field merge work, the version, the local write rule, the
reusable address and the write surface, is **175 lines**.

The clamp machinery is larger than the core it protects, it is where rounds 8
through 14 spent almost every defect, and it still carries a measured 4.4% silent
loss of user field writes. It exists to make a bad clock **invisible**. That is the
wrong goal: refusing a write and returning the authority's time, so the client
corrects its offset and retries, is better behaviour and roughly a tenth the
surface. The five ideas below have not changed since round 2 and have survived
109,600 exhaustive orderings.

**The core, which is settled**

1. one cell per field, addressed `(namespace, table, row, column)`
2. a version of `(version_ms, version_seq, version_hash)`, carrying no actor
3. merge is `newer wins, or equal and byte-identical`
4. presence is an ordinary cell at `!presence`
5. a cursor for delivery, never for deciding

**Priced, and probably not worth building yet**

- The **clamp floor and re-stamp**: 247 lines, a 4.4% silent loss, five rounds of
  defects. Refuse-and-report replaces it.
- **Collaborative columns**: they collide with ADR-0130 (Accepted, one document per
  row, and it rejects declaring a document layout per table), ADR-0168 (tables
  declare no document capability) and ADR-0135's `open(row.id)` handle. Three
  amendments for a feature only Honeycrisp needs, and Honeycrisp does not exist.
- The **repair pass**, which depends on the digest and on the clamp's obligations.

**Worth keeping, because it is additive**

- The **digest**: one 8-byte column and one comparison, addable later with no
  migration, and it answers the one question a cursor structurally cannot.

**Open and unowned**

- The **write path for a collaborative column**. Rendering is one-way; turning an
  edited string back into operations needs a diff, and no Lens can supply one.
- A **cell and a document at one address**: the document wins by projection
  assignment order, the cell goes inert and keeps replicating, and ADR-0125's
  release-local Lenses reach the state without a bug.

### What the measurement apparatus cost, and what it is worth now

Round 18 found **52 probes dead and 62 saved outputs unreproducible** after one
table rename, and they source almost every headline figure: the floor table, the
re-stamp partition, the render and projection timings, the body plane on disk.

Repairing them is not obviously worth it. Most measure subsystems this section
proposes to delete, and the figures they produce have now been restated four
rounds running. Three further findings say the same thing about the apparatus
rather than the design: three of the ten runs behind the digest median carry an
impossible negative write floor and should never have been pooled; the provenance
table said "median" where the figure is a **median of per-run minima**, which is
biased upward and moves four of five figures when corrected; and `grep` silently
misses 32 probes because they contain literal NUL bytes for the address tests, so
every earlier staleness sweep was blind to them.

The pattern across eighteen rounds is that the defects were always in the newest
mechanism and never in the core. That is what building past what you know looks
like, and it is the reason to stop adding.

### Where each figure comes from

Round 16 proved a grep cannot establish provenance: a figure's producer is a
**probe, an arm and a configuration**, not a digit string. So the figures name
their own sources here. The figures below name their own source. The rest are attributed in **Provenance**
and **Harness** at the end of this memo, at file granularity rather than arm
granularity, and the next round extends this table rather than re-quoting them.
The rule is that a figure with no attribution at either granularity is withdrawn:
sixteen families is where this starts, not where it ends, and read as a closed set
it would withdraw eight of eight live figures sampled against it.

| Figure | Probe | Arm | Saved output |
| --- | --- | --- | --- |
| 184.7 / 348.8 MB replica, 289.1 / 503.2 MB authority on disk | `bench9.ts` | `replica` / `authority`, `on_disk_mb`, 200k x 12 and 1000k x 3 | `bench9-r15.log` |
| 121 B wire for a one-field change | `bench9.ts` | `wire`, `one_field_cell_bytes` | `bench9-r15.log` |
| 8.9x and 3.0x wire, like for like | `r2m-wire-and-intern.ts` | `structured` (NOT `as benched`, which is 9.36x / 3.18x on a mismatched title) | `r16m-wire-and-intern.out` |
| 1.76x / 1.31x whole rebuild, band 1.7x to 1.8x | `r11m-bodyplane-attribution.ts` | `PGBg / RJY`, body plane on BOTH sides | `R11-attr.log`, `rerun/RERUN-attr.log`, `r14m-attr.out` |
| layout term, **median 13.6x** over four runs (spread 13.1-13.7; the `PG / RJb` arm reaches 16.3x) | same | `PG / RJ`, **median**; `PG / RJb` is the other identical arm | same three, plus `r17m-*` |
| 2.0 s / 7.3 s projection rebuild, eight runs spanning 10% | `r10m-projection-fair.ts`, `r13m-render-cost.ts` | `PGBg` and `WITH` (byte-identical SQL) | `r10m-projection-fair.out`, `R11-proj-repro.log`, `R11-attr.log`, `rerun/RERUN-attr.log`, `r13m-render-cost.out`, `r13m-render-cost-2.out`, `r14m-attr.out`, `r14m-render-cost.out` |
| 954 to 976 ms and 4670 to 4755 ms render, 4.8 and 4.7 us per row | `r13m-render-cost.ts` | `RENDER ALONE` = `WITH` minus `WITHOUT`, control `WITHb` | `r13m-render-cost.out`, `-2.out`, `r14m-render-cost.out` |
| digest write premium, **median +62% @12 and +56% @3** over ten runs (spread 49-69 and 48-63) | `r7m-digest-onecolumn.ts` | `FD vs F`, the **median of the per-run minimum**, which is not the same as a median and is biased upward; the pooled median over every raw sample is +55.6% and +50.7% | `r7m-digest-onecolumn*.out`, `r13m-`, `r14b-`, `r16m-`, `r17m-` |
| folded, **median +37% @12 and +32% @3** over ten runs (spread 31-44 and 26-38) | same | `FDM vs F`, **median** per run | same |
| row delete, **median 8.3x @12** over five runs (spread 7.5-9.1) | `r7m-body-and-delete-onecolumn.ts` | `DD vs D`, the **median of the per-run minimum**; pooled median 7.81x and 5.45x, control pooled at 1.00x | `r7m-body-and-delete-onecolumn.out`, `r13m-body-and-delete-onecolumn.out`, `r14b-delete.out`, `r17m-*` |
| 2174 ms authority write lock, 0.84 us per cell | `r11-authority-lock.ts` | `scan + hash + commit`, `N=2600000` | `r13m-lock-2600k.out` |
| 4282 re-stamps, 5331 field cells, 223 / 190 / 34 | `r15-b-restamp-partition.ts` | `TRIALS=1200` (the default 300 gives different counts) | `r16m-restamp-partition-1200.out` |
| 81.3% against 0% digest storage type | `r11b-digest-io.ts` | `INTEGER` against `BLOB`, 400 rounds | `r11b-digest-io.out` |
| 199,990 ms monotonic-guard drift | `r16-monotonic-drift.ts` | the refused `max(now, prev+1)`; moves with machine speed | `r16-monotonic-drift.out` |
| 109,600 orderings over 255 subsets, zero divergent | `converge3.ts` | exhaustive, JavaScript model of the algebra, no database | `r15-g-converge3.out` (NOT `r15m-converge.out`, which is `converge.ts`'s) |
| 1280 collisions among 6720 tuples before the tag, 0 after | `r17m-presenttag.ts` | the encoding ADR-0213 decides, `0x00` cleared / `0x01` present | `r17m-presenttag.out` (`r16-nul.ts` measured a different tag shape) |

**Bands built from `min` drift as the sample grows, which is why they kept
breaking.** Four rounds running, a quoted band failed to bound a fresh run of its
own probe on its own arm, and each round widened it. The cause is the statistic:
almost every figure here was `min` over N runs, and the minimum of N samples falls
monotonically as N rises, so a band anchored on it is guaranteed to breach the next
time anyone runs the probe. Ten runs of the digest premium now span 49 to 69 where
six spanned 49 to 66; nothing changed but the count. The figures above are
restated as **medians with the spread beside them**, because a median is stable
under resampling and a minimum is not. The same defect explains the null control:
re-run today it passes **549 of 549 fabricated figures, 100%**, against 506 when it
was written, purely because the output corpus grew from 220 files to 257. A
statistic that moves when you add unrelated files was never measuring the records.

**Round 16 built a provenance checker, and round 16 proved it cannot work.** The
premise was that a figure is sourced when it appears in a saved output. It is not.
A null control settles it: of 549 figures nobody ever measured, **506 passed when it was written and 549, every one, passes today**, and
per unit that is **99 of 99 fabricated percentages, 90 of 90 ratios, 200 of 200
millisecond values and 100 of 100 byte counts**. Only four-significant-figure MB
values discriminate at all. Every count the tool has printed ABOUT THESE RECORDS' SOURCING is withdrawn (the null-control counts stand, being a measurement of the tool rather than of the records):
300/300/0 was wrong three ways (bare substrings, a per-file unit test vacuous for
`s`, `x` and `B`, and sourcing from provenance reports that merely quote a claim),
and the tightened 285/14/3 is an artifact of which audit files happened to be in
the directory when it ran, moving to **197/91/15** once that round's own audits are
excluded. The regex is no better: it captures 370 numeric tokens and misses 857,
including **both denominators of the sentence it was built to protect**, and its
withdrawal skip exempts 31 live claims, among them the whole wire table row.

The root cause is not tuning. **A figure's producer is a probe, an arm and a
configuration, not a digit string.** `1968.65` under arm `PGBg` and `1969.23` under
arm `PGBs` sit one keystroke apart in the corpus and mean opposite things, one
being the decided query and the other the arm that replaces the Yjs render with a
byte copy, which this record spends a paragraph forbidding. Nothing mechanical
separates them. The wire figure makes the same point from the other side: `121 B`
has exactly one producer, and it prints `"one_field_cell_bytes":121`, a JSON key
with no unit anywhere near it, so a stricter matcher calls the true figure
unsourced and a looser one accepts a hundred coincidences.

What would actually work is inline provenance: each figure in these records
carrying its producing file and arm beside it, so the claim names its source
instead of a grep guessing. That is a rewrite of how the records cite, not a
script, and it is the honest next step rather than a sixth tightening pass.
`check-claims.ts` stays in the harness as a **coverage smoke test only**, useful
for spotting a figure that appears nowhere at all, and its counts are not evidence.

**Round 15 repaired the harness instead of counting it again.** Thirteen probes are retired to `superseded/` with a README. Nine name
`_replica_digest` or `repair_epoch`, artifacts the design deleted, so they cannot
run and must not be repaired; the other four are covered elsewhere. None of the
four round-14 called "broken by drift" was in fact repaired: three were retired,
and the fourth was never broken at all. Round 14's count of fourteen dead was
thirteen, because its error extraction read a `SQLiteError` string that
`r12-e-restamp-crosses-body.ts` PRINTS as evidence inside a passing assertion. The
one whose premise the schema made impossible is replaced:
`value` is TEXT, so the non-UTF-8 wedge it tested cannot occur, and
`r15-check-symmetry.ts` asserts what the settled schema actually does. **No
current claim may be sourced from `superseded/`; a claim that needs one of those
numbers is withdrawn instead.**

That last repair changed a decision's justification. The authority-wedge passage
read as present-tense fact and is a counterfactual: because neither side
constrains `value` to `json_valid`, a poisoned value is stored by both and wedges
neither, and the cost lands at read time on an unguarded projection. Measured on
the settled schema, the whole page applies, the poisoned value round-trips byte
for byte, and only an unguarded `json()` raises. The symmetry is what buys the
wedge out; the record had been describing the disease rather than the cure.

**Provenance decayed once before, and this is the third round it has bitten.** Round 14 counted the harness scripts that no longer executed, because every schema
tightening breaks the positional inserts in probes nobody re-ran. Round 15 retired
thirteen and repaired none, because none of them needed repairing. Two claims in these records had a dead producer AND no saved output at the time round 13 checked:
the authority wedge, the epoch collapse (quoted as "0 of 200 either way" where the live probe reports
200 of 200 inline against 0 of 200 under the epoch, a tie reported where there was
a rout). A third claim, the 280-of-400 resumed-pass figure, was suspected and cleared: `r11b-repair-pair.ts` runs and its output is kept. A further 22 saved outputs are
older than the scripts named for them. The rule this round adds: a claim whose
producer does not run is withdrawn, not re-quoted, and the sweep that finds them
runs every round rather than when a reviewer thinks to look.

**The freeze was not held, and round 14 shows the cost.** Round 13 declared the
design frozen and then changed the repair guard anyway, replacing the
one-pass-at-a-time rule with a sentinel restart. Round 14 measured that
replacement livelocking at two replicas. The pattern from rounds 8 to 12 is
therefore not broken, only narrowed: the one place the design still moved is the
one place a new defect appeared, and everything genuinely held still verified
clean. A change to a frozen design needs the same three passes as any other, and
this one got a commit message instead.

**Why round 13 froze the design, and what the freeze bought.** Rounds 8 through 12
each found the PREVIOUS round's fix defective, in this one subsystem, because the
design kept changing between rounds instead of being held still and verified.
Round 13 held it: no new mechanisms, corrections to the written text only. All
five round-12 changes verified, including three branches of the floor clause that
had never been run, and the round found exactly one new mechanism defect, which had
survived twelve rounds because the loss it causes is AGREED. Nothing diverges,
nothing stays dirty, and the fuzz counted lost create and delete intents while
never counting a lost field value. That is the shape of what a freeze finds: not
the newest patch's bug, but the oldest unexamined assumption.

**A fix that created the defect it was fixing, once.** Round 11 gave the authority
`repair_sum` so its recompute could fold into the pages it serves rather than hold
its write lock for two seconds. That is right for the lock and wrong for ownership:
the column is one per store and the pass is one per replica, so round 12 measured
two interleaved passes committing exactly twice the truth. The lock finding stands;
the fix needed an ownership rule beside it, and now has one. Unlike rounds 10 and
11, this was a real fix with a real new problem rather than arithmetic that could
not change an outcome.

**A fix that failed four times, and the root cause that stops it.** The re-stamp
floor was patched in rounds 8, 9, 10 and 11, and each patch was reviewed, measured
and adopted before the next round showed it did nothing. Round 8 floored at the
replica's own presence, which loses the write when the authority holds one that is
newer. Round 9 added the authority's held presence, which fixed that and cost 18
more lost intents. Round 10 clamped the new term to the authority's time, which is
**inert by algebra**. Round 11 clamped it to the authority's time plus the clamp
width, which is **inert by the clamp's own invariant**. Two consecutive fixes were
arithmetic that could not change an outcome, and both were adopted with prose
claiming a measured improvement.

The root cause is not any of the four formulas. It is that the family
`max(A, f(held), local)` has exactly two behaviours, because the authority never holds a presence more than one clamp width ahead of
its clamp reference, so every `f`
that respects the clamp equals either `A` or `held`. There is no third formula,
so there was never a fix to find: rounds 10 and 11 were searching a space with two
points in it. Once that is stated, the remaining choice is a trade with measured
costs on both sides, recorded in the Rejected table above, and it has to be
decided rather than engineered away.

Two process failures made those rounds possible, and both are now closed. First,
three of the numbers the record quoted for this subsystem had **no producing
output**: the files named `r9-fuzz-*.out` print the round-8 header and the round-8
flags, so they were produced by `r8-fuzz.ts`, and `r10-restamp-branches.ts` saved
nothing at all. Every one of those numbers has been withdrawn and replaced with a
1200-trace run whose output is kept. Second, the record asserted a counter went to
zero **while its own saved evidence showed 445**; nothing checked a quoted figure
against the file it came from. That check is now part of a round.

**Provenance.** Figures in this table come from `bench9.ts` (the settled schema,
both planes, the whole required set), `bench8.ts` (per-row re-derivation),
`r2m-storage.ts` (the settled schema against the two-relation and 16-byte-hash
alternatives), `r2m-dirty-index*.ts`, `r2m-wire-and-intern.ts`,
`r3m-cursor-column.ts` (the per-cell cursor A/B), `results2.json` (the
row-plus-version-map opponent), the surviving `r3-*` probes (`r3-body-plane`, `r3-create-and-restore`,
`r3-restamp`, `r3-restore-race`), and `r15-check-symmetry.ts` for the CHECK
symmetry that replaces the withdrawn authority-wedge figure, the
`converge*.ts` proofs, `r4m5-body-plane-disk.ts` (the body plane on disk), `r11b-digest-io.ts` (the
digest's storage type, on the settled schema under a control arm), the surviving `r5-*` probes (`r5-body`, `r5-digest-semantics`, `r5-fuzz`,
`r5-repair`, `r5-trigger`), and `final-verify.ts`
through `final-verify5.ts`. Where a row is not on the settled schema, it
is because the comparison it makes needs an opponent only an earlier bench built;
`r4m-headline.ts` is the exception, and builds both shapes in one run.
bench9's own fixtures measure 184.7 MB at 200k x 12 and 348.8 MB at 1000k x 3.
The authority files at the same fixtures are 289.1 MB and 503.2 MB, 56% and 44%
larger than the replica's, and no record prices them: the cursor, the address
index and the absence of `WITHOUT ROWID` are all known terms, but the total has
never been argued for.

**Harness.** The authoritative run is `bench9.ts`, which executes
`final-schema.sql` as settled at the time of the run, on both planes and covers
insert, scattered row read, changed-since, one-field write,
row delete, on-disk after `wal_checkpoint(TRUNCATE)`, and wire bytes. **Projection
rebuild is NOT among them**: `bench9.ts` still times a query with no `json_valid`
guard, no `_replica_doc` join and no body render, which ADR-0212 does not decide.
That figure comes from `r10m-projection-fair.ts` and
`r11m-bodyplane-attribution.ts`. `bench.ts`
through `bench8.ts` measured shapes that have since been superseded and are kept
as history; where a figure above still comes from one of them, it is because the
comparison it makes is against a shape only that bench built. Convergence is
`converge.ts`, `converge2.ts`, and `converge3.ts`; the layout is verified by
`final-verify.ts` through `final-verify5.ts`, and the repair pair by
`r11b-repair-pair.ts`. The round-11 Rejected rows come from `r11b-fuzz.ts`
(the floor table), `r11-authority-lock.ts` (the lock window), `r9m-recompute.ts`
(the recompute cost), `r11-gapped-body.ts` (the gapped-body premise) and
`r11b-digest-io.ts` (the storage-type rates). An adversarial pass over the harness itself found and fixed four biases
worth recording, because they all ran in the same direction: the `dirty` index
was measured with `dirty` cleared on every cell (reporting 65 KB for something
that costs 75 MB), whole-row JSON carried an index no timed query used, the
authority comparison assigned cursors in address order rather than arrival order
(flattering the shape being rejected), and `insert_ms` was mostly JavaScript
hashing and CHECK constraints rather than storage shape.
