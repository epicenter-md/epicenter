# 0178. Row facts and value facts are separate relations keyed by structured coordinates

- **Status:** Accepted
- **Date:** 2026-07-25
- **Amends:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)

## Context

ADR-0160 gave every scalar a structured address, and ADR-0163 put that structured
address on the wire with no flat qualified key. Neither ADR said how the address
lands in SQLite, and the first implementation stored both address kinds in one
`state` relation keyed by `(address_kind, qualified_key, row_id)`.

That single relation could not express the two kinds' different laws, so it
re-asserted them in CHECK constraints instead. Every value fact carried
`row_id = ''` as a sentinel because the column was structurally required and
semantically meaningless. `status` had to be three-valued (`live`, `deleted`,
`unset`) so one column could cover a row's terminal tombstone and a value's
reversible unset, and a CHECK then had to forbid the four illegal pairings. The
same shape leaked upward: the local intent queue reused the sentinel, and the
sealed batch sequence was smuggled in as a negative-sequence pseudo-value row at
a reserved internal address, because the only relation available to hold it was
one for value facts.

A flat `qualified_key` column also made the coordinates unreadable to SQL. A
trusted inspection host that wants to mount a Lens as logical relations
(ADR-0162) cannot filter on a namespace or a table without parsing a string.

## Decision

Facts are stored in two relations, in both the replica and the authority:

- `row_facts(namespace, table_name, row_id, presence, fields, changed_sequence)`,
  primary key `(namespace, table_name, row_id)`.
- `value_facts(namespace, value_name, presence, content, changed_sequence)`,
  primary key `(namespace, value_name)`.

Address coordinates are stored inline as their own columns. There is no
`qualified_key`, no `address_kind` discriminant column, and no `row_id` sentinel:
only `row_facts` has a `row_id` at all. `presence` is two-valued (`present`,
`absent`) in both relations, and the relation it appears in says which law it
obeys: absence is a terminal tombstone in `row_facts` and a reversible unset in
`value_facts`.

The local intent queues split the same way, into `row_outbox` and `value_outbox`,
sharing one strictly increasing local sequence space. The sealed batch sequence
is replica metadata and lives in `metadata.last_sealed_batch_sequence`.

Relations owned by a row address key on the row coordinates structurally:
`document_updates`, `document_publication`, and `document_versions` all key on
`(namespace, table_name, row_id)`. Row documents and blobs are not a new address
kind; they use the exact row address (ADR-0172, ADR-0174).

Coordinates stay inline rather than interned behind a surrogate. If a future
measurement earns interning, any `coordinate_id` remains an internal surrogate
and never becomes a durable or wire identity.

Durable local table and value names must be usable as SQL identifiers, because a
trusted inspection host mounts a selected Lens as logical relations named exactly
after the Lens property names. The grammar is therefore
`^[A-Za-z][A-Za-z0-9_]*$`, which keeps idiomatic `camelCase` names legal and
reserves every `_`-prefixed relation name for internal use. SQL identifiers are
case-insensitive, so a Lens refuses two table names, or two value names, that
differ only in case, and a table refuses two field names that differ only in
case. Row and value names occupy disjoint address key spaces, so one namespace
may declare both a `notes` table and a `notes` value.

## Consequences

Each law is now a column constraint or a missing column rather than a CHECK that
re-derives legality from a discriminant. The sentinel and the negative-sequence
pseudo-row are unrepresentable rather than merely discouraged.

The cost is that any read ordered by `changed_sequence` spans both relations, so
the exchange page and the batch sealer read a `UNION ALL` projection ordered by
sequence. That projection carries a query-local discriminant (`fact_kind`,
`intent_kind`) to say which branch a row came from; it is a derived label, not a
resurrected storage column.

`changed_sequence` is globally unique and increasing across both fact relations,
and SQLite cannot express a cross-relation unique constraint. The guarantee comes
from the authority's `metadata.next_sequence`, which the authority is the only
writer of and only ever advances. Per-relation unique indexes still refuse a
duplicate within one relation, which is the failure a paging or fold bug would
actually produce.

Both physical formats clean-break: `REPLICA_FORMAT_VERSION` becomes 4 and
`AUTHORITY_FORMAT_VERSION` becomes 3. No migration is provided and none is
intended; a non-current format is refused, not upgraded.
