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
mismatch could be localized. Nothing reads a bucket: the descent was refused for
cost (below), so only the root is ever compared, and the root is a sum over every
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
`encodeStateAsUpdateV2` of a document loaded from `doc_state`. Four constraints
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

### A drop subtracts, in the same transaction

ADR-0212's R2 deletes a row's older cells when a presence cell is written. That
delete returns what it removed and subtracts each entry in the same transaction,
or the first deletion in the store guarantees a permanent false mismatch.

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
  Measured on the settled one-column schema across three runs whose control arms
  sit within 5%: **+50% to +63% at 12 columns and +41% to +59% at 3**, on a write
  that already pays ADR-0212's row-local floor. Against a store with neither, a
  local write costs **+93% to +111%**. An earlier draft said +75% and +65%; that
  was measured against the 4096-row bucket table this record then deleted, which
  is the third consecutive round in which the priced artifact was removed after
  pricing. Hashing the value rather than the version alone is 4 to 15 points,
  which is two runs' worth of control-arm noise apart and does not support a
  tighter figure. **Folding the sum in memory and writing it once per transaction
  halves the premium**, to about +31% and +25%, and still satisfies the
  same-transaction rule; the higher figures assume one write per transaction.
- **A row delete costs far more than a write, and it scales with row width.**
  ADR-0212's R2 drops a row's cells when a presence cell is written, and each drop
  is an entry to subtract. Measured on the one-column schema: **9.0x at 12 columns
  and 6.0x at 3**, falling to **6.7x and 4.9x** when the sum is folded in memory
  and written once. "One add and one subtract per write" is true of a field write
  and badly untrue of a delete.
- **A body write's premium is not separately established.** The figures this
  record carried were measured on two entries it no longer uses, and a canonical
  re-encode is O(document) like the write it accompanies. It needs its own
  measurement before anyone relies on a number.
- **That is the price of knowing.** ADR-0212's repair pass is a correct repair
  that, without this, nothing can ever trigger: the record can say "full
  reconciliation always converges" and be unable to say when to run it.
- **It answers in 8 bytes.** A settled round compares two sums and stops.
- **It does not localize.** A mismatch costs the full-range pass, which at
  ADR-0212's fixture is 2.6M cells and roughly 315 MB. The precondition above is
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
- **The body entry was wrong three times, and the pattern is the lesson.** It was
  first absent, then hashed the encoding, then hashed the history. Each attempt
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
- **Hash only the version into an entry.** Cheaper per write by 8 points, and it
  makes the verifier trust exactly what it exists to verify.
- **Bucket the entries so a mismatch can name a region.** Refused for the cost in
  the Decision, and refusing it is what collapses 4096 rows per side into one
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
