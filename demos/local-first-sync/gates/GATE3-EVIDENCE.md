# Gate 3 evidence: one-slot conditional database succession

Date passed: 2026-07-13

## Result

Gate 3 passes the collapsed succession contract with independent in-memory and
SQLite authorities:

```txt
LIVE source A at head H
  -> client reads canonical A/H
  -> client transforms rows locally
  -> stage one content-addressed candidate B bound to A/H
  -> upload and seal immutable chunks
  -> activate(candidateId)
       if family.current == A and A.head == H:
         select B at head 0 and permanently fence A
       otherwise:
         change nothing; rebuild from the current source
```

The authority never stores application transform code. Candidate manifests and
chunks are authenticated by SHA-256 over canonical JSON. A pending upload is
not a database and cannot be read or written. Atomic activation creates B from
the verified chunks, which become B's initial head-0 checkpoint.

## Asymmetric refusal

Each family has one staging slot. Staging the same manifest replays. Staging a
different manifest replaces the slot and its uploaded chunks. There is no
candidate collection, race arbitration, expiry, garbage collector, or cleanup
worker.

This deliberately refuses concurrent preparation by several clients. A second
attempt replaces the first, and an abandoned upload remains until the next
attempt or explicit discard. Storage remains bounded by one candidate plus
fixed chunk, row, and byte limits.

## Traces proved

- exact manifest and chunk replay;
- multi-chunk upload and missing-chunk refusal;
- tampered chunk refusal;
- duplicate and out-of-order row identity refusal across chunks;
- candidate invisibility before activation;
- pending-upload read and write refusal by construction;
- authenticated manifest totals and a valid empty schema-only successor;
- write-first serialization: A advances and candidate activation becomes stale;
- activation-first serialization: B becomes current and A rejects every write;
- committed activation replay returns `already-active`;
- re-staging an already-created database id returns a defined refusal;
- a stale candidate can be replaced by one rebuilt from the new head;
- SQLite restart preserves current selection, idempotent activation, source fence,
  and B's initial checkpoint;
- succession state contains no actor, device, or source-locking lifecycle.

Run:

```sh
bun test demos/local-first-sync/gates/gate3.test.ts
```

Measured result on 2026-07-13: 6 tests, 125 assertions, all passing. Repository
typecheck and focused Biome checks also pass.

## Limits

The proof uses small limits to exercise boundary behavior. Production adapters
must choose measured request and storage limits. Historical source validation,
client-side transforms, lifecycle approval, and real app wiring remain later
waves. Gate 3 proves only the schema-blind authority transition and its durable
SQLite state.
