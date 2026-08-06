# 0212. Epicenter replicates cells, and a cell's version carries no identity

- **Status:** Proposed
- **Date:** 2026-08-06
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0211 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Supersedes:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md),
  [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
  (both `Proposed`, and 0142 is entirely unbuilt: `captureRecovery`, `startFresh`,
  `recovery-required`, and `history-expired` have zero references in the tree)
- **Amends:** [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
  at its mechanism, not its law. Every durable write still leaves the authority
  owed something. What changes is that the obligation is no longer a separate
  record: a cell whose version the authority has not confirmed *is* the
  obligation. Its blob plane, its terminal-issue mechanism, and its park state
  are withdrawn (see Consequences).
  Also [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md)
  wholly at conflict resolution: server arrival order is replaced by a version
  the writer computes.
- **Relates:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md)
  (the address), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md)
  and [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md) (why
  storage must be schemaless), [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md)
  (the projection that makes the replica's own query shape irrelevant),
  [ADR-0135](0135-row-documents-have-application-owned-roots.md) and
  [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md)
  (the body)

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
intents cost `ceil(N/64)` full round trips (`replica.ts:547`). And the path is
close to untested: `sealBatch`, `pendingIntents`, and `intentsPerBatch` have zero
test references, while `authority.test.ts` opens with a docblock claiming coverage
its single test does not provide.

Meanwhile the authority already stores latest-state-per-address rather than a log
(`authority.ts:137-153`), so the downstream half is already state-based. Only the
upstream half is a queue.

## Decision

**A replica is a store of cells, and a cell's version is a time, a counter, and a
hash of its own value. Nothing in a version names a device.**

### One cell per value

The unit of storage, merge, and transfer is a single value at one
`namespace / table / row / column` address. A row is what you get by grouping
cells. Whole-row storage is refused: a whole-row write asserts something about a
field it may know nothing about, so per-field and whole-row versions are not
composable at any granularity.

Whole-row JSON remains the **bootstrap transfer** format, where it measured 4x
faster insert and 42% smaller, and is never a stored shape.

### The version is `(version_ms, version_seq, version_hash)`

```txt
version_ms    Date.now() at the local write, raised to stay strictly monotonic
version_seq   0 unless this millisecond already had a write on this replica
version_hash  8 bytes of sha256 over the value's canonical JSON
```

Compare left to right; the higher version wins. **The comparison never touches
the value itself and never names an actor.**

`version_ms` is the version expressed as a time, chosen so a human can read it.
It is not a claim about when a person acted, and the authority verifies only that
it is not absurdly ahead of its own clock.

`version_seq` is local monotonicity done structurally. Inflating `version_ms`
instead would store its own drift: 200,000 same-cell writes take 129ms of real
time and produce 199,871ms of drift, and a stamp past the authority's clamp is
then unsyncable until wall time catches up.

`version_hash` is fixed-width, so `memcmp` orders it identically in SQL and in
JavaScript. Comparing values directly does not: SQLite orders `2 < '10'` while a
canonical-JSON comparison orders the reverse, and UTF-8 byte order disagrees with
UTF-16 code-unit order for astral characters. A hash is what makes a total order
available to both sides without either forfeiting `value ANY` or forbidding the
merge from ever running in SQL.

**No actor identity.** A version is a pure function of when, how many, and what.
There is no device id to persist, rotate, intern, or reconcile, and no version
vector to prune.

### Three merge algebras, deliberately not unified

| Plane | Rule |
| --- | --- |
| cell | higher `(version_ms, version_seq, version_hash)` wins |
| row death | `absent` beats `present` **regardless of version**; earliest death wins |
| body | `Y.mergeUpdates` on raw bytes |

Death is not last-write-wins. Last-write-wins over a total order is
time-symmetric, so `create@T3` would beat `delete@T2` and terminality would fail.
Death is a monotone absorbing element, and the lattice *is* the rule.

A body is not last-write-wins either, and the failure is not theoretical: two
devices editing a 40KB document offline would lose one entire document.
Last-write-wins is worst exactly where the payload is largest.

### Ordering is a version. Delivery names what is owed.

A cell carries an explicit `dirty` flag. A body carries its unsent bytes in
`pending_update`, whose presence is the whole marker. Neither dates its debt.

Encoding delivery as timestamp equality was tried and fails: write at T, confirm
at T, write a new value at T again, and a derived `confirmed = written` flag reads
clean, so the second write never syncs and never appears pending.

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

### The push response is a merge input

The authority answers with the winning version of everything it processed, and
the replica merges that answer exactly as it merges a pull. Clearing `dirty`
becomes a consequence of merging rather than a bookkeeping step, which is what
covers the case a conditional confirm misses: a push that *loses* the authority's
comparison would otherwise clear its flag while the authority holds a different
value, and a losing write takes no cursor, so the winner might never be
redelivered.

### The authority is not queryable, and never interprets a value

Its only two access patterns are point lookup by address, to merge, and range
scan by cursor, to serve deltas. Since the comparison never touches the value,
the authority stores values as **opaque bytes** it never parses. It keeps current
state only, with no history, so an arbitrarily stale cursor still works and
bootstrap is just "everything since cursor zero".

The cursor is the authority's alone. One counter shared across cells, deaths, and
bodies, assigned only when stored state actually changes. **A replica never
stores a per-cell cursor**: a cursor index on a `WITHOUT ROWID` table measured
109-186MB, 36-41% of the whole file, because every index entry carries the entire
primary key.

The two sides therefore order themselves differently on purpose: a replica by
address, because its question is "read this row"; the authority by cursor,
because its only question is "everything after N".

### Full reconciliation is always a correct repair

Merge is idempotent, so re-sending anything is safe and asking from cursor zero
always converges. ADR-0142's separate bootstrap, history-gap, and
lineage-mismatch recoveries are unnecessary rather than unbuilt.

## Consequences

- **Deleted:** the outbox and every path maintaining it; the batch/digest receipt
  handshake on both sides; `batch-conflict` recovery, replica-id rotation, and
  its eight-attempt loop; `_authority_replicas`, whose only job was batch
  idempotency; one-batch-per-round; and the permanent wedge where one oversized
  intent stops the queue forever (`replica.ts:375-376`).
- **The authority stops being a sequencer and becomes a store.** Two replicas
  could therefore merge directly with no server, which is impossible today by
  construction. This record does not build that: a cursor is server-assigned and
  has no meaning between peers, so peer sync would need range-based set
  reconciliation instead. Iroh 1.0 supplies the transport for it and explicitly
  not the reconciliation. The seam that keeps it cheap later is one rule: **the
  cursor never appears in a replica.**
- **A conflict is never shown to a person, and no surface claims to be
  "synced".** Both are refusals: retaining losers requires a different CRDT, and
  a sync assertion cannot be verified without a round trip, so a stale
  affirmation is worse than none.
- **Counters are refused.** "Add one" is not expressible; two devices each adding
  one yields one. None exist today, and one would need its own CRDT regardless.
- **Per-cell addressing costs about 2.4x its payload**, and roughly 70MB at a
  realistic hundred thousand rows. Interning the address recovers about 40% and
  is refused: the replica's first duty is to be readable in a SQL console, and an
  interned file needs three dictionary joins before it says anything.
- **Every value must round-trip canonical JSON byte-identically.** This is newly
  load-bearing: because the comparison no longer touches the value, a lossy
  round trip is invisible. `field.integer` has no maximum and JSON cannot
  represent integers above 2^53 exactly, so that bound needs stating and testing.
- **A table must declare at least one required field.** Otherwise a row with zero
  cells is reachable, has nothing to push, and exists on its creator alone
  forever. The same rule also guarantees a row can never lose its last cell,
  because unsetting a required field is already refused.
- **`row` is the sole liveness authority.** No read may infer existence from
  cells. Reading liveness as `SELECT DISTINCT row FROM cell` resurrects a deleted
  row on the very replica that just pulled the tombstone.
- **ADR-0171's blob plane is withdrawn**, and with it its park state and its
  terminal-issue record. A blob digest is an ordinary cell whose value happens to
  be a digest; a later write repoints the row and orphans bytes, which is garbage
  rather than corruption. An oversized document is refused at the write door,
  where the size is already known offline, rather than becoming a terminal sync
  condition whose presentation an application has to own.
- **The replaced path is close to untested**, so the migration's convergence
  check cannot be a regression test against what exists. It has to be a new
  differential test, written first.

## Considered alternatives

- **Keep ordered patch replay.** It protects exactly one thing: `[create,
  delete]` reordered leaves a permanently live row, because `delete` no-ops at an
  address that does not exist yet. Clocked tombstones handle that by comparison
  rather than by arrival order, so the guarantee improves rather than survives.
- **Real typed columns, one SQL table per Lens table.** Best steady-state numbers
  of any candidate (0.011ms row read). Refused on correctness: ADR-0125 requires
  a release to preserve values it does not understand, and a typed column has
  nowhere to put an unknown key. The escapes are an `_extra` JSON column with its
  own embedded clocks, which rebuilds the blob it refused with two merge paths, or
  losing data whenever two releases disagree. A generated migration also silently
  dropped 26.6MB of bodies in testing, detected only because a size number moved.
- **One JSON record per row with a parallel clock map.** Cheaper on disk and
  faster to seed, and refused because one field change ships the whole row (5.5x
  amplification measured) and because declaring merge groups makes the group
  names an unversioned wire contract a peer on another release cannot interpret.
- **A hybrid logical clock with an actor id.** Its counter is adopted; its actor
  is not. `max(observed)` propagates a skewed clock to every replica permanently,
  and a fixed-width value hash supplies the same total order with no identity to
  persist or rotate.
- **Direct Yjs for scalars.** A `Y.Map` key conflict resolves by highest random
  `clientID`, so the winner is unrelated to recency; map tombstone metadata is
  retained; and a key cannot be read without materializing the whole document,
  which forfeits the SQL projection.
- **A dirty bit derived from timestamp equality.** Elegant, and it silently loses
  a same-millisecond rewrite.
- **Range-based set reconciliation now, for symmetry.** It would delete the cursor
  and make the authority just another peer. Refused for v1: an always-online
  authority at a known origin needs no NAT traversal, so the symmetry buys
  nothing until the hub is removed, and a hash tree maintained incrementally on
  both sides is a project rather than a column.
