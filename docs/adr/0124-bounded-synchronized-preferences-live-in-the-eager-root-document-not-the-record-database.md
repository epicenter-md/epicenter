# 0124. Bounded synchronized preferences live in the eager root document, not the record database

- **Status:** Proposed
- **Date:** 2026-07-11
- **Relates:** [ADR-0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md) (reaffirmed), [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md), [ADR-0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md)

## Context

The SQLite record branch initially compiled declared KV keys into a reserved
record table, so a handful of settings inherited a server authority, snapshot
protocol, import comparison, schema epochs, and a row lifecycle. The record
plane's explicit `createRow` also cannot serve deterministic keys: two offline
devices can honestly make the first assignment to the same declared key, and
neither is corrupt. A setting's real contract is different from a record's: it
is bounded, eagerly useful at boot, rewritten in place, and safe to answer
with a default when missing or invalid.

## Decision

Declared workspace KV is a preference plane in the workspace's eager root Yjs
document, stored as `YKeyValueLww` entries under the kv namespace
([ADR-0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md) is
reaffirmed: the kv namespace owns its keys, defaults, and reset). The record
database is table-only. KV does not participate in record schema identity,
record snapshots, imports, quarantine, worker messages, or record wire
operations.

Reads validate the stored value against the current declared schema. A missing
or invalid value reads as a fresh default; the stored bytes are left intact so
diagnostics can still see the mismatch, and observers are notified of the
effective change when an invalid winning value forces a fallback. Because the
plane is not the record wire, a KV schema may be `nullable(...)`: `null` can
be a real stored preference, and deleting the key means no override exists.

A semantic change to a setting mints a new dot-namespaced key rather than
migrating the old one in place. The old key remains readable to old clients;
the new client reads the new key and gets its default until the user changes
it. This policy is appropriate only for values where silently returning a
default loses nothing important; anything else belongs in a record table or a
domain document.

Bounded is enforced, not assumed: only declared keys are admitted, key and
encoded-value budgets are checked at write time, and last-write-wins
timestamps are bounded against absurd clocks. Hydration ordering is explicit:
a surface must wait for local hydration before treating absence as the durable
default. Transactions never span the record database and the preference plane;
a value that must change atomically with a record is part of the record model,
not a preference.

## Consequences

- The record protocol loses every KV special case: no KV rows in snapshots, no
  KV import handling, no KV quarantine, no KV invalidation axis in the SQLite
  worker protocol, and no null-as-clear ambiguity on the record wire.
- The preference plane is eager and synchronous: it hydrates with the root
  document at boot and reads without a worker round trip, while record tables
  remain asynchronous behind their service boundary.
- The workspace composes three storage planes with one owner each: SQLite
  record tables, the eager root-document KV namespace, and lazy child
  documents ([ADR-0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md)).
  Less uniform, but each plane keeps fewer promises.
- Settings sync through the Yjs provider with timestamp last-write-wins, not
  server acceptance order. For preferences, a lost concurrent write costs one
  toggle, and the read-as-default rule already tolerates divergence.
- Cross-plane invariants have no transaction. A command that must update a
  record and a preference atomically must be remodeled so the record owns the
  invariant.
- The namespace must stay bounded for the eager document to stay cheap;
  unbounded or per-row state is record data, not a preference.

## Considered alternatives

- **Keep KV in the record database as a reserved table.** Rejected: settings
  inherit row lifecycle, snapshots, epochs, and import machinery they do not
  need, `null` collides with clear on the record wire, and deterministic keys
  break explicit creation because two devices can honestly create the same key
  first.
- **Give KV its own record wire operation family.** Rejected: a third
  operation family multiplies wire, snapshot, and fold behavior for a bounded
  namespace that does not need server ordering.
- **Migrate settings in place when their meaning changes.** Rejected: a
  generic KV migration engine recreates schema-epoch machinery inside the
  plane whose whole point is validate-or-default reads; new namespaced keys
  version by identity instead.
- **Store settings per device only.** Rejected: preferences are part of the
  workspace the user expects to follow them across devices; device-local state
  remains available outside the workspace for values that must not sync.
