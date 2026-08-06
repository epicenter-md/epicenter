# Architecture memo: a replicated cell store

- **Status:** In Progress
- **Date:** 2026-08-05
- **Settled as:** [ADR-0212](../docs/adr/0212-epicenter-replicates-cells-and-a-cells-version-carries-no-identity.md).
  This memo is the exploration behind that record and keeps the reversals and the
  Rejected table; the ADR is the decision, and carries the measurements that
  were taken after this memo settled. Delete this file once the ADR is
  Accepted and its schemas are built.

Evaluates replacing ordered-patch replication with a generic replicated cell
store. Verdict first: **take the radical model, with three amendments**, one of
which is a product win rather than a simplification. Details in section 10.

## 1. The current replication contract

**Correctness requirements** (what a user would notice if broken):

```txt
R1  A local write is durable before it is sent, and survives a crash as
    something still owed to the authority.
R2  A write is delivered exactly once in effect. A crash between "authority
    committed" and "client cleared its queue" must not double-apply.
R3  Two devices editing different fields of one row both survive.
R4  Row death is terminal. Nothing resurrects a deleted row.
R5  A replica converges to the same state as every other replica.
R6  A returning replica, however stale, receives everything it missed.
```

**Implementation artifacts** (choices, not requirements):

```txt
A1  A separate outbox relation holding ordered patch/delete intents
    (_replica_row_outbox, replica/schema.ts:65-80)
A2  A global authority sequence assigning total order
    (_authority_metadata.next_sequence, authority-schema.ts:34)
A3  A (batch seq, sha256 digest) receipt handshake proving acceptance
    (replica.ts:638-651, authority.ts:284-303)
A4  batch-conflict recovery that mints a new replica id and re-enrolls
    (replica.ts:587-619)
A5  Whole-row JSON storage with one sequence per row (fields TEXT)
A6  One batch sealed per round, so N intents cost ceil(N/64) round trips
    (replica.ts:558-562 seals once per outer iteration, replica.ts:690-696
    re-loops while work remains; the 64 is admission.ts:9)
```

Every artifact exists to serve R1, R2 and R5 **given that the authority is the
sequencer**. That premise is the thing under review.

Two facts narrow the problem more than expected. The authority stores
**latest state per address**, upserting `authority_sequence` in place
(`authority.ts:137-153`), so there is no history log to fall off and R6 holds for
any cursor age. And R3 is already satisfied per field, inside `foldIntent`
(`fold.ts:56-74`), not by stored metadata.

## 2. Does the outbox compact? No, and nothing tests that it doesn't

`sealBatch` (`replica.ts:355-381`) reads `pendingIntents` in `local_sequence`
order and appends each intent whole. No grouping by address, no folding of
successive patches, no dropping a patch superseded by a later delete. The only
shrinking is byte truncation at `encodedBatchBytes` (`replica.ts:366-373`).

Ten edits to one field become ten outbox rows, ten wire intents, and ten burned
authority sequences.

**Test coverage of this path is effectively zero.** `sealBatch`,
`pendingIntents`, and `intentsPerBatch` have **no test references at all**. The
wire-shape tests each send exactly one intent (`bun.test.ts:76-90`,
`conformance.test.ts:34`). Worse, `authority.test.ts` opens with a docblock
claiming coverage of "single-receipt discipline, fixed-through paging, terminal
deletion cleanup, and storage wall rollback"; the file is 69 lines, contains one
test about schema format, and defines three helpers it never uses.

This cuts both ways and both matter. There is no regression net for a rewrite.
There is also almost no sunk cost.

**Compaction already works elsewhere in this repo.** Local Mail's intent store
compacts by primary key on purpose (`intent.ts:144-150`,
`ON CONFLICT(message_id, label_id) DO UPDATE SET want = excluded.want`), and says
why at `intent.ts:24-27`: "archive then unarchive then archive is one row rather
than three acts." It can do that because its verb is **idempotent assignment**.
That is exactly what an LWW cell is.

## 3. What actually requires ordered replay

One thing. It is real, and the proposed model handles it better.

**Create-then-delete inverts into a permanent live row.** `fold.ts:85-99` makes
`delete` a no-op at an address that does not exist yet. So the batch
`[patch(new row), delete(same row)]`:

```txt
in order      patch creates the row, delete tombstones it     -> row is gone
reordered     delete no-ops (nothing there), patch creates it -> row lives
```

The row the user deleted then exists **forever, on every device**, because
nothing later can remove it. This is reachable from the public API with no sync
in between: `epicenter.ts:482-487` lowers `create` to a patch, `epicenter.ts:543`
enqueues the delete. Tests pin both halves (`fold.test.ts:53`, `:93-98`) and
`exchange-model.test.ts:11` is an explicitly ordered two-step.

**Under clocked tombstones this hazard disappears rather than being preserved.**
`delete@T2` beats `create@T1` by clock comparison regardless of arrival order.
Today the outcome depends on arrival order because "does the row exist" is a
precondition rather than a comparison. So ordered replay is not protecting a
requirement the new model lacks; it is a weaker implementation of R4.

Everything else that looks order-dependent is not a requirement:

| Apparent dependency | Reality |
| --- | --- |
| `set` then `unset` within one patch (`fold.test.ts:114`) | intra-intent. A cell model cannot express "set and unset the same cell" at all. |
| Same field patched twice | last-applied wins. **No test asserts a final value from two same-field patches.** |
| Sequence assignment order (`authority.ts:270-273`) | changes delivery order of unrelated rows, not any final state |
| Local optimistic value must equal authority replay (`replica.ts:495-508`) | a **divergence risk that LWW removes**: local fold and remote merge become the same pure function |
| `batch-conflict` renumbering preserves order (`replica.ts:605-613`) | artifact of A4, which dies with the outbox |
| Collapsing per-address is unrepresentable | true today only because `verb CHECK IN ('patch','delete')` has no merged verb and `batchDigest` keys idempotency. Both are artifacts. |

**No read-then-write operation exists in `packages/`.** The only verbs are
`patch` and `delete`. Application-level read-modify-write exists
(`folders.svelte.ts:52-56` computing `sortOrder: rows.length`) but never
atomically, so nothing loses a guarantee it has today.

## 4. Is cell-level the right granularity?

Mostly yes. One value type is wrong for LWW, and it is the important one.

There are 13 field constructors (`packages/field/src/builders.ts:282-296`).
There is **no** `field.body`, `field.text`, `field.blob`, or `field.document`.

| Value type | Recommended merge kind | Why |
| --- | --- | --- |
| `string`, `url`, `date`, `instant`, `datetime`, `select`, `number`, `integer`, `boolean`, `reference` | **LWW cell** | small, atomic, cheap to lose one of |
| `json(inner)` | **LWW composite cell** | already the practice: `TranscriptionOutcome` is a discriminated union in one cell (`contract.ts:15-25`), `KeyBinding` is `{modifiers, keys}` in one |
| `multiSelect`, `tags` | **LWW cell for v1**, first OR-Set candidate | concurrent tag additions on two devices lose one side. Rare, and OR-Set needs per-element tombstones. Name it, do not build it. |
| the **body** field | **Yjs plane**, not a cell (Revision 2) | see below |
| row presence | **clocked row-level cell** | see section 7 |

**The body is the finding.** A body is not a type; it is a designation on the
table naming an ordinary `field.string()` (`definitions.ts:62`, `:227-240`,
validated to reject non-string kinds). So **long-form prose is an LWW scalar
today**, the one case where LWW is worst. ADR-0207 named that and shipped anyway:

> `:262-265` "**A table's prose is either in a field or unreachable from the
> folder.** That is a real hole, and it lands hardest on rich text editors."

Yjs row documents merge per character but `:155` says "**A row document is never
rendered and never written**" to the folder. So today you choose folder
round-trip **or** character merge, never both.

Making the body a Yjs **cell** gets both. That is a product improvement, not
cleanup, and it is the strongest single argument for this model.

Cost to scope honestly: writing markdown back into a `Y.Text` must be a minimal
diff, not a replace, or every folder edit destroys the CRDT history that made it
worth doing. `apps/epicenter/src/folder/parse.ts:96-101` assigns the body into a
plain fields object, which is correct for an LWW scalar and has no history to
destroy. This is a prerequisite the Yjs body creates, not a defect it inherits.

**Composite cells cost nothing.** No cross-field invariant exists anywhere in the
repo; grep for one returns only unrelated hits. So "values that must change
together are one composite cell" is already the practice.

`field.reference` appears in **no production lens** and can be deleted
independently of this work.

## 5. Version scheme: reject HLC and actor IDs

| Scheme | Verdict |
| --- | --- |
| **Server-assigned revisions** (today) | Perfect order, no clock trust. But the authority must exist and be single-writer for any write to be ordered, which is what forces the outbox, the receipt handshake, and fork recovery. Also forecloses device-to-device sync permanently. |
| **Lamport clocks** | Converges without clock trust, but values drift from wall time, so "last write wins" degrades to "the most active device wins." A device idle for a month with a high counter beats a fresh write. Worse UX than wall time. |
| **HLC + actor** | **Rejected.** Its guarantee is causal consistency, and this model refuses cross-cell invariants, so there is no causality to preserve. Worse, HLC takes `max(observed)`, so one device with a clock set to 2031 **propagates 2031 to every replica permanently**. HLC does not contain a bad clock; it spreads it. |
| **Version vectors / DVV** | Detects concurrency rather than resolving it. Worth it only if the product surfaces conflicts. It does not, and a vector needs pruning as devices come and go. |
| **Direct Yjs for scalars** | **Rejected on three independent grounds.** Verified upstream (yjs/yjs): a `Y.Map` key conflict is resolved by **highest random `clientID`**, with the Lamport clock only secondary, so the winner is unrelated to recency. `Y.Map` retains tombstone metadata forever (`gc:true` discards content, keeps a GC marker). And a key cannot be read from encoded update bytes without materializing the whole `Y.Doc`, which kills the SQL projection. Yjs is right for text and wrong for scalars. |

> **This section's recommendation was reversed twice on 2026-08-06 after
> adversarial testing. Revision 1 replaced it with `(wall_ms, counter, actor)`;
> Revision 2 dropped the actor again and restored this section's hash as the
> third component. Both are at the end of this memo. The reasoning below is kept
> because the reversals only make sense against it.**

**Recommended:** `version = (wallMillis, valueHash)`.

```txt
wallMillis   local monotonic guard:  wall = max(now, lastWritten + 1)
valueHash    sha256(canonicalJson(value)), compared lexicographically
```

Compare wall time, then hash. Total, deterministic, identical on every replica
and the server, and it needs **no actor identity at all**.

Why the hash beats a device id:

- Nothing to persist, corrupt, migrate, or rotate.
- Merge becomes a pure function of `(clock, value)`.
- Two devices writing the *same* value at the same millisecond hash the same,
  which is correct: they do not conflict.
- `canonicalJson` already exists (`packages/lens/src/canonical.ts:1-19`) and is
  already used for batch digests, so `{a:1,b:2}` and `{b:2,a:1}` already agree.

This matters because **the current `replicaId` is not stable**: fork recovery
overwrites it in place (`replica.ts:595-604`) and one `synchronize` call can burn
through **eight** identities. Any design that puts actor identity in the merge
contract inherits that hazard. The hash does not.

Two three-line guards replace the rest:

```txt
local monotonic   protects against NTP correcting backwards mid-session, which
                  would otherwise discard the user's own later edit
server clamp      reject a clock more than ~5 minutes ahead of server time.
                  Unlike HLC this CONTAINS a broken clock.
```

Accepted loss: at an exact millisecond tie the winner is arbitrary. A tie means
two edits inside one millisecond, where "arbitrary" is the only honest answer.

## 6. The download watermark claim: CONFIRMED

**An LWW clock cannot be a download cursor.** It is a logical *write* time, not
an *arrival* time.

```txt
T5    device A, offline, writes cell X with clock T5
T50   device C syncs fully, sets its watermark to T50
T100  device A reconnects and uploads X@T5
      C asks for "everything with clock > T50"
      X@T5 is never delivered. Silently. Forever.
```

**Minimal safe receipt cursor**  -  and most of it already exists:

```txt
1  The authority assigns a monotonic integer from one counter on every write
   that CHANGES stored state. This is _authority_metadata.next_sequence
   (authority-schema.ts:34), already assigned via upsert at
   authority.ts:137-153, already advanced only on `applied`
   (authority.ts:270-273).
2  Store it per CELL rather than per row, so `WHERE cursor > ?` returns changed
   cells. Today it is per row (authority_sequence).
3  Clients page on the cursor and never on the LWW clock. The two tokens have
   two jobs and must never be conflated.
4  A write that LOSES its LWW comparison changes nothing, so it takes no cursor
   and needs no delivery. This is both correct and the efficiency win.
```

No lower bound is needed. The authority holds latest-state-per-address, so an
arbitrarily old cursor still surfaces every changed cell (`authority.ts:94-97`).

## 7. Deletion

**Today:** a tombstone is one row carrying the full address with
`presence='absent'`, `fields IS NULL`, and a sequence, on both sides
(`replica/schema.ts:45-61`, `authority-schema.ts:52-68`). It is **never
removed**: no `DELETE FROM` targets either fact table, and there is no `VACUUM`,
retention window, expiry, or GC anywhere in `packages/data` or
`packages/server`. Tombstones are load-bearing, not garbage: `fold.ts:71-73`
needs one to refuse a later patch, and `epicenter.ts:489-500` reads a refused
patch as proof of one. They are deliberately visible in the raw view
(`inspection.ts:176`, tested at `inspection.test.ts:196`).

**So retention costs nothing new.** This model inherits an existing forever-cost
rather than adding one.

**Row presence must stay row-level.** Per-cell tombstones alone cannot express
"this row is gone" without allowing a concurrent cell write to leave a partial
row behind. So keep one presence cell per row, carrying an ordinary version.

> Revision 2 reverses the paragraph below. Terminal death is refused, and the
> presence cell's version orders incarnations instead.

**Keep terminal death.** Once absent, always absent, regardless of clocks. It
matches today (`fold.ts:33-40`), it is what `epicenter.ts:489-500` reads, and it
removes an entire question. The alternative, clock-comparing resurrection,
buys undelete and costs a new failure mode.

**Per-cell tombstones are still needed** for clearing an optional field. `unset`
becomes a cell whose value is absent, with a clock. This preserves a distinction
the current model loses: "the user cleared this" versus "it was never set."

**The batch receipt handshake is not needed.** State-based merge is idempotent,
so there is nothing to acknowledge for a scalar cell; that is what deletes A3.

> **Revision 2 qualifies this.** A body still needs an acknowledgement, and one
> that names a monotonic send token: without it a late reply to a superseded send
> empties both delivery slots and loses everything typed since.

**Garbage collection: none, and say so.** The premise below is refused in
Revision 2, since death is no longer terminal, but the conclusion survives for a
different reason: a cell at a dead address cannot be collected locally, because a
replica that collected it and one that did not would disagree if the address were
re-created at a version between the two. The original argument was that with
terminal death, a returning replica would resurrect anything collected. If tombstone growth ever matters,
the answer is a policy, not a mechanism: retain N days, and a device dark longer
re-bootstraps rather than merging. There is no staleness concept today at all;
`_authority_replicas` has four columns and no timestamp
(`authority-schema.ts:36-50`).

> **Revision 2 replaces this.** The delete-time cascade becomes a projection-time
> generation gate: a body whose generation is not the row's current presence
> version renders empty. A cascade cannot work once an address is reusable,
> because a re-creation nobody types into produces no body update to hang it on.

**Documents already cascade correctly and transactionally.** `storeFact` deletes the row's
document state in the same transaction as the row delete: `document_updates` and
`document_publication` on the replica (`replica.ts:248-260`), `document_updates`
and `document_versions` on the authority (`authority.ts:154-163`), with liveness gates
against late writes and a test at `documents.test.ts:233`. Preserve this exactly.

**Blobs do not cascade, and there is no linkage to hang one on.** No blob
relation exists in either schema. Whispering deletes online copy, then device
copy, then row, sequentially and non-transactionally, with a documented partial
prefix on failure (`recordings.ts:231-288`). This model neither fixes nor worsens
that; it should be named as out of scope.

## 8. What we deliberately lose

| Capability | Status |
| --- | --- |
| **Audit / history** | Already lost. The authority stores latest state per address, not a log. |
| **Undo** | Never existed through sync. Session undo is client state. |
| **Conflict UI** | Forgone. LWW resolves silently; surfacing conflicts needs version vectors. |
| **Operation intent** | Lost, partially recovered: per-cell tombstones preserve "cleared" versus "never set", which whole-row JSON currently loses. |
| **Counters** | Refused. Two devices each adding 1 yields 1. None exist today; one would need its own CRDT regardless. |
| **Atomic multi-row workflows** | Already refused (ADR-0164). |
| **Repo-specific: batch receipts** | The `(seq, digest)` handshake is proof your batch landed. Without it, "is my write synced" becomes a clock comparison. Fine, but the UI meaning of "synced" changes. |
| **Repo-specific: bounded upload chunks** | `sealBatch`'s byte truncation guarantees forward progress in bounded pieces. State-based upload needs its own chunking, and it is not free. |
| **Repo-specific: ordered create-then-delete** | Not lost. **Improved**, per section 3. |

## 9. The mutation API, designed from scratch

> **Revision 2 withdraws this section.** The API it proposes does not survive:
> `create` has to be a verb, and `patch` is already the right name for a partial
> per-cell write. The surface that ships is the one that already exists at
> `packages/data/src/epicenter.ts:69-80`. Kept because the reasoning about
> composite cells and named absence is still the reasoning that applies.

Not CRUD, not JSON Patch. One primitive, `set`, over cells; the merge kind is
visible at the call site because it is the thing that actually differs.

```ts
// One cell. LWW. This is the whole primitive.
await notes.set(noteId, { title: 'Weeknotes' });

// Several cells in one call. Sugar over N independent cell writes, and
// deliberately NOT atomic: there is no transaction to imply.
await notes.set(noteId, { title: 'Weeknotes', pinned: true });

// "Create" is not a verb. A row is where cells happen to exist.
const noteId = newRowId();
await notes.set(noteId, { title: 'Untitled' });

// Values that must move together are ONE cell, and the type says so.
await notes.set(noteId, { position: { x: 3, y: 7 } });

// Clearing a cell is a value, not a missing key. `undefined` cannot cross
// JSON, so absence is named.
await notes.clear(noteId, ['summary']);

// A body is not a value you set. It is a document you open.
await using body = await notes.body(noteId);
body.text.insert(0, 'Weeknotes for ');

// Death is terminal and row-level.
await notes.delete(noteId);
```

What is deliberately absent: `patch`, `update`, `create`, `transaction`,
`updateMany`, and any call whose shape implies two cells move atomically.

## 10. Recommendation

**Take the radical model, with three amendments.**

**Product contract:** *Every value you change is durable immediately, converges
on your other devices without asking, and the most recent edit to a field wins.*

> **Revision 1 reverses Amendment 1's mechanism and Revision 2 reverses
> Amendment 3's naming.** The outbox is still deleted, which is the part that
> holds. Pending-ness is NOT a derived query: a derived flag silently loses a
> same-millisecond rewrite, so a cell carries an explicit `dirty` column. The
> migration outline below also stages against a whole-row `fields TEXT` that the
> settled design refuses as a stored shape.

**Amendment 1 - there is no outbox.** The proposal says the outbox "compacts
pending scalar writes by cell." That keeps a relation the design deletes. If a
cell carries its own clock and its confirmed clock, pending-ness is a query:

```sql
WHERE local_clock > confirmed_clock
```

A view, not a second relation to keep consistent. This also kills
`replica.ts:375-376`, where one oversized intent **permanently wedges** the
outbox.

**Amendment 2  -  no HLC, no actor id.** `version = (wallMillis, valueHash)` plus
a local monotonic guard and a server clock clamp. Section 5.

> **Revision 2 corrects the noun.** A body becomes a Yjs *plane* in its own
> relation, carrying an incarnation and two delivery slots. It gets no cell:
> admitting one would give a single value two homes and two merge rules.

**Amendment 3  -  the body becomes a Yjs cell.** This closes the hole ADR-0207
named and accepted, and it is the reason to do this work now rather than later.
Section 4.

**Keep from the proposal:** the cell store keyed by
namespace/table/row/column; rows derived by grouping; per-cell merge kinds; a
server-assigned change cursor distinct from the conflict clock; full
reconciliation as a valid repair; clocked row tombstones; composite cells over
cross-cell invariants; counters refused until one exists. (Revision 2 reverses
"clocked row tombstones": presence became an ordinary cell.)

**Deletion prize:**

```txt
_replica_row_outbox and every path that maintains it
the (batch seq, digest) receipt handshake, both sides
batch-conflict recovery, replica id rotation, the 8-attempt loop
_authority_replicas (its only job is batch idempotency)
one-batch-per-round, so N pending writes stop costing ceil(N/64) round trips
per-intent wire traffic: ten edits to one cell become one cell
the local-vs-authority fold divergence risk (one pure function, two places)
ADR-0142's unbuilt recovery taxonomy
```

**User loss:** silent LWW resolution with no conflict surface; no counters; a
losing window as wide as the authority's ingest clamp rather than the single
millisecond stated here, which Revision 2 corrects; "synced" becomes a clock
comparison rather than a receipt.

**Also unlocked:** the authority stops being a sequencer, so two devices could
merge directly with no server. That is impossible today by construction.

**Migration outline:**

```txt
0  Fix docs first, cheaply: ADR-0142 is entirely unbuilt (captureRecovery,
   startFresh, recovery-required: zero hits) and its Consequences claims test
   coverage that does not exist. README lists it Accepted while Proposed
   ADR-0163 claims to supersede it. Resolve before designing against it.
1  Add `clocks TEXT` beside `fields TEXT` as a SIDECAR, never inline. This is
   forced, not preferred: project.ts:130 inserts positionally via SELECT * into
   a frozen column set, and inspection.test.ts:247-277 pins that objects
   project as JSON text. Inline breaks the raw view, the friendly views, and
   every <app>.sqlite3.
2  Write clocks on every local write. Nothing reads them yet.
3  Teach the authority to merge by clock, still accepting ordered intents.
   Verify convergence against the ordered path.
4  Move the cursor from per-row to per-cell.
5  Switch upload from intents to changed cells. Delete the outbox.
6  Delete the receipt handshake and fork recovery.
7  Bodies become Yjs cells. Needs the markdown-to-Y.Text minimal diff first.

There is no compatibility layer, because no user-visible need requires one:
nothing has shipped through this boundary and the format version is already a
hard refusal (replica.ts:752-768).
```

**One honest risk.** The path being replaced is close to untested: `sealBatch`,
`pendingIntents`, and `intentsPerBatch` have zero test references, and
`authority.test.ts` claims coverage in a docblock that its one test does not
provide. So step 3's convergence comparison is not a regression check against
existing tests. It has to be a new differential test, written first.

## Revision 1: the version scheme is `(wall_ms, counter, actor)`

> **Superseded by Revision 2 below on the actor.** Two further claims in this
> section are reversed elsewhere and marked where they appear: the single body
> delivery slot (see section 7 and the Rejected table), and the tail-versus-vector
> byte comparison below, which ADR-0212 withdraws because this harness does not
> reproduce it. The counter survives. Kept because Revision 2 only makes sense
> against it.

Section 5 recommended `(wallMillis, valueHash)` and rejected a hybrid logical
clock. **That was wrong.** Five parallel designs plus an adversarial pass
reversed it on evidence, and the reversal is recorded here rather than by editing
section 5, because the argument only makes sense against what it replaced.

**What broke it.** `(wall_ms, value)` needs five write-path rules to be correct,
three of which SQLite cannot enforce, and two of them interact into a permanent
wedge:

- A derived `pending` column silently loses a same-millisecond rewrite: write at
  T, confirm at T, write a new value at T again, and `written_at_ms` equals
  `confirmed_at_ms` so the cell reads clean and never syncs.
- The monotonic guard that fixes it (`written_at_ms = max(now, prev + 1)`) stores
  its drift, so 200,000 same-cell writes take 129 ms of real time and produce
  199,871 ms of drift. Once a stamp passes the authority's clamp the cell is
  unsyncable until wall time catches up, and the guard forbids the only repair.
  A clock set forward once and corrected, which a VM resume does routinely,
  strands cells for the length of the skew.
- Comparing `value` drags SQL's type order (`2 < '10'`) and UTF-8 versus UTF-16
  order into the merge, so a merge computed in SQL and one computed in JS pick
  opposite winners.

Under `(wall_ms, counter, actor)` three of the five rules cease to exist: the
counter is local monotonicity done structurally rather than by inflating a stored
clock, and the comparator never touches `value`, so type order, encoding order,
and NULL three-valued logic all stop mattering and the merge predicate can live
in the schema where it is enforceable. The cost is +19.4 bytes per cell, measured.

The earlier objections do not survive contact. The byte argument compared HLC
against a *stored* hash this memo never proposed storing. The actor-stability
objection cited `replicaId` rotating during fork recovery, a subsystem these
waves delete, and HLC needs uniqueness rather than stability. `max(observed)`
propagating a skewed clock is real, and the authority's ingest clamp bounds it to
minutes, which is strictly better than what `(wall_ms, value)` achieves, where
the monotonic guard makes local skew permanent.

**Ordering is a timestamp. Delivery names what is owed.** That is the sentence
the whole revision reduces to. `wall_ms` and `deleted_at_ms` survive because
they order things. `confirmed_at_ms` does not, because it encoded delivery as
timestamp equality and equality cannot tell "already sent" from "written again in
the same millisecond". Cells carry an explicit dirty flag; a body carries the
unsent bytes themselves in a `pending_update BLOB`, whose presence is the entire
marker.

A body gets no clock at all. A scalar's clock resolves conflicts; a body's marker
tracks delivery, and giving it a timestamp advertises a merge policy that does
not exist.

> **The byte comparison below is withdrawn.** ADR-0212 keeps this refusal on the
> silent-failure argument alone: the 253B and 605B figures are not reproduced by
> the harness that settles the record.

**A state vector was tried and refused.** Pushing
`encodeStateAsUpdateV2(doc, confirmedVector)` is 67x smaller than a full push,
but an accumulated local tail is smaller still (253 B versus 605 B), because the
vector diff echoes recently received remote bytes back at the authority. And an
overstated stored vector produces a causally gapped update the authority accepts
and buffers forever while its text never advances; the quiet variant is a 13-byte
no-op that confirms state the authority does not hold. The rule that generalizes:
**never store a durable local claim about another party's state.**

**The push response is a merge input.** The authority answers with the winning
version of every cell it processed, and the client merges that answer exactly as
it merges a pull delta. Clearing the dirty flag stops being bookkeeping and
becomes a consequence of merging, which is what fixes the case a conditional
confirm misses: a push that *loses* the authority's comparison would otherwise
clear its flag while the authority holds a different value, and a losing write
takes no cursor, so the winner may never be redelivered.

Still open, and each one changes the protocol rather than the schema: whether the
authority keeps history or only current state, whether it is always in the sync
path or two replicas may merge directly, and whether a user is ever shown that a
conflict happened. The third is the only one that cannot be reversed later,
because losers that were never stored cannot be recovered.

## Revision 2: the actor is dropped, and death stops being its own algebra

Revision 1 adopted `(wall_ms, counter, actor)`. The actor is now dropped and
section 5's hash restored as the third component, so the settled scheme is
`(version_ms, version_seq, version_hash)`. Two things had to be true for that,
and both were tested rather than argued.

**Revision 1 knocked down a design section 5 never proposed.** Its third bullet
attacked comparing `value`, dragging SQL's type order and UTF-8 versus UTF-16
into the merge. Section 5 proposed `sha256(canonicalJson(value))`, not the value.
A fixed-width hash is `memcmp` on both sides, so that objection never applied,
and the ADR now uses exactly this argument in the hash's favour.

**Revision 1's remaining objection to the actor was withdrawn on its own terms.**
It kept `max(observed)` propagating a skewed clock as a live cost of an HLC,
while also adopting an authority ingest clamp that bounds precisely that. The
clamp bounds an HLC the same way. What survives is smaller and sufficient: there
is no identity to persist, rotate, intern, or reconcile.

**Revision 1's byte argument was backwards.** It said the hash was never proposed
to be stored. It is stored, at 8 bytes per cell, and that is what buys a total
order both SQL and JavaScript agree on.

**Terminal death is refused.** Row presence becomes an ordinary cell under the
one scalar algebra. Absorbing death made an address single-use for the lifetime
of the Epicenter, which collides head-on with ADR-0206: a mirror keyed by a
provider id cannot re-create a record the provider restored, and 30 reconciler
passes with strictly later versions leave the row absent. Two rules replace it,
and the presence cell's own version does a generation column's work:

```txt
R1  a cell is refused if its (version_ms, version_seq) is older than the row's
    presence cell
R2  a presence write drops every cell older than itself by (version_ms, version_seq)
```

The incarnation boundary ignores `version_hash` on purpose. The hash breaks ties
between competing values of one cell; across two different cells it means
nothing, and letting it decide here dropped a cell written in the same
transaction as its own create, on hash luck. That was a real bug, caught by the
convergence proof rather than by reading.

Each rule alone is order-dependent and the pair is not: 109,600 runs over all 255
subsets of an eight-delivery set, zero divergent.

**The mutation API does not change.** Section 9 proposed renaming `patch` to
`set` and declaring "create is not a verb". Both are withdrawn. `create` is the
only call that writes the presence cell, so it is the only one that can reuse an
address, and it is already the one moment the type system can demand a complete
row; `patch` is already partial by nature, which is what a per-cell write is.
`create`'s two doors already implement ADR-0206 literally. One sentence in its
docblock does stop being true: an id you deleted no longer "stays deleted",
because `create` can reuse it.

**A more appealing rule was tried and does not converge.** "A dead row holds
nothing", where an `absent` write drops every cell regardless of version, is
order-dependent: a cell newer than the delete survives if it arrives after a
later re-creation and dies if it arrives before. So a cell written concurrently
by a replica that never saw the delete is stored at a dead address, unreachable
by any read, until the address is re-created. It cannot be collected locally
either, because a replica that collected it and one that did not would disagree
if the address were later re-created at a version between the two.

## Rejected, with what each refusal costs

Measured at 196k live rows of 12 columns and 980k of 3, which is the fixture every
storage comparison was built on, on-disk after `VACUUM` and
`wal_checkpoint(TRUNCATE)`. Four rows are measured on the settled
`final-schema.sql`; the rest are on the bench that built both shapes of the
comparison they make, which is named in Provenance below. Every
cell-store projection is verified identical to every other by fingerprint; the
whole-row JSON baseline is distributional rather than cell-for-cell, because its
fixture desynchronises at the first dead row. Nothing in this table gets
re-litigated without a number that beats it.

A third adversarial pass rewrote most of this table. Two corrections are worth
naming because they moved a decision rather than a digit. The projection win from
collapsing presence into the cell relation was 2.1x against an opponent query
that joined before grouping and paid a temp b-tree over every cell; written
properly it is 1.02x, so that collapse is justified by interpretability and not
by speed. And the dirty index's cost and its saving had been quoted from two
mutually exclusive states, one with every cell owed and one with none.

| Refused | Why | Measured cost of refusing it |
| --- | --- | --- |
| Whole-row JSON as the stored shape | per-field and whole-row versions do not compose | 2.12x and 1.66x the size of what ships today (181.0 vs 85.3 MB, 342.4 vs 206.2 MB), re-deriving one changed row 1.69x and 1.21x slower and the whole projection 16.8x and 8.6x slower |
| Real typed columns | ADR-0125: nowhere to put an unknown key | 3.81x and 2.33x the disk, fixture-matched (181.0 vs 47.5 MB, 342.4 vs 147.1), against a shape that stores no version, no `dirty` and no presence, so the ratio is a floor |
| One JSON record per row plus a version map | the map is opaque, so no version is legible and the merge cannot be one SQL predicate; one field change ships the whole record and map; merge-group names become an unversioned wire contract | THIS REFUSAL COSTS DISK. Packed as 18 binary bytes per field it is 130.5 MB and 274.1, so the cell store is 39% and 25% LARGER. The 8.4% figure an earlier pass quoted was against a version map stored as base64 inside JSON, roughly 40 bytes per field. On the wire the cell store still wins, 8.6x at 12 columns and 2.9x at 3 |
| Interning the address | the replica must be readable in a SQL console with no joins | at most 34% of the file, before dictionary tables and integer keys are added back |
| Readable version columns (ISO-8601 plus hex) | a view gives the same legibility for nothing | +65 MB (+36%) and +101 MB (+29%) |
| A per-cell cursor on the replica | it is a durable local claim about the authority's state | +9.8 MB (5.4%) and +18.9 MB (5.5%) for the column, measured as a clean A/B on the settled schema; 91 MB and 140 MB if it is also indexed, which nothing here would query |
| An index on `dirty` | the scan it replaces is cheap and once per round | in the common case, nothing owed, it costs 0 MB and saves the whole scan (about 0.05 s and 0.11 s); with every cell owed it costs +81 MB and +126 MB and saves 6% to 7%, which is inside the run-to-run spread |
| Row presence in its own relation | one algebra, one relation, and an address that can be reused | 1.02x and 1.27x slower projection rebuild (582 vs 568 ms, 1400 vs 1104 ms), once the two-relation query groups before it joins, for 1.5% and 4.1% MORE disk |
| A generation column plus a `resurrect` verb | the presence cell's version already orders incarnations | one column on every cell, one new API surface, and it loses a concurrent write from a replica that has not seen the bump, where R1 and R2 keep it |
| A 16-byte `version_hash` | the merge predicate's value guard closes the same hole | +19.4 MB (+10.7%) and +29.5 MB (+8.6%) |
| A replica-global `version_seq` | it is not durable across a restart | a same-millisecond rewrite after a crash is discarded on a coin flip, which is what the mechanism predicts and what 20,000 trials measure |
| A strict `>` merge predicate | the authority echoes a won push at its own version | the cell never clears `dirty` and re-pushes every round forever |
| A single body delivery slot | an acknowledgement clears bytes the authority never received | every edit made during a push round trip is lost permanently, and no version exists that could notice |
| Range-based set reconciliation as the delivery mechanism | it is a good verifier and a bad courier | finding one changed cell costs a 32 KB bucket exchange plus 586 address and version pairs, against one cell for a cursor |
| ~~An incremental digest as a verifier, for now~~ **ADOPTED in round 4** | the deferral's two premises are both falsified: the lifetime does not catch a restore, and neither does a cursor regression | the deferral cost three rounds of patches to a mechanism that cannot carry the signal. Price paid: 72 KB of disk, about +30% and +20% per local write, +63% and +57% on a bulk seed; it answers "are we equal" in 0.29 ms for 8 bytes |
| Renaming `patch` to `set`, and deleting `create` | `create` is the only verb that can reuse an address, and `patch` is already the right name | churn with no measured benefit, and a merge rule that cannot be expressed |
| Terminal, absorbing row death | it makes an address single-use, against ADR-0206 | a provider-keyed row never returns: 30 reconciler passes at strictly later versions leave it absent |
| An unconditional cell drop on `absent` | it does not converge | a cell at a dead address is retained, unreadable, until the address is re-created |
| Counters | two devices each adding one yields one | none exist, and one needs its own CRDT regardless |
| A body with no incarnation tag | it does not converge across a delete and a re-creation | two orderings give the new row the dead row's prose, two give it an empty body |
| Never deleting a body instead | it converges, and a CRDT has no truncate | the deleted incarnation's prose stays in the new row forever, unremovable by any operation |
| An authority lifetime as the only restore signal | the column lives inside the file being restored | a restore carries the old lifetime back: 0 cells over 50 rounds, 100 of 350 addresses wrong |
| A reset that only re-reads | the read direction is not the broken one | after the reset the replica still disagrees on the 50 cells the restore destroyed, and pushes nothing |
| Re-stamping an R1 refusal at the authority clock | R1 and the clamp are different refusals | the previous incarnation's offline edit beats the re-creation's snapshot, which is what R2 exists to prevent |
| A local write floor taken from the cell alone | R1 measures against the row's presence cell | a write to a never-set column is silently refused for the width of the clamp, measured at 241 seconds |
| Assigning rather than merging into `inflight_update` | an overlapping round clobbers a live send | the bytes in flight are lost with nothing able to notice |
| An acknowledgement with no send token | a late reply cannot be told from a current one | both slots empty, and everything typed since the first send is gone |
| Tying `authority_lifetime` to `last_applied_cursor` in a CHECK | the two facts are independent | the reset state is unrepresentable and the replica re-resets every round forever |
| Leaving the authority's address unchecked | a value is opaque, an address is not | one unrepresentable address aborts every page and wedges every replica permanently |
| One hash for a cleared cell and for JSON `null` | they are different values | two replicas refuse each other forever, at probability 1 rather than 2^-64 |
| An unbounded repair pass | `sealBatch` was the only upload bound in the system | 2.6M cells and roughly 315 MB in one request |
| Merging inside a `json(inner)` field | one cell is one merge unit, so declared-together values never tear | a whole-blob write, which is the point rather than a limitation |

`Supersedes` and `Amends` carry reciprocal links on both records, as
`docs/adr/README.md` requires. `Relates` does not: it is one-directional by
convention here, and only ADR-0170 carries one back, because that record owns a
noun this one borrows.

**A check that failed three times, and what it cost.** Restore detection was
patched three times and failed three times. Round 2 added a `lifetime` column,
because there was no signal at all. Round 3 found the lifetime lives inside the
file being restored, and added a cursor-regression re-mint. Round 4 found the
cursor an authority is shown is the replica's *read* cursor, while a restore
destroys what the replica *wrote*, and clearing `dirty` is a separate commit from
advancing that cursor: measured with no clock skew and no concurrency, forty cells
survive on one device with nothing dirty and every side reporting a consistent
cursor.

The root cause is not any of the three patches. It is that a cursor is a delivery
mechanism, and "do the two sides hold the same thing" is not derivable from a
delivery counter in any form. Each patch added a proxy for the missing
information; none of them added the information. The mechanism that carries it was
priced in this table and deferred, and the deferral is what the three rounds cost.
It is adopted above.

**Provenance.** Figures in this table come from `bench9.ts` (the settled schema,
both planes, the whole required set), `bench8.ts` (per-row re-derivation),
`r2m-storage.ts` (the settled schema against the two-relation and 16-byte-hash
alternatives), `r2m-dirty-index*.ts`, `r2m-wire-and-intern.ts`,
`r3m-cursor-column.ts` (the per-cell cursor A/B), `results2.json` (the
row-plus-version-map opponent), the `r3-*` probes (every protocol claim: the
authority wedge, the restore race, the re-stamp, the body plane), the
`converge*.ts` proofs, and `final-verify.ts`, `final-verify2.ts` and
`final-verify3.ts`. Where a row is not on the settled schema, it
is because the comparison it makes needs an opponent only an earlier bench built;
`r4m-headline.ts` is the exception, and builds both shapes in one run.
bench9's own 200k-all-live fixture measures 184.7 MB and 348.8 MB.

**Harness.** The authoritative run is `bench9.ts`, which executes
`final-schema.sql` as settled at the time of the run, on both planes and covers the whole required set:
insert, scattered row read, projection rebuild, changed-since, one-field write,
row delete, on-disk after `wal_checkpoint(TRUNCATE)`, and wire bytes. `bench.ts`
through `bench8.ts` measured shapes that have since been superseded and are kept
as history; where a figure above still comes from one of them, it is because the
comparison it makes is against a shape only that bench built. Convergence is
`converge.ts`, `converge2.ts`, and `converge3.ts`; the layout is verified by
`final-verify.ts` and `final-verify2.ts`. An adversarial pass over the harness itself found and fixed four biases
worth recording, because they all ran in the same direction: the `dirty` index
was measured with `dirty` cleared on every cell (reporting 65 KB for something
that costs 75 MB), whole-row JSON carried an index no timed query used, the
authority comparison assigned cursors in address order rather than arrival order
(flattering the shape being rejected), and `insert_ms` was mostly JavaScript
hashing and CHECK constraints rather than storage shape.
