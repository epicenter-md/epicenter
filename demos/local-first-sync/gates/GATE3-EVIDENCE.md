# Gate 3 evidence withdrawn: optimistic conditional activation needs a new proof

Date withdrawn: 2026-07-12

## Result

Gate 3 does not yet pass the current product contract. The deleted 2026-07-11
harness proved an earlier frozen-source transition with server-executed
transforms and post-activation private-overlay import. A later unimplemented
device-participation design was also superseded. ADRs 0119, 0121, and 0125 now
require neither model.

The old harness remains available in git history as implementation material for
candidate upload, completeness checks, atomic family selection, and permanent
superseded-database rejection. It is not current evidence.

## Replacement gate

The replacement must prove this smallest transition with independent in-memory
and SQLite authorities:

```txt
ACTIVE source A at head H
  -> client reads canonical snapshot A/H
  -> client transforms and uploads immutable candidate B bound to A/H
  -> authority seals B after manifest completeness and integrity checks
  -> activate(candidateId)
       success: atomically select B and permanently supersede A
       stale: change nothing, let staging clean up B, and retry from the new head
```

The sealed server-owned manifest is the source of truth for A, H, the target
records-schema hash, and successor binding. Activation accepts no caller copy of
those operands.

Required traces:

- stage a candidate over several idempotent chunk requests;
- replay the same candidate manifest and same chunk bytes successfully, while
  rejecting candidate-id or chunk-index reuse with different content;
- reject missing, duplicate-identity, count-mismatched, digest-mismatched, or
  unsealed candidates;
- compute the manifest digest from canonical JSON with fixed fields and chunks
  sorted by index; reject duplicate chunk indexes and duplicate `(table, rowId)`
  identities across chunks;
- reseal a sealed candidate successfully;
- keep every candidate invisible before activation;
- accept ordinary source writes throughout upload;
- force both write/activation serialization orders: write-first advances A and
  makes activation stale; activation-first makes A non-current and rejects the
  old-database write;
- let two complete candidates race from A/H and admit exactly one through the
  family-selection and source-head compare-and-swap;
- retry a committed activation and return `already-activated`;
- expire and garbage-collect stale, failed, and abandoned candidates under
  bounded candidate/chunk/row/byte quotas without touching A; serialize expiry,
  sealing, activation, and cleanup so cleanup cannot delete a winning candidate
  and activation cannot revive an expired candidate;
- activate a complete client-uploaded logical baseline without giving the
  schema-blind authority application transform code;
- block the entire succession when any canonical source row fails the
  historical source descriptor, report its identity, and leave A unchanged;
- permanently reject every post-activation write to superseded A;
- retain forgotten old local databases for read and logical export while
  providing no automatic merge or generic re-import.

The replacement must also prove an absence: migration requests, authority
tables, and state transitions contain no device-participation or source-locking
state. `actorId` and `actorSequence` remain only in ordinary retry-safe
synchronization tests.

## Scope

The user owns the assertion that important devices showed `Synced` before
approval. KV and independently addressed Yjs child documents continue syncing;
conditional activation changes only the selected records database.
