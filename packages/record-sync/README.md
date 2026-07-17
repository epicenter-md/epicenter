# @epicenter/record-sync

`@epicenter/record-sync` is the portable record-plane core. It owns the logical
mutation protocol, the schema-blind row fold, canonical server persistence,
snapshots, and compaction. Yjs document sync remains in `@epicenter/sync`.

The core sees one SQLite capability:

```ts
type RecordSyncSqlite = {
	run(sql, parameters?): void;
	all(sql, parameters?): Row[];
	transaction(run): Result;
};
```

Runtime packages adapt their native engine to that capability:

```txt
sqlite.org OO1 (browser) --+
bun:sqlite ----------------+--> RecordSyncSqlite --> record authority
DO storage.sql ------------+
```

The caller owns opening and closing the database. The adapter owns only SQL API
translation and transaction entry. The record authority owns DDL, the
per-replica round triple (`replicaId`, `acceptedRound`, `requestDigest`),
canonical rows and deletion tombstones, sequence-addressed body logs,
snapshots, and compaction (ADR-0131/0132/0133).

## Exports

- `@epicenter/record-sync`: protocol schemas, parsers, fold, authority, snapshot
  codec, and the `RecordSyncSqlite` contract.
- `@epicenter/record-sync/browser`: sqlite.org OO1 adapter.
- `@epicenter/record-sync/bun`: `bun:sqlite` adapter.
- `@epicenter/record-sync/durable-object`: SQLite-backed Durable Object adapter.

Transport code validates untrusted client messages with `parseSyncRequest`
and `parseSnapshotChunkRequest`. Clients validate server messages with the
matching response parsers.

## Verification

```sh
bun run --cwd packages/record-sync typecheck
bun run --cwd packages/record-sync test
```

The conformance test runs the same authority scenario through all three adapter
surfaces over real SQLite semantics. Browser OPFS lifecycle and deployed
workerd lifecycle remain environment smoke tests; this package test does not
claim to cover either runtime lifecycle.
