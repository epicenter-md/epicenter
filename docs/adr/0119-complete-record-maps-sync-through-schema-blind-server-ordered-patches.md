# 0119. Complete record maps sync through schema-blind server-ordered patches

- **Status:** Accepted
- **Date:** 2026-07-15
- **Relates:** [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md), [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md), [ADR-0092](0092-identity-is-the-partition.md), [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md)

## Context

Epicenter currently stores record collections in Yjs. That requires a device to
hydrate CRDT state before querying and makes memory use follow the complete
collection. Large personal collections need a complete local replica with
bounded point reads and scans, while synchronized scalar edits still need one
deterministic conflict rule.

## Decision

Each workspace owns one schema-opaque current-state map from
`(table key, row id)` to a valid JSON object. Every synchronized device holds a
complete replica. The runtime stores that map in private SQLite tables; the
physical SQLite schema is runtime state, not application schema.

The record wire has exactly three commands:

```ts
type RecordCommand =
	| {
			kind: 'createRow';
			table: string;
			rowId: string;
			value: Record<string, JsonValue>;
	  }
	| {
			kind: 'patchRow';
			table: string;
			rowId: string;
			set: Record<string, JsonValue>;
			unset: string[];
	  }
	| { kind: 'deleteRow'; table: string; rowId: string };
```

`createRow` creates an absent identity and refuses a live duplicate.
`patchRow` changes only named keys and is an accepted no-op for an absent row.
`deleteRow` physically removes a live row and is an accepted no-op when absent.
`set` and `unset` are disjoint. No wire value is `undefined`.

Patching, rather than whole-row replacement, is structural. It preserves keys
unknown to the submitting release and lets concurrent changes to different keys
compose. Concurrent changes to the same key resolve by server acceptance order.
Device clocks and per-cell timestamps do not participate.

The server understands workspace, table, row, JSON value, actor, command, and
sequence identity. It does not understand application fields, schemas, lenses,
queries, or migrations. It accepts idempotent actor-ordered commands, folds them
into current state, and serves cursor-based pulls. A WebSocket is only a wake-up
hint.

The command tail is transport state, not product history. The authority may
compact an accepted prefix into one logical current-state snapshot. A replica
whose cursor falls below the retained floor installs the snapshot, reapplies its
durable pending commands, and continues. The protocol promises no permanent
event log, partial replica, query subscription, peer-to-peer merge, or audit
history.

Command envelopes and portable snapshot rows are bounded. Two replicas can each
author a valid patch whose server-ordered combination exceeds one portable row.
That semantic refusal is permanent for the atomic sealed batch. The replica
moves the rejected commands, plus later pending commands on any row touched by
that batch, into durable local quarantine. It rotates its actor, bootstraps
accepted current state, and rebases only later commands on disjoint row keys. It
surfaces the refusal and never retries the rejected batch forever. Quarantined
intent is recovery evidence, not authority, and is never truncated or silently
applied.

## Consequences

- Record scale follows SQLite pages and query working sets, not one hydrated
  CRDT graph.
- Point reads use the canonical `(table, row id)` primary key. Per-table scans
  touch one contiguous key range.
- Missing keys, extra keys, explicit nulls, and values invalid under the current
  application release remain canonical data.
- Every actor preserves its command order. A transaction may contain commands
  for several rows in one workspace, but never another workspace or a Yjs
  document.
- Deletion is physical absence. The protocol carries no permanent tombstone or
  used-identity registry; conforming creation allocates fresh random ids.
- Current state, actor high-water marks, exact recent receipts, the uncompacted
  tail, and one snapshot baseline are transport state. Old commands are not.
- Application history remains an explicit application table.
- Local-only workspaces use the same canonical map without actor, cursor, or
  outbox state until synchronization is explicitly configured.
- Permanently rejected synchronized intent stays locally inspectable. Continued
  synchronization uses a fresh actor after the replica has rebuilt accepted
  state.

## Considered alternatives

- **Synchronize SQLite files or WAL pages.** Rejected because independently
  writable physical files are not a logical merge boundary.
- **Use whole-row replacement.** Rejected because unknown-key preservation and
  independent-field concurrency would become racy client conventions.
- **Use HLC or wall-clock LWW.** Rejected because a bad clock can dominate and
  every key would retain conflict metadata.
- **Keep records in Yjs.** Rejected because bounded record collections do not
  earn eager CRDT history and memory cost.
- **Retain the command log forever.** Rejected because synchronization is not an
  audit product.
- **Build partial replication.** Rejected because every supported device is
  intentionally a complete workspace replica.
