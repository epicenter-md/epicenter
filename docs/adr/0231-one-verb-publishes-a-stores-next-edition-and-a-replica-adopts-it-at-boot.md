# 0231. One verb publishes a store's next edition, and a replica adopts it at boot

- **Status:** Accepted
- **Date:** 2026-08-10
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0232 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Corrected before merge, three times.** First: a dated-volume namespace
  grammar with a manifest and a backup "system" were withdrawn the same day
  they were drafted; the worry they served is one sentence (dead weight must
  not accumulate forever) and one verb serves it. Second: an ordered
  generation integer, an in-session supersession arm in the transport, and a
  claim that fresh struct identities were a second safety net were withdrawn
  (the edition is a name compared for equality; adoption happens at boot;
  the safety is stated honestly below). Third: the remaining machinery
  collapsed once the edition was recognized as the cursor's other half: a
  `confirmed` flag was a cached copy of `cursor > 0`, an edition-in-the-
  filename grammar with enumeration and crash choreography was replaced by
  two ordering rules, and the fusion of the edition id with the document's
  Yjs guid was elegance that cost construction plumbing and bought nothing.
  What survives of each correction is a paragraph under *Considered
  alternatives*.
- **Amends:** [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  at two clauses. The rebuild refusal: withdrawn as stated, kept as reasons; an
  uncoordinated rebuild does destroy a laggard's offline edit, and the missing
  piece was a precondition, not a counterargument. The restore rule: "restoring
  in place does not work, and its failure is silent" was true because every
  other device re-sends; with the edition ref refusing the re-senders, an
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
  carrier is a name beside the cursor compared only for equality, not a
  number compared for order. Nothing was ever built under the old wording;
  the only `generation` in the code is socket-reconnect bookkeeping in
  `packages/data/src/sync/connection.ts` and the auth-generation lifecycle of
  ADR-0232, both unrelated.
- **Does not amend:** [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md).
  Its snapshot-and-tail design runs unchanged inside one edition, and its
  deletion of compaction generations stands: those answered "and then what"
  for a log that no longer grows forever. This record extends its title
  outward: a deletion becomes real across editions too, which is why the
  spare is mortal.
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
  data). "Edition" rather than "universe" partly because ADR-0232 already
  uses "universe" for the app's runtime state, and these are different things
  that must not share a word.

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
edition. An edition is the log's name; the cursor is a position within it;
together they are a replica's whole sync bookmark. A replica adopts a new
edition only at boot.**

### The edition is the cursor's other half

A replica's sync position was always a two-part bookmark, and the system has
only ever written down half of it. The `cursor` says where in the log, and
silently assumes there is only one log per namespace, ever. This record adds
the missing half and nothing else:

```txt
(namespace, edition, cursor)
  which app    which log   where in it
```

A namespace has many editions only in time, never in space: a device holds at
most one, the authority holds the current one plus one spare, and nothing
anywhere enumerates editions or relates two of them. The only question in the
system is "is yours the current one?", answered by one equality at the dial.

The edition id is an opaque string minted by whoever publishes the edition.
It is not ordered (so "is the client newer?" is not a question the system can
ask; the authority's ref is definitionally current), it is not the document's
Yjs guid (the id and the updates it labels live in one atomic durable record
and have no channel through which to disagree, so fusing them bought no
safety and cost threading a guid through store construction), and it is not
part of any file name.

**Absent is a value: the primordial edition's name.** A namespace that has
never been replaced has no ref, and a replica that predates this record has
no edition field; the two match, so every deployed store migrates with zero
special cases. After the first replace the ref exists, and a dial presenting
no edition, or the wrong one, is refused like any other stale replica. An
old-build client can therefore never corrupt a replaced namespace; it is
refused, visibly, until it upgrades.

Exactly two durable facts exist, and neither can be derived:

- **The ref**: the current edition's name, one row in the authority's
  `_meta`, beside ADR-0220's snapshot and tail, which belong to that edition
  alone. The ref is the one human decision, made durable.
- **The replica's edition field**: which log its bytes belong to, stored in
  the durable record beside the cursor, traveling atomically with the updates
  it labels.

The four problems are four callers of the one verb, distinguished only by the
argument:

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

### The verb is force-push with a lease and a spare

Replace is refused as an automatic sync move and offered as a deliberate,
person-initiated call, out of band: an authenticated POST on the store mount,
authorized by the signed-in bearer on its own partition, carrying
`(fromEdition, toEdition, bytes)` and optionally `atHead`. Routine sync keeps
ADR-0220's rules untouched; a snapshot offer inside an edition must still
pass provenance exactly because it is automatic and a claim. Replace makes no
coverage claim, so it needs no provenance; what it needs is a lease:

- **`fromEdition` is compare-and-swap, always** (absent counts, for the first
  replace). The authority applies the replace only if the ref still names
  `fromEdition`, and answers a miss with the current name. Two concurrent
  replaces cannot scramble; the loser retries or reconsiders.
- **`atHead` is a lease by intent.** Reclaim passes it (the tail position it
  built from) and is refused if the tail moved, because reclaim promises
  "same data" and an entry landing mid-swap would be silently lost. Reset and
  restore omit it: discarding entries, seen and unseen, is the operation, and
  a person resetting a wedged store may be unable to reach head at all.
- **No unresolved dependencies.** A replica holding buffered updates it could
  not integrate must not offer its state as anyone's new edition.

At the authority the swap is one transaction and reads no bytes: rename the
edition's `_log` and `_snapshot` tables to the spare (evicting the previous
spare), recreate them, seed the replacement bytes as the snapshot at position
1, point the ref at `toEdition`, and close every socket. Closed sockets
reconnect through the dial, meet the ref, and that is the whole of
notification: edition discovery has exactly one path, the same way catch-up
and live relay have exactly one path. The frame vocabulary (`frames.ts`) does
not change; the edition appears on the wire in exactly two places, a dial
query parameter and the refusal that answers a stale one.

**Undo is metadata-only.** The spare is the previous edition whole, tables
and ref value, so undoing a bad replace swaps the tables back and re-points
the ref, without a byte moving or being read. A garbage replace is one
deliberate call, visible, and undone by one cheaper one.

### Adoption happens at boot

A running store is immortal within its edition. It never swaps documents,
never tears down mid-session, and never invalidates a handle it has given
out; `document(id)` types stay live for the page's life. When a dial is
refused with a different edition, the replica records the new name in a
durable note, surfaces one alarm (the same shape as `durability()` and
`needsResync`: a status an application shows, not an error a call returns),
and keeps working locally. Sync is simply over for this page.

`open()` owns the transition, and adoption is not a code path: it is boot.
At open, the replica compares its edition to the noted ref (and to the live
ref when a connection is available). On a mismatch it runs the funeral,
surfacing unsynced work for export first, then deletes its local file whole,
opens fresh, and lets the ordinary join deliver snapshot and tail into an
empty document. **Deleting a file whole is the only deletion in this design,
at every layer**; there is no surgical removal from a live CRDT anywhere.

Two ordering rules replace all crash choreography, and they are rules, not
state:

- **Authority before local.** The replacement is durable at the authority
  before any local file changes. The initiating device builds the
  replacement in memory, posts it, and only on success wipes and rewrites its
  own file, then reloads; it never swaps under its own feet.
- **Wipe whole before reuse.** A local file is deleted entire and recreated,
  never edited across editions. The file keeps its one name per namespace;
  at any crash point it holds the old edition, nothing, or the new edition,
  and "nothing" just means boot catches up from the authority, which holds
  the replacement by construction. This also means the old edition's bytes
  do not linger on the device after it moves on.

This is ADR-0232's decision applied to data: a page lifetime is one edition,
and rebuilding from the boot snapshot is simpler than proving every piece of
live state swaps correctly. Reload is native to the runtime (ADR-0227) and
boot already replays everything (ADR-0215), so the transition instrument
costs nothing new.

### A replica that never exchanged a byte joins instead of mourning

`cursor == 0` means this replica has never exchanged a byte with the
authority in its edition: never read an entry, never had a push acknowledged.
Its edition name is a private label with no commitment behind it, and its
document grew alone, so merging it is the ordinary independent-document
merge. Told the current edition, such a replica does not mourn, it joins: it
adopts the current name, the authority's snapshot merges in through the
ordinary adopt path, and its offline work pushes through the outbox like any
other local write. The fresh install that worked offline before its first
sign-in is greeted, not asked to export.

A replica with `cursor > 0` returning across a replace is the drawer device,
and it is surfaced, never merged and never silently destroyed: it shows what
it holds and offers an export before the wipe. Merging it is impossible to do
honestly (see *Considered alternatives*), and destroying it quietly is the
failure this corpus refuses everywhere else. The physics limit, stated so
nobody oversells this: a powered-off device keeps its copy until it
reconnects. What this design guarantees is that a stale copy can never be
published anywhere, and that it is offered its funeral at the first dial.

### The safety, stated honestly

Contamination means old-edition bytes reaching a new-edition document, and
Yjs provides no net against it: the engine applies any update to any
document, a full state from one edition integrates cleanly into another,
tombstones and all, and the restore verb proves identity freshness was never
the guard (a restored edition reuses the saved state's struct identities
wholesale and is safe anyway). The guard is two-fold and entirely this
record's: remotely, the one equality at the dial is the only door, and it
refuses; locally, wipe-whole-before-reuse means a device that has moved on
holds no old bytes at all. Anyone who ever shares a channel across editions
trusting the document to reject old bytes will corrupt a partition.

### The spare is mortal, and the shelf is local

The remote spare exists for one purpose, undoing a garbage replace, and it is
depth one: the next replace evicts it. Keeping past editions server-side
would rebuild the privacy leak ADR-0220's title retired, a reset whose
predecessor is immortal is a lie to the person who clicked it, and the
never-compacted log already taught this lesson once by leaking every deleted
note to new devices. Deletion stays real, across editions as within them.

Depth lives where the owner lives: `history.sqlite3` on the owner's disk is
the deep shelf, restore is the bridge that publishes a shelf entry upward,
and time travel is a client feature over client history.

After account deletion (`replace(empty)` then `deleteStore()` per namespace,
the namespace list coming from the account's actual manifest rather than the
fictional `DELETABLE_NAMESPACES`), the guard against a drawer device
re-seeding a fresh authority is the bearer's death, not the ref: the
principal no longer resolves, so the dial never reaches a Durable Object.

## Consequences

- **Unbounded monotonic growth ends as a policy, not a mechanism.** The log
  still grows within an edition, deliberately; when the corpse is worth
  shedding, one replace reclaims it, and `pressure()` is the gauge that says
  when.
- **ADR-0215's partial-hydration fix stops being load-bearing.** The store
  stays fully hydrated and synchronous; a document that outgrows its live set
  is replaced, not partially loaded.
- **Row ids survive a replace; struct identities do not.** A row is a
  name-addressed attribute, so every id, field value, and row document
  survives re-encoding. Nothing an application references changes.
- **Row documents are re-encoded without being read.** The reclaim walk
  copies each row's container generically, attributes and sequence deltas,
  structure preserved and meaning untouched. This is the one part that is
  real engineering rather than plumbing, and it needs evidence-grade tests
  before the sentence above is trusted.
- **A superseded device is stale until a person reloads it.** Stated plainly
  so nobody assumes otherwise: it keeps working locally, it cannot publish
  anywhere, and "the reset appears everywhere instantly" is not a property of
  this design. Visible and healable over prevented, applied to time.
- **The store and the in-edition transport never learn editions exist.**
  `store.ts` and `frames.ts` are untouched; the edition lives in the openers
  (the durable record and the two ordering rules), the mount and Durable
  Object (the ref and the verb), and the application
  (`app.store.reclaim() / reset() / restore(bytes)`, three intents over one
  wire verb, because their preconditions differ). The application also owns
  full-reset orchestration and ordering (export, then authority, then blobs,
  then the local file), because the store knows nothing of blobs and the host
  owns no application data (ADR-0226).
- **The reborn bytes are branded.** `encodeStateSince()` preserves struct
  identities and reclaims nothing; the reclaim walk re-mints and reclaims
  everything. Both are byte arrays, and handing the wrong one to replace
  "works" while silently defeating the verb, so the walk's return type is
  distinct and the reclaim plumbing accepts only it.
- **`deleteStore()` gets its caller**, and `DELETABLE_NAMESPACES` is replaced
  by the account's actual manifest of namespaces.
- **Not built.** Nothing here exists in code. The nearest pieces are
  `deleteStore()` (unrouted), ADR-0220's snapshot adoption (the join arm is
  deployed; the funeral is new), ADR-0229's addressing seams, and ADR-0232's
  reload lifecycle.

## Considered alternatives

Each was examined against the tension in *Context*; each hides its cost in
one of three places: resurrection, a roster, or a server that reads bytes.

- **Do nothing everywhere.** Correct within an edition and adopted as the
  everyday policy above; as the only policy it fails arithmetically, at
  roughly 100,000 items in about thirty days for a recorder at three hundred
  captures a day, two items per deletion forever.
- **Partial hydration (ADR-0215's named fix).** Keeps the corpse and stops
  paying RAM to look at it. Refused: every device still downloads, stores,
  and syncs a corpse that never stops growing, and the entire synchronous
  read surface would be rebuilt to dodge a cost that was postponed, not
  removed.
- **Distributed tombstone collection.** A device roster, per-device
  positions, and a rule for when a silent device is gone. Refused by
  ADR-0212 and still refused: causal stability never arrives while the
  drawer device sleeps, and a liveness rule that expels quiet devices is
  this record's rebuild wearing a disguise.
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
- **An ordered generation integer, checked in-session.** The second draft of
  this record. Refused: the ordering invents questions the system cannot
  answer (a client "newer" than its authority, number reuse after undo), and
  the in-session supersession arm swaps a document under live `Y.Type`
  handles, which is the half-hydrated-handle class ADR-0215 exists to kill.
  Equality-named editions and boot-only adoption delete both.
- **The edition as a separate file per edition, named by a document guid,
  with a `confirmed` flag.** The third draft of this record, collapsed in
  place. The flag was a cached copy of `cursor > 0`; the per-edition file
  names forced database enumeration, a highest-wins rule, and mark-then-swap
  crash choreography, all defending a two-file window that
  authority-before-local closes; and fusing the id with the Yjs guid cost
  construction plumbing while the atomic durable record already made
  disagreement inexpressible. Two ordering rules replaced all of it, and
  wipe-whole is stronger than separate files anyway: it leaves no old bytes
  on the device.
- **A protocol-level epoch checked per frame.** Works, and is strictly
  worse: every handler grows a comparison and a missed check is silent
  corruption. One equality at the one door, plus files that never hold two
  editions, makes the mistake inexpressible instead of checked.
- **Keeping every edition remotely (time travel as addressing).** Beautiful
  and refused: a remote shelf of past editions makes deletion unreal again.
  The shelf belongs on the owner's disk (`history.sqlite3`); the remote
  spare is depth one and mortal.
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
