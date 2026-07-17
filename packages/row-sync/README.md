# @epicenter/row-sync

`@epicenter/row-sync` is the portable row-plane core. It owns the `RowIntent`
mutation protocol, the schema-blind fold-never-refuse row fold, the canonical
authority persistence, and outcome compaction (ADR-0131/0133). Row-owned
document updates travel inside `RowIntent` and composite row outcomes; there is
no separate document sync channel.

The core sees one SQLite capability:

```ts
type RowSyncSqlite = {
	run(sql, parameters?): void;
	all(sql, parameters?): Row[];
	transaction(run): Result;
};
```

Runtime packages adapt their native engine to that capability:

```txt
sqlite.org OO1 (browser) --+
bun:sqlite ----------------+--> RowSyncSqlite --> row-sync authority core
DO storage.sql ------------+
```

The caller owns opening and closing the database. The adapter owns only SQL API
translation and transaction entry. The row-sync authority core owns DDL, the
exact-retry receipt per enrolled replica (`replicaId`, `acceptedRound`,
`requestDigest`), canonical rows, sequence-addressed composite outcomes,
document baselines plus retained update tails, and outcome compaction behind the
retention floor. It keeps no deleted-id tombstones and publishes no snapshot
artifact; a replica below the floor reacquires state through the stateless
baseline scan (ADR-0136).

## Exports

- `@epicenter/row-sync`: protocol schemas, parsers, admission limits,
  `foldFields`, `openRowAuthority`, the round digest, and the `RowSyncSqlite`
  contract.
- `@epicenter/row-sync/browser`: sqlite.org OO1 adapter.
- `@epicenter/row-sync/bun`: `bun:sqlite` adapter.
- `@epicenter/row-sync/durable-object`: SQLite-backed Durable Object adapter.

Transport code validates untrusted client messages with `parseEnrollRequest`,
`parseSyncRequest`, and `parseBaselineScanRequest`. Clients validate server
messages with the matching response parsers.

## Verification

```sh
bun run --cwd packages/row-sync typecheck
bun run --cwd packages/row-sync test
```

The conformance test runs the same authority scenario through all three adapter
surfaces over real SQLite semantics. Browser OPFS lifecycle and deployed
workerd lifecycle remain environment smoke tests; this package test does not
claim to cover either runtime lifecycle.
