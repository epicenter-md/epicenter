# 0131. Row sync folds sealed RowIntent rounds without refusal

- **Status:** Proposed
- **Date:** 2026-07-16
- **Supersedes:** [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md)
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md), [ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md), [ADR-0135](0135-row-bodies-have-one-content-root.md), [ADR-0136](0136-replica-bootstrap-uses-a-disposable-anchored-live-scan.md)

## Context

ADR-0119 split scalar row changes into `createRow`, `patchRow`, and
`deleteRow`, then allowed the authority to reject a sealed batch after the
replica had already made it durable. Row-owned bodies added a fourth
`bodyAppend` command. The replica therefore needed an append-only outbox,
command ordering, quarantine, actor rotation, rebootstrap, stored batch JSON,
and recovery rules for changes that the user had already seen locally.

The product model is smaller. A user creates, updates, or deletes one row. The
row owns both its JSON fields and its collaborative body. Their fold
laws differ, but that difference belongs inside row folding rather than in a
transport command vocabulary.

## Decision

The protocol carries one canonical row mutation type:

```ts
type RowIntent =
	| {
			kind: 'create';
			table: string;
			rowId: string;
			fields: JsonObject;
			bodyUpdate?: Uint8Array;
	  }
	| ({ kind: 'update'; table: string; rowId: string } &
			(
				| {
						fields: { set: JsonObject; unset: string[] };
						bodyUpdate?: Uint8Array;
				  }
				| { fields?: never; bodyUpdate: Uint8Array }
			))
	| {
			kind: 'delete';
			table: string;
			rowId: string;
			fields?: never;
			bodyUpdate?: never;
	  };
```

The same semantic `RowIntent` accumulates locally, persists in SQLite, freezes
inside a sealed round, crosses the wire, and folds at the authority. Physical
encodings may differ: SQLite stores body bytes as a BLOB and JSON transport
base64-encodes them. No layer translates the intent into `RecordCommand`,
`createRow`, `patchRow`, `deleteRow`, or `bodyAppend` variants.

Create contains the complete initial field postimage required by the
submitting release's table lens. The schema-blind authority validates only
bounded JSON and permanent row rules; it does not know which application
fields are required. Update fields use disjoint absolute `set` and `unset`
operations. Omitting a field preserves it, setting `null` stores JSON null, and
unsetting removes the property. An update must contain non-empty field changes,
a body update, or both.

A `RowIntent` is one lifecycle atom, not one all-or-nothing application atom:

- `create` on an absent address creates the fields and, when present, its body
  in one authority transaction. `create` on a live address no-ops as a whole.
- `update` on an absent address no-ops as a whole. On a live row, its field and
  body components fold independently. A field component that would exceed the
  row cap no-ops and may visibly correct at retirement; a valid body update
  still merges. An unrelated scalar capacity race never discards durable
  collaborative content.
- `delete` removes the row fields and body state in one authority transaction.
  Delete on absence is a deterministic no-op.

The reserved KV address accepts only field-bearing `update` intents. It folds
an absent physical payload from `{}`, materializes on first write, and rejects
`create`, `delete`, and body-bearing intents before sealing.

The replica has two private intent states. Open RowIntents are durable local
work that may still compact. A sealed round is an immutable retry image under
one round number and digest. Edits authored while a round is unresolved remain
open for a later round. Nothing compacts across that boundary.

Sealing selects a deterministic bounded subset of open RowIntents. Intents that
do not fit remain open for later rounds. Local admission rejects any single
RowIntent that cannot fit the per-intent ceiling, including a merged body
update that grows beyond it; the system does not create an unsendable durable
intent. Chunking, streaming, and upload sessions remain refused.

The exchange is:

```txt
sync({ token, sealedRound?: { round, requestDigest, intents[] } })
```

The authority folds a round exactly once and stores one `(replicaId,
acceptedRound, requestDigest)` triple. A matching retry refolds nothing. A
digest mismatch or a round other than `acceptedRound` or `acceptedRound + 1`
is a terminal replica fork. The sealed round stays durable through every
response page and retires only after the exchange reaches head.

The accepted-round triple is the durable head of that replica's retry chain and
is not removed by outcome-tail compaction or replica bootstrap. It remains for
the workspace lifetime unless the replica is explicitly and permanently revoked.
Bootstrap keeps the same replica id, sealed round, digest, and canonical
RowIntent rows. Scratch confirmed state is disposable; authored intent and
exact-retry identity are not.

Confirmed outcome transport remains distinct from authorship intent. One
applied RowIntent consumes one authority sequence and emits one composite row
outcome: the complete field postimage when fields changed, the opaque body
update when the body changed, or both. Delete emits one deletion outcome. These
outcomes are never replayed as RowIntents. A deterministic no-op may consume an
authority sequence without emitting a row fact; the page checkpoint advances
across that gap.

## Consequences

- ADR-0119's durable product semantics survive: complete schema-opaque replicas,
  absolute set/unset field changes, authority order, unknown-key preservation,
  logical snapshots, no application history, and no partial replication.
- The three scalar commands and `bodyAppend` disappear from the wire. A create
  with an initial body needs no scalar-before-body ordering or parking rule.
- Quarantine, dependent-intent partitioning, actor rotation, forced
  rebootstrap, per-command actor sequences, stored batch JSON, and durable
  rejection history disappear.
- A fold may partially apply the components of a live-row update. That is
  deliberate: lifecycle validity is shared, while scalar capacity and CRDT
  merge are independent laws.
- Exact lost-response retry remains mandatory. Open and sealed are lifecycle
  states around the same semantic type, not separate command formats.
- Body update encoding is one workspace protocol decision, not a per-table
  contract. A protocol-major mismatch is refused before a round folds.

## Considered alternatives

- **Keep scalar commands plus `bodyAppend`.** Rejected because authority
  storage mechanics leak into authorship and force one row change through a
  translation and ordering ladder.
- **Make a combined update atomic across fields and body.** Rejected because a
  concurrent scalar capacity race could silently discard durable collaborative
  text.
- **Let one oversized open intent remain durable until the network improves.**
  Rejected because no network condition can make a protocol-oversized intent
  sendable.
- **Store or replay RowIntents as confirmed history.** Rejected because sync is
  not an audit product; confirmed pages carry resulting facts instead.
