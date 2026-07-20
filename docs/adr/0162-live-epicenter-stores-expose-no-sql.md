# 0162. Live Epicenter stores expose no SQL

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0157](0157-read-only-sql-exposes-one-schema-opaque-row-relation.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)

## Context

Applications need typed local reads. Operators may also want to inspect data
with ordinary SQLite tools. Turning the private live store into that inspection
surface would couple application SQL to internal tables, connection lifetime,
TEMP views, lock behavior, deletion markers, and adapter-specific storage.

## Decision

The live `Epicenter` API exposes typed tables and values only. It exposes no
`sql()` method, raw SQLite connection, query builder, projection DTO, CTE
injection, TEMP view, persistent application view, or native-reader contract.

Direct read-only SQLite inspection is a separate operational concern. Native
adapters may document how a stopped store can be copied and inspected, but the
private schema is diagnostic and version-specific. No application may depend on
its relation names or open the live file beside the runtime.

A future portable export, if a real product workflow requires one, is a
read-only artifact derived from a stable logical cut of the whole Epicenter. It
must be self-describing and must not be the live store file. A queryable SQLite
export may materialize application-facing tables when supplied matching typed
definitions. Export does not justify a live SQL API, database catalogs, capture
state machines, or TEMP view lifetimes today.

## Consequences

- Typed queries can use private SQLite indexes and SQL internally without
  turning implementation schema into public API.
- Generic SQLite inspection is possible through an offline copy, with explicit
  expectations that the physical schema is private.
- Capture, import, merge, anchored export, recovery-copy, and SQL-projection
  APIs do not ship speculatively. They return only for a concrete user workflow.

## Considered alternatives

- **TEMP views created when definitions bind.** Rejected because their lifetime
  and connection ownership become public behavior and every adapter must
  reproduce it.
- **Stable application-facing views in the live file.** Rejected because
  release-local definitions would mutate persistent schema and collide across
  applications and versions.
- **Read-only `sql()` guarded by parsing or `EXPLAIN`.** Rejected because it is
  still a second application query language over private storage.

