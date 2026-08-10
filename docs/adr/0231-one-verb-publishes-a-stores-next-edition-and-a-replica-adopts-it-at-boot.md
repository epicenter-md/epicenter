# 0231. One verb publishes a store's next edition, and a replica adopts it at boot

- **Status:** Accepted
- **Date:** 2026-08-10
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0232 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Corrected before merge, five times.** First: a dated-volume namespace
  grammar with a manifest and a backup "system" were withdrawn the same day
  they were drafted; the worry they served is one sentence (dead weight must
  not accumulate forever) and one verb serves it. Second: an ordered
  generation integer checked in-session and a claim that fresh struct
  identities were a second safety net were withdrawn. Third: the remaining
  client machinery collapsed once the edition was recognized as the cursor's
  other half: a `confirmed` flag was a cached copy of `cursor > 0`, an
  edition-in-the-filename grammar was replaced by two ordering rules, and
  fusing the id with the document's Yjs guid was elegance that cost
  plumbing. Fourth: the edition name itself collapsed onto the log's own
  number line (positions never restart, so a replica's cursor already names
  its edition and the authority keeps one boundary position; zero new client
  state), and the remote spare was denied (undo is a restore from the
  owner's shelf; the server holds exactly one history, ever). Fifth: the
  stale replica's export-or-wipe ceremony was withdrawn, after the server
  half landed and the client half was designed against it: adoption became
  automatic (authority wins; a stale replica discards and resyncs), and the
  consent for what that discards moved to the verb, where the person with
  the context is. The product surface collapsed with it, to one action over
  the one verb. What survives of each correction is a paragraph under
  *Considered alternatives*.
- **Amends:** [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  at two clauses. The rebuild refusal: withdrawn as stated, kept as reasons; an
  uncoordinated rebuild does destroy a laggard's offline edit, and the missing
  piece was a precondition, not a counterargument. The restore rule: "restoring
  in place does not work, and its failure is silent" was true because every
  other device re-sends; with the boundary refusing the re-senders, an
  in-place restore finally sticks, so it becomes a deliberate verb rather than
  a refused one. Copy-restore beside the live document survives as the gentle
  default.
- **Amends:** [ADR-0219](0219-a-deleted-row-is-removed-and-the-presence-flag-is-retired.md)
  at one sentence: "they are the same operation with opposite trade-offs and
  there is no third option." This record is the third option, priced.
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  by building what its consequences promised: "the address carries a
  generation, and nothing increments it. A stale device compares generations
  and full-resyncs rather than merging." Built here with one change: the
  carrier is the transport's own position axis rather than a new field.
  Nothing was ever built under the old wording; the only `generation` in the
  code is socket-reconnect bookkeeping in
  `packages/data/src/sync/connection.ts` and the auth-generation lifecycle of
  ADR-0232, both unrelated.
- **Does not amend:** [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md).
  Its snapshot-and-tail design runs unchanged inside one edition, and its
  deletion of compaction generations stands: those answered "and then what"
  for a log that no longer grows forever. This record extends its title
  outward: a deletion becomes real across editions too, which is why the
  server keeps no past edition at all.
- **Relates:** [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md)
  (make the hazard inexpressible rather than documented),
  [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (isolation is structural rather than checked, extended here to time),
  [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md)
  (the namespace determines the location),
  [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
  (the precedent: "an account change replaces the app's whole universe, and
  rebuilding it from the boot snapshot is simpler than proving every piece of
  live state swaps correctly"; this record applies the same sentence to
  data). "Edition" names the concept; ADR-0232's "universe" names runtime
  state, and the two must not share a word.
- **Yjs version note.** Every claim here about merge physics was verified
  against the store's actual dependency, `@y/y@14.0.0-rc.24`: a
  state-vector-diffed update still carries the whole delete set
  (`writeStateAsUpdate` writes the struct diff plus `writeIdSet` of the full
  delete set), the apply path still has no document-identity check, and
  `applyUpdate` still forces `transaction.local = false` (pinned by a store
  test). A future Yjs may change the constants; it cannot change the wall,
  which is the CRDT contract itself.

## Context

A CRDT document fuses three things into one artifact: the current state, the
merge metadata, and the memory of everything that ever happened. The third
grows monotonically, and it exists to serve one promise: any replica, from any
point in the past, can merge without asking anyone. That promise is why sync
is easy here; the dead weight is the storage cost of unbounded generosity
toward the past. A tombstone is paid by every device, in memory, on every
load, forever (ADR-0212); a decade of ordinary churn is 156,000 items to show
2,000 live rows (ADR-0219), so the corpse is the document and the live set is
a rounding error.

The trade underneath every option is **merge without asking** versus **forget
without asking**, and both cannot hold for the same data over the same span.
Pruning a tombstone is safe only when every replica has seen the deletion;
that causal stability requires knowing the replica set; a local-first system
with drawer devices refuses, correctly, to know it. So forgetting needs a
coordination point, and the only honest question is who coordinates and how
often. This record's answer: a person, rarely, on purpose. One human decision
replaces the distributed consensus that cannot exist.

Three other problems turned out to be the same problem wearing different
clothes. Nothing in the product can reset an application, and a local wipe
could not stick anyway: any signed-in device re-offers its whole state on next
connect and adoption merges it back (ADR-0220), which is ADR-0214's in-place
restore failure arriving through the sharing model. Account deletion is half
fiction: `deleteStore()` exists on the authority with no caller, citing a
`DELETABLE_NAMESPACES` list that exists nowhere. And restoring a device from
history was refused in place because the same re-senders quietly undo it.

Reclaim, reset, restore, delete. Each needs a way to say "what came before
this moment is no longer the document", discovered by every replica on its own
schedule and undoable by none of them.

## Decision

**Growing is the everyday policy, and forgetting is one person-owned verb:
replace this namespace's log with the state handed in, publishing its next
edition. The edition is not a new field anywhere. Log positions never
restart, so a replica's cursor already names the edition it belongs to, and
the authority keeps one boundary position marking where the current edition
began. A replica adopts a new edition only at boot.**

### The cursor already names the edition

A replica's sync position was always a two-part bookmark: which log, and
where in it. The discovery of this record's fourth correction is that the
transport's existing number line can carry both halves. Positions are minted
only by the authority and never restart across a replace: a replace seeds
the new edition's state as the snapshot at `head + 1` and sets the
**boundary** there. Every cursor ever issued in the old edition is `≤ head`,
and every position in the new edition is `> head`, so the number line itself
partitions the histories and there is no value a stale replica could hold
that looks current.

```txt
positions:  1 ........... 4000 | 4001 ...........
            old edition        | current edition
                        boundary = 4001
```

One durable fact is added to the whole system: the boundary, one integer in
the authority's `_meta`, `0` for a namespace never replaced. The replica's
durable state is **unchanged from today**: `{updates, outbox, cursor}`. The
dial is unchanged (the cursor already travels in the URL). The frame
vocabulary (`frames.ts`) is unchanged. The entire protocol delta is one
server-side comparison at the door and one refusal that names the boundary:

- `cursor ≥ boundary`: today's protocol, byte for byte.
- `0 < cursor < boundary`: refused before any socket exists; this replica
  belongs to a retired edition (adoption, below).
- `cursor == 0`: ordinary join; a replica that never exchanged a byte holds
  no commitment, its document grew alone, and merging an independent
  document is the one cross-edition merge that is safe. The fresh install
  that worked offline before first sign-in is greeted, not asked to export.

Deployed replicas and old builds migrate with zero request changes: their
dials already carry a cursor, the comparison is new server behavior only,
and after a first replace an un-upgraded client is refused visibly rather
than corrupting anything.

On ordering, because the second draft refused an ordered integer and this
looks like one: the refused thing was a *new, client-visible counter axis*,
which invented questions the system cannot answer (a client "newer" than its
authority, number reuse after undo). The boundary is a position on the axis
the transport already owns, minted only by the authority, so no client can
hold a "newer" value and nothing is ever reused. The ordering was already
there; this record stopped duplicating it.

The four problems are four callers of the one verb, distinguished only by
the argument:

```txt
replace(current state, re-encoded)    reclaim: same data, fresh identities,
                                      zero tombstones, fresh log
replace(empty)                        reset the application
replace(saved bytes)                  restore a backup or a history point
replace(empty) + deleteStore()        account deletion, per namespace
```

A backup is not a system. It is one encoded state written to a file: a saved
argument for a future replace. The device-local `history.sqlite3` (ADR-0214)
is already a shelf of such arguments.

### Concretely: where each number lives, and its ceiling

The replica's cursor already has the right home and keeps it: one atomic
durable record beside the updates and outbox it indexes (browser: the single
IndexedDB record `{updates, outbox, cursor}` in `epicenter-store-<namespace>`;
Bun: the `_cursor` relation in the store's SQLite file). The atomicity is
load-bearing: bookmark and bytes commit as a unit, and above that the store
orders every apply as bytes-first-cursor-after, so a crash means idempotent
re-delivery and never a skipped entry.

The boundary is one row in a `_meta` table in the authority's Durable Object
SQLite, beside `_log` and `_snapshot`. DO SQLite is transactional across
tables and the object is single-threaded, so the replace (CAS the boundary,
seed the replacement as the snapshot at `head + 1`, delete the log, move the
boundary) is one atomic step with no concurrency to reason about, and the
dial's check is one row read before the upgrade is accepted.

**Replace is a new storage verb, not a reuse of `replaceSnapshot`.** The
in-edition recap's guard deliberately refuses any position past the head
(a recap must never stand for entries nobody wrote); replace files the fresh
state at `head + 1`, deliberately past it. Same tables, different verb,
different invariant; collapsing them would weaken the recap's guard.

The number ceiling, stated once so nobody rediscovers it: positions travel
as unsigned 32-bit integers in the frame headers and never restart, so the
lifetime budget is 4,294,967,295 entries per namespace. Coalescing caps
production at roughly one entry per second of continuous editing per device
(the 1-second idle timer ADR-0220 measured at a 30x reduction), so a device
editing twenty-four hours a day exhausts the budget in about 136 years of
never stopping; realistic capture workloads take millennia. Server storage
is bounded at roughly twice the document's size by the snapshot cycle, with
measured growth around 4 MB a year against a 10 GB Durable Object limit,
and every hot query is primary-key shaped. The one real pressure point is
the replica's own durable record: after local compaction it holds one
baseline row containing the whole encoded document, rewritten per commit,
about 10 MB at the old ceiling's scale. Editions are the fix for that
number too: a reclaimed document's baseline is small again, which is the
second, quieter argument for the verb.

### Growing is the policy, not the disease

The one-document-that-grows design stays the everyday reality for every
device, all the time. ADR-0220 priced the never-compacting log at about 4 MB
a year and this record does not reopen that; within an edition nothing
compacts, nothing prunes, and merge stays free for everyone including the
device in the drawer. `pressure()` and items-per-live-row are the gauge, and
the packed-fields diet (capture-time facts written once by one device packed
into one attribute, ADR-0228's reasoning run in reverse) is a legitimate
multiplier to bench before anyone reaches for the verb. The verb is the
escape hatch, not the lifestyle. An edition ends only when a person ends it.

**The freshness contract, half decided.** The fifth correction decides the
supersession half: a deliberate compaction IS the freshness contract, and a
device that had not synced before it rejoins fresh instead of merging. The
consent lives at the verb (the warning below), not at the stale device.
What stays open, per lens, is the *automatic* half: whether reclaim may
become maintenance (any at-head replica compacts when pressure is high,
with no human verb in the product). That weakens the CRDT's crown jewel
(merge from any past) to a window on a schedule nobody chose, which is
plainly right for a capture-shaped app and plainly wrong for a vault-shaped
one, so it remains a per-lens product decision and this record does not
make it.

### The verb is force-push with a lease

Replace is refused as an automatic sync move and offered as a deliberate,
person-initiated call, out of band: an authenticated POST on the store mount,
authorized by the signed-in bearer on its own partition, carrying
`(fromBoundary, bytes)` and optionally `atHead`. Routine sync keeps
ADR-0220's rules untouched; a snapshot offer inside an edition must still
pass provenance exactly because it is automatic and a claim. Replace makes no
coverage claim, so it needs no provenance; what it needs is a lease:

- **`fromBoundary` is compare-and-swap, always** (`0` for the first
  replace). The authority applies the replace only if the boundary still
  holds that value, and answers a miss with the current one. Two concurrent
  replaces cannot scramble; the loser retries or reconsiders.
- **`atHead` is a lease by intent.** Reclaim passes it (the head it built
  from) and is refused if the tail moved, because reclaim promises "same
  data" and an entry landing mid-swap would be silently lost. Reset and
  restore omit it: discarding entries, seen and unseen, is the operation,
  and a person resetting a wedged store may be unable to reach head at all.
- **No unresolved dependencies.** A replica holding buffered updates it
  could not integrate must not offer its state as anyone's new edition.

**The product surface is one action, not three intents.** The fifth
correction collapsed `reclaim() / reset() / restore(bytes)` as first-class
verbs into one user-facing action, **Compact store**, backed by the one wire
verb. Reclaim, reset, and restore are *sources of replacement bytes*, not
product surface: compact's source is the reclaim walk over this device's own
state; reset's is the encoded empty document (account deletion's flow will
use it); restore's is a shelf entry (the shelf exists on the owner's disk,
and the bridge is built the day a product needs it). Nothing beyond compact
is built until a caller proves itself.

At the authority the swap is one transaction and reads no bytes: write the
replacement as the snapshot at `head + 1`, delete every log entry at or
below `head`, drop older snapshots, set `boundary = head + 1`, and close
every socket. Closed sockets reconnect through the dial, meet the boundary,
and that is the whole of notification: edition discovery has exactly one
path, the same way catch-up and live relay have exactly one path.

**There is no server-side undo, on purpose.** The authority holds exactly
one history, ever; keeping the previous edition even briefly was denied in
the fourth correction, and the fifth thinned recovery further and says so
plainly. What remains: a compact's replacement IS the current state, so
there is usually nothing to undo; the owner's `history.sqlite3` shelf holds
encoded states where it exists; and a stale replica is a complete copy only
until its first dial, so catching one means catching it offline. Undoing,
where a saved state exists, is one more use of the verb:
`replace(saved bytes)`. What is given up: recovery when no shelf entry and
no still-offline replica exists, a scenario priced at zero machinery both
times it was examined. What is gained: "a deletion becomes real" holds with
no asterisk, because the server never holds a retired edition at all.

### Adoption is automatic: authority wins, a stale replica discards and resyncs

A running store is immortal within its edition. It never swaps documents,
never tears down mid-session, and never invalidates a handle it has given
out; `document(id)` types stay live for the page's life. Adoption is
therefore a reload, never an in-session swap.

**The rule (fifth correction): when a person compacts a store, they declare
the published state authoritative.** A replica whose cursor names a retired
edition does not preserve, merge, or offer its local state for export; at
its next dial it discards its local file whole and rejoins at zero, and the
ordinary join delivers the new edition's snapshot into an empty document.
Every path ends in this one move: the initiating device after a successful
replace, the stale replica at its next dial, the loser of a concurrent
replace, and every crash in the middle. One adoption path instead of a
state machine.

Discovery has one subtlety and one hard safety rule. A browser `WebSocket`
cannot read a refused upgrade's status or body, so the same door is also
readable: an authenticated plain GET on the sync route (no upgrade) answers
the boundary. The safety rule, because automatic discard's failure mode is
wiping local data on a network blip: **a replica discards only when a dial
failed AND an authenticated probe of its own partition returned a
well-formed boundary with `0 < cursor < boundary`.** A refused fetch, a
non-200, an unparseable body, or a dead network all fall through to
ordinary backoff and never discard. The rule lives in the connection
driver, not in each host (ADR-0222's lesson).

The sequence at discovery: stop persistence, delete the local file whole,
reload (ADR-0232's instrument, the same one an auth change uses). Boot
needs no new code: a wiped store opens empty, dials at zero, and the
existing join arm is the whole of adoption. There is no durable note and no
recovery state; a crash anywhere in the middle leaves the old file or
nothing, and either way the next dial converges by repetition. **Deleting a
file whole is the only deletion in this design, at every layer**; there is
no surgical removal from a live CRDT anywhere.

Two ordering rules replace all crash choreography, and they are rules, not
state:

- **Authority before local.** The replacement is durable at the authority
  before any local file changes. The initiating device builds the
  replacement in memory, posts it, and only on a confirmed success discards
  its own file and reloads; it never swaps under its own feet, and it
  adopts through the same join as everyone else rather than through a
  private rewrite path.
- **Wipe whole before reuse.** A local file is deleted entire and recreated,
  never edited across editions. The file keeps its one name per namespace;
  at any crash point it holds the old edition or nothing, and "nothing"
  just means boot catches up from the authority, which holds the
  replacement by construction. The old edition's bytes do not linger on a
  device that has moved on, which is also why no set-aside copy is kept: a
  reset whose predecessor lingers on every stale device is the same lie the
  remote spare was refused for.

**What the person is consenting to, said at the verb.** The one warnable
loss is offline work on a device that never synced it. The confirmation
carries it plainly:

> **Compact this store?**
> Compacting rewrites sync history down to what the store holds right now.
> Every signed-in device will re-download the store the next time it opens.
> A device holding offline changes it never synced will lose them. If
> another device has been offline with edits you care about, let it sync
> first.

**The trust delta, named honestly.** Under the withdrawn ceremony, no
authority could destroy a replica's local state without a human step on
that device; under this rule, a compaction (or an authority that lies about
its boundary) causes replicas to discard on their own. This is accepted
because the partition is the owner's own, discard follows only an
authenticated probe of it, and the authority could already withhold or
rewrite everything a replica would ever sync again; the marginal power is
over local copies of data the owner already declared replaced.

The physics limit, stated so nobody oversells this: a powered-off device
keeps its copy until it reconnects. What this design guarantees is that a
stale copy can never be published anywhere, and that it adopts the current
edition at its first dial. "Never silently merged" survives absolutely;
"never silently discarded" was withdrawn deliberately, with the consent
moved to the verb.

This is ADR-0232's decision applied to data: a page lifetime is one edition,
and rebuilding from the boot snapshot is simpler than proving every piece of
live state swaps correctly. Reload is native to the runtime (ADR-0227) and
boot already replays everything (ADR-0215), so the transition instrument
costs nothing new.

### The safety, stated honestly

Contamination means old-edition bytes reaching a new-edition document, and
Yjs provides no net against it: the engine applies any update to any
document, a full state from one edition integrates cleanly into another,
tombstones and all, and the restore verb proves identity freshness was never
the guard (a restored edition reuses the saved state's struct identities
wholesale and is safe anyway). The guard is two comparisons and an ordering
rule, all this record's: remotely, the only way to write is over an accepted
socket, and the door compares the cursor to the boundary; the verb compares
`fromBoundary`; locally, wipe-whole-before-reuse means a device that has
moved on holds no old bytes at all. Identity questions are answered by
addresses and doors, never by inspecting content, which is the same property
that keeps end-to-end encryption possible (ADR-0218).

### The shelf is local

Depth lives where the owner lives: `history.sqlite3` on the owner's disk is
the deep shelf, restore is the bridge that publishes a shelf entry upward,
and time travel is a client feature over client history. Server-side depth
of any kind, including the spare this record briefly carried, would rebuild
the privacy leak ADR-0220's title retired: a reset whose predecessor is
retrievable is a lie to the person who clicked it, and the never-compacted
log already taught this lesson once by leaking every deleted note to new
devices.

After account deletion (`replace(empty)` then `deleteStore()` per namespace,
the namespace list coming from the account's actual manifest rather than the
fictional `DELETABLE_NAMESPACES`), the guard against a drawer device
re-seeding a fresh authority is the bearer's death, not the boundary: the
principal no longer resolves, so the dial never reaches a Durable Object.

## Consequences

- **Unbounded monotonic growth ends as a policy, not a mechanism.** The log
  still grows within an edition, deliberately; when the corpse is worth
  shedding, one replace reclaims it, and `pressure()` is the gauge that says
  when.
- **Client durable state is unchanged from today.** No new fields, no new
  dial parameters, no new frames, and (after the fifth correction) no
  durable note either. The entire client-side delta is one classification
  rule at the dial and one discard-and-reload; adoption itself is the join
  arm that already exists.
- **ADR-0215's partial-hydration fix stops being load-bearing.** The store
  stays fully hydrated and synchronous; a document that outgrows its live
  set is replaced, not partially loaded.
- **Row ids survive a replace; struct identities do not.** A row is a
  name-addressed attribute, so every id, field value, and row document
  survives re-encoding. Nothing an application references changes.
- **Row documents are re-encoded without being read.** The reclaim walk
  copies each row's container generically, attributes and sequence deltas,
  structure preserved and meaning untouched. This is the one part that is
  real engineering rather than plumbing, and it needs evidence-grade tests
  before the sentence above is trusted.
- **A superseded device adopts at its next dial, and not before.** Stated
  plainly so nobody assumes otherwise: offline it keeps working locally, it
  can never publish anywhere, and "the compaction appears everywhere
  instantly" is not a property of this design. When it next dials, it
  discards and resyncs on its own, with no ceremony and no human step on
  that device; the human step already happened, once, at the verb.
- **The store and the in-edition transport never learn editions exist.**
  `store.ts` and `frames.ts` are untouched; the boundary lives in the mount
  and Durable Object (one integer, the verb, and the probe), the discard
  verb in the openers (delete the local file whole), the supersession rule
  in the connection driver, and the one product action (Compact store, with
  its warning) in the application. The application also owns account
  deletion's orchestration and ordering (authority, then blobs, then the
  local file), because the store knows nothing of blobs and the host owns
  no application data (ADR-0226).
- **The reborn bytes are branded.** `encodeStateSince()` preserves struct
  identities and reclaims nothing; the reclaim walk re-mints and reclaims
  everything. Both are byte arrays, and handing the wrong one to replace
  "works" while silently defeating the verb, so the walk's return type is
  distinct and the reclaim plumbing accepts only it.
- **`deleteStore()` gets its caller**, and `DELETABLE_NAMESPACES` is replaced
  by the account's actual manifest of namespaces.
- **Built: the authority half.** The boundary (`_meta`), the `replace` verb
  (CAS on `fromBoundary`, `atHead` lease, one transaction), the dial's
  refusal before any socket exists, and the authenticated POST on the store
  mount (`STORE_REPLACE_ROUTE`) are implemented and test-gated
  (`sync/transport.test.ts`, `packages/server/workers/e2e.test.ts`).
  **Being built under the fifth correction: the client half.** The boundary
  probe, the driver's supersession rule, `discard()` on the openers, the
  reclaim walk with its branded return type, and the compact action.
  **Not built:** `deleteStore()`'s caller (account deletion's flow), the
  restore bridge from the shelf, and any automatic-maintenance freshness
  contract.

## Considered alternatives

Each was examined against the tension in *Context*; each hides its cost in
one of three places: resurrection, a roster, or a server that reads bytes.

- **Do nothing everywhere.** Correct within an edition and adopted as the
  everyday policy above; as the only policy it fails arithmetically, at
  roughly 100,000 items in about thirty days for a recorder at three hundred
  captures a day, two items per deletion forever.
- **State vectors instead of a transport cursor.** Yjs's own sync vocabulary
  looks like it could replace the log position, and cannot, for two reasons
  verified in `@y/y@14.0.0-rc.24` source: a blind authority cannot evaluate
  a state vector without decoding documents (the architecture refused four
  times with measurements), and a state-vector diff always carries the
  entire delete set, so the growing part of the document becomes the
  per-message payload. The cursor also makes loss loud (contiguity check)
  where state-vector sync buffers it silently.
- **Partial hydration (ADR-0215's named fix).** Keeps the corpse and stops
  paying RAM to look at it. Refused: every device still downloads, stores,
  and syncs a corpse that never stops growing, and the entire synchronous
  read surface would be rebuilt to dodge a cost that was postponed, not
  removed.
- **Distributed tombstone collection.** A device roster, per-device
  positions, and a rule for when a silent device is gone. Refused by
  ADR-0212 and still refused: causal stability never arrives while the
  drawer device sleeps, and a liveness rule that expels quiet devices is
  this record's rebuild wearing a disguise. (The per-lens freshness
  contract above is the honest, opt-in version of this trade, and it reuses
  this record's mechanism rather than adding one.)
- **TTL tombstones, or a hand-rolled LWW store that prunes by time.**
  Bounds dead weight by accepting that a device offline longer than T
  silently resurrects deletions. Refused: silent resurrection is corruption
  nobody can see, and it re-fights the war Yjs already won (ADR-0213).
- **Server-side compaction or selective deletion.** The authority cannot
  read the bytes (ADR-0218), so it can neither prove coverage nor delete
  within them. Blindness is load-bearing and kept; four authority designs
  died at this joint already.
- **Dated volume namespaces (a drafted companion record, withdrawn).**
  Partition heavy tables into calendar-named stores so old periods are
  individually deletable. Withdrawn: it answers live-set size while the
  disease is dead weight, it taxes every application with a manifest, a
  discovery rule, and cross-volume queries, and ADR-0229 already lets an
  application open a second namespace as ordinary policy the day one truly
  needs it. Worth keeping if that day comes: a period name must be derived
  from the calendar, never minted, so partitioned devices converge in one
  volume (ADR-0216).
- **An ordered edition counter as a new client-visible axis, checked
  in-session.** The second draft. Refused: a separate counter axis invents
  questions the system cannot answer (a client "newer" than its authority,
  number reuse after undo), and the in-session supersession arm swaps a
  document under live `Y.Type` handles, the half-hydrated-handle class
  ADR-0215 exists to kill. The boundary is not this: it lives on the
  authority-minted position axis the transport already owns, where ordering
  is total and unforgeable, and it is checked only at the door and at boot.
- **An opaque edition name beside the cursor, with a per-edition local file
  and a remote spare.** The third draft, collapsed in place by the fourth
  correction. The name duplicated information the number line already
  carried (positions never restart, so the cursor names the edition); the
  `confirmed` flag was `cursor > 0`; the per-edition file names forced
  enumeration and crash choreography that two ordering rules replace; and
  the remote spare defended a scenario (initiating device dies instantly,
  no shelf entry, no stale replica anywhere) too thin to buy machinery for,
  at the cost of the server briefly holding a history the owner believed
  destroyed. What the name alone bought was gentle undo for devices stale
  across an undone replace; that kindness is priced and declined.
- **A protocol-level epoch checked per frame.** Works, and is strictly
  worse: every handler grows a comparison and a missed check is silent
  corruption. One comparison at the one door, plus files that never hold
  two editions, makes the mistake inexpressible instead of checked.
- **Keeping past editions remotely (time travel as addressing).** Beautiful
  and refused: a remote shelf of editions makes deletion unreal again. The
  shelf belongs on the owner's disk (`history.sqlite3`).
- **Merging a laggard's offline work across the break.** The obvious repair,
  and it almost works, which is why the refusal is written out: the laggard
  can merge the new edition into its old document (Yjs merges any two
  documents), but every field then holds the old struct and the re-minted
  struct as rivals, and Yjs resolves each map key by client id, which is
  time-blind. Some fields resolve to Tuesday and some to today, arbitrarily,
  per field: plausible-looking soup, worse than an honest export because it
  is silent. Diffing across the break by value is a subsystem, not a button
  (ADR-0212). Export-or-discard is honest; a half-right automatic merge is
  not.
- **A backup subsystem.** There is nothing to build: the artifact is one
  encoded state, the shelf is `history.sqlite3`, and restore is the verb
  this record already defines.
- **Export-or-wipe at the stale replica (the fifth correction's
  withdrawal).** The first design of the client half: a refused dial wrote a
  durable note, sync blocked, an alarm surfaced, and boot demanded a human
  choice between exporting the stale state and wiping it, so nothing was
  ever discarded silently. Withdrawn: the ceremony asked the wrong person,
  later, with less context (the person compacting is the only one who knows
  whether a drawer device matters), and it bought that misplaced question
  with a real state machine: a durable refusal note, a blocked-sync state,
  an export surface, and a boot ceremony, all defending one narrow, warnable
  promise. Moving the consent to the verb deletes the machinery and makes
  every failure tail (crash, retry, concurrent compaction, drawer device)
  collapse into the one adoption path. What was given up, priced and
  printed on the confirmation: offline edits a device never synced do not
  survive someone else's compaction. A future vault-shaped lens that truly
  needs export-first supersession would build it then, as its own product
  surface over the same wire facts; nothing is kept warm for it.
