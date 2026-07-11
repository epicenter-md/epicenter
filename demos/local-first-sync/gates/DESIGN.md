# Gates 1 and 2: client materialization and compaction proof

This directory tests one claim inside one exact schema epoch and one database
incarnation:

> No retry, crash, or pull-page schedule makes accepted or pending user intent
> transiently disappear from visible application state.

The protocol has only two mutation operations: `patchRow` and terminal
`deleteRow`. A client-minted `actorId` plus a contiguous `actorSequence`
identifies a mutation. `serverSequence` orders accepted mutations globally.
`pullCursor` is the largest contiguous accepted server sequence installed by a
client. A push acknowledgement never deletes the outbox entry; only its ordered
echo in a pull page does.

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
3. Candidate B: typed tables + quarantine + tombstones + outbox, with no
   canonical client shadow.

Both SQLite pull appliers are independent. Candidate B applies the accepted
page directly, removes echoed mutations, then reapplies the remaining
assignment-only outbox. This is valid because patches never discard unspecified
fields and deletes are terminal.

Run the proof with:

```sh
bun test demos/local-first-sync/gates/gate1.test.ts
```

The measured result and its limits are recorded in
[`GATE1-EVIDENCE.md`](GATE1-EVIDENCE.md).

Gate 2 adds one immutable logical snapshot generation at the current server
head. Clients stage fixed chunks durably, verify the manifest and every chunk,
then replace accepted state, prune snapshot-contained outbox mutations, replay
the rest, and advance the cursor in one SQLite transaction. Its measured result
is recorded in [`GATE2-EVIDENCE.md`](GATE2-EVIDENCE.md).

Gate 3 adds exact schema identity, new-incarnation cutover, resumable transformed
baselines, and private-intent import. Its result is recorded in
[`GATE3-EVIDENCE.md`](GATE3-EVIDENCE.md).
