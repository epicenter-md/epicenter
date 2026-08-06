# Architecture memo: a replicated cell store

- **Status:** Draft
- **Date:** 2026-08-05

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
    (replica.ts:547, admission.ts:9)
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

**Create-then-delete inverts into a permanent live row.** `fold.ts:85-97` makes
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
| the **body** field | **Yjs cell** (this is the change) | see below |
| row presence | **clocked row-level cell** | see section 7 |

**The body is the finding.** A body is not a type; it is a designation on the
table naming an ordinary `field.string()` (`definitions.ts:62`, `:227-240`,
validated to reject non-string kinds). So **long-form prose is an LWW scalar
today**, the one case where LWW is worst. ADR-0207 named that and shipped anyway:

> `:261-264` "**A table's prose is either in a field or unreachable from the
> folder.** That is a real hole, and it lands hardest on rich text editors."

Yjs row documents merge per character but `:156` says "**A row document is never
rendered and never written**" to the folder. So today you choose folder
round-trip **or** character merge, never both.

Making the body a Yjs **cell** gets both. That is a product improvement, not
cleanup, and it is the strongest single argument for this model.

Cost to scope honestly: writing markdown back into a `Y.Text` must be a minimal
diff, not a replace, or every folder edit destroys the CRDT history that made it
worth doing. `apps/epicenter/src/folder/parse.ts:96-101` currently replaces.

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

**Minimal safe receipt cursor** — and most of it already exists:

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
row behind. So keep one clocked presence cell per row.

**Keep terminal death.** Once absent, always absent, regardless of clocks. It
matches today (`fold.ts:33-40`), it is what `epicenter.ts:489-500` reads, and it
removes an entire question. The alternative, clock-comparing resurrection,
buys undelete and costs a new failure mode.

**Per-cell tombstones are still needed** for clearing an optional field. `unset`
becomes a cell whose value is absent, with a clock. This preserves a distinction
the current model loses: "the user cleared this" versus "it was never set."

**Acknowledgement is not needed.** State-based merge is idempotent, so there is
nothing to acknowledge; that is what deletes A3.

**Garbage collection: none, and say so.** With terminal death, a returning
replica would resurrect anything collected. If tombstone growth ever matters,
the answer is a policy, not a mechanism: retain N days, and a device dark longer
re-bootstraps rather than merging. There is no staleness concept today at all;
`_authority_replicas` has four columns and no timestamp
(`authority-schema.ts:36-50`).

**Documents already cascade correctly and transactionally.** `storeFact` deletes
`document_updates` and `document_publication` in the same transaction as the row
delete (`replica.ts:248-260`, `authority.ts:154-163`), with liveness gates
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

**Amendment 1 — there is no outbox.** The proposal says the outbox "compacts
pending scalar writes by cell." That keeps a relation the design deletes. If a
cell carries its own clock and its confirmed clock, pending-ness is a query:

```sql
WHERE local_clock > confirmed_clock
```

A view, not a second relation to keep consistent. This also kills
`replica.ts:375-376`, where one oversized intent **permanently wedges** the
outbox.

**Amendment 2 — no HLC, no actor id.** `version = (wallMillis, valueHash)` plus
a local monotonic guard and a server clock clamp. Section 5.

**Amendment 3 — the body becomes a Yjs cell.** This closes the hole ADR-0207
named and accepted, and it is the reason to do this work now rather than later.
Section 4.

**Keep from the proposal:** the cell store keyed by
namespace/table/row/column; rows derived by grouping; per-cell merge kinds; a
server-assigned change cursor distinct from the conflict clock; full
reconciliation as a valid repair; clocked row tombstones; composite cells over
cross-cell invariants; counters refused until one exists.

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

**User loss:** silent LWW resolution with no conflict surface; no counters; at an
exact millisecond tie the winner is arbitrary; "synced" becomes a clock
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
