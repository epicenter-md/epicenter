# @epicenter/row-sync

`@epicenter/row-sync` is the portable scalar row-plane protocol. It is
intentionally CRDT-free and storage-free: `RowIntent` carries JSON field or
reserved KV changes only. The package owns bounded wire parsing, pure field
folding, exact-retry digests, and protocol vocabulary. It owns no SQLite schema,
authority transaction, runtime adapter, or document state.

The AGPL `@epicenter/server` package owns durable authority persistence,
receipts, current rows, bounded row-address and deletion markers, and transport
compaction. The MIT `@epicenter/sqlite` package supplies only the runtime-neutral
embedded SQLite driver and adapters.

Document snapshots and update logs belong to the workspace authority's
document hub. They never enter scalar admission, folding, pull, acquisition,
settlement, or recovery lineage.

Push and pull are separate internal operations. Push folds one immutable round
and returns only its receipt. Pull installs current state through one fixed
authority head. A fresh or below-floor replica uses stateless address-ordered
acquisition; it does not receive a published snapshot or resumable scan token.

## Exports

- `@epicenter/row-sync`: current-state protocol parsers, admission limits,
  `foldFields`, scalar intent encodings, and the round digest. Untrusted bytes
  enter through the parsers; the raw TypeBox schemas stay internal.

Transport code validates untrusted client messages with
`parsePushRequest`, `parsePullRequest`, and
`parseAcquireRequest`. Clients validate server messages with the matching
response parsers.

## Verification

```sh
bun run --cwd packages/row-sync typecheck
bun run --cwd packages/row-sync test
```

Authority and SQLite-adapter conformance live with their respective owners in
`@epicenter/server` and `@epicenter/sqlite`.
