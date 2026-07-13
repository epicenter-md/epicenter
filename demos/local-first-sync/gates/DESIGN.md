# Record synchronization gates

This directory tests one claim inside one exact records schema and one records
epoch. Its request envelope uses `recordsSchemaHash` for the portable records
contract and `recordsEpoch` for one authority lifetime.

> No retry, crash, or pull-page schedule makes accepted or pending user intent
> transiently disappear from visible application state.

The protocol has three mutation operations: `createRow` materializes an absent
identity, `updateRow` assigns named cells of a live row, and `deleteRow`
physically removes it. There is no tombstone state anywhere: absence is the
only deleted state, and a row identity has one lifetime. The fold is total
over accepted operations: `updateRow` and `deleteRow` on an absent row are
accepted deterministic no-ops, which is exactly what makes physical deletion
safe against delayed edits. `createRow` on a live identity is never accepted:
the server refuses the whole push atomically (`create-conflict`, high-water
unchanged, actor paused), and a replica that folds an accepted duplicate
create locally is corrupt and must discard state and rebootstrap.

A client-minted `actorId` plus a contiguous `actorSequence` identifies a
mutation, so a create retried after a lost acknowledgement is absorbed by
sequence dedup, never refused. `serverSequence` orders accepted mutations
globally. `pullCursor` is the largest contiguous accepted server sequence
installed by a client. A push acknowledgement never deletes the outbox entry;
only its ordered echo in a pull page does.

```txt
                 schema-blind, ordered
 client A ─push─> SQLite server log <─push─ client B
    │                    │                     │
    └──── pull(cursor) ──┴── pull(cursor) ─────┘

 visible = accepted prefix + pending outbox overlay
```

The harness compares three implementations after every event:

1. `reference.ts`: pure in-memory specification.
2. Candidate A: canonical schema-blind shadow + typed projection + outbox.
3. Candidate B: typed tables + quarantine + outbox, with no canonical client
   shadow and no tombstone table.

Both SQLite pull appliers are independent. Candidate B first removes the rows
that exist only as its own optimistic pending creations, applies the accepted
page through the strict fold, prunes exact own echoes, then replays the
remaining outbox through the same fold. This is valid because updates assign
named cells without discarding unspecified fields, absent-row updates and
deletes fold to no-ops, and a pending creation's identity cannot be live in
accepted state unless the replica is corrupt (in which case the strict fold
throws instead of converging silently).

Run the proof with:

```sh
bun test demos/local-first-sync/gates/gate1.test.ts
```

The measured result and its limits are recorded in
[`GATE1-EVIDENCE.md`](GATE1-EVIDENCE.md).

Gate 2 adds one immutable logical snapshot generation at the current server
head. Snapshots carry live rows only plus the actor high-waters frozen at the
same read state: a row deleted before compaction survives as absence. Clients
stage fixed chunks durably, verify the manifest and every chunk, then replace
accepted state, prune snapshot-contained outbox mutations, replay the rest
through the fold, and advance the cursor in one SQLite transaction. Its
measured result is recorded in [`GATE2-EVIDENCE.md`](GATE2-EVIDENCE.md).

The withdrawn Gate 3 harness modeled online database succession. ADR-0130
deletes that product contract. Its replacement proof lives in production tests:
every request and cursor is qualified by a records epoch, stale-epoch work is
rejected transactionally, replica mismatch preserves local pending work, and a
fresh replica uses the ordinary snapshot bootstrap path. Schema changes,
restore, and wholesale replacement are deployment administration, not a new
portable gate protocol. The proof index is recorded in
[`GATE3-EVIDENCE.md`](GATE3-EVIDENCE.md).

Wave 4 extracts the portable record protocol, fold, authority, and three SQLite
adapters. Its result and remaining runtime smoke scope are recorded in
[`GATE4-EVIDENCE.md`](GATE4-EVIDENCE.md).
