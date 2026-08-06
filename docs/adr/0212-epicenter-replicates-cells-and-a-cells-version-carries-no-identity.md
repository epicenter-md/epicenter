# 0212. Epicenter replicates cells, and a cell's version carries no identity

- **Status:** Proposed
- **Date:** 2026-08-06
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0211 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Supersedes:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md)
  (`Proposed`), and with it the three records 0163 itself superseded, because
  retiring 0163 alone would revive them:
  [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md)
  (`Accepted`), [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md)
  (`Accepted`), and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
  (`Accepted`, and unbuilt in source: `captureRecovery`, `startFresh`,
  `recovery-required`, and `history-expired` have zero references in `packages/`
  or `apps/`, though `specs/20260717T212450-two-plane-row-document-runtime.md:381`
  is a checked box claiming otherwise and needs resolving).
  Also [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md),
  which said Epicenter "stores no background conflict inbox, device timestamp,
  per-key causal clock, or retained losing value" and rejected device timestamps
  outright: this record stores a wall clock and a counter on every cell and
  deletes 0121's outbox, so three of its four decision paragraphs stop
  governing.
  Also [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md)
  (`Proposed`), whose write-once slot (`digest A + B -> refuse or park B`, and
  "no replacement-in-place... or blob garbage collector") is contradicted
  outright: a blob digest becomes an ordinary cell that a later write repoints.
- **Amends:** [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
  at its mechanism, not its law. Every durable write still leaves the authority
  owed something. What changes is that the obligation is no longer a separate
  record: a cell the authority has not confirmed *is* the obligation. Its blob
  plane, its terminal-issue mechanism, and its park state are withdrawn.
  Also [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)
  at the publication obligation: a revision counter is replaced by the unsent
  bytes themselves. Its projection rule survives.
  Also [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md)
  at the hole it named and accepted (`:258-264`, "a table's prose is either in a
  field or unreachable from the folder"). A body becomes a Yjs plane, so folder
  round-trip and character merge stop being exclusive. This makes a
  markdown-to-`Y.Text` minimal diff a prerequisite: `apps/epicenter/src/folder/parse.ts:96-101`
  assigns the body into a plain fields object today, which is correct for an LWW
  scalar and would destroy CRDT history once there is any.
- **Relates:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md)
  (the address, and the reason an address must be reusable),
  [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md)
  and [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md) (why
  storage must be schemaless), [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md)
  (the projection that makes the replica's own query shape irrelevant),
  [ADR-0135](0135-row-documents-have-application-owned-roots.md) (the body)

## Context

Scalar replication today stores a queue of ordered patch intents, ships them in
sealed batches, and resolves conflicts by the order the authority happened to
apply them. Everything else follows from that one choice: the outbox exists to
hold work awaiting a sequence, the `(batch seq, digest)` receipt exists to prove
it got one, and `batch-conflict` recovery exists for when that lineage breaks,
minting a new replica id up to eight times per `synchronize` call.

Three measured facts made the choice worth reopening. The outbox does not
compact, so ten edits to one field become ten intents and burn ten authority
sequences (`replica.ts:363-374`). Only one batch seals per round, so N pending
intents cost `ceil(N/64)` round trips (`replica.ts:558-562` seals once per outer
iteration, `replica.ts:690-696` re-loops while work remains). And the path is
close to untested: `sealBatch`, `pendingIntents`, and `intentsPerBatch` have zero
test references, while `authority.test.ts` opens with a docblock claiming
coverage its single test does not provide.

Meanwhile the authority already stores latest-state-per-address rather than a log
(`authority.ts:137-153`), so the downstream half is already state-based. Only the
upstream half is a queue.

**What the replica is optimised for.** The projection is derived, and it is
derived on the reading side (ADR-0208). So the replica store is not a query
surface, and read latency is cheap to trade. What is not cheap to trade is
legibility: a person opening the file in a SQL console must be able to see what
Epicenter believes without decoding anything. Storage size matters next, and
projection rebuild cost after that. Scattered read latency is deliberately not an
axis, and every refusal below is priced against the first three.

## Decision

**A replica is a store of cells, and a cell's version is a time, a counter, and a
hash of its own value. Nothing in a version names a device.**

### One cell per value, and whether the row exists is one of them

The unit of storage, merge, and transfer is a single value at one
`namespace / table / row / column` address. A row is what you get by grouping
cells. Whole-row storage is refused: a whole-row write asserts something about a
field it may know nothing about, so per-field and whole-row versions are not
composable at any granularity.

**Row presence is an ordinary cell** at a reserved column, not a second relation
with a second merge rule. An earlier draft of this record gave row death its own
algebra (`absent` beats `present` regardless of version, earliest death wins).
That is deleted. It cost a relation, an algebra, and a join, and it made an
address single-use for the lifetime of the Epicenter, which directly contradicts
what ADR-0206 exists to allow.

Whole-row JSON remains the **bootstrap transfer** format, where it measures 2.9x
faster to seed once JavaScript hashing and CHECK constraints are held constant,
and 53% smaller at 200k rows of 12 columns (40% at 1M rows of 3). It is never a
stored shape.

### The layout

```sql
CREATE TABLE _replica_cell (
	namespace    TEXT NOT NULL,
	table_name   TEXT NOT NULL,
	row_id       TEXT NOT NULL,
	column_name  TEXT NOT NULL CHECK (
	               column_name = '!presence' OR column_name GLOB '[A-Za-z]*'),
	value        TEXT,       -- canonical JSON; NULL is a cleared cell, which is a value
	version_ms   INTEGER NOT NULL,
	version_seq  INTEGER NOT NULL,
	version_hash BLOB NOT NULL CHECK (length(version_hash) = 8),
	dirty        INTEGER NOT NULL CHECK (dirty IN (0, 1)),
	CHECK (column_name <> '!presence' OR value IN ('"present"', '"absent"')),
	PRIMARY KEY (namespace, table_name, row_id, column_name)
) WITHOUT ROWID, STRICT;

CREATE TABLE _replica_body (
	namespace, table_name, row_id,
	doc_state       BLOB NOT NULL,
	pending_update  BLOB,   -- local edits accumulate here
	inflight_update BLOB,   -- sending MOVES them here; an ack clears only this
	PRIMARY KEY (namespace, table_name, row_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE _authority_cell (
	cursor INTEGER PRIMARY KEY,   -- the cursor IS the rowid
	namespace, table_name, row_id, column_name,
	value BLOB,                   -- opaque bytes, never parsed
	version_ms, version_seq, version_hash
) STRICT;
CREATE UNIQUE INDEX _authority_cell_address
	ON _authority_cell(namespace, table_name, row_id, column_name);
```

`!presence` is the reserved column carrying liveness. A Lens column name must
start with a letter, so no Lens can name it, and `!` sorts before every letter,
so a row's liveness is the first thing an ordered scan of that row meets. The
schema enforces both halves, so the reservation is a constraint rather than a
convention.

Each metadata singleton carries one more column than it looks like it needs. A
replica stores `authority_lifetime` beside `last_applied_cursor`, and an
authority mints a `lifetime` once per store; the reason is under "the authority
names its own store lifetime" below.

### The version is `(version_ms, version_seq, version_hash)`

```txt
version_ms    Date.now() at the local write, never below what it overwrites
version_seq   0, or one past the cell's own counter within the same version_ms
version_hash  8 bytes of sha256 over the value's canonical JSON
```

Compare left to right. **The comparison never touches the value itself and never
names an actor.**

`version_ms` is the version expressed as a time, chosen so a human can read it.
It is not a claim about when a person acted, and the authority verifies only that
it is not absurdly ahead of its own clock.

`version_seq` is local monotonicity done structurally. Inflating `version_ms`
instead would store its own drift.

`version_hash` is fixed-width, so `memcmp` orders it identically in SQL and in
JavaScript. Comparing values directly does not: SQLite orders `2 < '10'` while a
canonical-JSON comparison orders the reverse, and UTF-8 byte order disagrees with
UTF-16 code-unit order for astral characters. A hash is what makes a total order
available to both sides without either forfeiting `value ANY` or forbidding the
merge from ever running in SQL.

**No actor identity.** A version is a pure function of when, how many, and what.
There is nothing to persist, rotate, intern, or reconcile, and no version vector
to prune. This is the whole reason, and it is the only one: an earlier draft
also argued that a hybrid logical clock spreads a skewed clock through
`max(observed)`, which is true and which this record's own ingest clamp bounds to
minutes, exactly as it would bound an HLC. That argument is withdrawn rather
than relied on.

### The local write rule is derived from the cell being written

```txt
version_ms  = max(Date.now(), current.version_ms)
version_seq = version_ms === current.version_ms ? current.version_seq + 1 : 0
```

Both components come from the row being written, which is already in hand, so
this costs nothing and survives a crash. **A replica-global counter does not.**
A process restart inside one millisecond reissues `version_seq = 0`, so a rewrite
and the value it replaces carry the same `(ms, seq)`, the tie falls to the hash,
and the hash knows nothing about which write came second: measured over 20,000
trials, the later write is silently discarded **50.3% of the time**.

Raising `version_ms` to meet what it overwrites is what makes a local edit beat a
version that arrived from a clock running ahead. It stores no drift: 200,000
same-cell writes produce **0 ms** of drift, because `version_seq` absorbs them.

### The merge predicate is `>`, or `=` with a byte-equal value

```sql
WHERE (excluded.version_ms, excluded.version_seq, excluded.version_hash)
    > (cell.version_ms, cell.version_seq, cell.version_hash)
   OR ((excluded.version_ms, excluded.version_seq, excluded.version_hash)
     = (cell.version_ms, cell.version_seq, cell.version_hash)
      AND excluded.value IS cell.value)
```

The equal case is load-bearing, not a rounding. The authority answers a push with
the winning version, which for a push that *won* is byte-identical to what was
sent. Under a strict `>` that echo fails the comparison, `dirty` never clears,
and the cell re-pushes every round forever.

The value guard is what keeps the equal case safe. Admitting equality alone makes
two replicas holding different values at one exact version replace each other's
copy on every exchange, oscillating forever while both read as clean. That needs
a 64-bit hash collision at the same `(ms, seq)`, so it is vanishingly unlikely,
and it never self-heals, and the guard costs nothing. Widening the hash to 16
bytes would also close it and was measured at **+36 MB (+11.5%)**, so the guard
is taken and the wider hash refused.

### An address is reusable, and the presence cell's version is the generation

Two rules, and neither works without the other:

```txt
R1  a cell is REFUSED if its (version_ms, version_seq) is older than the
    row's presence cell
R2  a presence write DROPS every cell older than itself by (version_ms, version_seq)
```

The incarnation boundary compares `(version_ms, version_seq)` and deliberately
not `version_hash`. The hash breaks ties between two competing values of one
cell; across two different cells it means nothing, and letting it decide here
drops a cell written in the same transaction as its own create, on hash luck.

Together the presence cell's version does the work a generation column would do,
with no column and no `resurrect` verb. A re-creation supplies the fields it
wants because R2 discards the previous incarnation's; that is the complete
snapshot an explicit resurrection API would have had to demand, enforced
structurally. And it is stronger than a generation on the case a generation
handles worst: a replica that has not seen the re-creation writes at its own wall
clock, which is later, so its write lands rather than being discarded as
old-generation.

Each rule alone is order-dependent, and the pair is not. Verified exhaustively:
every ordering of every subset of an eight-delivery set converges, 109,600 runs
over 255 subsets, zero divergent.

An `absent` write drops cells by the same version comparison as any other
presence write, and deliberately not unconditionally. "A dead row holds nothing"
is the more appealing rule and it does not converge: a cell newer than the delete
survives if it arrives after a later re-creation and dies if it arrives before.
So a cell written concurrently by a replica that never saw the delete is stored
at a dead address, where no read can reach it, until the address is re-created
and R2 discards it. It cannot be collected locally either, because a replica that
collected it and one that did not would disagree if the address were later
re-created at a version between the two.

### The write surface, which is the one that already exists

```ts
create(fields): Promise<Row>;          // the runtime mints the id and returns the row
create(rowId, fields): Promise<Row>;   // an application supplies a key it already knows
patch(id, changes): Promise<Result<Row | undefined, ReadError>>;
delete(id): Promise<boolean>;
```

This is `packages/data/src/epicenter.ts:69-79` unchanged. The exploration memo
proposed renaming `patch` to `set` and declaring that "create is not a verb"; both
are withdrawn. `create` has to be a verb, because it is the only call that writes
the presence cell and therefore the only one that can reuse an address, and it is
already the one moment the type system can demand a complete row. `patch` is
already partial by nature, which is exactly what a per-cell write is.

`create`'s two doors are ADR-0206 implemented literally: `suppliedId ?? mintRowId()`
at `epicenter.ts:468`. Both doors return the row, so a caller never has to thread
an id it did not choose.

A `json(inner)` field is **one cell**. Its value is the whole blob, so a write
replaces it whole and nothing merges inside it. That is the point rather than a
limitation: one cell is one merge unit, so values that must move together are
declared as one field and can never tear.

One sentence in that docblock stops being true. It says `patch` "refuses an
address that holds no live fact, so an id you already deleted stays deleted rather
than being resurrected by a write." The refusal survives, and is R1's local
counterpart. The conclusion does not: a deleted id can be reused, by `create`,
which is the whole point of dropping absorbing death.

### Two merge algebras, deliberately not unified

| Plane | Rule |
| --- | --- |
| cell, including presence | higher `(version_ms, version_seq, version_hash)` wins |
| body | `Y.mergeUpdatesV2` on raw bytes |

There were three. Row death was the third, and collapsing it into the cell plane
is what this revision is mostly about.

A body is not last-write-wins, and the failure is not theoretical: two devices
editing a 40KB document offline would lose one entire document. Last-write-wins
is worst exactly where the payload is largest. The entry point is
`mergeUpdatesV2`, not `mergeUpdates`: the V1 function throws on the V2 bytes
everything else here uses.

### Ordering is a version. Delivery names what is owed.

A cell carries an explicit `dirty` flag, **with no index**. A partial index on
`dirty = 1` over a `WITHOUT ROWID` table carries the entire primary key per
entry, which is the same cost this record refuses a replica-side cursor for: it
measured **+75 MB at 200k rows of 12 columns and +92 MB at 1M rows of 3**, on a
replica with local work standing. The scan it replaces costs **46 ms and 92 ms**
respectively, once per sync round.

Encoding delivery as timestamp equality was tried and fails: write at T, confirm
at T, write a new value at T again, and a derived `confirmed = written` flag reads
clean, so the second write never syncs and never appears pending.

**A body carries two slots, not one.** Local edits accumulate in
`pending_update`; sending *moves* them into `inflight_update`; an acknowledgement
clears `inflight_update` alone; a failed send merges it back. One slot loses
every edit made during the round trip, permanently and undetectably, because the
acknowledgement clears bytes the authority never received and a body has no
version that could later notice. The cell plane survives the identical
interleaving, because merging its answer is what clears its flag. A body cannot
have that, which is exactly why it needs the second slot.

A body gets no version at all. A cell's version resolves conflicts; a body's
marker tracks delivery, and giving a body a timestamp would advertise a merge
policy it does not have.

**A replica never stores a claim about the authority's state.** Storing the
authority's last-known Yjs state vector was tried and refused: an overstated
vector produces a causally gapped update the authority accepts and buffers while
its text never advances, and the quiet variant is a 13-byte no-op that "succeeds"
and confirms state the authority does not hold. A marker that decides *what* to
push fails silently and self-perpetuates. The unsent bytes claim only what the
replica can actually know, and measured smaller (253B versus 605B).

### The push response is a merge input, including its refusals

The authority answers with the winning version of everything it processed, and
the replica merges that answer exactly as it merges a pull. Clearing `dirty`
becomes a consequence of merging rather than a bookkeeping step, which is what
covers the case a conditional confirm misses: a push that *loses* the authority's
comparison would otherwise clear its flag while the authority holds a different
value, and a losing write takes no cursor, so the winner might never be
redelivered.

**A refusal is a merge input too, and carries the authority's clock.** The ingest
clamp is the one refusal this record names, and a refused write stores nothing,
takes no cursor, and therefore appears nowhere in a response that only reports
what was stored. Its `dirty` flag is never cleared and the round repeats forever
with no bound: a laptop resuming with its clock a day fast strands the cell for
about 24 hours, and one resuming with an RTC reading 2031 strands it for years.
Rewriting cannot repair it, because the local write rule never lowers
`version_ms`. So a refusal names the address and the authority's own time, and
the replica re-stamps the refused cell at that time. This is not a durable claim
about another party's state: it is a one-shot repair carried by the response, and
the skewed version never propagated because the authority never accepted it.

### The authority is a store, ordered by cursor, and names its own lifetime

Its only two access patterns are point lookup by address, to merge, and range
scan by cursor, to serve deltas. Since the comparison never touches the value, it
stores values as **opaque bytes** it never parses. **The body plane is the one
exception**: merging a body means running Yjs, so the authority interprets there
and the dependency is real, including for any future non-JavaScript authority.

**The cursor is the rowid**, and the address is a unique index. The alternative,
an address primary key with a secondary cursor index, is 2.9x slower on the
authority's only range question at a fixed fixture, and 6.8x slower once cursors
are assigned in arrival order rather than address order, which is what a cursor
means. Returning rows rather than counting them, it is 964 ms against 285 ms. It
is disk-neutral and merge-neutral: the two merge figures differ by less than the
1.9x first-touch penalty that sits on either of them.

A new cursor is assigned only on a **strict** version increase, never on the
equal case. Otherwise a retried byte-identical push takes fresh cursors for
everything it re-sent and redelivers the entire dataset to every other replica.

The authority keeps current state only, with no history, so an arbitrarily stale
cursor still works and bootstrap is just "everything since cursor zero".
**A replica never stores a per-cell cursor**: that index measured 85.3 MB, 32% of
the file.

**The authority names its own store lifetime, and returns it with every
response.** A cursor is meaningless across a restore. Replace the authority's
file from an older snapshot and its counter comes back lower than watermarks
already held: measured over 50 rounds with 50 real post-restore writes, a replica
receives **0 cells** and disagrees on 300 of 300, pushing nothing because nothing
is dirty. A replica stores `(lifetime, cursor)` and resets its cursor to zero when
shown a lifetime that is not the one it recorded. Without this, "an arbitrarily
stale cursor still works" is true of a stale cursor and false of a stale
authority, and only the first was stated.

### Repair is bidirectional

Merge is idempotent, so re-sending anything is safe and asking from cursor zero
always converges. That repairs the replica and **not the authority**: every
pulled cell has `dirty = 0`, so a replica whose authority has lost cells
considers nothing owed and re-uploads nothing, while every byte sits on a live
replica. A repair pass therefore pushes every cell, ignoring `dirty`, which is
sound precisely because merge is idempotent and affordable precisely because the
equal case takes no cursor.

ADR-0142's separate bootstrap, history-gap, and lineage-mismatch recoveries are
unnecessary as separate mechanisms. The lineage question is not: it is the store
lifetime above.

## Consequences

- **Deleted:** the outbox and every path maintaining it; the batch/digest receipt
  handshake on both sides; `batch-conflict` recovery, replica-id rotation, and
  its eight-attempt loop; `_authority_replicas`, whose only job was batch
  idempotency; one-batch-per-round; the permanent wedge where one oversized
  intent stops the queue forever (`replica.ts:375-376`); and, relative to this
  record's own first draft, a merge algebra, a relation, a projection join, and
  an index.
- **The authority stops being a sequencer and becomes a store.** Two replicas
  could therefore merge directly with no server, which is impossible today by
  construction. This record does not build that: a cursor is server-assigned and
  has no meaning between peers, so peer sync would need range-based set
  reconciliation instead. The seam that keeps it cheap later is one rule: **the
  cursor never appears in a replica.**
- **A conflict is never shown to a person, and no surface claims to be
  "synced".** Both are refusals: retaining losers requires a different CRDT, and
  a sync assertion cannot be verified without a round trip, so a stale
  affirmation is worse than none.
- **The silent-loss window is the ingest clamp, not a millisecond.** A device
  whose clock is four minutes fast, which the clamp admits, wins against an edit
  made three real minutes later, and nothing tells anyone. "At an exact
  millisecond tie the winner is arbitrary" understated this by the width of the
  clamp. Relatedly, the local write rule raises a cell's `version_ms` to meet a
  skewed version it merged, so a correct clock inherits that floor for that cell:
  the scheme is `max(observed)` bounded per cell rather than globally, which is
  better than an HLC's global propagation and is not the absence of propagation.
- **The store costs 2.13x whole-row JSON on disk** (181.4 MB against 85.3 MB at
  200k rows of 12 columns; 345.2 MB against 206.2 MB, or 1.67x, at 1M rows of 3),
  and 3.75x its own payload. At 1M rows of 3 columns the payload ratio falls to
  2.54x, so the multiplier is a function of row width and a single figure for it
  is not meaningful. Interning the address would
  recover at most 32%, before adding back dictionary tables and integer keys, and
  is refused: the replica's first duty is to be readable in a SQL console, and an
  interned file needs three dictionary joins before it says anything.
- **Legibility is bought with views, not with columns.** Storing the version as
  ISO-8601 text and the hash as hex is genuinely readable and orders identically,
  and it measured **+65 MB (+36%) and +101 MB (+29%)** at the two shapes. A view
  rendering `version_ms` as a timestamp and `version_hash` as hex costs nothing
  and reads better than either, so the stored columns stay compact.
- **Re-deriving one changed row costs 1.69x and 1.21x** what whole-row JSON
  costs (6.9 against 4.09 microseconds, 4.79 against 3.95). That is the operation
  that runs in steady state, because a write touches one row, and the margin
  there is small.
- **Rebuilding the WHOLE projection costs 590 ms at 2.4M cells and 1122 ms at
  3M**, against 35 ms and 130 ms: 16.8x and 8.6x. That number is a cold start, a
  repair, or a re-import, and it is the price of the layout rather than a
  steady-state cost. Keeping presence in its own relation would have cost 1230 ms
  and 2090 ms, so the collapse recovered 2.1x and 1.8x of it for 1.7% and 4.9%
  more disk. Every projection above was verified to produce identical output.
- **Counters are refused.** "Add one" is not expressible; two devices each adding
  one yields one. None exist today, and one would need its own CRDT regardless.
- **Every value must round-trip canonical JSON byte-identically.** This is newly
  load-bearing: because the comparison no longer touches the value, a lossy round
  trip is invisible. Two findings, and neither is the one previously stated.
  Canonical JSON round-trips every integer byte-identically, including above
  2^53, because the precision is already gone before storage sees it: a caller
  writing 2^53 + 1 hands over 2^53, and half of the first thousand integers above
  2^53 cannot be held at all. That is a write-door bound on `field.integer`
  (`builders.ts:141` declares no maximum), not a storage bound. The one genuinely
  lossy round trip is negative zero, which is a legal finite number that canonical
  JSON writes as `0` and nothing refuses.
- **A table must declare at least one required field.** Otherwise a row with zero
  cells is reachable, has nothing to push, and exists on its creator alone
  forever. The same rule also guarantees a row can never lose its last cell,
  because unsetting a required field is already refused.
- **Presence is the sole liveness authority.** No read may infer existence from
  the other cells. Reading liveness as "this row has cells" resurrects a deleted
  row on the very replica that just pulled the tombstone, and R1 is what makes
  the inverse safe: a cell cannot exist at an address whose presence cell is
  newer, so a cell behind a tombstone is refused rather than stored, unreadable
  and uncollected forever.
- **ADR-0171's blob plane is withdrawn**, and with it its park state and its
  terminal-issue record. A blob digest is an ordinary cell whose value happens to
  be a digest; a later write repoints the row and orphans bytes, which is garbage
  rather than corruption. This contradicts ADR-0173's write-once slot, which is
  why 0173 is superseded rather than related. An oversized document is refused at
  the write door, where the size is already known offline, rather than becoming a
  terminal sync condition whose presentation an application has to own.
- **Crash safety has to be written down, because it is not implied.** Applying a
  pulled page and advancing the stored cursor are one transaction, or a crash
  between them loses those cells with nothing able to notice. A body's merged
  state and its two slots are one transaction, or the body defect above
  reappears through a different door.
- **The replaced path is close to untested**, so the migration's convergence
  check cannot be a regression test against what exists. It has to be a new
  differential test, written first.

## Considered alternatives

Measured costs are at 200k rows of 12 columns unless stated. The full table,
including what each refusal costs, is in the memo.

- **Keep ordered patch replay.** It protects exactly one thing: `[create,
  delete]` reordered leaves a permanently live row, because `delete` no-ops at an
  address that does not exist yet (`fold.ts:85-99`). Clocked tombstones handle
  that by comparison rather than by arrival order, so the guarantee improves
  rather than survives.
- **Row death as an absorbing element, with earliest death winning.** This
  record's own first draft. Refused because it makes an address single-use for
  the lifetime of the Epicenter, which collides head-on with ADR-0206: a mirror
  keyed by a provider id cannot re-create a record the provider restored, its
  reconciler cannot detect the failure because the write is accepted locally and
  silently absorbed, and full reconciliation cannot repair it because the
  tombstone is the converged state. Verified: 30 reconciler passes, all with
  strictly later versions, leave the row absent.
- **A generation column, with an explicit `resurrect` verb.** The same fix,
  spelled with a column on every cell and a new API surface. Refused because the
  presence cell's version already orders incarnations, so the column is
  redundant, and because a generation loses a concurrent write from a replica
  that has not seen the bump, where R1 and R2 keep it.
- **Real typed columns, one SQL table per Lens table.** Cheapest on disk by a
  wide margin (48.5 MB, 2.7x smaller than the cell store) and fastest to read
  (0.0037 ms per row, against 0.010 ms). Refused on correctness, not on
  performance: ADR-0125 requires a release to preserve values it does not
  understand, and a typed column has nowhere to put an unknown key. The escapes
  are an `_extra` JSON column with its own embedded versions, which rebuilds the
  blob it refused with two merge paths, or losing data whenever two releases
  disagree.
- **One JSON record per row with a parallel version map.** Cheaper on disk and
  faster to seed, and refused because one field change ships the whole record and
  the whole map (1039 bytes against 121, 8.6x at 12 columns and 2.9x at 3) and
  because declaring merge groups makes the group names an unversioned wire
  contract a peer on another release cannot interpret.
- **A hybrid logical clock with an actor id.** Its counter is adopted; its actor
  is not, because there is no identity to persist or rotate and merge stays a
  pure function of `(version, value)`. Not because it spreads a skewed clock:
  this record's clamp bounds that for an HLC exactly as it does here.
- **Direct Yjs for scalars.** A `Y.Map` key conflict resolves by highest random
  `clientID`, so the winner is unrelated to recency; map tombstone metadata is
  retained; and a key cannot be read without materializing the whole document,
  which forfeits the SQL projection.
- **A dirty bit derived from timestamp equality.** Elegant, and it silently loses
  a same-millisecond rewrite.
- **An index on `dirty`.** Costs up to 75 MB, 30% of the file, to save 46 ms once
  per sync round.
- **Readable version columns.** ISO-8601 and hex order identically to the compact
  encoding and cost 36% more disk. A view is free.
- **A 16-byte version hash.** Closes the exact-version oscillation for +36 MB.
  The value guard in the merge predicate closes it for nothing.
- **Range-based set reconciliation instead of a cursor.** It would delete the
  cursor and make the authority just another peer. Refused, and not on the
  symmetry argument previously given: symmetry was never the reason to want it.
  It is refused because it is a bad *delivery* mechanism: finding one changed
  cell costs a 32KB bucket exchange plus the address and version of all 586 cells
  in the differing bucket, where a cursor costs the changed cell. The seam remains
  one rule, that the cursor never appears in a replica.
- **An incremental multiset digest beside the cursor, as a verifier rather than
  a delivery mechanism.** This is the one thing that can detect divergence at
  all, and it was measured rather than argued: a 4096-bucket table of modular
  64-bit sums costs **72 KB** of disk and answers "are the two sides actually
  equal" in **0.29 ms for 8 bytes on the wire**. It is deferred, not refused. Its
  price is on the write path, at **+17% to +27% per local write**, and that is an
  upper bound because the measurement charges it a read of the old version that a
  real merge already performs. It is deferred because the store lifetime catches
  the realistic divergence (a restored or rewound authority) for one column, and
  the bidirectional repair pass can be triggered on demand or on a schedule
  without it. Adopt it if silent divergence is ever actually observed. The sums
  must be folded in the application and not in SQL: SQLite raises on 64-bit
  integer overflow, and an earlier attempt to keep the running sum in a column
  promoted it to REAL and silently destroyed the digest.
