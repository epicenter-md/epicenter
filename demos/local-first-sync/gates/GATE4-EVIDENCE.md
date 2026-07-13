# Gate 4 evidence: shared production core

Gate 4 proves the records-schema and authority-lifetime fences now named
`recordsSchemaHash` and `recordsEpoch`. It does not prove stale-epoch refusal;
administrative replacement remains outside the shared protocol.

Wave 4 extracted the record synchronization proof into
`@epicenter/record-sync`. The old gate engines remain independent evidence; the
production core does not import them.

## Ownership

```txt
@epicenter/record-sync
  protocol.ts    closed request schemas, JSON validation, opaque identity fence
  fold.ts        total createRow/updateRow/deleteRow transitions
  authority.ts   canonical rows, actor order, mutation tail, snapshots, compaction
  snapshot.ts    stable encoding plus injected SHA-256
  sqlite.ts      run / all / synchronous transaction

runtime adapters
  browser.ts          sqlite.org OO1 API translation
  bun.ts              bun:sqlite API translation
  durable-object.ts   storage.sql + transactionSync translation
```

The record core has no dependency on workspace schemas, Yjs, Hono, auth, or
billing. `@epicenter/sync` remains the separate Yjs body-plane protocol.

## Conformance result

The same scenario passes through all three adapter surfaces:

- transaction rollback;
- actor sequence acceptance, duplicate suppression, and gap refusal;
- exact records schema hash and records epoch identity fencing;
- nested JSON cell persistence;
- terminal deletion;
- ordered pull;
- SHA-256 snapshot validation;
- frozen actor high-water publication;
- log-prefix compaction and stale-cursor snapshot bootstrap;
- reopen under the same identity and refusal under a different records epoch.

All adapter tests use a real SQLite engine. The browser and Durable Object cases
wrap that engine in their native API shapes, so this proves SQL and transaction
translation parity without pretending to prove OPFS worker lifecycle or
workerd eviction behavior.

## Snapshot publication correction

SHA-256 may be asynchronous in a portable runtime. Snapshot publication now:

```txt
capture rows + actor high-waters + head in one read transaction
  -> hash immutable chunks outside SQLite
  -> publish only if head and generation still match
  -> otherwise discard and recapture
```

The compare-and-swap prevents a hash await from publishing rows and actor
high-waters from different accepted heads. The final manifest, chunks,
watermark, generation, and log deletion still commit in one transaction.

## Commands

```sh
bun run --cwd packages/record-sync typecheck
bun run --cwd packages/record-sync test
bun run check:licenses
```

Result on 2026-07-11: 9 tests passed, 0 failed, 52 assertions. The Durable
Object adapter also compiles against Cloudflare's real `DurableObjectStorage`
type. The license graph confirms the new MIT toolkit package has no path to
AGPL code.

## Still not proven

- Browser OPFS reopen, cross-worker invalidation, and large-database behavior.
- Durable Object cold-start, eviction, output-gate, and deployed storage limits.
- The typed client materialization and reactive query layer. That is Wave 5.
- Structural byte and account limits from Open Question 13.
