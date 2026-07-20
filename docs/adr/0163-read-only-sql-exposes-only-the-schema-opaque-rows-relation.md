# 0163. Read-only SQL exposes only the schema-opaque rows relation

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0157](0157-read-only-sql-exposes-one-schema-opaque-row-relation.md)
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md), and [ADR-0162](0162-portability-is-a-frozen-editable-projection-of-one-selected-owner.md)

## Context

Per-lens SQL views require a privileged lens in the process that owns SQLite,
make connection lifecycle depend on application releases, and give simultaneous
lenses competing names. Exposing private runtime tables instead would turn every
storage migration into an application compatibility event. Deleting SQL would
lose useful ad hoc filtering, grouping, joins, and inspection.

## Decision

The SQL API is stateless and lens-independent. It exposes exactly one protected
logical relation named `rows`:

```sql
rows(
  table_key   TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  fields_json TEXT NOT NULL
)
```

`rows` presents the replica's current locally visible ordinary rows, including
durable optimistic scalar edits. It excludes typed KV and every private replica,
document, blob, and runtime relation. One statement sees one stable local SQLite
transaction. SQL performs no hidden network work and does not claim an exact
historical server checkpoint; different remotely accepted rows may become
visible locally at different times.

`rows` is also readable in place. On desktop and Bun, the live
`epicenter.sqlite3` file itself contains a relation named `rows` (a real table
or a view over private tables), so a person can open the database read-only
with ordinary SQLite tools, or through an owner-level native reader (an
`openEpicenterReader()`-style call that takes no database ID and no
application definition), and query the same relation the API exposes. External
connections are read-only (`query_only`); the platform supports no external
write path to the live file, and a direct write never synchronizes (ADR-0161).
In the browser, `rows` keeps the same semantics through the SQL API without a
filesystem-path promise.

Behind that name, the backing representation is private. Where no direct file
access exists, the runtime may serve `rows` through an isolated query
connection. Every implementation must make the relation incrementally
readable: executing a query cannot rebuild or reinsert the complete visible
dataset first.

Only read-only `SELECT` and `WITH` statements are accepted. The executor compiles
the bound statement and proves that it can address only `rows`; it rejects DDL,
writes, attachments, pragmas that mutate or reveal private layout, virtual-table
opens, and physical relation access. Scalar SQLite JSON functions remain
available. CTEs and subqueries provide per-query aliases. The platform installs
no lens-shaped persistent or TEMP views, and the API exposes no view lifecycle.

SQL parameters and raw result rows may cross an owner transport. The result
schema remains in the calling application's JavaScript realm and validates the
returned rows there.

## Consequences

- Several lenses can query the same local owner without registration or name
  collisions.
- Live data is inspectable in place, read-only, without an export step.
  Deliberate editing stays with the detached portable artifact (ADR-0162).
- Queries spell JSON extraction and filter by permanent `table_key` values.
- `rows` replaces `records` without a compatibility alias.
- Table-valued JSON traversal is outside v1. A measured caller may reopen the
  executor proof model, but never gains private runtime table access.
- Private storage may change from overlays to durable optimistic rows without
  changing the SQL contract.

## Considered alternatives

- **Install one TEMP view per lens.** Rejected because a stateless SQL call
  should not create application lifecycle inside the SQLite owner.
- **Let applications create TEMP views.** Rejected because the current API is
  read-only and would need connection identity, cleanup, and concurrent naming
  semantics. A CTE expresses the same per-query convenience.
- **Expose private canonical tables.** Rejected because their layout includes
  synchronization state and must remain migration-safe.
- **Keep `records` as an alias.** Rejected because the clean break should have
  one public relation and one noun.
