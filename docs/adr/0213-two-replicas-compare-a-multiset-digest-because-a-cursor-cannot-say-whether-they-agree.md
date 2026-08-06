# 0213. Two replicas compare a multiset digest, because a cursor cannot say whether they agree

- **Status:** Proposed
- **Date:** 2026-08-06
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0212 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0212](0212-epicenter-replicates-cells-and-a-cells-version-carries-no-identity.md),
  which decides the cell store this verifies and owns the repair pass a mismatch
  schedules. That record converges without this one; this one detects that it
  failed to.
  [ADR-0135](0135-row-documents-have-application-owned-roots.md) (`Accepted`),
  which decides that Epicenter never interprets a document's roots and that the
  authority neither inspects nor validates its root layout. That is the constraint
  the body entry is shaped by, and this record stays inside it rather than
  amending it.
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
-- in each metadata singleton, replica and authority alike
digest_format INTEGER NOT NULL,
digest_sum    BLOB NOT NULL CHECK (length(digest_sum) = 8)
```

**One column, not a table.** An earlier draft kept 4096 buckets a side so a
mismatch could be localized. Nothing reads a bucket: the descent was refused (below), so only the root is ever compared, and the root is a sum over every
entry regardless of how they are grouped. A sum over every entry does not depend on how the
entries were grouped, which is associativity rather than a measurement; the
bucket table was 4096 rows per side that answered nothing.

### A multiset sum, folded in the application

The sum is addition modulo 2^64 over per-entry hashes, not XOR: XOR cancels
identical pairs, so two genuinely different states can agree. Addition is exact,
order-independent, and inverted by subtraction, which is what makes it
incremental. Every write adds its new entry and subtracts the one it replaced.

**The fold happens in the application, never in SQL.** SQLite raises on 64-bit
integer overflow, and an earlier attempt to keep a running sum in a column
promoted it to REAL and silently destroyed the digest.

### The sum is stored as eight bytes, not as an integer

A sum is uniform over 2^64, and every SQLite driver in this family returns
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

### A body has an entry, and it hashes the operation set, canonically

A body carries no version, so without an entry a body divergence is undetectable:
the cell roots agree, the cursor sees nothing, and a device that bootstraps
afterwards gets an empty document while another holds the prose.

**The entry is a canonical re-encoding of the merged operation set**:
`encodeStateAsUpdateV2` of a document loaded from `doc_state` **into a fresh
`Y.Doc` with default options**, never into the application's own. The loader is
part of the contract: an editor holding its document with `gc:false` writes a
different `doc_state` for the same operation set, and computing the entry from
that live document instead of a fresh load, which is the obvious optimisation,
makes the two sides disagree. Four constraints
decide it, and each of the three attempts before it violated one that had not been
written down.

```txt
1  a function of what the two sides actually hold
2  sensitive to content, or it cannot detect the thing it exists for
3  root-agnostic, because ADR-0135 says Epicenter "does not declare, validate,
   version, reserve, enumerate, or interpret roots" and the authority "neither
   inspects nor validates its root layout"
4  canonical across two encodings of one operation set
```

`doc_state` itself fails 4. A replica that applies a delete locally holds structs
split at the deletion point; an authority that merges the same delete as an opaque
update does not, and both render the same prose in different bytes: 199 false
alarms in 200 rounds.

`encodeSnapshotV2(snapshot(doc))` fails 2, and fails it completely. A Yjs snapshot
is a delete set and a state vector, so two documents holding entirely different
text of the same length at the same clock produce **byte-identical** entries. It is
the version-only entry this record refuses for cells, adopted on the plane with no
version at all.

The prose the projection renders fails 3. Both sides fold the same entry, so the
authority would have to render, which means naming a root; ADR-0135 forbids that,
one document may hold any number of independently interpreted roots, and "the
prose" is not well defined across them.

A canonical re-encode satisfies all four. It never names a root, it contains every
operation, and Yjs re-encodes deterministically, so two sides that merged the same
updates agree byte for byte however they got there. Verified across two encodings
of one edit, a same-clock content change, a three-root document, concurrent edits
merged in both orders, and the empty document.

### A mismatch does not localize

Grouping entries into buckets so a mismatch could name a region was tried and
refused, and refusing it is what leaves one sum. A bucket keyed on a hash of the
address is a hash class rather than a range: its members are scattered across the
whole address space, enumerating one costs a full scan plus a hash per cell (116 milliseconds
over 240,000 cells, so of the order of a second at ADR-0212's fixture), and it cannot resume from an address the way
the existing repair pass does. Storing a `bucket` column on every cell would fix
the scan, and costs disk ADR-0212 refuses for a cursor column on the same grounds.

So a mismatch says only that a repair is owed. It schedules ADR-0212's ordinary
full-range pass, which already resumes by address.

### A comparison has a precondition

A replica compares sums only when it **owes nothing**, which means no cell is
`dirty` **and** no body holds a `pending_update` or an `inflight_update`, and when
it has applied the page through `next_cursor - 1`, and only against a sum the
authority read in the same transaction as that page. Defining "owes nothing" on
cells alone would fire a full repair every round a user is typing into a body,
because unsent body bytes set no cell `dirty`. Without the precondition the comparison is not wrong so
much as useless: measured, a replica making one ordinary local write per round
schedules a full repair on **500 rounds out of 500**, with zero divergence.

### A completed pass recomputes the sum

The sum would be incremental only, with nothing deriving it from the store, and a sum that
has drifted from its own content is a mismatch no amount of repair can close: the
pass converges the content, the comparison reads the sum, and the two never meet.
Measured with one fold omitted at one of the roughly ten sites that fold: two
stores holding **41 identical cells**, sums unequal, **50 full-range passes over 50
rounds**, still unequal. At this record's fixture that is 2.6 M cells and about
315 MB every round, forever, with nothing user-visible wrong.

So a repair pass that completes **recomputes `digest_sum` on both sides**: the
replica from `_replica_cell` and `_replica_body`, scoped by `repair_from`, and the
authority from `_authority_cell` and `_authority_body`.

**The authority's half cannot be a running total, because the schema holds no
state for one.** `_authority_metadata` has one 8-byte slot and it is `digest_sum`
itself: accumulating a partial sum there leaves garbage rather than drift the
moment a replica goes offline mid-pass, and two interleaved passes leave the
loser's partial as the durable value. Measured: a pass abandoned after six of ten
pages leaves the authority summing 60% of its own store, which every replica then
mismatches every round. So the authority recomputes **terminally, under its own
write lock**, which it can do and a replica cannot because it is not the side a
user is typing into.
Recomputing one side only leaves the other's drift permanent, and an authority
whose sum has drifted is a mismatch every replica repairs every round forever,
which is the failure this section exists to remove. **The recompute derives from content, and the arithmetic has to say so.** A pass
that scans the store and then assigns what it found has no isolation story, and
both readings fail: inside a transaction the terminal write raises `database is
locked` while a user is typing, so the pass never completes; outside one it writes
back a sum for a snapshot the store has already left, which is the drift it was
added to remove.

An earlier draft answered that with `sum_at_scan_start + every delta folded
since`, which is a **self-assignment**: `digest_sum` is defined as exactly that
running total, so committing it changes nothing and the omitted fold it exists to
correct survives inside `sum_at_scan_start` untouched. What the commit has to be is **the sum of the entries the
scan actually derived from content, plus only those deltas whose address the scan
has already passed**. The first term is what makes it a recompute; the second must
be scoped by the pass's own watermark, which `repair_from` already is, or every
write landing ahead of the scan is counted twice and 40 of 40 completed passes
leave the sum wrong in the other direction.

The cost is not free and an earlier draft said it was: hashing every cell is
**+295% on top of the scan** the pass already pays, about 1.9 seconds of added hashing on a
2.5 second scan-plus-hash at 2.6M cells, and the body half is a document load and
re-encode at 8.9 microseconds per small body and 38.6 at 40 KB, so 196k bodies is
another 1.8 to 7.6 seconds. A
completed pass therefore owes **about +3.6 seconds at an 80-character body and +9.4 at
40 KB**, roughly 1.8 times the projection rebuild, now that the rebuild is priced on the query the
record decides.

**That number also retires the bucket refusal below.** Enumerating a bucket was
refused as a full scan plus a hash per cell, quoted at "of the order of a second";
measured on the settled schema at the settled fixture the recompute is **2.5
seconds**, against about 1.3 for the bucket enumeration, which hashes an address
where this hashes an address, a version and a value, and this section now mandates it on every completed pass. The
refusal stands on the resumability argument alone. A terminal scan on the replica would hold that as
one window; folded into the pass's own transactions it is spread across them, and it is what makes a sum a check on state
rather than a durable local claim that decides what to send and perpetuates its
own error. Without it, ADR-0212's claim that a digest mismatch is a state check would be
false, because nothing would ever recompute anything.

### A drop subtracts, in the same transaction

Every removal subtracts, not only the obvious one. ADR-0212's R2 deletes a row's
older cells when a presence cell is written, **and its body row with them**, and
the open door **replaces** a stale-generation body with an empty document. The
cell delete returns what it removed and subtracts each entry in the same
transaction; the two body mutations have no write of their own to hang a fold on,
so each must subtract the entry it removes explicitly. Miss any of the three and
the first deletion in the store guarantees a permanent false mismatch.

The same rule generalizes: the digest sum and the write it describes are one
transaction. Otherwise the digest becomes the thing ADR-0212 refuses elsewhere, a
durable marker that decides what to send and is wrong in a way that perpetuates
itself.

### The entry encoding is a cross-release contract

An entry is the low 8 bytes, big-endian, of

```txt
cell:  sha256(ns \0 table \0 row \0 column \0 version_ms \0 version_seq \0 || version_hash || value_utf8)
body:  sha256(ns \0 table \0 row \0 "!body" \0 generation_ms \0 generation_seq \0 || encodeStateAsUpdateV2(load(doc_state)))
```

where a cleared cell contributes no value bytes. Both metadata singletons carry a
`digest_format`, compared before the sums, and a peer on another format is
**incomparable** rather than divergent. It is separate from `format_version`
because a release can change what it folds without changing the wire protocol,
and `format_version` is a hard refusal that would stop the exchange entirely.

## Consequences

- **It costs one 8-byte column per side and about half a local write again.**
  Measured on the settled one-column schema across four runs: **+49% to +72% at 12
  columns and +41% to +59% at 3**, on a write that already pays ADR-0212's
  row-local floor. Against a store with neither, a local write costs **+82% to
  +117%**. The control arm sits within 5% and does not bound this: the ratio moves
  20 points between process invocations, so the envelope is the number and a
  tighter one would be invented. An earlier draft said +75% and +65%; that
  was measured against the 4096-row bucket table this record then deleted, which
  is the third consecutive round in which the priced artifact was removed after
  pricing. Hashing the value rather than the version alone is 2 to 15 points across four
  runs. **Folding the sum in memory and writing it once per transaction
  cuts the premium by about a third**, to **+31% to +48%** and **+22% to +37%**,
  and still satisfies the same-transaction rule; the higher figures assume one
  write per transaction.
- **A row delete costs far more than a write, and it scales with row width.**
  ADR-0212's R2 drops a row's cells when a presence cell is written, and each drop
  is an entry to subtract. Measured across runs whose control arms sit at 1.00x to
  1.02x: **8.6x to 9.1x at 12 columns and 5.9x to 6.6x at 3**, falling to **6.5x
  to 6.7x** and **4.9x to 5.2x** when the sum is folded in memory and written
  once. "One add and one subtract per write" is true of a field write
  and badly untrue of a delete.
- **A body write's premium scales with the document, and is not yet measured for
  the entry this record decides.** A linear entry, which a canonical re-encode is,
  measured **+26% to +40% at an 80-character body and +27% to +61% at 40 KB**:
  7 to 11 microseconds added at the small size and 42 to 69 at the large one, on a 40 KB control arm wider than the effect (+15% to -14% against the small arm's 3%), so the scaling is where the numbers point rather than something they establish. **Both**
  halves cost a fresh load and a re-encode. The write path's own `doc_state` comes
  from the application's live document, which is the one byte string this record
  forbids the entry from using, so the new entry cannot reuse it; and nothing
  stores the previous entry, so subtracting it costs a re-encode of the pre-edit
  document. A column holding the last
  folded entry would recover most of it and no record proposes one. The
  earlier figures said the premium "does not scale with the document", which was
  true only of the snapshot, whose payload is 8 bytes at any size and which this
  record rejects. Hashing 40 KB of rendered text and 40 KB of `doc_state` cost
  13.23 and 13.24 microseconds, so the input's shape is not what matters; its
  length is.
- **Neither the recompute nor the body entry has been fuzzed as decided.** Every
  trace count attributed to them ran an earlier mechanism: the fuzz implements a
  terminal scan, which this record rejects for the replica. That is the third time
  a number here has been attributed to a mechanism that was not the one running,
  and it is the reason the counts are reported as untested rather than restated.
- **The body entry has no convergence evidence.** The 1200-trace fuzz reported for
  it ran the snapshot entry, which this record calls blind to the thing it
  compares, so "zero missed divergences" holds only because body text never
  diverged in those traces and the detector could not have seen it if it had. The
  entry is verified against its four constraints and against nothing else. That is
  the same error twice: evidence attributed to a mechanism that was never the one
  running.
- **That is the price of knowing.** ADR-0212's repair pass is a correct repair
  that, without this, nothing can ever trigger: the record can say "full
  reconciliation always converges" and be unable to say when to run it.
- **It answers in 8 bytes.** A settled round compares two sums and stops.
- **It does not localize.** A mismatch costs the full-range pass, which at
  ADR-0212's fixture is 2.6M cells and roughly 336 MB at an 80-character body. The precondition above is
  what keeps that rare; without it, it is every round. This is the whole reason
  the false-alarm rate matters more than the true-positive rate.
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
- **A causally gapped `doc_state` is refused at the write door.** `load` drops
  structs it cannot integrate, so a store holding `{u1, u3}` and one holding `{u1}`
  produce byte-identical entries: the entry is a function of what a document can
  integrate rather than of what the store holds, which is constraint 1, the one it
  was adopted to satisfy. Refusing the gap is cheaper than folding the state
  vector and the pending bytes alongside, and the plane already refuses
  subdocuments at the same door.
- **Subdocuments are invisible to this entry, and to the plane.** A `Y.Doc` is a
  legal value inside a `Y.Map`, and typing into one leaves the parent's
  `doc_state` unchanged, so a subdocument's prose is never delivered, never
  repaired, and never detected. ADR-0212's body plane has one `doc_state` and two
  slots per row, all of them the parent's stream, so this is a refusal that has to
  be made at the write door rather than a gap to be closed here.
- **`clientID` uniqueness is a precondition of the body algebra, not an
  assumption.** Two offline documents that drew the same `clientID` merge to
  different text depending on order, so the plane does not converge and the digest
  then mismatches forever.
- **The body entry was wrong four times, and the pattern is the lesson.** It was
  first absent, then hashed the encoding, then the history, then the rendered
  prose of a root the authority is forbidden to name. Each attempt
  reached for whatever the CRDT library offered that sounded canonical, rather
  than asking what the question is about. The question is whether two sides hold
  the same document, so the answer is the document, and a check for this entry has
  to test both directions: identical prose must agree, and different prose must
  differ. Testing only the first is what let the snapshot through.

## Considered alternatives

- **Derive detection from the cursor.** Three attempts, in Context. The root cause
  is that a delivery counter does not contain the information.
- **XOR rather than modular addition.** Identical pairs cancel, so two different
  states agree. Free to compute and wrong.
- **Store the sum as `INTEGER`.** Measured to make the stored sum a function of
  write order, so identical stores compare unequal and repair fires on 89% of
  rounds.
- **Hash only the version into an entry.** Cheaper per write by 2 to 15 points,
  and it makes the verifier trust exactly what it exists to verify.
- **Bucket the entries so a mismatch can name a region.** Refused on resumability
  in the Decision, the cost argument having been retired by the recompute, and refusing it is what collapses 4096 rows per side into one
  column, because nothing then reads a bucket and the sum does not depend on how
  entries were grouped.
- **Hash `doc_state` for a body entry.** The obvious encoding, and not a function
  of the document's content: 199 false alarms in 200 rounds for a single writer who
  deletes text.
- **Hash a Yjs snapshot for a body entry.** It sounds canonical and contains no
  content: two documents with entirely different text of the same length, at the
  same clock, hash identically.
- **Hash the prose a body renders.** Content-sensitive and canonical, and it
  requires the authority to name a root and render it, which ADR-0135 forbids and
  which is not even well defined for a document holding several independently
  interpreted roots.
- **Compare unconditionally.** 500 false full repairs out of 500 rounds.
