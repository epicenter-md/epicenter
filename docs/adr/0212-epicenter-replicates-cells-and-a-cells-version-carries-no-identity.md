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
  Also [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md)
  (`Proposed`), whose write-once slot (`digest A + B -> refuse or park B`, and
  "no replacement-in-place... or blob garbage collector") is contradicted
  outright: a blob digest becomes an ordinary cell that a later write repoints.
- **Amends:** [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md)
  at conflict resolution and at the outbox, not at its product posture. Withdrawn:
  server acceptance order as the conflict rule, the refusal to store a device
  timestamp or a per-key clock (this record stores a wall clock and a counter on
  every cell), and the durable outbox its crash-recovery paragraph depends on.
  What survives, and is restated here, is that no background conflict inbox
  exists and no losing value is retained.
  Also [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
  at the unit of convergence. That record makes one scalar address the unit,
  "either a row addressed by `(namespace key, table key, row ID)` or a value"
  (`:35-36`); the unit becomes a cell. Its refusal of distributed transactions is
  the reason this record can refuse cross-cell invariants, and survives intact.
  Also [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)
  at its storage inventory: "pending intents" (`:24`) and "accepted nullable blob
  digests" (`:27`) are both withdrawn. Its division of labour, SQLite for
  convergent facts and raw files for blob bytes, is untouched.
  Also [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
  at its mechanism, not its law. Every durable write still leaves the authority
  owed something. What changes is that the obligation is no longer a separate
  record: a cell the authority has not confirmed *is* the obligation. Its blob
  plane, its terminal-issue mechanism, and its park state are withdrawn.
  Also [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)
  at both of its halves. Withdrawn: the publication obligation's revision counter,
  replaced by the unsent bytes themselves, and the bounded live chain (`:63-69`, a
  compact baseline plus a short ordered tail), replaced by one merged
  `doc_state`. Its nullable compact projection survives.
  Also [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)
  (`Accepted`) and, by the contract it names,
  [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md).
  Withdrawn: that `createSqliteDocumentLog` and its append log are "the only
  durable document representation" (`0159:27-29`). A body is one merged state plus
  two delivery slots, so append admission and compaction stop being concepts. The
  Yjs 14 major and the V2 encoding both survive, and are relied on.
  Also [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md)
  at the hole it named and accepted (`:262-265`, "a table's prose is either in a
  field or unreachable from the folder"). A body becomes a Yjs plane, so folder
  round-trip and character merge stop being exclusive. This makes a
  markdown-to-`Y.Text` minimal diff a prerequisite: `apps/epicenter/src/folder/parse.ts:96-101`
  assigns the body into a plain fields object today, which is correct for an LWW
  scalar and would destroy CRDT history once there is any.
  Also [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md)
  (`Accepted`) at its presence law and its relations. Withdrawn: "`presence` is
  two-valued and has one law: `absent` is a terminal tombstone" (`:51-52`), which
  is what makes an address single-use and what collides with this record's own
  reason for existing; and `_replica_row_facts` and `_replica_row_outbox`, which
  become one cell relation with no queue. What survives, and is the premise this
  record argues from throughout, is that a row's id comes from whoever knows it
  and one relation holds every fact.
- **Relates:** [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md),
  which already decides that a restore creates a fresh authority lifetime. This
  record borrows that noun rather than minting a second one, makes it observable
  by returning it on every response, and adds one behaviour that record does not
  decide: the authority re-mints its lifetime when a replica presents a cursor
  past its own counter, which is a corrupt-client guard rather than a detector.
  The two questions are separate. The lifetime answers "am I talking to the same
  authority"; the digest answers "do we hold the same thing".
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
with a second merge rule. Giving row death its own absorbing algebra costs a
relation, an algebra, and a join, and makes an address single-use for the lifetime
of the Epicenter, which contradicts what ADR-0206 exists to allow.

There is one wire format, and it carries cells. Keeping whole-row JSON as a second
format for the initial seed was considered on a size argument and refused: the 473
bytes it compares against carry no per-field version, and this schema's version
columns are `NOT NULL`. Against a whole-row encoding that does carry them, a seed
is 34% smaller rather than 70%, which does not buy a second format the protocol
would have to specify, version, and keep converging with the first.

### The layout

```sql
CREATE TABLE _replica_metadata (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	format_version INTEGER NOT NULL,
	attached_deployment TEXT,
	attached_principal TEXT,

	authority_lifetime TEXT,
	last_applied_cursor INTEGER NOT NULL CHECK (last_applied_cursor >= 0),

	repair_from TEXT,
	repair_epoch INTEGER NOT NULL DEFAULT 0 CHECK (repair_epoch >= 0),
	digest_format INTEGER NOT NULL,

	CHECK ((attached_deployment IS NULL) = (attached_principal IS NULL))
) STRICT;

CREATE TABLE _replica_cell (
	namespace TEXT NOT NULL,
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL CHECK (
		length(row_id) BETWEEN 1 AND 128 AND
		row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
		row_id GLOB '[A-Za-z0-9]*'
	),
	column_name TEXT NOT NULL CHECK (
		column_name = '!presence' OR column_name GLOB '[A-Za-z]*'
	),

	value TEXT,

	version_ms INTEGER NOT NULL CHECK (version_ms > 0),
	version_seq INTEGER NOT NULL CHECK (version_seq >= 0),
	version_hash BLOB NOT NULL CHECK (length(version_hash) = 8),

	dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),

	CHECK (
		column_name <> '!presence' OR
		(value IS NOT NULL AND value IN ('"present"', '"absent"'))
	),

	PRIMARY KEY (namespace, table_name, row_id, column_name)
) WITHOUT ROWID, STRICT;

CREATE TABLE _replica_body (
	namespace TEXT NOT NULL,
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL,
	generation_ms INTEGER NOT NULL,
	generation_seq INTEGER NOT NULL,
	doc_state BLOB NOT NULL,
	pending_update BLOB,
	inflight_update BLOB,
	send_token INTEGER NOT NULL DEFAULT 0 CHECK (send_token >= 0),
	CHECK ((inflight_update IS NULL) OR send_token > 0),
	PRIMARY KEY (namespace, table_name, row_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE _replica_digest (
	bucket INTEGER PRIMARY KEY CHECK (bucket BETWEEN 0 AND 4095),
	sum BLOB NOT NULL CHECK (length(sum) = 8)
) STRICT;

CREATE VIEW replica_cell AS
SELECT
	namespace,
	table_name,
	row_id,
	column_name,
	value,
	strftime('%Y-%m-%dT%H:%M:%fZ', version_ms / 1000.0, 'unixepoch') AS version_at,
	version_seq,
	lower(hex(version_hash)) AS version_hash,
	dirty
FROM _replica_cell;

CREATE TABLE _authority_metadata (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	format_version INTEGER NOT NULL,
	lifetime TEXT NOT NULL,
	next_cursor INTEGER NOT NULL CHECK (next_cursor >= 1),
	digest_format INTEGER NOT NULL
) STRICT;

CREATE TABLE _authority_cell (
	cursor INTEGER PRIMARY KEY,
	namespace TEXT NOT NULL,
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL CHECK (
		length(row_id) BETWEEN 1 AND 128 AND
		row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
		row_id GLOB '[A-Za-z0-9]*'
	),
	column_name TEXT NOT NULL CHECK (
		column_name = '!presence' OR column_name GLOB '[A-Za-z]*'
	),
	value TEXT,
	version_ms INTEGER NOT NULL CHECK (version_ms > 0),
	version_seq INTEGER NOT NULL CHECK (version_seq >= 0),
	version_hash BLOB NOT NULL CHECK (length(version_hash) = 8),
	CHECK (
		column_name <> '!presence' OR
		(value IS NOT NULL AND value IN ('"present"', '"absent"'))
	)
) STRICT;

CREATE UNIQUE INDEX _authority_cell_address
	ON _authority_cell(namespace, table_name, row_id, column_name);

CREATE TABLE _authority_body (
	namespace TEXT NOT NULL,
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL,
	generation_ms INTEGER NOT NULL,
	generation_seq INTEGER NOT NULL,
	doc_state BLOB NOT NULL,
	cursor INTEGER NOT NULL,
	PRIMARY KEY (namespace, table_name, row_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX _authority_body_cursor ON _authority_body(cursor);

CREATE TABLE _authority_digest (
	bucket INTEGER PRIMARY KEY CHECK (bucket BETWEEN 0 AND 4095),
	sum BLOB NOT NULL CHECK (length(sum) = 8)
) STRICT;
```

**The authority repeats every CHECK it can evaluate without parsing a value**,
which is all of them except one. A CHECK the replica holds and the authority does
not is a wedge: applying a page is one transaction, one unrepresentable cell
aborts the whole page, the cursor never advances, and the only way to change a
cell is to write a newer version of an address the replica cannot even express.
Measured: a single malformed value leaves a replica at cursor zero having applied
nothing, forever, and a page size of one just moves where it wedges.

**The projection must therefore guard `json(value)`.** Removing the CHECK moved
the wedge from the write path to the read path, where it is worse: one unreadable
value makes `json_group_object(column_name, json(value))` raise, and the rebuild
returns **zero rows rather than every good row plus one nonconforming one**.
Re-deriving that single row raises too, so no row-at-a-time rebuild escapes it.
The projection reads
`CASE WHEN json_valid(value) THEN json(value) ELSE json_quote(value) END`, which
restores every row for one `CASE`. "A nonconforming row at read time" is true of
the JavaScript traversal and was not true of the SQL projection.

**So the replica does not constrain `value` to valid JSON.** That is the one
CHECK the authority cannot mirror, because mirroring it means parsing a value it
is defined never to parse. A value this release's Lens cannot read is a
nonconforming row at read time, which the traversal already reports
(`Err(NonconformingRow)`), rather than a page that can never be applied.

**And the authority's `value` is TEXT, not BLOB.** It is still opaque, and it
still is never parsed. It is TEXT so that it round-trips into the replica's TEXT
column losslessly: under `STRICT` there is no lossless path from non-UTF-8 bytes,
and a lossy decode desynchronises a value from its own `version_hash`, which is
the one thing the merge trusts.

**`_replica_metadata` deliberately does not constrain the lifetime against the
cursor.** "Do I know which authority this is" and "have I applied anything" are
independent facts, and a CHECK tying them makes the reset state, a new lifetime at
cursor zero, unrepresentable.

`!presence` is the reserved column carrying liveness. A Lens column name must
start with a letter (`packages/lens/src/definitions.ts:410-411`), so no Lens can
name it, and `!` sorts before every letter, so a row's liveness is the first thing
an ordered scan of that row meets. The schema enforces both halves, so the
reservation is a constraint rather than a convention.

**A table's designated body field gets no cell.** It is an ordinary
`field.string()` by ADR-0207's definition, so the `column_name` CHECK would admit
it, and admitting it would give one value two homes and two merge rules. The body
lives only in `_replica_body`, and the projection restores it as a field on the
way out.

Each metadata singleton carries one more column than it looks like it needs. A
replica stores `authority_lifetime` beside `last_applied_cursor`, and an
authority mints a `lifetime` and re-mints it on restore, rebuild, or a cursor
regression; the reason is under "the authority
names its own lifetime" below.

### The version is `(version_ms, version_seq, version_hash)`

```txt
version_ms    Date.now() at the local write, never below what it overwrites
version_seq   0, or one past whichever cell supplied the floor below
version_hash  8 bytes of sha256 over the value's canonical JSON
```

Compare left to right. **The ordering never reads the value and never names an
actor.** The equal arm of the merge predicate compares the value for byte
equality, which is a test and not an ordering, and that difference is what lets
the authority keep values opaque.

`version_ms` is the version expressed as a time, chosen so a human can read it.
It is not a claim about when a person acted, and the authority verifies only that
it is not more than five minutes ahead of its own clock.

`version_seq` is local monotonicity done structurally. Inflating `version_ms`
instead would store its own drift.

A cleared cell hashes a marker that canonical JSON cannot produce, and not
`canonicalJson(null)`. They are different values, and sharing a hash is not a
2^-64 accident: two replicas at the same `(version_ms, version_seq)`, one clearing
a cell and one writing JSON `null`, would hold fully equal versions with unequal
values, refuse each other forever, and both read clean.

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

### The local write rule is derived from the row being written

```txt
version_ms  = max(Date.now(), current.version_ms, presence.version_ms)
version_seq = one past whichever of those two the floor came from, else 0
```

Both components come from the row being written, and cost one row-local aggregate
read per write. That read is not cheap: measured as an interleaved A and B in one
database, it takes the median local write from 10.5 to 16.8 microseconds at 200k
rows of 12 columns, Measured against a control arm of two
identical passes, with WAL checkpointing moved outside the timed region, it costs
**+30% to +37%**. Two earlier figures for this, "about 10%" and "at least double",
were both artifacts: the first compared two different processes on two different
schemas, and the second had no control arm, so a 3.6x drift within one arm was
read as mechanism. It is the price of a write the user just made never being refused by R1,
and both components survive a crash. **A replica-global counter does not.** A
process restart inside one millisecond reissues `version_seq = 0`, so a rewrite
and the value it replaces carry the same `(ms, seq)`, the tie falls to the hash,
and the hash knows nothing about which write came second: the later write is silently discarded on a
**coin flip**, which is what the mechanism predicts exactly and what 20,000 trials
measure.

**The presence cell has to be in the floor, not just the cell.** A column that has
never been set has no `current`, but R1 measures every write against the row's
presence cell, and that may be minutes ahead because the ingest clamp admits a
clock that far out. Deriving the floor from the cell alone means a user typing
into a never-set field on a replica with a correct clock has the write silently
refused by R1, with no error and nothing dirty to retry, for the whole width of
the clamp. Measured: refused at the moment of writing, again a second later, again
a minute later, and stored only after 241 seconds.

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
bytes would also close it, and on the decided schema measures **+19.4 MB (+10.7%)
and +29.5 MB (+8.6%)**, so the guard is taken and the wider hash refused.

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
get(id): Promise<Result<Row | undefined, ReadError>>;
patch(id, changes): Promise<Result<Row | undefined, ReadError>>;
delete(id): Promise<boolean>;
```

This is `packages/data/src/epicenter.ts:69-79` unchanged. A body is reached
through the row document handle ADR-0135 already defines, not through this
surface, which is what keeps a value you `patch` and a document you open from
looking like the same kind of thing. The exploration memo
proposed renaming `patch` to `set` and declaring that "create is not a verb"; both
are withdrawn. `create` has to be a verb, because it is the only call that writes
the presence cell and therefore the only one that can reuse an address, and it is
already the one moment the type system can demand a complete row. `patch` is
already partial by nature, which is exactly what a per-cell write is.

`create`'s two doors are ADR-0206 implemented literally: `suppliedId ?? mintRowId()`
at `epicenter.ts:468`. Both doors return the row, so a caller never has to thread
an id it did not choose.

**`create` with a supplied id is a whole-row assertion, and it discards.** R2
drops every cell older than the presence cell it writes, so it means "this row
exists and this is its complete state as of now", not "make sure this row exists".
That is what a mirror reconciler wants, and it is not what an accidental second
`create` wants: a device with stale local state that calls `create` on a row
another device has since edited erases those edits everywhere, silently, through a
call that returns success. `epicenter.ts:465-481` already refuses `create` on a
row it can see is live, and that guard reads local state only, so it catches the
common accident and not the offline one. A caller that has not seen the row's
current state should let the runtime mint the id, or read and `patch`.

A `json(inner)` field is **one cell**. Its value is the whole blob, so a write
replaces it whole and nothing merges inside it. That is the point rather than a
limitation: one cell is one merge unit, so values that must move together are
declared as one field and can never tear.

One sentence in that docblock (`epicenter.ts:66-67`) stops being true. It says `patch` "refuses an
address that holds no live fact, so an id you already deleted stays deleted rather
than being resurrected by a write." The refusal survives, and is R1's local
counterpart. The conclusion does not: a deleted id can be reused, by `create`,
which is the whole point of dropping absorbing death.

### Two merge algebras, deliberately not unified

| Plane | Rule |
| --- | --- |
| cell, including presence | higher `(version_ms, version_seq, version_hash)` wins, plus R1 and R2 above, which belong to the presence cell alone |
| body | `Y.mergeUpdatesV2` on raw bytes |

Row death is not a third: it is a cell.

A body is not last-write-wins, and the failure is not theoretical: two devices
editing a 40KB document offline would lose one entire document. Last-write-wins
is worst exactly where the payload is largest. The entry point is
`mergeUpdatesV2`, not `mergeUpdates`: the V1 function throws on the V2 bytes
everything else here uses.

### Ordering is a version. Delivery names what is owed.

A cell carries an explicit `dirty` flag, **with no index**. A partial index on
`dirty = 1` over a `WITHOUT ROWID` table carries the entire primary key per
entry, which is the same cost this record refuses a replica-side cursor for: it
measured on the decided schema at **+81 MB and +126 MB** with local work standing.
The scan it replaces costs **about 50 ms and 120 ms** when nothing is owed, which is the
common case, and in the state where the index actually costs those megabytes it
saves 26 ms and 38 ms, or about 7%, because both sides then have to return every
cell.

Encoding delivery as timestamp equality was tried and fails: write at T, confirm
at T, write a new value at T again, and a derived `confirmed = written` flag reads
clean, so the second write never syncs and never appears pending.

**A body carries two slots, not one.** Local edits accumulate in
`pending_update`; sending *merges* pending into `inflight_update` and clears
pending; an acknowledgement naming the current `send_token` clears
`inflight_update`. One slot loses every edit made during the round trip,
permanently and undetectably, because the acknowledgement clears bytes the
authority never received and a body has no version that could later notice. The
cell plane survives the identical interleaving, because merging its answer is what
clears its flag. A body cannot have that, which is exactly why it needs the second
slot.

Three details are load-bearing, and each was a live defect written the obvious
way. The move **merges** rather than assigns, or an overlapping round clobbers
bytes a live send is still carrying. An acknowledgement **names the incarnation and the token**, or a
late reply to a superseded send empties both slots and loses everything typed
since. The incarnation is not decoration: a new generation replaces the body row
and restarts the counter, so a token alone is ambiguous across a re-creation and a
stranded reply from the previous life can match the current one. And opening the store **merges inflight back into pending
unconditionally**, which is safe by idempotence and is the only thing that
recovers a crash between the committed move and the request leaving the socket.

**A body response is a merge input, exactly as a cell response is.** It returns
the generation and the state the authority holds. An acknowledgement clears
`inflight_update` only when the returned generation matches; a newer returned
generation resets the body and both slots. Without this the body plane has a
refusal, for an update naming an older generation, and no channel to report it:
either the acknowledgement fires anyway and clears bytes the authority rejected,
or it does not and the replica retries forever.

**A body belongs to an incarnation.** It carries the `(version_ms, version_seq)`
of the presence cell that created its row, and nothing else. A body update naming an older
generation is refused, and one naming a **newer** generation replaces `doc_state`
rather than merging into it: `mergeUpdatesV2` across generations is what would
splice the deleted incarnation's prose into the live row. **opening a body whose generation is not the row's
current presence version replaces it** with an empty document at the current
generation and both slots cleared; and **the projection renders such a body as
empty** until that happens. The write door is not optional, and the projection gate is not redundant beside
it. The write door handles the body a replica already holds when the re-creation
arrives, and R2's drop below handles the same case transactionally. The
projection gate handles the one neither can: a body update that arrives *after*
the re-creation naming the dead generation, which is refused but which a replica
that already merged the old body would otherwise still render. That
replacement is a cross-plane write, so R1 and R2 are not the only ones; the
alternative is losing every edit made to a re-created row.

**R2's drop extends to the body.** A presence write that drops a row's older cells
drops its body row in the same transaction. Without that, nothing in the design
ever deletes a body: `delete(id)` writes a presence cell, and a deleted row leaves
its full prose on every replica and on the authority forever, which the repair
pass then re-uploads rather than collects. The gate has to
live in the projection rather than in the body merge: a re-creation that nobody
types into produces no body update at all, so a rule attached to body ingest never
fires, and a replica that held the previous incarnation renders its prose in the
new row while a replica that joined later renders nothing. That is divergence and
a content leak at once. **The presence cell is the only cell with authority over other cells**, and it has
four effects: R1 refuses an older cell, R2 drops older cells, R2 drops an older
body, and the write door replaces one. Nothing else in the design reaches across
an address or a plane. Without this the body plane does not converge: a late update from a replica
that never saw the delete produces `"the old note -- B typed this"` in two
orderings and an empty body in two others. The alternative, never deleting a body,
does converge and silently leaves the deleted incarnation's prose in the new row
forever, because a CRDT has no truncate and no operation could ever remove it.

A body still gets no *version*. A cell's version resolves conflicts, a body's
marker tracks delivery, and a generation names which row it belongs to; giving a
body a version would advertise a merge policy it does not have.

**A replica never stores a claim that decides what to push.** It does store one
`last_applied_cursor`, which decides what to *ask for* and is self-correcting: an
understated cursor re-reads, and an overstated one is caught by the authority
lifetime beside it. The dangerous class is the other one. Storing the authority's
last-known Yjs state vector was tried and refused: an overstated
vector produces a causally gapped update the authority accepts and buffers while
its text never advances, and the quiet variant is a 13-byte no-op that "succeeds"
and confirms state the authority does not hold. A marker that decides *what* to
push fails silently and self-perpetuates. The unsent bytes claim only what the
replica can actually know. An earlier exploration measured the accumulated tail
smaller than the vector diff (253B against 605B); that comparison is not
reproduced by this record's harness, and the refusal rests on the silent-failure
argument above rather than on the byte count.

### The push response is a merge input, including its refusals

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
with them, **at `(authority time, rank)`, where rank is each cell's position in
the row's own `(version_ms, version_seq)` ascending order, in one transaction**,
exempt from the write floor above. Rank rather than the
original counter: the re-stamp collapses a *range* of `version_ms` onto one time,
and a `version_seq` was only ever meaningful inside its own millisecond, so
preserving it lets a cell written at a later millisecond land below one written
earlier and be eaten by R2. Rank rather than address order too, which is what puts
a `create`'s presence cell first. The body's generation is the presence cell's
version, so a re-stamp that lowers presence and leaves the body behind makes a row
stale against itself: the projection blanks it and the next open replaces it,
losing prose the user typed seconds earlier on the device that typed it. Re-stamping a
field cell alone would land it below its own row's presence cell, which is exactly
what R1 refuses, so the debt would never clear.

**A scheduled repair is durable, and it carries two facts.**
`_replica_metadata.repair_from` holds the address a running pass has reached;
`repair_epoch` records that an obligation was raised, and a pass clears the
obligation only if the epoch it began at is still current. One column cannot do
both: a pass already in flight overwrites it continuously and clears it on
completion, so an obligation raised mid-pass is erased by the pass that was
already running, leaving a row present and empty with nothing dirty and nothing
owed.

A repair scheduled by a clamp re-stamp is **scoped to the row it names**, and only
a presence-cell re-stamp rewinds `last_applied_cursor`. Unscoped, a device with a
clock permanently outside the clamp turns every local write into a full-store
re-read and re-push: measured, 200 ordinary writes produce 200 full rewinds and
never settle, because the next write re-derives its version from the same fast
clock.

**A clamp refusal on a presence cell also schedules a repair for that row.**
Lowering a presence cell is the one operation in the design that moves a version
down, and it retroactively un-refuses every pull R1 rejected while the cell was
high. Those pulls stored nothing and consumed their cursors, and a cell the
authority already holds at that exact version takes no new cursor, so nothing
redelivers them. The design already owns the machine that fixes this; it just has
to call it. This is not a durable claim about
another party's state: it is a one-shot repair carried by the response, and the
skewed version never propagated because the authority never accepted it.

An **R1** refusal must not be answered that way. R1 fires at the authority as well
as the replica, and re-stamping there would promote a previous incarnation's value
over the re-creation's own snapshot, which is exactly what R2 exists to prevent.
Measured: an offline edit at version 1500, a delete at 2000, a re-creation at
2100, and a re-stamp at the authority's clock leaves the row holding the offline
edit. So an R1 refusal is answered with **the presence cell**. The replica merges
it like any other cell, R2 then drops the refused write, and the debt clears
because the obligation was discharged rather than deferred.

### The authority is a store, ordered by cursor, and names its own lifetime

Its only two access patterns are point lookup by address, to merge, and range
scan by cursor, to serve deltas. Since ordering never reads a value, it stores
values as **opaque bytes** it never parses. **The body plane is the one
exception**: merging a body means running Yjs, so the authority interprets there
and the dependency is real, including for any future non-JavaScript authority.

**The cursor is the rowid**, and the address is a unique index. The alternative,
an address primary key with a secondary cursor index, is slower on the authority's
only range question, and the gap widens with the fixture: 2.4x when cursors happen
to be assigned in address order, and 6.8x once they are assigned in arrival order,
which is what a cursor means. Returning rows rather than counting them, at that
same arrival-ordered fixture, it is 1894 ms against 282 ms. It is disk-neutral. On
merge the chosen shape pays 1.3x at the arrival-ordered fixture and 1.9x at the
address-ordered one, because moving a row to take a new cursor is real work. It is
paid once per changed cell rather than once per served page, and it is the trade
this record takes deliberately rather than a wash.

A new cursor is assigned only on a **strict** version increase, never on the
equal case. Otherwise a retried byte-identical push takes fresh cursors for
everything it re-sent and redelivers the entire dataset to every other replica.

The authority keeps current state only, with no history, so an arbitrarily stale
cursor still works and bootstrap is just "everything since cursor zero".
**A replica never stores a per-cell cursor**, because it would be a durable local
claim about the authority's state. Measured as a clean A and B on this schema, the
column costs **+9.8 MB (5.4%) and +18.9 MB (5.5%)**; an index on it, which nothing
in this design would query, costs **91 MB and 140 MB**.

**The authority names its own lifetime, and returns it with every response.**
This is ADR-0170's noun, not a second one: that record already decides that a
restore creates a fresh authority lifetime. What is added here is that the
lifetime becomes observable, because a replica cannot otherwise tell that it is
talking to a different one. A cursor is meaningless across a restore. Replace the authority's
file from an older snapshot and its counter comes back lower than watermarks
already held: measured over 50 rounds with 50 real post-restore writes, a replica
receives **0 cells** and disagrees on 300 of 300, pushing nothing because nothing
is dirty. **Detection is a digest, not a cursor.** Three successive attempts to derive a
divergence signal from the cursor each failed, in a different place, and the
pattern is the finding: a cursor is a *delivery* mechanism, and the question "do
the two sides actually hold the same thing" is not answerable from a delivery
counter in any of its forms. The last attempt is the clearest. A restore destroys
what a replica *wrote*, and the cursor a replica can vouch for is what it *read*;
clearing `dirty` by merging a push answer is a separate commit from advancing the
read cursor, so a replica can push forty cells, have them accepted, and still
present a cursor that predates them. Measured, with no clock skew and no
concurrency: the authority never re-mints, forty cells survive on exactly one
device with nothing dirty, both sides report the same lifetime and a consistent
cursor, and a new device bootstraps to a truncated store.

So the multiset digest this record deferred is **adopted**. One table of 4096
buckets on each side, a modular 64-bit sum per bucket, maintained by an add and a
subtract per write. A cell's bucket is the first 12 bits of a hash of its
address, so buckets are stable and evenly filled. **A bucket is not an address
range**, so a mismatch is not localized into a resumable cursor: it schedules the
ordinary full-range pass, which already resumes by address, and the bucket set
only says that one is owed. Enumerating a single bucket would cost a full scan
plus a hash per cell, about 1.3 seconds at this record's own fixture, so the
descent is not worth its own chunking scheme.

**An entry hashes the address, the version, and the value.** Hashing only the
version would make the verifier trust `version_hash`, which is the pairing the
merge already trusts, so the one corruption this schema is shaped to prevent, a
value that no longer matches its own hash, would be invisible to both.

**A body has an entry too**, keyed on its address and generation and hashing
`doc_state`. Without one a body divergence is undetectable: the cell roots agree,
the cursor sees nothing, and a device that bootstraps afterwards gets an empty
document while another holds the prose. Measured over 4000 randomized traces,
three end at quiescence with divergent body text and identical cell roots; adding
the body entry takes that to zero for 48 extra repair passes out of 42,641.

**Both sides store a bucket sum as eight bytes, not as an integer.** A sum is
uniform over 2^64 and every SQLite driver in this family returns `INTEGER` as a
double unless a per-connection flag is set, so a sum read back is a different
number from the one written. That makes the stored sum a function of write order
rather than of the multiset, and two sides holding identical cells then compare
unequal. A per-connection flag is the weaker fix: one connection opened without it
corrupts the file.

**A drop subtracts.** R2's delete returns what it removed and subtracts each entry
in the same transaction, or the first deletion guarantees a permanent false
mismatch.

**A comparison has a precondition.** A replica compares roots only when it owes
nothing and has applied the page through `next_cursor`, and only against a root
the authority read in the same transaction as that page. Without it the comparison
is not wrong so much as useless: measured, a replica making one ordinary local
write per round schedules a full repair on 500 rounds out of 500.

**The bucket count and the entry encoding are a cross-release contract**, so both
metadata singletons carry a `digest_format` and it is compared before the roots.
A peer on another format is incomparable rather than divergent. Measured, a
release that changed the bucket count alone would report 496 buckets differing on
identical state, and the root itself survives the change. It costs 72 KB of disk per side, 144 KB for the pair, and **+52%** on a local
write
that already pays the row-local floor, measured on this schema with a control arm.
Implemented naively, with a second read to find the version it must subtract, it
is +64% to +73%; folding that lookup into the floor aggregate the write already
performs is what buys the cheaper number. Floor and digest together roughly double
a local write against a store that has neither. The deferral cost three rounds of
patches to a mechanism that could not carry the signal. The two premises the
deferral rested on are both falsified: the lifetime does not catch a restore, and
the cursor regression does not catch one either.

The lifetime stays, because it answers a different and cheaper question: am I
talking to the authority I was talking to before. It is re-minted on restore and
on rebuild, and **the re-mint is bounded**: a replica presenting a cursor beyond
the authority's counter plus one page is a corrupt client rather than a rewound
store, and is answered with a reset scoped to that client. Unbounded, one
unauthenticated request forces every replica to re-bootstrap, which at this record's own
fixture and its own 121 bytes per cell is about 945 MB across three devices, and
1.4 GB at the narrow shape.

**A lifetime alone cannot see the case it was added for.** It is a column of the
authority's own file, so restoring that file carries the old lifetime back with
it, and measured with the column in place the replica still receives 0 cells over
50 rounds and disagrees on 100 of 350 addresses. What survives of that attempt is a guard, not a detector. A replica presenting a
cursor past the authority's own counter holds something the authority cannot
explain, so the authority **re-mints and persists its lifetime in the same
transaction that reads the response**, and only within one page of its counter; a
wilder cursor is a corrupt client and gets a reset scoped to itself. Atomicity is
not decoration: two concurrent requests otherwise mint two lifetimes and keep the
loser's, or answer from a pre-mint snapshot and tell a replica not to reset. A
replica resets when the lifetime it holds is not the one it is shown.

That guard detects nothing on its own, because it expires: it holds only until the
authority has re-issued as many cursors as a restore rewound, and the first
replica's repair pass is what re-issues them. Detection is the digest.

A reset schedules the **bidirectional repair pass**, not a plain pull. Resetting
and re-reading repairs the read direction only: measured, a replica that resets
pulls all 300 cells and still disagrees on the 50 the restore destroyed, because
those sit clean on the replica, which considers nothing owed and pushes nothing.

### Repair is bidirectional

Merge is idempotent, so re-sending anything is safe and asking from cursor zero
always converges. That repairs the replica and **not the authority**: every
pulled cell has `dirty = 0`, so a replica whose authority has lost cells
considers nothing owed and re-uploads nothing, while every byte sits on a live
replica. A repair pass therefore pushes every cell, ignoring `dirty`, which is
sound precisely because merge is idempotent and affordable precisely because the
equal case takes no cursor.

**It pushes every body too.** A settled body holds nothing in either delivery
slot, so a pass that reads only what is owed carries nothing for it, and an
authority whose body is behind can never be detected or repaired. That is the
failure the pass exists for, on the plane whose payload is largest, which is this
record's own argument for making a body Yjs at all. So a repair sends each body's
whole `doc_state`, which Yjs makes idempotent. **It is chunked by address range**, resuming from the
last address it confirmed. Deleting `sealBatch` deleted the only bound on upload
size in the system, and an unbounded pass at 200k rows of 12 columns is 2.6M
cells, and by this record's own wire encoding roughly 315 MB in one request.

ADR-0142's separate bootstrap, history-gap, and lineage-mismatch recoveries are
unnecessary as separate mechanisms. The lineage question survives, as the authority lifetime above.

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
  construction. The verifier half of that now exists: the digest is
  a range reconciliation primitive and both sides maintain one. What is unbuilt is
  the courier, because a cursor is server-assigned and has no meaning between
  peers. The seam that keeps it cheap later is one rule: **a
  per-cell cursor never appears in a replica.** A replica does hold one
  `last_applied_cursor`, which is a single scalar to discard rather than an index
  to unwind.
- **A conflict is never shown to a person, and no surface claims to be
  "synced".** Both are refusals: retaining losers requires a different CRDT, and
  a sync assertion cannot be verified without a round trip, so a stale
  affirmation is worse than none.
- **The silent-loss window is the ingest clamp forwards, and unbounded
  backwards.** A device whose clock is four minutes fast, which the clamp admits,
  wins against an edit made three real minutes later, and nothing tells anyone.
  Backwards there is no bound at all: the clamp only refuses a clock that is
  ahead, so a replica with a dead clock writes into the past, loses to a
  months-old value, and is never refused, never re-stamped, and never repaired.
  The response carries the authority's time on every round rather than only on a
  refusal, which is the one place a replica can notice its own backward skew. "At an exact
  millisecond tie the winner is arbitrary" understated this by the width of the
  clamp. Relatedly, the local write rule raises a cell's `version_ms` to meet a
  skewed version it merged, so a correct clock inherits that floor for that cell:
  the scheme is `max(observed)` bounded per cell rather than globally, and that is
  not the absence of propagation.
- **The store costs 2.12x today's whole-row JSON on disk** (181.0 MB against
  85.3 MB; 342.4 MB against 206.2 MB, or 1.66x), and 3.69x its own payload,
  falling to 2.48x at 1M rows of 3 columns, so the multiplier is a function of row
  width and a single figure for it is not meaningful.
- **Per-field versioning is not free, and this shape is not the cheapest way to
  buy it.** Three points on one fixture, one run, all VACUUMed (196k live rows of
  12 columns; 980k of 3 in brackets):

  | shape | disk | what it can do |
  | --- | --- | --- |
  | whole-row JSON, what ships today | 85.3 MB (206.2) | no per-field version at all |
  | one record per row plus a packed version map | 127.9 MB (274.1) | per-field merge, versions opaque |
  | this cell store, cells only | 181.0 MB (342.4) | per-field merge, every version legible |
  | this cell store, with the body plane | 182.3 MB (349.4) | the shape as decided |

  So per-field versioning costs **+50% and +33%** over what ships, and this shape
  costs **a further +41% and +25%** over the cheapest way to have it. An earlier
  draft quoted +39% and +53% by pairing a 196k-live figure for this store against
  an all-live figure for the opponent.

  The fourth row is the honest total, and no earlier figure in this record
  contained it: every storage number here was taken with `_replica_body` empty,
  while the opponent carries its prose inline as an ordinary column. At an
  80-character body it adds 0.7% and 2.0%, taking the headline ratio to 2.14x and
  1.69x. It is untested at the 40KB document this record uses to justify the plane
  existing, and `_replica_body` spends 141.9 MB to hold 102.7 MB of state at the
  wide fixture, 38% overhead from repeating a three-part text key. An earlier
  draft claimed the cell store was 7.8% *smaller* than the versioned opponent;
  that held only because the opponent it measured stored each version as base64
  inside JSON text, roughly 40 bytes per field for what this schema holds in 18
  binary bytes. Packed fairly, the opponent wins on disk.

  The +39% buys two things and they are the two the record is built on. Every
  version is a legible column rather than a byte range inside a blob, which is the
  replica's stated first duty. And the merge is one SQL predicate over columns
  rather than a decode, compare, and re-encode of a map, which is what lets the
  same comparison run on both sides. It also keeps a one-field change at 121 bytes
  on the wire rather than the whole record and its whole map.
- **Interning the address would recover at most 34%**, before adding back
  dictionary tables and integer keys, and is refused: the replica's first duty is
  to be readable in a SQL console, and an interned file needs three dictionary
  joins before it says anything.
- **Legibility is bought with views, not with columns.** Storing the version as
  ISO-8601 text and the hash as hex is genuinely readable and orders identically,
  and it measured **+65 MB (+36%) and +101 MB (+29%)** at the two shapes. A view
  rendering `version_ms` as a timestamp and `version_hash` as hex costs nothing
  and reads better than either, so the stored columns stay compact.
- **Re-deriving one changed row costs 1.69x and 1.21x** what whole-row JSON
  costs (6.9 against 4.09 microseconds, 4.79 against 3.95). That is the operation
  that runs in steady state, because a write touches one row, and the margin
  there is small.
- **Rebuilding the WHOLE projection costs about 0.57 s at 2.6M cells and 1.1 s at
  4M**, warm. Against whole-row JSON, measured in one run so the ratio is
  self-consistent, it is 16.8x and 8.6x. Both figures carry two significant
  figures at most: the same query on the same schema has been recorded between
  555 ms and 594 ms across runs, and every one of them discards the first pass, so
  a genuinely cold rebuild is not what was measured. That is a cold start, a
  repair, or a re-import, and it is the price of the layout rather than a
  steady-state cost.
- **Collapsing presence into the cell relation buys almost no time, and that is
  worth stating plainly.** An earlier draft claimed 2.1x and 1.8x. That was an
  artifact of a badly written opponent: joining `_replica_row` before grouping
  forces a temp b-tree over every cell. Written the obvious way instead, grouping
  first and joining liveness once per row, two relations project in 582 ms and
  1400 ms against one relation's 568 ms and 1104 ms. At the wide shape that gap is
  inside the 7% run-to-run band and is **no measurable difference**; at the narrow
  shape it is **1.27x**, for
  1.5% and 4.1% more disk. The collapse is justified by interpretability and by
  being one relation with one algebra rather than two, and it is **separable from
  the correctness fix**: dropping absorbing death is what makes an address
  reusable, and R1 and R2 work equally well with presence in its own relation.
- **The projections of every cell-store shape agree on row count and total
  projected length**, which is what the fingerprint checks and is weaker than
  identity. The whole-row JSON baseline is **not** comparable cell for cell
  and was never verified to be: its fixture desynchronises from the others at the
  first dead row, because `cellValue` draws a variable number of random values per
  column. The distributions match, so the storage and timing comparisons against
  it are unbiased, but they are distributional rather than exact.
- **Detection costs two relations and half again on every local write.** The
  digest is 4096 buckets a side, 72 KB of disk each, and an add and a subtract per
  write, measured at +52% on a write that already pays the row-local floor. With
  the floor, a local write costs about double what it would in a store that had
  neither. It is the one mechanism here that exists to answer a question rather than
  to carry data, and the record spent three rounds discovering that no cheaper
  proxy answers it.
- **Counters are refused.** "Add one" is not expressible; two devices each adding
  one yields one. None exist today, and one would need its own CRDT regardless.
- **Every value must round-trip canonical JSON byte-identically.** This is newly
  load-bearing: because ordering no longer reads the value, a lossy round trip
  is invisible. Two findings, and neither is the one previously stated.
  Canonical JSON round-trips every integer byte-identically, including above
  2^53, because the precision is already gone before storage sees it: a caller
  writing 2^53 + 1 hands over 2^53, and half of the first thousand integers above
  2^53 cannot be held at all. That is a write-door bound on `field.integer`
  (`builders.ts:141` declares no maximum), not a storage bound. The one genuinely
  lossy round trip is negative zero, which is a legal finite number that canonical
  JSON writes as `0` and nothing refuses.
- **The rule that a table must declare at least one required field is retired.**
  It was carried in on two justifications and neither survives. "A row with zero
  cells has nothing to push and strands on its creator" fails because a row always
  carries its presence cell. "An empty record is indistinguishable from a row
  whose every optional field was cleared" fails because a cleared cell is a value:
  it projects an explicit null where a never-set field projects nothing, and
  preserving that distinction is one of the things this model buys. A table with
  only optional fields is now representable, and a row of it projects as an empty
  record, which is what it is.
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
  reappears through a different door. A digest bucket and the merge it describes
  are one transaction, or the digest becomes the thing this record refuses
  elsewhere: a durable marker that decides what to send, wrong in a way that
  perpetuates itself.
- **The replaced path is close to untested**, so the migration's convergence
  check cannot be a regression test against what exists. It has to be a new
  differential test, written first.

## Considered alternatives

Measured costs below are at 196k live rows of 12 columns, which is the fixture
every storage comparison was built on, with 980k of 3 in brackets where it moves a
conclusion. Timings taken on the settled schema use a 200k all-live fixture and
are marked. The full table,
including what each refusal costs, is in
[the memo](../../specs/20260805T190000-replicated-cell-store-memo.md), which is
scheduled for deletion on acceptance; the git ref is `e77191a274`.

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
  wide margin, 3.81x and 2.33x smaller fixture-matched (47.5 MB against 181.0,
  147.1 against 342.4), though that shape stores no version, no `dirty`, and no
  presence, so it is a projection rather than a replica and the ratio is a floor. Refused on correctness, not on
  performance: ADR-0125 requires a release to preserve values it does not
  understand, and a typed column has nowhere to put an unknown key. The escapes
  are an `_extra` JSON column with its own embedded versions, which rebuilds the
  blob it refused with two merge paths, or losing data whenever two releases
  disagree.
- **One JSON record per row with a parallel version map.** **Cheaper on disk than
  this design**, by 29% and 20% once the map is packed rather than stored as
  base64 in JSON, and faster to seed. Refused because the map is opaque, so no
  version is legible and the merge cannot be one SQL predicate; because one field
  change ships the whole record and the whole map (8.9x at 12 columns and 3.0x at 3, like for like) and
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
- **An index on `dirty`.** In the common case, with nothing owed, it costs no
  extra disk and saves the whole scan. With every cell owed it costs +81 MB and
  +126 MB, 45% and 37% of the base file, and then saves 7.2% and 6.3% rather than
  the whole scan.
- **Readable version columns.** ISO-8601 and hex order identically to the compact
  encoding and cost 36% and 29% more disk. A view is free.
- **A 16-byte version hash.** Closes the exact-version oscillation for +19 MB and
  +30 MB. The value guard in the merge predicate closes it for nothing.
- **Range-based set reconciliation instead of a cursor.** It would delete the
  cursor and make the authority just another peer. Refused, and not on the
  symmetry argument previously given: symmetry was never the reason to want it.
  It is refused because it is a bad *delivery* mechanism: finding one changed
  cell costs a 32KB bucket exchange plus the address and version of every cell in the
  differing bucket, 623 and 962 at the two shapes, where a cursor costs the changed cell. The seam remains
  one rule, that a per-cell cursor never appears in a replica.
- **An incremental multiset digest, deferred.** Adopted instead, in the Decision
  above, after three successive attempts to derive detection from the cursor
  failed. The deferral rested on two premises and both are falsified: the store
  lifetime does not catch a restore, because it lives inside the file being
  restored, and neither does a cursor regression, because the cursor an authority
  is shown is what a replica read rather than what it wrote. The price paid is
  72 KB of disk per side and roughly a quarter added to a local write. The one
  implementation constraint that survives from the deferral: the sums must be
  folded in the application and not in SQL, because SQLite raises on 64-bit
  integer overflow, and an earlier attempt to keep a running sum in a column
  promoted it to REAL and silently destroyed the digest.
